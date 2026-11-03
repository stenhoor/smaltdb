import { SmaltError } from '../errors.js';
import { formatReal } from '../catalog/schema.js';
import { Collation, type SqlValue, compareValues, normalizeInt } from '../values.js';
import {
  type StaticType,
  asciiLower,
  asciiUpper,
  castToInteger,
  isIntValue,
  toBlob,
  toNumeric,
  toText,
  truthy,
} from './convert.js';
import { sqlPrintf, valueInt64 } from './printf.js';
import { STAT_AGGREGATES } from './stat-aggregates.js';
import { dateFn, datetimeFn, juliandayFn, strftimeFn, timeFn, timediffFn, unixepochFn } from './datetime.js';
import { MATH_FUNCTIONS, ROUNDING, logScalar, mathScalar, roundingScalar } from './math.js';

/**
 * The package version, replaced at build time from package.json (esbuild `define` in
 * scripts/build.mjs, and in vitest.config.ts for tests), so it cannot drift from the package.
 * Bundles made without the define (benchmarks, sqllogictest) report 'unknown'.
 */
declare const __SMALTDB_VERSION__: string | undefined;
const SMALTDB_VERSION: string = typeof __SMALTDB_VERSION__ === 'string' ? __SMALTDB_VERSION__ : 'unknown';

/** A compiled expression: reads the register file and returns a value. */
export type Fn = (r: SqlValue[]) => SqlValue;

export interface CompiledArg {
  fn: Fn;
  type: StaticType;
  collation: Collation;
}

/** Engine state visible to functions such as last_insert_rowid(). */
export interface FunctionContext {
  lastInsertRowid(): number | bigint;
  changes(): number;
  totalChanges(): number;
  /** Current time in Unix milliseconds; the same value for every call within one statement execution. */
  now(): number;
  /** Set while evaluating an index expression or CHECK constraint (see DateTimeContext.pureContext). */
  pureContext?: string;
}

/** `base` for evaluating an index expression or CHECK constraint (`where`: 'an index', 'a CHECK constraint'). */
export function pureFunctionContext(base: FunctionContext, where: string): FunctionContext {
  return {
    lastInsertRowid: () => base.lastInsertRowid(),
    changes: () => base.changes(),
    totalChanges: () => base.totalChanges(),
    now: () => base.now(),
    pureContext: where,
  };
}

export interface ScalarFunction {
  minArgs: number;
  /** -1 = variadic */
  maxArgs: number;
  /** False for random() etc. (never constant-folded). */
  deterministic: boolean;
  /**
   * The date and time functions: not constant-folded, but allowed in index expressions and CHECK
   * constraints, where they fail at run time if they read the clock or time zone (SQLite).
   */
  pureDate?: boolean;
  compile(args: CompiledArg[], ctx: FunctionContext): { fn: Fn; type: StaticType };
  /**
   * The result type for these argument types, the same as `compile` gives, without compiling (binding types an
   * expression before it is compiled). Absent: the binder compiles once to find out.
   */
  resultType?(args: readonly Pick<CompiledArg, 'type' | 'collation'>[]): StaticType;
}

export interface AggregateState {
  step(args: SqlValue[]): void;
  /** Single-argument step (used by generated code; same semantics as step([v])). */
  step1?(v: SqlValue): void;
  /** Two-argument step (used by generated code; same semantics as step([a, b])). */
  step2?(a: SqlValue, b: SqlValue): void;
  /**
   * Undo a step with these arguments (SQLite's xInverse): window frames that slide add the rows entering the frame
   * and remove the rows leaving it, instead of recomputing every frame. Absent: frames are recomputed. Returns false
   * when the state can no longer be trusted to full precision (rounding left by values that have left); the caller
   * then rebuilds it from the rows of the current frame.
   */
  inverse?(args: SqlValue[]): boolean;
  /** May be called more than once (window frames read the running result after each step). */
  final(): SqlValue;
}

export interface AggregateFunction {
  minArgs: number;
  maxArgs: number;
  resultType(argTypes: StaticType[]): StaticType;
  create(argTypes: StaticType[], collation: Collation): AggregateState;
}

const isRealType = (t: StaticType | undefined): boolean => t === 'real';

// ------------------------------------------------------------------ helpers

