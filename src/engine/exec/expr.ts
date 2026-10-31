import { SmaltError } from '../errors.js';
import { storageTypeFor } from '../catalog/schema.js';
import type { CallExpr, ColumnExpr, Expr, SelectStmt } from '../sql/ast.js';
import { Collation, type SqlValue, collationByName, compareValues, normalizeInt } from '../values.js';
import {
  type Affinity,
  type StaticType,
  affinityOfStorage,
  applyNumericAffinity,
  applyTextAffinity,
  castToInteger,
  castToNumeric,
  castToReal,
  hashKey,
  isIntValue,
  realToInt,
  staticTypeOfStorage,
  toBlob,
  toNumeric,
  toText,
  truthy,
} from './convert.js';
import { type CompiledArg, type Fn, type FunctionContext, aggregateFunctions, scalarFunctions } from './functions.js';

export type { Fn };

/** Where a compiled expression's collation came from (SQLite precedence: explicit > column > none). */
export const enum CollSrc {
  None = 0,
  Column = 1,
  Explicit = 2,
}

export interface Compiled {
  fn: Fn;
  type: StaticType;
  collation: Collation;
  collSrc: CollSrc;
  affinity: Affinity;
  /** Value does not depend on registers (literal or folded). */
  constant: boolean;
}

export interface ColumnBinding {
  reg: number;
  type: StaticType;
  collation: Collation;
  affinity: Affinity;
  /** The name resolved to a select-list alias: use this compiled expression instead of a register. */
  compiled?: Compiled;
}

/** Name resolution and planner callbacks used while compiling expressions. */
export interface CompileScope {
  resolveColumn(e: ColumnExpr): ColumnBinding;
  /** Post-aggregation context: maps an aggregate call (or GROUP BY expression) to its register. */
  aggregateRef?(call: CallExpr): ColumnBinding;
  groupRef?(e: Expr): ColumnBinding | undefined;
  scalarSubquery(select: SelectStmt): Compiled;
  existsSubquery(select: SelectStmt): Fn;
  /** Returns membership test: 1, 0, or NULL (SQL IN semantics) for a probe value. */
  inSubquery(select: SelectStmt, probe: Compiled): Fn;
  funcCtx: FunctionContext;
}

const NO_REGS: SqlValue[] = [];
const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

function konst(v: SqlValue, type: StaticType, affinity: Affinity = 'NONE'): Compiled {
  return { fn: () => v, type, collation: Collation.Binary, collSrc: CollSrc.None, affinity, constant: true };
}

function literalType(v: SqlValue, isReal: boolean | undefined): StaticType {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'number':
      return isReal || !Number.isInteger(v) ? 'real' : 'int';
    case 'bigint':
      return 'int';
    case 'string':
      return 'text';
    default:
      return 'blob';
  }
}

/** Fold a node whose inputs are all constant (and deterministic). */
function fold(c: Compiled): Compiled {
  if (!c.constant) return c;
  const v = c.fn(NO_REGS);
  return { ...c, fn: () => v };
}

function isNumericType(t: StaticType): boolean {
  return t === 'int' || t === 'real' || t === 'num';
}

