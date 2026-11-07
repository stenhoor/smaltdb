/**
 * SQL's operator semantics as named functions (ADR 0014, section 2). The engine's shared layer gives each operation
 * one meaning; behaviour that is SQLite's own lives here, under the `sql.` namespace, and the SQL front end chooses
 * these functions: comparison in SQLite's storage-class order, arithmetic with integer overflow to REAL and
 * truncating integer division, `||`, bit operators, LIKE and GLOB, IN over a list, and CAST.
 *
 * A function compiles its arguments' closures into one closure. What the SQL front end decides (the collation of a
 * comparison, which operand converts by affinity, the probe's affinity for IN) arrives in `SqlCompileOptions`, so
 * these closures are the ones the closure compiler always built: moving them here changes no result and no closure.
 */
import type { FnTraits } from './traits.js';
import { SmaltError } from '../errors.js';
import { Collation, type SqlValue, compareValues, normalizeInt } from '../values.js';
import {
  type StaticType,
  applyNumericAffinity,
  applyTextAffinity,
  castToInteger,
  castToNumeric,
  castToReal,
  hashKey,
  isIntValue,
  realToInt,
  toBlob,
  toNumeric,
  toText,
  truthy,
} from './convert.js';
import type { Fn } from './functions.js';

/** One compiled argument. */
export interface SqlArg {
  fn: Fn;
  type: StaticType;
  /** The value does not depend on registers. */
  constant?: boolean;
  /**
   * An affinity conversion applied to this operand's non-NULL value before comparing (SQLite §4.2): the plan's
   * `sql.affinity_numeric` / `sql.affinity_text` around the operand.
   */
  convert?: ((v: SqlValue) => SqlValue) | null;
}

/** What the SQL front end decided for the call. */
export interface SqlCompileOptions {
  /** Collation of a comparison, LIKE-free IN list or grouping. */
  collation?: Collation;
  /** IN over a list: the probe's affinity, applied to the list values ('NONE' when it has none). */
  probeAffinity?: 'NUMERIC' | 'TEXT' | 'NONE';
  /** NOT LIKE, NOT GLOB, NOT IN: the negation folded into the same closure. */
  negated?: boolean;
}