function simple(
  min: number,
  max: number,
  type: StaticType | ((args: CompiledArg[]) => StaticType),
  impl: (vals: SqlValue[], args: CompiledArg[], ctx: FunctionContext) => SqlValue,
  deterministic = true,
): ScalarFunction {
  return {
    minArgs: min,
    maxArgs: max,
    deterministic,
    resultType: typeof type === 'function' ? (args) => type(args as CompiledArg[]) : () => type,
    compile(args, ctx) {
      const t = typeof type === 'function' ? type(args) : type;
      const n = args.length;
      if (n === 1) {
        const a0 = args[0].fn;
        const buf: SqlValue[] = [null];
        return { type: t, fn: (r) => ((buf[0] = a0(r)), impl(buf, args, ctx)) };
      }
      if (n === 2) {
        const a0 = args[0].fn;
        const a1 = args[1].fn;
        const buf: SqlValue[] = [null, null];
        return { type: t, fn: (r) => ((buf[0] = a0(r)), (buf[1] = a1(r)), impl(buf, args, ctx)) };
      }
      const fns = args.map((a) => a.fn);
      const buf: SqlValue[] = new Array(n).fill(null);
      return {
        type: t,
        fn: (r) => {
          for (let i = 0; i < n; i++) buf[i] = fns[i](r);
          return impl(buf, args, ctx);
        },
      };
    },
  };
}

/** A date/time function: never constant-folded, but allowed in indexes and CHECK constraints. */
function dateFunction(min: number, max: number, type: StaticType, impl: (vals: SqlValue[], args: CompiledArg[], ctx: FunctionContext) => SqlValue): ScalarFunction {
  return { ...simple(min, max, type, impl, false), pureDate: true };
}

/** Count code points (SQLite measures text length in characters, not UTF-16 units). */
function charLength(s: string): number {
  let n = s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      n--;
      i++;
    }
  }
  return n;
}

const SURROGATE = /[\uD800-\uDFFF]/;

/** Text that SQLite's numeric affinity turns into a number (decimal only; surrounding spaces allowed). */
const NUMERIC_TEXT = /^[ \t\n\v\f\r]*[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[ \t\n\v\f\r]*$/;

function toInt(v: SqlValue): number {
  const n = castToInteger(v);
  return n === null ? 0 : Number(n);
}

function substr(x: SqlValue, startV: SqlValue, lenV: SqlValue | undefined, isReal: boolean): SqlValue {
  if (x === null || startV === null || lenV === null) return null;
  let p1 = toInt(startV);
  let p2: number;
  let negP2 = false;
  const isBlob = x instanceof Uint8Array;
  const chars: string | string[] | Uint8Array = isBlob ? (x as Uint8Array) : typeof x === 'string' ? x : toText(x, isReal)!;
  const useArray = !isBlob && SURROGATE.test(chars as string);
  const seq: string | string[] | Uint8Array = useArray ? Array.from(chars as string) : chars;
  const len = seq.length;
  if (lenV !== undefined) {
    p2 = toInt(lenV);
    if (p2 < 0) {
      p2 = -p2;
      negP2 = true;
    }
  } else {
    p2 = Number.MAX_SAFE_INTEGER;
  }
  if (p1 < 0) {
    p1 += len;
    if (p1 < 0) {
      p2 += p1;
      if (p2 < 0) p2 = 0;
      p1 = 0;
    }
  } else if (p1 > 0) {
    p1--;
  } else if (p2 > 0) {
    p2--;
  }
  if (negP2) {
    p1 -= p2;
    if (p1 < 0) {
      p2 += p1;
      p1 = 0;
    }
  }
  const end = Math.min(len, p1 + p2);
  if (p1 >= end) return isBlob ? new Uint8Array(0) : '';
  if (isBlob) return (seq as Uint8Array).slice(p1, end);
  if (useArray) return (seq as string[]).slice(p1, end).join('');
  return (seq as string).slice(p1, end);
}

function trimImpl(mode: 0 | 1 | 2) {
  return (v: SqlValue[], args: CompiledArg[]): SqlValue => {
    const x = v[0];
    if (x === null) return null;
    const s = toText(x, isRealType(args[0].type))!;
    const set = v.length > 1 ? v[1] : ' ';
    if (set === null) return null;
    const chars = new Set(Array.from(toText(set, isRealType(args[1]?.type))!));
    const arr = Array.from(s);
    let a = 0;
    let b = arr.length;
    if (mode !== 2) while (a < b && chars.has(arr[a])) a++;
    if (mode !== 1) while (b > a && chars.has(arr[b - 1])) b--;
    return arr.slice(a, b).join('');
  };
}

function hex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += (b[i] < 16 ? '0' : '') + b[i].toString(16).toUpperCase();
  return s;
}