export function compileExpr(e: Expr, scope: CompileScope): Compiled {
  if (scope.groupRef) {
    const g = scope.groupRef(e);
    if (g) return { fn: regReader(g.reg), type: g.type, collation: g.collation, collSrc: g.collation ? CollSrc.Column : CollSrc.None, affinity: g.affinity, constant: false };
  }
  switch (e.kind) {
    case 'literal':
      return konst(e.value, literalType(e.value, e.isReal));
    case 'param': {
      const reg = e.index - 1;
      return { fn: (r) => r[reg], type: 'any', collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE', constant: false };
    }
    case 'column': {
      const b = scope.resolveColumn(e);
      if (b.compiled) return b.compiled;
      return {
        fn: regReader(b.reg),
        type: b.type,
        collation: b.collation,
        collSrc: CollSrc.Column,
        affinity: b.affinity,
        constant: false,
      };
    }
    case 'collate': {
      const inner = compileExpr(e.expr, scope);
      const c = collationByName(e.collation);
      if (c === undefined) throw new SmaltError('SMALT_ERROR', `no such collation sequence: ${e.collation}`);
      return { ...inner, collation: c, collSrc: CollSrc.Explicit };
    }
    case 'unary':
      return compileUnary(e.op, compileExpr(e.operand, scope));
    case 'binary':
      return compileBinary(e.op, e.left, e.right, scope);
    case 'between': {
      const x = compileExpr(e.expr, scope);
      const lo = compileExpr(e.low, scope);
      const hi = compileExpr(e.high, scope);
      const ge = comparison('>=', x, lo);
      const le = comparison('<=', x, hi);
      const both = and(ge, le);
      return e.not ? compileUnary('NOT', both) : both;
    }
    case 'isNull': {
      const x = compileExpr(e.expr, scope);
      const f = x.fn;
      const not = e.not;
      return fold({ fn: (r) => ((f(r) === null) !== not ? 1 : 0), type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: x.constant });
    }
    case 'inList':
      return compileInList(e.not, compileExpr(e.expr, scope), e.list.map((x) => compileExpr(x, scope)));
    case 'inSelect': {
      const probe = compileExpr(e.expr, scope);
      const test = scope.inSubquery(e.select, probe);
      const fn: Fn = e.not
        ? (r) => {
            const v = test(r);
            return v === null ? null : v === 1 ? 0 : 1;
          }
        : test;
      return { fn, type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: false };
    }
    case 'exists': {
      const f = scope.existsSubquery(e.select);
      const fn: Fn = e.not ? (r) => (f(r) === 1 ? 0 : 1) : f;
      return { fn, type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: false };
    }
    case 'subquery':
      return scope.scalarSubquery(e.select);
    case 'like':
      return compileLike(e.op, e.not, compileExpr(e.expr, scope), compileExpr(e.pattern, scope), e.escape ? compileExpr(e.escape, scope) : undefined);
    case 'case':
      return compileCase(e, scope);
    case 'cast':
      return compileCast(compileExpr(e.expr, scope), e.type);
    case 'call':
      return compileCall(e, scope);
  }
}

function regReader(reg: number): Fn {
  return (r) => r[reg];
}

// ------------------------------------------------------------------ unary / logic

function compileUnary(op: string, x: Compiled): Compiled {
  const f = x.fn;
  let out: Compiled;
  switch (op) {
    case 'NOT':
      out = {
        fn: (r) => {
          const t = truthy(f(r));
          return t === null ? null : t ? 0 : 1;
        },
        type: 'int',
        collation: 0,
        collSrc: CollSrc.None,
        affinity: 'NONE',
        constant: x.constant,
      };
      break;
    case '-':
      out = { fn: (r) => negate(f(r)), type: isNumericType(x.type) ? x.type : 'num', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: x.constant };
      break;
    case '+':
      // Unary plus is a no-op that strips affinity and collation (SQLite).
      out = { ...x, affinity: 'NONE', collSrc: CollSrc.None, collation: Collation.Binary };
      break;
    case '~':
      out = {
        fn: (r) => {
          const v = f(r);
          if (v === null) return null;
          const n = castToInteger(v)!;
          return normalizeInt(BigInt.asIntN(64, ~BigInt(n)));
        },
        type: 'int',
        collation: 0,
        collSrc: CollSrc.None,
        affinity: 'NONE',
        constant: x.constant,
      };
      break;
    default:
      throw new SmaltError('SMALT_ERROR', `unknown unary operator ${op}`);
  }
  return fold(out);
}

function negate(v: SqlValue): SqlValue {
  if (v === null) return null;
  if (typeof v === 'number') return v === 0 ? 0 : -v;
  if (typeof v === 'bigint') return v === I64_MIN ? -Number(v) : normalizeInt(-v);
  return negate(toNumeric(v));
}

function and(a: Compiled, b: Compiled): Compiled {
  const fa = a.fn;
  const fb = b.fn;
  return fold({
    fn: (r) => {
      const x = truthy(fa(r));
      if (x === false) return 0;
      const y = truthy(fb(r));
      if (y === false) return 0;
      return x === null || y === null ? null : 1;
    },
    type: 'int',
    collation: 0,
    collSrc: CollSrc.None,
    affinity: 'NONE',
    constant: a.constant && b.constant,
  });
}

function or(a: Compiled, b: Compiled): Compiled {
  const fa = a.fn;
  const fb = b.fn;
  return fold({
    fn: (r) => {
      const x = truthy(fa(r));
      if (x === true) return 1;
      const y = truthy(fb(r));
      if (y === true) return 1;
      return x === null || y === null ? null : 0;
    },
    type: 'int',
    collation: 0,
    collSrc: CollSrc.None,
    affinity: 'NONE',
    constant: a.constant && b.constant,
  });
}

// ------------------------------------------------------------------ binary operators

function compileBinary(op: string, le: Expr, re: Expr, scope: CompileScope): Compiled {
  const a = compileExpr(le, scope);
  const b = compileExpr(re, scope);
  switch (op) {
    case 'AND':
      return and(a, b);
    case 'OR':
      return or(a, b);
    case '=':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=':
    case 'IS':
    case 'IS NOT':
      return comparison(op, a, b);
    case '+':
    case '-':
    case '*':
    case '/':
    case '%':
      return arithmetic(op, a, b);
    case '||': {
      const fa = a.fn;
      const fb = b.fn;
      const ra = a.type === 'real';
      const rb = b.type === 'real';
      return fold({
        fn: (r) => {
          const x = fa(r);
          if (x === null) return null;
          const y = fb(r);
          if (y === null) return null;
          return toText(x, ra)! + toText(y, rb)!;
        },
        type: 'text',
        collation: 0,
        collSrc: CollSrc.None,
        affinity: 'NONE',
        constant: a.constant && b.constant,
      });
    }
    case '&':
    case '|':
    case '<<':
    case '>>':
      return bitwise(op, a, b);
    default:
      throw new SmaltError('SMALT_UNSUPPORTED', `operator ${op} is not supported yet`);
  }
}

/** Collation for a comparison: explicit COLLATE wins, then column collation, left before right. */
export function comparisonCollation(a: Compiled, b: Compiled): Collation {
  if (a.collSrc === CollSrc.Explicit) return a.collation;
  if (b.collSrc === CollSrc.Explicit) return b.collation;
  if (a.collSrc === CollSrc.Column) return a.collation;
  if (b.collSrc === CollSrc.Column) return b.collation;
  return Collation.Binary;
}

function isNumAff(a: Affinity): boolean {
  return a === 'INTEGER' || a === 'REAL' || a === 'NUMERIC';
}

/**
 * Affinity conversions applied before comparing (SQLite §4.2): numeric affinity is applied to the
 * other operand if it has TEXT/BLOB/no affinity; TEXT affinity to an operand with no affinity.
 */
export function comparisonConverters(a: Compiled, b: Compiled): [((v: SqlValue) => SqlValue) | null, ((v: SqlValue) => SqlValue) | null] {
  let ca: ((v: SqlValue) => SqlValue) | null = null;
  let cb: ((v: SqlValue) => SqlValue) | null = null;
  if (isNumAff(a.affinity) && !isNumAff(b.affinity)) cb = applyNumericAffinity;
  else if (isNumAff(b.affinity) && !isNumAff(a.affinity)) ca = applyNumericAffinity;
  else if (a.affinity === 'TEXT' && b.affinity === 'NONE') {
    const real = b.type === 'real';
    cb = (v) => applyTextAffinity(v, real);
  } else if (b.affinity === 'TEXT' && a.affinity === 'NONE') {
    const real = a.type === 'real';
    ca = (v) => applyTextAffinity(v, real);
  }
  return [ca, cb];
}

function comparison(op: string, a: Compiled, b: Compiled): Compiled {
  const fa = a.fn;
  const fb = b.fn;
  const coll = comparisonCollation(a, b);
  const [ca, cb] = comparisonConverters(a, b);
  const constant = a.constant && b.constant;
  const base = { type: 'int' as StaticType, collation: 0 as Collation, collSrc: CollSrc.None, affinity: 'NONE' as Affinity, constant };

  if (op === 'IS' || op === 'IS NOT') {
    const want = op === 'IS' ? 1 : 0;
    return fold({
      ...base,
      fn: (r) => {
        let x = fa(r);
        let y = fb(r);
        if (x === null || y === null) return (x === null && y === null) === (want === 1) ? 1 : 0;
        if (ca) x = ca(x);
        if (cb) y = cb(y);
        return (compareValues(x, y, coll) === 0) === (want === 1) ? 1 : 0;
      },
    });
  }

  // Fast path: both operands statically numeric (no conversions or collation needed).
  if (isNumericType(a.type) && isNumericType(b.type)) {
    let fn: Fn;
    switch (op) {
      case '=':
        fn = (r) => {
          const x = fa(r);
          if (x === null) return null;
          const y = fb(r);
          if (y === null) return null;
          // eslint-disable-next-line eqeqeq
          return (x as number) == (y as number) ? 1 : 0;
        };
        break;
      case '!=':
        fn = (r) => {
          const x = fa(r);
          if (x === null) return null;
          const y = fb(r);
          if (y === null) return null;
          // eslint-disable-next-line eqeqeq
          return (x as number) != (y as number) ? 1 : 0;
        };
        break;
      case '<':
        fn = (r) => {
          const x = fa(r);
          if (x === null) return null;
          const y = fb(r);
          if (y === null) return null;
          return (x as number) < (y as number) ? 1 : 0;
        };
        break;
      case '<=':
        fn = (r) => {
          const x = fa(r);
          if (x === null) return null;
          const y = fb(r);
          if (y === null) return null;
          return (x as number) <= (y as number) ? 1 : 0;
        };
        break;
      case '>':
        fn = (r) => {
          const x = fa(r);
          if (x === null) return null;
          const y = fb(r);
          if (y === null) return null;
          return (x as number) > (y as number) ? 1 : 0;
        };
        break;
      default:
        fn = (r) => {
          const x = fa(r);
          if (x === null) return null;
          const y = fb(r);
          if (y === null) return null;
          return (x as number) >= (y as number) ? 1 : 0;
        };
    }
    return fold({ ...base, fn });
  }

  const test = cmpTest(op);
  return fold({
    ...base,
    fn: (r) => {
      let x = fa(r);
      if (x === null) return null;
      let y = fb(r);
      if (y === null) return null;
      if (ca) x = ca(x);
      if (cb) y = cb(y);
      return test(compareValues(x, y, coll)) ? 1 : 0;
    },
  });
}

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

function arithmetic(op: string, a: Compiled, b: Compiled): Compiled {
  const fa = a.fn;
  const fb = b.fn;
  const real = a.type === 'real' || b.type === 'real';
  const type: StaticType = real ? 'real' : a.type === 'int' && b.type === 'int' ? 'int' : 'num';
  const impl = arithImpl(op, real);
  return fold({
    fn: (r) => {
      const x = fa(r);
      if (x === null) return null;
      const y = fb(r);
      if (y === null) return null;
      return impl(x, y);
    },
    type,
    collation: 0,
    collSrc: CollSrc.None,
    affinity: 'NONE',
    constant: a.constant && b.constant,
  });
}

function num(v: SqlValue): number | bigint {
  return typeof v === 'number' || typeof v === 'bigint' ? v : (toNumeric(v) as number | bigint);
}

function inI64(b: bigint): boolean {
  return b >= I64_MIN && b <= I64_MAX;
}

function realResult(x: number): SqlValue {
  return Number.isNaN(x) ? null : x;
}

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
      default: {
        // SQLite: REAL % casts both operands to INTEGER, result is REAL.
        const ix = realToInt(x);
        let iy = realToInt(y);
        if (iy === 0 || iy === 0n) return null;
        if (iy === -1 || iy === -1n) iy = 1;
        return Number(BigInt(ix) % BigInt(iy));
      }
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
    return realOp(Number(nx), Number(ny));
  };
}