export interface SqlFunction {
  readonly name: string;
  /** Number of arguments, or [min, max] (max -1: any number). */
  readonly arity: number | readonly [number, number];
  compile(args: SqlArg[], options: SqlCompileOptions): { fn: Fn; type: StaticType };
  /** What the planner and code generation know about it (exec/traits.ts). */
  readonly traits?: FnTraits;
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function isNumericType(t: StaticType): boolean {
  return t === 'int' || t === 'real' || t === 'num';
}

// ------------------------------------------------------------------ comparison

/** Comparison operators by name; `sql.is` and `sql.is_not` treat NULL as a value. */
export const COMPARISON_FUNCTIONS: Readonly<Record<string, string>> = {
  '=': 'sql.eq',
  '!=': 'sql.ne',
  '<': 'sql.lt',
  '<=': 'sql.le',
  '>': 'sql.gt',
  '>=': 'sql.ge',
  IS: 'sql.is',
  'IS NOT': 'sql.is_not',
};

function cmpTest(op: string): (c: number) => boolean {
  switch (op) {
    case '=':
      return (c) => c === 0;
    case '!=':
      return (c) => c !== 0;
    case '<':
      return (c) => c < 0;
    case '<=':
      return (c) => c <= 0;
    case '>':
      return (c) => c > 0;
    default:
      return (c) => c >= 0;
  }
}

function comparisonFn(op: string, a: SqlArg, b: SqlArg, coll: Collation): Fn {
  const fa = a.fn;
  const fb = b.fn;
  const ca = a.convert ?? null;
  const cb = b.convert ?? null;

  if (op === 'IS' || op === 'IS NOT') {
    const want = op === 'IS' ? 1 : 0;
    return (r) => {
      let x = fa(r);
      let y = fb(r);
      if (x === null || y === null) return (x === null && y === null) === (want === 1) ? 1 : 0;
      if (ca) x = ca(x);
      if (cb) y = cb(y);
      return (compareValues(x, y, coll) === 0) === (want === 1) ? 1 : 0;
    };
  }

  // Fast path: both operands statically numeric (no conversions or collation needed).
  if (isNumericType(a.type) && isNumericType(b.type)) {
    switch (op) {
      case '=':
        return (r) => {
          const x = fa(r);
          if (x === null) return null;
          const y = fb(r);
          if (y === null) return null;
          // eslint-disable-next-line eqeqeq
          return (x as number) == (y as number) ? 1 : 0;
        };
      case '!=':
        return (r) => {
          const x = fa(r);
          if (x === null) return null;
          const y = fb(r);
          if (y === null) return null;
          // eslint-disable-next-line eqeqeq
          return (x as number) != (y as number) ? 1 : 0;
        };
      case '<':
        return (r) => {
          const x = fa(r);
          if (x === null) return null;
          const y = fb(r);
          if (y === null) return null;
          return (x as number) < (y as number) ? 1 : 0;
        };
      case '<=':
        return (r) => {
          const x = fa(r);
          if (x === null) return null;
          const y = fb(r);
          if (y === null) return null;
          return (x as number) <= (y as number) ? 1 : 0;
        };
      case '>':
        return (r) => {
          const x = fa(r);
          if (x === null) return null;
          const y = fb(r);
          if (y === null) return null;
          return (x as number) > (y as number) ? 1 : 0;
        };
      default:
        return (r) => {
          const x = fa(r);
          if (x === null) return null;
          const y = fb(r);
          if (y === null) return null;
          return (x as number) >= (y as number) ? 1 : 0;
        };
    }
  }

  const test = cmpTest(op);
  return (r) => {
    let x = fa(r);
    if (x === null) return null;
    let y = fb(r);
    if (y === null) return null;
    if (ca) x = ca(x);
    if (cb) y = cb(y);
    return test(compareValues(x, y, coll)) ? 1 : 0;
  };
}

// ------------------------------------------------------------------ arithmetic

/** Arithmetic operators by name. */
export const ARITHMETIC_FUNCTIONS: Readonly<Record<string, string>> = { '+': 'sql.add', '-': 'sql.sub', '*': 'sql.mul', '/': 'sql.div', '%': 'sql.mod' };

function num(v: SqlValue): number | bigint {
  return typeof v === 'number' || typeof v === 'bigint' ? v : (toNumeric(v) as number | bigint);
}

function inI64(b: bigint): boolean {
  return b >= I64_MIN && b <= I64_MAX;
}

function realResult(x: number): SqlValue {
  return Number.isNaN(x) ? null : x;
}

/**
 * SQLite arithmetic on two non-NULL values: integers stay integers until they overflow 64 bits (then REAL), integer
 * division truncates, division by zero is NULL, text converts to a number. `forceReal`: an operand is statically
 * REAL.
 */
export function arithImpl(op: string, forceReal: boolean): (x: SqlValue, y: SqlValue) => SqlValue {
  const realOp = (x: number, y: number): SqlValue => {
    switch (op) {
      case '+':
        return realResult(x + y);
      case '-':
        return realResult(x - y);
      case '*':
        return realResult(x * y);
      case '/':
        return y === 0 ? null : realResult(x / y);
      default:
        return realMod(x, y);
    }
  };
  const intOp = (x: number | bigint, y: number | bigint): SqlValue => {
    if (typeof x === 'number' && typeof y === 'number') {
      switch (op) {
        case '+': {
          const s = x + y;
          if (Number.isSafeInteger(s)) return s;
          break;
        }
        case '-': {
          const s = x - y;
          if (Number.isSafeInteger(s)) return s;
          break;
        }
        case '*': {
          const s = x * y;
          if (Number.isSafeInteger(s)) return s === 0 ? 0 : s;
          break;
        }
        case '/':
          if (y === 0) return null;
          if (Math.abs(x) < 2147483648 && Math.abs(y) < 2147483648) {
            const q = Math.trunc(x / y);
            return q === 0 ? 0 : q;
          }
          break;
        default:
          if (y === 0) return null;
          if (y === -1) return 0;
          {
            const m = x % y;
            return m === 0 ? 0 : m;
          }
      }
    }
    const bx = BigInt(x);
    const by = BigInt(y);
    let res: bigint;
    switch (op) {
      case '+':
        res = bx + by;
        break;
      case '-':
        res = bx - by;
        break;
      case '*':
        res = bx * by;
        break;
      case '/':
        if (by === 0n) return null;
        if (bx === I64_MIN && by === -1n) return realResult(Number(bx) / -1);
        res = bx / by;
        break;
      default:
        if (by === 0n) return null;
        if (by === -1n) return 0;
        res = bx % by;
    }
    if (!inI64(res)) return realOp(Number(x), Number(y));
    return normalizeInt(res);
  };
  return (x, y) => {
    const nx = num(x);
    const ny = num(y);
    if (!forceReal && isIntValue(nx) && isIntValue(ny)) return intOp(nx, ny);
    // REAL %: convert the *original* operands to int64 (converting a bigint through a double would lose precision).
    if (op === '%') return realMod(nx, ny);
    return realOp(Number(nx), Number(ny));
  };
}

/** SQLite REAL `%`: both operands cast to INTEGER, remainder returned as REAL. */
function realMod(x: number | bigint, y: number | bigint): SqlValue {
  const ix = typeof x === 'bigint' ? x : realToInt(x);
  let iy = typeof y === 'bigint' ? y : realToInt(y);
  if (iy === 0 || iy === 0n) return null;
  if (iy === -1 || iy === -1n) iy = 1;
  return Number(BigInt(ix) % BigInt(iy));
}

/** SQLite unary minus: integers negate exactly (the minimum integer becomes REAL), text converts to a number. */
export function negate(v: SqlValue): SqlValue {
  if (v === null) return null;
  if (typeof v === 'number') return v === 0 ? 0 : -v;
  if (typeof v === 'bigint') return v === I64_MIN ? -Number(v) : normalizeInt(-v);
  return negate(toNumeric(v));
}

function arithmeticFn(op: string, a: SqlArg, b: SqlArg): { fn: Fn; type: StaticType } {
  const fa = a.fn;
  const fb = b.fn;
  const real = a.type === 'real' || b.type === 'real';
  const type: StaticType = real ? 'real' : a.type === 'int' && b.type === 'int' ? 'int' : 'num';
  const impl = arithImpl(op, real);
  return {
    fn: (r) => {
      const x = fa(r);
      if (x === null) return null;
      const y = fb(r);
      if (y === null) return null;
      return impl(x, y);
    },
    type,
  };
}

// ------------------------------------------------------------------ checked arithmetic and strict casts

/** Numbers only: the checked and strict operations take what their language has already typed. */
function numberOperand(v: SqlValue, name: string): number | bigint {
  if (typeof v === 'number' || typeof v === 'bigint') return v;
  throw new SmaltError('SMALT_MISMATCH', `${name} takes numbers, not ${typeof v === 'string' ? 'text' : 'a blob'}`);
}

/**
 * `add_checked`, `sub_checked`, `mul_checked`: as `add`, `sub`, `mul`, except that an integer result outside the
 * 64-bit range is an error (`SMALT_RANGE`) rather than a real, and text is not converted.
 */
function checkedArithmeticFn(op: '+' | '-' | '*', name: string, a: SqlArg, b: SqlArg): { fn: Fn; type: StaticType } {
  const fa = a.fn;
  const fb = b.fn;
  const real = a.type === 'real' || b.type === 'real';
  const type: StaticType = real ? 'real' : a.type === 'int' && b.type === 'int' ? 'int' : 'num';
  return {
    fn: (r) => {
      const x0 = fa(r);
      if (x0 === null) return null;
      const y0 = fb(r);
      if (y0 === null) return null;
      const x = numberOperand(x0, name);
      const y = numberOperand(y0, name);
      if (real || !isIntValue(x) || !isIntValue(y)) {
        const fx = Number(x);
        const fy = Number(y);
        return realResult(op === '+' ? fx + fy : op === '-' ? fx - fy : fx * fy);
      }
      if (typeof x === 'number' && typeof y === 'number') {
        const s = op === '+' ? x + y : op === '-' ? x - y : x * y;
        if (Number.isSafeInteger(s)) return s === 0 ? 0 : s;
      }
      const bx = BigInt(x);
      const by = BigInt(y);
      const res = op === '+' ? bx + by : op === '-' ? bx - by : bx * by;
      if (res < I64_MIN || res > I64_MAX) throw new SmaltError('SMALT_RANGE', `integer overflow in ${name}`);
      return normalizeInt(res);
    },
    type,
  };
}

const INTEGER_TEXT = /^\s*[+-]?\d+\s*$/;
const NUMBER_TEXT = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/;

/** `cast_integer_strict`: an integer, or an error for what is not one (no prefix of text, no saturation). */
export function castToIntegerStrict(v: SqlValue): number | bigint | null {
  if (v === null || typeof v === 'bigint') return v;
  if (typeof v === 'number') {
    const t = Math.trunc(v);
    if (Number.isSafeInteger(t)) return t === 0 ? 0 : t;
    if (Number.isFinite(t) && t >= -9223372036854775808 && t < 9223372036854775808) return normalizeInt(BigInt(t));
    throw new SmaltError('SMALT_RANGE', `${v} does not fit in an integer`);
  }
  if (typeof v === 'string' && INTEGER_TEXT.test(v)) {
    const n = BigInt(v.trim());
    if (n >= I64_MIN && n <= I64_MAX) return normalizeInt(n);
    throw new SmaltError('SMALT_RANGE', `${v.trim()} does not fit in an integer`);
  }
  throw new SmaltError('SMALT_MISMATCH', typeof v === 'string' ? `cannot convert text ${JSON.stringify(v)} to an integer` : 'cannot convert a blob to an integer');
}

/** `cast_real_strict`: a real, or an error for text that is not a number in full, and for blobs. */
export function castToRealStrict(v: SqlValue): number | null {
  if (v === null || typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string' && NUMBER_TEXT.test(v)) return Number(v.trim());
  throw new SmaltError('SMALT_MISMATCH', typeof v === 'string' ? `cannot convert text ${JSON.stringify(v)} to a real` : 'cannot convert a blob to a real');
}

// ------------------------------------------------------------------ bit operators

/** Bit operators by name. */
export const BITWISE_FUNCTIONS: Readonly<Record<string, string>> = { '&': 'sql.bitand', '|': 'sql.bitor', '<<': 'sql.shl', '>>': 'sql.shr' };

function bitwiseFn(op: string, a: SqlArg, b: SqlArg): Fn {
  const fa = a.fn;
  const fb = b.fn;
  return (r) => {
    const x = fa(r);
    if (x === null) return null;
    const y = fb(r);
    if (y === null) return null;
    const bx = BigInt(castToInteger(x)!);
    let by = BigInt(castToInteger(y)!);
    let res: bigint;
    switch (op) {
      case '&':
        res = bx & by;
        break;
      case '|':
        res = bx | by;
        break;
      default: {
        let left = op === '<<';
        if (by < 0n) {
          left = !left;
          by = -by;
        }
        if (by >= 64n) res = left || bx >= 0n ? 0n : -1n;
        else res = left ? BigInt.asIntN(64, bx << by) : bx >> by;
      }
    }
    return normalizeInt(BigInt.asIntN(64, res));
  };
}

// ------------------------------------------------------------------ LIKE and GLOB

/** SQL LIKE (ASCII case-insensitive) / GLOB (case-sensitive, with [...] classes). */
export function likeMatch(pattern: string, s: string, escape: number, glob: boolean): boolean {
  const p = Array.from(pattern);
  const t = Array.from(s);
  const ANY = glob ? '*' : '%';
  const ONE = glob ? '?' : '_';
  const fold = (c: string): string => (glob ? c : c.length === 1 && c >= 'A' && c <= 'Z' ? c.toLowerCase() : c);
  const esc = escape >= 0 ? String.fromCodePoint(escape) : null;
  // Iterative matcher with single backtrack point for the last wildcard (standard approach).
  let pi = 0;
  let ti = 0;
  let starP = -1;
  let starT = -1;
  while (ti < t.length) {
    if (pi < p.length) {
      const c = p[pi];
      if (esc !== null && c === esc && pi + 1 < p.length) {
        if (fold(p[pi + 1]) === fold(t[ti])) {
          pi += 2;
          ti++;
          continue;
        }
      } else if (c === ANY) {
        starP = pi++;
        starT = ti;
        continue;
      } else if (c === ONE) {
        pi++;
        ti++;
        continue;
      } else if (glob && c === '[') {
        const end = classEnd(p, pi);
        if (end > 0) {
          if (classMatch(p, pi, end, t[ti])) {
            pi = end + 1;
            ti++;
            continue;
          }
        } else if (c === t[ti]) {
          pi++;
          ti++;
          continue;
        }
      } else if (fold(c) === fold(t[ti])) {
        pi++;
        ti++;
        continue;
      }
    }
    if (starP >= 0) {
      pi = starP + 1;
      ti = ++starT;
      continue;
    }
    return false;
  }
  while (pi < p.length && p[pi] === ANY) pi++;
  return pi === p.length;
}

function classEnd(p: string[], start: number): number {
  let i = start + 1;
  if (p[i] === '^') i++;
  if (p[i] === ']') i++;
  while (i < p.length && p[i] !== ']') i++;
  return i < p.length ? i : -1;
}

function classMatch(p: string[], start: number, end: number, c: string): boolean {
  let i = start + 1;
  let negate = false;
  if (p[i] === '^') {
    negate = true;
    i++;
  }
  let found = false;
  let first = true;
  while (i < end) {
    if (p[i] === '-' && !first && i + 1 < end) {
      const lo = p[i - 1].codePointAt(0)!;
      const hi = p[i + 1].codePointAt(0)!;
      const x = c.codePointAt(0)!;
      if (x >= lo && x <= hi) found = true;
      i += 2;
    } else {
      if (p[i] === c) found = true;
      i++;
    }
    first = false;
  }
  return found !== negate;
}

function likeFn(glob: boolean, args: SqlArg[], not: boolean): Fn {
  const [x, pat, escape] = args;
  const fx = x.fn;
  const fp = pat.fn;
  const fe = escape?.fn;
  const xr = x.type === 'real';
  const pr = pat.type === 'real';
  const er = escape?.type === 'real';
  return (r) => {
    const v = fx(r);
    const p = fp(r);
    if (v === null || p === null) return null;
    let esc = -1;
    if (fe) {
      const e = fe(r);
      if (e === null) return null;
      const es = toText(e, er)!;
      if (Array.from(es).length !== 1) throw new SmaltError('SMALT_ERROR', 'ESCAPE expression must be a single character');
      esc = es.codePointAt(0)!;
    }
    const m = likeMatch(toText(p, pr)!, toText(v, xr)!, esc, glob);
    return m !== not ? 1 : 0;
  };
}

// ------------------------------------------------------------------ IN over a list

const NO_REGS: SqlValue[] = [];

/**
 * `probe IN (list)`: 1, 0 or NULL. A list of constants becomes a hash set with the probe's affinity and collation
 * applied to the list values up front; otherwise each element is compared with `sql.eq`, whose closures arrive as
 * `args[1..]` (already compiled with their conversions).
 */
function inListFn(args: SqlArg[], options: SqlCompileOptions): Fn {
  const [x, ...list] = args;
  const not = options.negated ?? false;
  const finish = (v: SqlValue): SqlValue => (v === null ? null : not ? (v === 1 ? 0 : 1) : v);
  const fx = x.fn;
  if (list.every((c) => c.constant)) {
    const coll = options.collation ?? Collation.Binary;
    const set = new Set<unknown>();
    let hasNull = false;
    const numAff = options.probeAffinity === 'NUMERIC';
    const textAff = options.probeAffinity === 'TEXT';
    for (const c of list) {
      let v = c.fn(NO_REGS);
      if (v === null) {
        hasNull = true;
        continue;
      }
      if (numAff) v = applyNumericAffinity(v);
      else if (textAff) v = applyTextAffinity(v, c.type === 'real');
      set.add(hashKey(v, coll));
    }
    const listAllNumeric = list.every((c) => c.type === 'int' || c.type === 'real' || c.type === 'null');
    return (r) => {
      const v = fx(r);
      if (v === null) return null;
      // A probe without affinity compared to numeric list values: no conversion (SQLite).
      if (!numAff && !textAff && typeof v === 'string' && listAllNumeric) return finish(hasNull ? null : 0);
      if (set.has(hashKey(v, coll))) return finish(1);
      return finish(hasNull ? null : 0);
    };
  }
  const tests = list.map((c) => c.fn);
  return (r) => {
    let sawNull = false;
    for (const t of tests) {
      const v = t(r);
      if (v === 1) return finish(1);
      if (v === null) sawNull = true;
    }
    return finish(sawNull ? null : 0);
  };
}

// ------------------------------------------------------------------ the registry

/**
 * The engine's operations under their former `sql.*` names (ADR 0016 section 1): each is the same operation as its
 * behaviour name, traits included, so plans that use either mean the same. They stay until smaltql has moved to the
 * behaviour names.
 */
export const SQL_ALIASES: Readonly<Record<string, string>> = {
  'sql.eq': 'cmp_eq',
  'sql.ne': 'cmp_ne',
  'sql.lt': 'cmp_lt',
  'sql.le': 'cmp_le',
  'sql.gt': 'cmp_gt',
  'sql.ge': 'cmp_ge',
  'sql.is': 'cmp_is',
  'sql.is_not': 'cmp_is_not',
  'sql.add': 'add',
  'sql.sub': 'sub',
  'sql.mul': 'mul',
  'sql.div': 'div_trunc',
  'sql.mod': 'mod_trunc',
  'sql.bitand': 'bit_and',
  'sql.bitor': 'bit_or',
  'sql.shl': 'shift_left',
  'sql.shr': 'shift_right',
  'sql.bitnot': 'bit_not',
  'sql.neg': 'neg',
  'sql.not': 'truth_not',
  'sql.concat': 'text_concat',
  'sql.like': 'like',
  'sql.glob': 'glob',
  'sql.in_list': 'in_list',
  'sql.cast_integer': 'cast_integer',
  'sql.cast_real': 'cast_real',
  'sql.cast_text': 'cast_text',
  'sql.cast_blob': 'cast_blob',
  'sql.cast_numeric': 'cast_numeric',
  'sql.affinity_numeric': 'affinity_numeric',
  'sql.affinity_text': 'affinity_text',
  'sql.current_date': 'current_date',
  'sql.current_time': 'current_time',
  'sql.current_timestamp': 'current_timestamp',
};

const fixed = (name: string, arity: SqlFunction['arity'], compile: SqlFunction['compile'], traits?: FnTraits): [string, SqlFunction] => [name, traits ? { name, arity, compile, traits } : { name, arity, compile }];

/** The traits of SQL's comparison operators: all compare in SQLite's value order; IS / IS NOT are not inlined. */
const COMPARISON_TRAITS: Readonly<Record<string, FnTraits>> = {
  '=': { compare: '=', inline: '=' },
  '!=': { compare: '!=', inline: '!=' },
  '<': { compare: '<', inline: '<' },
  '<=': { compare: '<=', inline: '<=' },
  '>': { compare: '>', inline: '>' },
  '>=': { compare: '>=', inline: '>=' },
  IS: { compare: 'IS' },
  'IS NOT': { compare: 'IS NOT' },
};

const ARITHMETIC_TRAITS: Readonly<Record<string, FnTraits>> = {
  '+': { inline: '+', offset: 1 },
  '-': { inline: '-', offset: -1 },
  '*': { inline: '*' },
  '/': { inline: '/' },
  '%': { inline: '%' },
};

const OPERATIONS: ReadonlyMap<string, SqlFunction> = new Map<string, SqlFunction>([
  ...Object.entries(COMPARISON_FUNCTIONS).map(([op, alias]) => [op, SQL_ALIASES[alias]] as const).map(([op, name]) =>
    fixed(name, 2, (args, o) => ({ fn: comparisonFn(op, args[0], args[1], o.collation ?? Collation.Binary), type: 'int' }), COMPARISON_TRAITS[op]),
  ),
  ...Object.entries(ARITHMETIC_FUNCTIONS).map(([op, alias]) => [op, SQL_ALIASES[alias]] as const).map(([op, name]) => fixed(name, 2, (args) => arithmeticFn(op, args[0], args[1]), ARITHMETIC_TRAITS[op])),
  ...Object.entries(BITWISE_FUNCTIONS).map(([op, alias]) => [op, SQL_ALIASES[alias]] as const).map(([op, name]) => fixed(name, 2, (args) => ({ fn: bitwiseFn(op, args[0], args[1]), type: 'int' }))),
  fixed(
    'neg',
    1,
    ([x]) => {
      const f = x.fn;
      return { fn: (r) => negate(f(r)), type: isNumericType(x.type) ? x.type : 'num' };
    },
    { inline: 'neg', negation: true },
  ),
  fixed('bit_not', 1, ([x]) => {
    const f = x.fn;
    return {
      fn: (r) => {
        const v = f(r);
        if (v === null) return null;
        const n = castToInteger(v)!;
        return normalizeInt(BigInt.asIntN(64, ~BigInt(n)));
      },
      type: 'int',
    };
  }),
  fixed('truth_not', 1, ([x]) => {
    const f = x.fn;
    return {
      fn: (r) => {
        const t = truthy(f(r));
        return t === null ? null : t ? 0 : 1;
      },
      type: 'int',
    };
  }),
  fixed('text_concat', 2, ([a, b]) => {
    const fa = a.fn;
    const fb = b.fn;
    const ra = a.type === 'real';
    const rb = b.type === 'real';
    return {
      fn: (r) => {
        const x = fa(r);
        if (x === null) return null;
        const y = fb(r);
        if (y === null) return null;
        return toText(x, ra)! + toText(y, rb)!;
      },
      type: 'text',
    };
  }),
  fixed('like', [2, 3], (args, o) => ({ fn: likeFn(false, args, o.negated ?? false), type: 'int' }), { pattern: true }),
  fixed('glob', [2, 3], (args, o) => ({ fn: likeFn(true, args, o.negated ?? false), type: 'int' }), { pattern: true }),
  fixed('in_list', [1, -1], (args, o) => ({ fn: inListFn(args, o), type: 'int' }), { inList: true }),
  fixed('add_checked', 2, ([a, b]) => checkedArithmeticFn('+', 'add_checked', a, b)),
  fixed('sub_checked', 2, ([a, b]) => checkedArithmeticFn('-', 'sub_checked', a, b)),
  fixed('mul_checked', 2, ([a, b]) => checkedArithmeticFn('*', 'mul_checked', a, b)),
  fixed('cast_integer_strict', 1, ([x]) => {
    const f = x.fn;
    return { fn: (r) => castToIntegerStrict(f(r)), type: 'int' };
  }),
  fixed('cast_real_strict', 1, ([x]) => {
    const f = x.fn;
    return { fn: (r) => castToRealStrict(f(r)), type: 'real' };
  }),
  fixed('cast_integer', 1, ([x]) => {
    const f = x.fn;
    return { fn: (r) => castToInteger(f(r)), type: 'int' };
  }),
  fixed('cast_real', 1, ([x]) => {
    const f = x.fn;
    return { fn: (r) => castToReal(f(r)), type: 'real' };
  }),
  fixed('cast_text', 1, ([x]) => {
    const f = x.fn;
    const xr = x.type === 'real';
    return { fn: (r) => toText(f(r), xr), type: 'text' };
  }),
  fixed('cast_blob', 1, ([x]) => {
    const f = x.fn;
    const xr = x.type === 'real';
    return { fn: (r) => toBlob(f(r), xr), type: 'blob' };
  }),
  fixed('cast_numeric', 1, ([x]) => {
    const f = x.fn;
    return { fn: (r) => castToNumeric(f(r)), type: 'num' };
  }),
  // The affinity conversions SQLite applies to a comparison operand (§4.2), as values in their own right.
  fixed(
    'affinity_numeric',
    1,
    ([x]) => {
      const f = x.fn;
      return { fn: (r) => applyNumericAffinity(f(r)), type: x.type };
    },
    { comparisonConversion: true },
  ),
  fixed(
    'affinity_text',
    1,
    ([x]) => {
      const f = x.fn;
      const real = x.type === 'real';
      return { fn: (r) => applyTextAffinity(f(r), real), type: x.type };
    },
    { comparisonConversion: true },
  ),
]);

/** Operations the expression compiler builds itself rather than from the registry (they read the statement's clock). */
const COMPILED_OPERATIONS = new Set(['current_date', 'current_time', 'current_timestamp']);

/**
 * The engine's own operations (ADR 0016 section 1), by behaviour name and by their former `sql.*` names: arithmetic,
 * comparisons, conversions and the other operations languages build plans from, besides the named scalar functions.
 */
export const SQL_FUNCTIONS: ReadonlyMap<string, SqlFunction> = new Map<string, SqlFunction>([
  ...OPERATIONS,
  ...Object.entries(SQL_ALIASES).flatMap(([alias, name]) => (OPERATIONS.has(name) ? [[alias, OPERATIONS.get(name)!] as const] : [])),
]);

/** An operation's behaviour name: a former `sql.*` name resolved, any other name as it is. */
export const canonicalName = (fn: string): string => SQL_ALIASES[fn] ?? fn;

/** True for one of the engine's own operations (not a named scalar function), under either of its names. */
export const isEngineOperation = (fn: string): boolean => SQL_FUNCTIONS.has(fn) || COMPILED_OPERATIONS.has(canonicalName(fn));

/** The named function `name`; throws for a name the registry doesn't have (a bug in a front end). */
export function sqlFunction(name: string): SqlFunction {
  const f = SQL_FUNCTIONS.get(name);
  if (f === undefined) throw new SmaltError('SMALT_INTERNAL', `no SQL function ${name}`);
  return f;
}