function quote(v: SqlValue, isReal: boolean): string {
  if (v === null) return 'NULL';
  if (typeof v === 'string') return "'" + v.replace(/'/g, "''") + "'";
  if (v instanceof Uint8Array) return "X'" + hex(v) + "'";
  // SQLite quotes an infinite REAL as a literal that parses back to it.
  if (v === Infinity) return '9.0e+999';
  if (v === -Infinity) return '-9.0e+999';
  return toText(v, isReal)!;
}

function sqlTypeof(v: SqlValue, t: StaticType): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'number':
      return t === 'real' || !Number.isSafeInteger(v) ? 'real' : 'integer';
    case 'bigint':
      return 'integer';
    case 'string':
      return 'text';
    default:
      return 'blob';
  }
}

function round(x: SqlValue, nV: SqlValue): SqlValue {
  if (x === null) return null;
  const n = nV === undefined ? 0 : Math.max(0, Math.min(30, nV === null ? 0 : toInt(nV)));
  if (nV === null) return null;
  const v = Number(toNumeric(x));
  if (!Number.isFinite(v)) return v;
  if (n === 0) {
    if (Math.abs(v) < 4503599627370496) return v < 0 ? -Math.floor(-v + 0.5) : Math.floor(v + 0.5);
    return v;
  }
  if (Math.abs(v) >= 1e21) return v;
  return Number(v.toFixed(n));
}

function printf(args: SqlValue[], types: CompiledArg[]): SqlValue {
  if (args.length === 0) return null;
  return sqlPrintf(args[0], args, types.map((t) => isRealType(t.type)));
}

function randomInt64(): number | bigint {
  const b = new BigInt64Array(1);
  crypto.getRandomValues(b);
  return normalizeInt(b[0]);
}

const firstArgType = (args: CompiledArg[]): StaticType => args[0]?.type ?? 'any';

/** Result type of coalesce-like functions: common type of arguments, else 'any'. */
function commonType(args: CompiledArg[]): StaticType {
  let t: StaticType | undefined;
  for (const a of args) {
    if (a.type === 'null') continue;
    if (t === undefined) t = a.type;
    else if (t !== a.type) {
      if ((t === 'int' || t === 'real' || t === 'num') && (a.type === 'int' || a.type === 'real' || a.type === 'num')) t = 'num';
      else return 'any';
    }
  }
  return t ?? 'null';
}

// ------------------------------------------------------------------ scalar registry

/**
 * iif(C1, V1 [, C2, V2 ...] [, ELSE]) and its alias if(): the same as
 * CASE WHEN C1 THEN V1 [WHEN C2 THEN V2 ...] [ELSE ELSE] END (SQLite 3.48+).
 */
const IIF: ScalarFunction = {
  minArgs: 2,
  maxArgs: -1,
  deterministic: true,
  compile(args) {
    const n = args.length;
    const conds: Fn[] = [];
    const vals: Fn[] = [];
    for (let i = 0; i + 1 < n; i += 2) {
      conds.push(args[i].fn);
      vals.push(args[i + 1].fn);
    }
    const els = n % 2 === 1 ? args[n - 1].fn : undefined;
    const valueArgs = args.filter((_a, i) => i % 2 === 1 || i === n - 1);
    const type = commonType(els ? valueArgs : [...valueArgs, { fn: () => null, type: 'null', collation: Collation.Binary }]);
    const m = conds.length;
    return {
      type,
      fn: (r) => {
        for (let i = 0; i < m; i++) if (truthy(conds[i](r)) === true) return vals[i](r);
        return els ? els(r) : null;
      },
    };
  },
};