function bitwise(op: string, a: Compiled, b: Compiled): Compiled {
  const fa = a.fn;
  const fb = b.fn;
  return fold({
    fn: (r) => {
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
    },
    type: 'int',
    collation: 0,
    collSrc: CollSrc.None,
    affinity: 'NONE',
    constant: a.constant && b.constant,
  });
}

// ------------------------------------------------------------------ IN, LIKE, CASE, CAST

function compileInList(not: boolean, x: Compiled, list: Compiled[]): Compiled {
  const fx = x.fn;
  const base = { type: 'int' as StaticType, collation: 0 as Collation, collSrc: CollSrc.None, affinity: 'NONE' as Affinity };
  const finish = (v: SqlValue): SqlValue => (v === null ? null : not ? (v === 1 ? 0 : 1) : v);
  if (list.length === 0) return konst(not ? 1 : 0, 'int');
  // All-constant list: hash lookup with the probe's affinity and collation applied up front.
  if (list.every((c) => c.constant)) {
    const coll = x.collSrc !== CollSrc.None ? x.collation : Collation.Binary;
    const set = new Set<unknown>();
    let hasNull = false;
    const numAff = isNumAff(x.affinity);
    const textAff = x.affinity === 'TEXT';
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
    return fold({
      ...base,
      constant: x.constant,
      fn: (r) => {
        let v = fx(r);
        if (v === null) return null;
        // A probe without affinity compared to numeric list values: no conversion (SQLite).
        if (!numAff && !textAff && typeof v === 'string' && listAllNumeric) return finish(hasNull ? null : 0);
        if (set.has(hashKey(v, coll))) return finish(1);
        return finish(hasNull ? null : 0);
      },
    });
  }
  const tests = list.map((c) => comparison('=', x, c).fn);
  return {
    ...base,
    constant: false,
    fn: (r) => {
      let sawNull = false;
      for (const t of tests) {
        const v = t(r);
        if (v === 1) return finish(1);
        if (v === null) sawNull = true;
      }
      return finish(sawNull ? null : 0);
    },
  };
}

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