export const scalarFunctions = new Map<string, ScalarFunction>([
  [
    'abs',
    simple(1, 1, firstArgType, ([x]) => {
      if (x === null) return null;
      if (typeof x === 'number') return Math.abs(x);
      if (typeof x === 'bigint') {
        if (x === -(2n ** 63n)) throw new SmaltError('SMALT_ERROR', 'integer overflow');
        return x < 0n ? normalizeInt(-x) : x;
      }
      const n = toNumeric(x)!;
      return typeof n === 'bigint' ? (n < 0n ? -n : n) : Math.abs(n);
    }),
  ],
  [
    'coalesce',
    {
      minArgs: 2,
      maxArgs: -1,
      deterministic: true,
      compile(args) {
        const fns = args.map((a) => a.fn);
        return {
          type: commonType(args),
          fn: (r) => {
            for (let i = 0; i < fns.length; i++) {
              const v = fns[i](r);
              if (v !== null) return v;
            }
            return null;
          },
        };
      },
    },
  ],
  [
    'ifnull',
    {
      minArgs: 2,
      maxArgs: 2,
      deterministic: true,
      compile([a, b]) {
        const fa = a.fn;
        const fb = b.fn;
        return { type: commonType([a, b]), fn: (r) => fa(r) ?? fb(r) };
      },
    },
  ],
  ['iif', IIF],
  ['if', IIF],
  ['nullif', simple(2, 2, firstArgType, ([a, b], args) => (a !== null && b !== null && compareValues(a, b, args[0].collation) === 0 ? null : a))],
  [
    'length',
    simple(1, 1, 'int', ([x], args) => {
      if (x === null) return null;
      if (typeof x === 'string') return charLength(x);
      if (x instanceof Uint8Array) return x.length;
      return toText(x, isRealType(args[0].type))!.length;
    }),
  ],
  [
    'octet_length',
    simple(1, 1, 'int', ([x], args) => {
      if (x === null) return null;
      if (x instanceof Uint8Array) return x.length;
      return new TextEncoder().encode(toText(x, isRealType(args[0].type))!).length;
    }),
  ],
  ['lower', simple(1, 1, 'text', ([x], args) => (x === null ? null : asciiLower(toText(x, isRealType(args[0].type))!)))],
  ['upper', simple(1, 1, 'text', ([x], args) => (x === null ? null : asciiUpper(toText(x, isRealType(args[0].type))!)))],
  ['substr', simple(2, 3, (a) => (a[0].type === 'blob' ? 'blob' : 'text'), (v, args) => substr(v[0], v[1], v.length > 2 ? v[2] : undefined, isRealType(args[0].type)))],
  ['substring', simple(2, 3, (a) => (a[0].type === 'blob' ? 'blob' : 'text'), (v, args) => substr(v[0], v[1], v.length > 2 ? v[2] : undefined, isRealType(args[0].type)))],
  ['trim', simple(1, 2, 'text', trimImpl(0))],
  ['ltrim', simple(1, 2, 'text', trimImpl(1))],
  ['rtrim', simple(1, 2, 'text', trimImpl(2))],
  [
    'replace',
    simple(3, 3, 'text', ([x, y, z], args) => {
      if (x === null || y === null || z === null) return null;
      const s = toText(x, isRealType(args[0].type))!;
      const find = toText(y, isRealType(args[1].type))!;
      if (find === '') return s;
      return s.split(find).join(toText(z, isRealType(args[2].type))!);
    }),
  ],
  [
    'instr',
    simple(2, 2, 'int', ([x, y], args) => {
      if (x === null || y === null) return null;
      const xr = isRealType(args[0].type);
      const yr = isRealType(args[1].type);
      if (x instanceof Uint8Array || y instanceof Uint8Array) {
        const a = toBlob(x, xr)!;
        const b = toBlob(y, yr)!;
        outer: for (let i = 0; i + b.length <= a.length; i++) {
          for (let j = 0; j < b.length; j++) if (a[i + j] !== b[j]) continue outer;
          return i + 1;
        }
        return 0;
      }
      const s = toText(x, xr)!;
      const i = s.indexOf(toText(y, yr)!);
      return i < 0 ? 0 : charLength(s.slice(0, i)) + 1;
    }),
  ],
  ['round', simple(1, 2, 'real', (v) => round(v[0], v.length > 1 ? v[1] : undefined as unknown as SqlValue))],
  [
    'typeof',
    {
      minArgs: 1,
      maxArgs: 1,
      deterministic: true,
      compile([a]) {
        const f = a.fn;
        const t = a.type;
        return { type: 'text', fn: (r) => sqlTypeof(f(r), t) };
      },
    },
  ],
  [
    'hex',
    simple(1, 1, 'text', ([x], args) => {
      if (x === null) return '';
      return hex(toBlob(x, isRealType(args[0].type))!);
    }),
  ],
  ['quote', simple(1, 1, 'text', ([x], args) => quote(x, isRealType(args[0].type)))],
  [
    'char',
    simple(0, -1, 'text', (v) => {
      // SQLite: each argument as sqlite3_value_int64() (NULL is 0); out of range gives U+FFFD.
      let s = '';
      for (const x of v) {
        const c = valueInt64(x);
        s += String.fromCodePoint(c < 0n || c > 0x10ffffn ? 0xfffd : Number(c));
      }
      return s;
    }),
  ],
  [
    'unicode',
    simple(1, 1, 'int', ([x]) => {
      if (x === null) return null;
      const s = toText(x)!;
      return s.length === 0 ? null : s.codePointAt(0)!;
    }),
  ],
  [
    'min',
    simple(2, -1, commonType, (v, args) => {
      let best: SqlValue = v[0];
      if (best === null) return null;
      for (let i = 1; i < v.length; i++) {
        if (v[i] === null) return null;
        if (compareValues(v[i], best, args[0].collation) < 0) best = v[i];
      }
      return best;
    }),
  ],
  [
    'max',
    simple(2, -1, commonType, (v, args) => {
      let best: SqlValue = v[0];
      if (best === null) return null;
      for (let i = 1; i < v.length; i++) {
        if (v[i] === null) return null;
        if (compareValues(v[i], best, args[0].collation) > 0) best = v[i];
      }
      return best;
    }),
  ],
  ['random', simple(0, 0, 'int', () => randomInt64(), false)],
  [
    'randomblob',
    simple(1, 1, 'blob', ([n]) => {
      const b = new Uint8Array(Math.max(1, toInt(n)));
      crypto.getRandomValues(b);
      return b;
    }, false),
  ],
  ['zeroblob', simple(1, 1, 'blob', ([n]) => new Uint8Array(Math.max(0, toInt(n))))],
  [
    'sign',
    simple(1, 1, 'int', ([x]) => {
      // SQLite: text that is entirely a number (surrounding spaces allowed) counts; blobs and other text give NULL.
      if (x === null || x instanceof Uint8Array) return null;
      if (typeof x === 'string' && !NUMERIC_TEXT.test(x)) return null;
      const n = typeof x === 'string' ? Number(x.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '')) : x;
      return n > 0 ? 1 : n < 0 ? -1 : 0;
    }),
  ],
  ['likely', simple(1, 1, firstArgType, ([x]) => x)],
  ['unlikely', simple(1, 1, firstArgType, ([x]) => x)],
  ['likelihood', simple(2, 2, firstArgType, ([x]) => x)],
  ['printf', simple(0, -1, 'text', printf)],
  ['format', simple(0, -1, 'text', printf)],
  [
    'concat',
    simple(1, -1, 'text', (v, args) => {
      let s = '';
      for (let i = 0; i < v.length; i++) if (v[i] !== null) s += toText(v[i], isRealType(args[i].type));
      return s;
    }),
  ],
  [
    'concat_ws',
    simple(2, -1, 'text', (v, args) => {
      if (v[0] === null) return null;
      const sep = toText(v[0], isRealType(args[0].type))!;
      const parts: string[] = [];
      for (let i = 1; i < v.length; i++) if (v[i] !== null) parts.push(toText(v[i], isRealType(args[i].type))!);
      return parts.join(sep);
    }),
  ],
  ['last_insert_rowid', simple(0, 0, 'int', (_v, _a, ctx) => ctx.lastInsertRowid(), false)],
  ['changes', simple(0, 0, 'int', (_v, _a, ctx) => ctx.changes(), false)],
  ['total_changes', simple(0, 0, 'int', (_v, _a, ctx) => ctx.totalChanges(), false)],
  ['smaltdb_version', simple(0, 0, 'text', () => SMALTDB_VERSION)],
  // Date and time (datetime.ts). Not constant-folded: 'now' and 'localtime' depend on when they run.
  ['date', dateFunction(0, -1, 'text', (v, _a, ctx) => dateFn(v, ctx))],
  ['time', dateFunction(0, -1, 'text', (v, _a, ctx) => timeFn(v, ctx))],
  ['datetime', dateFunction(0, -1, 'text', (v, _a, ctx) => datetimeFn(v, ctx))],
  ['julianday', dateFunction(0, -1, 'real', (v, _a, ctx) => juliandayFn(v, ctx))],
  ['unixepoch', dateFunction(0, -1, 'num', (v, _a, ctx) => unixepochFn(v, ctx))],
  ['strftime', dateFunction(0, -1, 'text', (v, _a, ctx) => strftimeFn(v, ctx))],
  ['timediff', dateFunction(2, 2, 'text', (v, _a, ctx) => timediffFn(v, ctx))],
]);

// The math functions (math.ts): acos … trunc, as SQLite builds them with SQLITE_ENABLE_MATH_FUNCTIONS.
for (const [name, m] of MATH_FUNCTIONS) scalarFunctions.set(name, mathScalar(m));
scalarFunctions.set('log', logScalar);
for (const [name, g] of ROUNDING) scalarFunctions.set(name, roundingScalar(g));

// ------------------------------------------------------------------ aggregates

/** Neumaier-compensated sum with exact integer accumulation (SQLite 3.43+ semantics). */
class SumState implements AggregateState {
  private intSum: number | bigint = 0;
  private isInt = true;
  private real = 0;
  private comp = 0;
  private count = 0;
  constructor(
    private readonly mode: 'sum' | 'total' | 'avg',
    private readonly argReal: boolean,
  ) {}

  step(args: SqlValue[]): void {
    this.step1(args[0]);
  }

  step1(arg: SqlValue): void {
    let v = arg;
    if (v === null) return;
    if (typeof v === 'string' || v instanceof Uint8Array) v = toNumeric(v)!;
    this.count++;
    if (this.isInt && !this.argReal && isIntValue(v)) {
      const s = this.intSum;
      if (typeof s === 'number' && typeof v === 'number') {
        const r = s + v;
        if (Number.isSafeInteger(r)) {
          this.intSum = r;
          return;
        }
      }
      const big = BigInt(s) + BigInt(v as number | bigint);
      if (big > 2n ** 63n - 1n || big < -(2n ** 63n)) {
        if (this.mode === 'sum') throw new SmaltError('SMALT_ERROR', 'integer overflow');
        this.switchToReal();
        this.addReal(Number(v));
        return;
      }
      this.intSum = normalizeInt(big);
      return;
    }
    if (this.isInt) this.switchToReal();
    this.addReal(Number(v));
  }