function compileLike(op: string, not: boolean, x: Compiled, pat: Compiled, escape?: Compiled): Compiled {
  if (op !== 'LIKE' && op !== 'GLOB') throw new SmaltError('SMALT_ERROR', `no such function: ${op.toLowerCase()}`);
  const glob = op === 'GLOB';
  const fx = x.fn;
  const fp = pat.fn;
  const fe = escape?.fn;
  const xr = x.type === 'real';
  return fold({
    fn: (r) => {
      const v = fx(r);
      const p = fp(r);
      if (v === null || p === null) return null;
      let esc = -1;
      if (fe) {
        const e = fe(r);
        if (e === null) return null;
        const es = toText(e)!;
        if (Array.from(es).length !== 1) throw new SmaltError('SMALT_ERROR', 'ESCAPE expression must be a single character');
        esc = es.codePointAt(0)!;
      }
      const m = likeMatch(toText(p)!, toText(v, xr)!, esc, glob);
      return m !== not ? 1 : 0;
    },
    type: 'int',
    collation: 0,
    collSrc: CollSrc.None,
    affinity: 'NONE',
    constant: x.constant && pat.constant && (escape?.constant ?? true),
  });
}

function compileCase(e: Extract<Expr, { kind: 'case' }>, scope: CompileScope): Compiled {
  const base = e.base ? compileExpr(e.base, scope) : undefined;
  const whens = e.whens.map((w) => {
    const when = compileExpr(w.when, scope);
    const test = base ? comparison('=', base, when).fn : when.fn;
    return { test, then: compileExpr(w.then, scope) };
  });
  const els = e.else ? compileExpr(e.else, scope) : konst(null, 'null');
  const thens = whens.map((w) => w.then.fn);
  const tests = whens.map((w) => w.test);
  const elseFn = els.fn;
  const types = [...whens.map((w) => w.then.type), els.type].filter((t) => t !== 'null');
  let type: StaticType = types.length === 0 ? 'null' : types[0];
  for (const t of types) if (t !== type) type = isNumericType(t) && isNumericType(type) ? 'num' : 'any';
  const n = tests.length;
  return fold({
    fn: (r) => {
      for (let i = 0; i < n; i++) {
        const v = tests[i](r);
        if (v !== null && truthy(v)) return thens[i](r);
      }
      return elseFn(r);
    },
    type,
    collation: 0,
    collSrc: CollSrc.None,
    affinity: 'NONE',
    constant: false,
  });
}