  /** Rows removed (sliding window frames) since the state was created, and the largest |value| removed. */
  private removed = 0;
  private removedMax = 0;

  /**
   * Undo a step (sliding window frames), as SQLite's sumInverse does: once a REAL has been added the sum stays REAL.
   * Integer sums subtract exactly; REAL sums keep the compensated (Neumaier) sum, whose error grows only with the
   * square of epsilon per update, and ask for a rebuild when even that could show next to the result. An integer
   * sum that would overflow asks for a rebuild too, rather than failing on an intermediate value.
   */
  inverse(args: SqlValue[]): boolean {
    let v = args[0];
    if (v === null) return true;
    if (typeof v === 'string' || v instanceof Uint8Array) v = toNumeric(v)!;
    this.count--;
    if (this.isInt) {
      const s = this.intSum;
      if (typeof s === 'number' && typeof v === 'number') {
        const r = s - v;
        if (Number.isSafeInteger(r)) {
          this.intSum = r;
          return true;
        }
      }
      const big = BigInt(s) - BigInt(v as number | bigint);
      if (big > 2n ** 63n - 1n || big < -(2n ** 63n)) return false;
      this.intSum = normalizeInt(big);
      return true;
    }
    const x = Number(v);
    this.addReal(-x);
    this.removed++;
    const ax = Math.abs(x);
    if (ax > this.removedMax) this.removedMax = ax;
    return Math.abs(this.real + this.comp) >= 1e9 * this.removed * Number.EPSILON * Number.EPSILON * this.removedMax;
  }

  private switchToReal(): void {
    this.isInt = false;
    this.real = 0;
    this.comp = 0;
    this.addReal(Number(this.intSum));
  }

  private addReal(x: number): void {
    const t = this.real + x;
    if (Math.abs(this.real) >= Math.abs(x)) this.comp += this.real - t + x;
    else this.comp += x - t + this.real;
    this.real = t;
  }

  /**
   * The REAL sum. An infinite term makes the compensation NaN or infinite, and SQLite then leaves it out; a NaN sum
   * (Inf + -Inf) is NULL, as SQLite stores every NaN result.
   */
  private realSum(): number | null {
    const r = Number.isFinite(this.comp) ? this.real + this.comp : this.real;
    return Number.isNaN(r) ? null : r;
  }

  final(): SqlValue {
    if (this.mode === 'total') return this.isInt ? Number(this.intSum) : this.realSum();
    if (this.count === 0) return null;
    if (this.mode === 'avg') {
      if (this.isInt) return Number(this.intSum) / this.count;
      const r = this.realSum();
      return r === null ? null : r / this.count;
    }
    return this.isInt ? this.intSum : this.realSum();
  }
}

class CountState implements AggregateState {
  n = 0;
  constructor(private readonly star: boolean) {}
  step(args: SqlValue[]): void {
    if (this.star || args[0] !== null) this.n++;
  }
  inverse(args: SqlValue[]): boolean {
    if (this.star || args[0] !== null) this.n--;
    return true;
  }
  final(): SqlValue {
    return this.n;
  }
}

class MinMaxState implements AggregateState {
  private best: SqlValue = null;
  /** Set when the last step() changed the result (used for bare columns in min/max queries). */
  changed = false;
  constructor(
    private readonly sign: 1 | -1,
    private readonly collation: Collation,
  ) {}
  step(args: SqlValue[]): void {
    this.step1(args[0]);
  }

  step1(v: SqlValue): void {
    this.changed = false;
    if (v === null) return;
    if (this.best === null || this.sign * compareValues(v, this.best, this.collation) < 0) {
      this.best = v;
      this.changed = true;
    }
  }
  final(): SqlValue {
    return this.best;
  }
}

class GroupConcatState implements AggregateState {
  private parts: string[] | null = null;
  private seps: string[] = [];
  constructor(
    private readonly argReal: boolean,
    private readonly hasSep: boolean,
    private readonly sepReal = false,
  ) {}
  step(args: SqlValue[]): void {
    const v = args[0];
    if (v === null) return;
    if (this.parts === null) this.parts = [];
    else this.seps.push(this.hasSep ? (args[1] === null ? '' : toText(args[1], this.sepReal)!) : ',');
    this.parts.push(toText(v, this.argReal)!);
  }
  final(): SqlValue {
    if (this.parts === null) return null;
    let s = this.parts[0];
    for (let i = 1; i < this.parts.length; i++) s += this.seps[i - 1] + this.parts[i];
    return s;
  }
}

export { MinMaxState };

export const aggregateFunctions = new Map<string, AggregateFunction>([
  ['count', { minArgs: 0, maxArgs: 1, resultType: () => 'int', create: (t) => new CountState(t.length === 0) }],
  [
    'sum',
    {
      minArgs: 1,
      maxArgs: 1,
      resultType: (t) => (t[0] === 'int' ? 'int' : t[0] === 'real' ? 'real' : 'num'),
      create: (t) => new SumState('sum', t[0] === 'real'),
    },
  ],
  ['total', { minArgs: 1, maxArgs: 1, resultType: () => 'real', create: (t) => new SumState('total', t[0] === 'real') }],
  ['avg', { minArgs: 1, maxArgs: 1, resultType: () => 'real', create: (t) => new SumState('avg', t[0] === 'real') }],
  ['min', { minArgs: 1, maxArgs: 1, resultType: (t) => t[0], create: (_t, c) => new MinMaxState(1, c) }],
  ['max', { minArgs: 1, maxArgs: 1, resultType: (t) => t[0], create: (_t, c) => new MinMaxState(-1, c) }],
  ['group_concat', { minArgs: 1, maxArgs: 2, resultType: () => 'text', create: (t) => new GroupConcatState(t[0] === 'real', t.length > 1, t[1] === 'real') }],
  ['string_agg', { minArgs: 2, maxArgs: 2, resultType: () => 'text', create: (t) => new GroupConcatState(t[0] === 'real', true, t[1] === 'real') }],
]);
// Statistics (stat-aggregates.ts): variance, standard deviation, covariance, correlation, skewness, kurtosis, and
// SQLite's median and percentile functions.
for (const [name, agg] of STAT_AGGREGATES) aggregateFunctions.set(name, agg);

/** Format helper re-exported for EXPLAIN and tests. */
export { formatReal };