function compileCast(x: Compiled, typeName: string): Compiled {
  const st = storageTypeFor(typeName);
  const f = x.fn;
  const xr = x.type === 'real';
  let fn: Fn;
  switch (st) {
    case 'INTEGER':
      fn = (r) => castToInteger(f(r));
      break;
    case 'REAL':
      fn = (r) => castToReal(f(r));
      break;
    case 'TEXT':
      fn = (r) => toText(f(r), xr);
      break;
    case 'BLOB':
      fn = (r) => toBlob(f(r), xr);
      break;
    default:
      fn = (r) => castToNumeric(f(r));
  }
  const affinity = st === 'ANY' ? 'NUMERIC' : affinityOfStorage(st);
  const type = st === 'ANY' || st === 'NUMERIC' ? 'num' : staticTypeOfStorage(st);
  return fold({ fn, type, collation: x.collation, collSrc: x.collSrc, affinity, constant: x.constant });
}

function compileCall(e: CallExpr, scope: CompileScope): Compiled {
  if (e.over !== undefined) throw new SmaltError('SMALT_UNSUPPORTED', 'window functions are not supported yet');
  const name = e.name;
  const isAgg = aggregateFunctions.has(name) && !((name === 'min' || name === 'max') && e.args.length > 1);
  if (isAgg) {
    if (!scope.aggregateRef) throw new SmaltError('SMALT_ERROR', `misuse of aggregate function ${name}()`);
    const b = scope.aggregateRef(e);
    return { fn: regReader(b.reg), type: b.type, collation: b.collation, collSrc: CollSrc.None, affinity: 'NONE', constant: false };
  }
  if (e.distinct || e.star || e.filter) throw new SmaltError('SMALT_ERROR', `DISTINCT/FILTER/* is only valid with aggregate functions`);
  if (name === 'current_time' || name === 'current_date' || name === 'current_timestamp') {
    const now = new Date();
    const iso = now.toISOString();
    const v = name === 'current_date' ? iso.slice(0, 10) : name === 'current_time' ? iso.slice(11, 19) : iso.slice(0, 10) + ' ' + iso.slice(11, 19);
    return { fn: () => v, type: 'text', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: false };
  }
  const def = scalarFunctions.get(name);
  if (!def) throw new SmaltError('SMALT_ERROR', `no such function: ${name}`);
  const n = e.args.length;
  if (n < def.minArgs || (def.maxArgs >= 0 && n > def.maxArgs)) throw new SmaltError('SMALT_ERROR', `wrong number of arguments to function ${name}()`);
  const args = e.args.map((a) => compileExpr(a, scope));
  const compiledArgs: CompiledArg[] = args.map((a) => ({ fn: a.fn, type: a.type, collation: a.collation }));
  const { fn, type } = def.compile(compiledArgs, scope.funcCtx);
  // Collation of a function result: from its first argument when that argument carries one.
  const collSrc = args[0]?.collSrc === CollSrc.Explicit ? CollSrc.Explicit : CollSrc.None;
  return fold({ fn, type, collation: collSrc ? args[0].collation : 0, collSrc, affinity: 'NONE', constant: def.deterministic && args.every((a) => a.constant) });
}

/** Split a predicate into AND-ed conjuncts. */
export function conjuncts(e: Expr | undefined, out: Expr[] = []): Expr[] {
  if (!e) return out;
  if (e.kind === 'binary' && e.op === 'AND') {
    conjuncts(e.left, out);
    conjuncts(e.right, out);
  } else out.push(e);
  return out;
}

/** Evaluate a predicate result as a WHERE condition (NULL and 0 are false). */
export function isTrue(v: SqlValue): boolean {
  if (v === null) return false;
  if (typeof v === 'number') return v !== 0;
  return truthy(v) === true;
}
