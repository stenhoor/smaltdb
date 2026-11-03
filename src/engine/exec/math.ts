/**
 * SQLite's math functions (func.c, built with SQLITE_ENABLE_MATH_FUNCTIONS, as in the official builds):
 * acos … trunc. Each is defined once, as a function of doubles, and used by both the closure compiler
 * (scalarFunctions in functions.ts) and the code generator (codegen.ts), so the two cannot disagree.
 *
 * Semantics, from func.c:
 * - An argument is used when it is numeric after SQLite's numeric affinity (sqlite3_value_numeric_type):
 *   INTEGER, REAL, or text that looks like a number. NULL, other text and blobs give NULL.
 * - The result is a REAL; a NaN result is NULL (sqlite3_result_double). Infinities stay.
 * - ln, log, log10, log2 return NULL for arguments <= 0; log(B, X) also for a base whose log is <= 0
 *   (B <= 1). log(X) is log10(X).
 * - ceil, ceiling, floor and trunc return an INTEGER argument unchanged, and a REAL result otherwise.
 *
 * Results come from JavaScript's Math functions, except tanh and log10 (ports of musl's, below). ECMAScript does
 * not require exact results, so the last bit can differ from SQLite's C library (and between browsers): on V8 it
 * is within one unit in the last place of SQLite's WASM build for every function. sqrt, ceil, floor, trunc, mod,
 * degrees and radians are exact.
 */
import type { SqlValue } from '../values.js';
import { type StaticType, applyNumericAffinity, toNumeric } from './convert.js';
import type { CompiledArg, Fn, ScalarFunction } from './functions.js';

/** A math function of doubles. A NaN result becomes NULL. */
export interface MathFunction {
  /** Number of arguments. */
  arity: 0 | 1 | 2;
  /** The function of doubles. */
  f: (...x: number[]) => number;
  /**
   * The same as a JavaScript expression of `$0`, `$1` (plain doubles), for generated code; absent:
   * generated code calls `f`.
   */
  js?: string;
  /**
   * How arguments are taken. 'numeric' (default): every argument must be numeric (else NULL).
   * 'logBase': log(B, X) checks only B; X is converted like sqlite3_value_double (non-numeric is 0).
   */
  args?: 'numeric' | 'logBase';
}

// ------------------------------------------------------------------ musl ports
//
// V8's Math.tanh and Math.log10 are up to 2 units in the last place away from the correctly rounded result on
// common inputs (e.g. tanh(0.7), log10(0.565)); musl's (which SQLite's WASM build uses) are within one, and agree
// with it to the bit. These are ports of musl 1.2's tanh.c and log10.c (from FreeBSD), on IEEE 754 doubles.

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);
/** Index of the high 32 bits of a double in `u32` (the platform's byte order). */
const HI = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 1 : 0;
const LO = 1 - HI;

/** musl tanh. */
function tanh(x: number): number {
  f64[0] = x;
  const sign = u32[HI] >>> 31;
  u32[HI] &= 0x7fffffff;
  const ax = f64[0];
  const w = u32[HI];
  let t: number;
  if (w > 0x3fe193ea) {
    // |x| > log(3)/2 ~= 0.5493, or NaN
    if (w > 0x40340000) t = 1 - 0 / ax; // |x| > 20, or NaN
    else {
      t = Math.expm1(2 * ax);
      t = 1 - 2 / (t + 2);
    }
  } else if (w > 0x3fd058ae) {
    // |x| > log(5/3)/2 ~= 0.2554
    t = Math.expm1(2 * ax);
    t = t / (t + 2);
  } else if (w >= 0x00100000) {
    t = Math.expm1(-2 * ax);
    t = -t / (t + 2);
  } else t = ax; // subnormal
  return sign ? -t : t;
}

const IVLN10HI = 4.34294481878168880939e-1;
const IVLN10LO = 2.50829467116452752298e-11;
const LOG10_2HI = 3.01029995663611771306e-1;
const LOG10_2LO = 3.69423907715893078616e-13;
const LG1 = 6.666666666666735130e-1;
const LG2 = 3.999999999940941908e-1;
const LG3 = 2.857142874366239149e-1;
const LG4 = 2.222219843214978396e-1;
const LG5 = 1.818357216161805012e-1;
const LG6 = 1.531383769920937332e-1;
const LG7 = 1.479819860511658591e-1;

/** musl log10 (for x > 0; the callers return NULL for x <= 0). */
function log10(x: number): number {
  f64[0] = x;
  let hx = u32[HI];
  let k = 0;
  if (hx < 0x00100000 || hx >>> 31) {
    if (x === 0) return -Infinity;
    if (hx >>> 31) return NaN;
    // subnormal: scale up
    k -= 54;
    x *= 18014398509481984; // 0x1p54
    f64[0] = x;
    hx = u32[HI];
  } else if (hx >= 0x7ff00000) return x;
  else if (hx === 0x3ff00000 && u32[LO] === 0) return 0;
  // reduce x into [sqrt(2)/2, sqrt(2)]
  hx = (hx + (0x3ff00000 - 0x3fe6a09e)) >>> 0;
  k += (hx >>> 20) - 0x3ff;
  hx = ((hx & 0x000fffff) + 0x3fe6a09e) >>> 0;
  u32[HI] = hx;
  x = f64[0];
  const f = x - 1.0;
  const hfsq = 0.5 * f * f;
  const s = f / (2.0 + f);
  const z = s * s;
  let w = z * z;
  const t1 = w * (LG2 + w * (LG4 + w * LG6));
  const t2 = z * (LG1 + w * (LG3 + w * (LG5 + w * LG7)));
  const R = t2 + t1;
  // hi + lo = f - hfsq + s*(hfsq+R) ~ log(1+f), hi with its low 32 bits cleared
  f64[0] = f - hfsq;
  u32[LO] = 0;
  const hi = f64[0];
  const lo = f - hi - hfsq + s * (hfsq + R);
  // val_hi + val_lo ~ log10(1+f) + k*log10(2)
  let valHi = hi * IVLN10HI;
  const dk = k;
  const y = dk * LOG10_2HI;
  let valLo = dk * LOG10_2LO + (lo + hi) * IVLN10LO + lo * IVLN10HI;
  w = y + valHi;
  valLo += y - w + valHi;
  valHi = w;
  return valLo + valHi;
}

/** C's pow, where it differs from Math.pow: pow(±1, ±Infinity) is 1 (ECMAScript gives NaN). */
function cPow(x: number, y: number): number {
  if ((x === 1 || x === -1) && (y === Infinity || y === -Infinity)) return 1;
  return Math.pow(x, y);
}

/** log(B, X) as func.c computes it: ln(X) / ln(B), NULL unless ln(B) > 0 and X > 0. */
function logBase(b: number, x: number): number {
  const lb = Math.log(b);
  if (!(lb > 0) || !(x > 0)) return NaN;
  return Math.log(x) / lb;
}

const DEG_PER_RAD = 180 / Math.PI;
const RAD_PER_DEG = Math.PI / 180;

/** The REAL-valued math functions. ceil, floor and trunc are separate (they keep integers). */
export const MATH_FUNCTIONS: ReadonlyMap<string, MathFunction> = new Map<string, MathFunction>([
  ['acos', { arity: 1, f: Math.acos, js: 'Math.acos($0)' }],
  ['acosh', { arity: 1, f: Math.acosh, js: 'Math.acosh($0)' }],
  ['asin', { arity: 1, f: Math.asin, js: 'Math.asin($0)' }],
  ['asinh', { arity: 1, f: Math.asinh, js: 'Math.asinh($0)' }],
  ['atan', { arity: 1, f: Math.atan, js: 'Math.atan($0)' }],
  ['atanh', { arity: 1, f: Math.atanh, js: 'Math.atanh($0)' }],
  ['cos', { arity: 1, f: Math.cos, js: 'Math.cos($0)' }],
  ['cosh', { arity: 1, f: Math.cosh, js: 'Math.cosh($0)' }],
  ['sin', { arity: 1, f: Math.sin, js: 'Math.sin($0)' }],
  ['sinh', { arity: 1, f: Math.sinh, js: 'Math.sinh($0)' }],
  ['tan', { arity: 1, f: Math.tan, js: 'Math.tan($0)' }],
  ['tanh', { arity: 1, f: tanh }],
  ['exp', { arity: 1, f: Math.exp, js: 'Math.exp($0)' }],
  ['sqrt', { arity: 1, f: Math.sqrt, js: 'Math.sqrt($0)' }],
  ['degrees', { arity: 1, f: (x) => x * DEG_PER_RAD, js: `($0 * ${DEG_PER_RAD})` }],
  ['radians', { arity: 1, f: (x) => x * RAD_PER_DEG, js: `($0 * ${RAD_PER_DEG})` }],
  ['ln', { arity: 1, f: (x) => (x > 0 ? Math.log(x) : NaN), js: '($0 > 0 ? Math.log($0) : NaN)' }],
  ['log10', { arity: 1, f: (x) => (x > 0 ? log10(x) : NaN) }],
  ['log2', { arity: 1, f: (x) => (x > 0 ? Math.log2(x) : NaN), js: '($0 > 0 ? Math.log2($0) : NaN)' }],
  ['atan2', { arity: 2, f: Math.atan2, js: 'Math.atan2($0, $1)' }],
  ['mod', { arity: 2, f: (x, y) => x % y, js: '($0 % $1)' }],
  ['pow', { arity: 2, f: cPow }],
  ['power', { arity: 2, f: cPow }],
  ['pi', { arity: 0, f: () => Math.PI, js: `${Math.PI}` }],
]);

/** log(X) is log10(X); log(B, X) is the logarithm of X to base B. */
export const LOG1: MathFunction = { arity: 1, f: (x) => (x > 0 ? log10(x) : NaN) };
export const LOG2: MathFunction = { arity: 2, f: logBase, args: 'logBase' };

/** ceil, ceiling, floor, trunc: an INTEGER argument is returned unchanged, a REAL one rounded. */
export const ROUNDING: ReadonlyMap<string, (x: number) => number> = new Map([
  ['ceil', Math.ceil],
  ['ceiling', Math.ceil],
  ['floor', Math.floor],
  ['trunc', Math.trunc],
]);

/**
 * An argument as sqlite3_value_numeric_type then sqlite3_value_double see it: the double, or
 * undefined when it is not numeric (NULL, text that is not a number, a blob).
 */
export function numericArg(v: SqlValue): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = applyNumericAffinity(v);
    if (typeof n === 'number') return n;
    if (typeof n === 'bigint') return Number(n);
  }
  return undefined;
}

/** sqlite3_value_double: any value as a double (NULL is 0, text and blobs by their numeric prefix). */
function doubleArg(v: SqlValue): number {
  const n = toNumeric(v);
  return n === null ? 0 : Number(n);
}

const isNumeric = (t: StaticType): boolean => t === 'int' || t === 'real' || t === 'num';

/** The REAL result of a double: NaN is NULL. */
const real = (z: number): SqlValue => (z === z ? z : null);

/** The scalar function for a REAL-valued math function. */
export function mathScalar(m: MathFunction): ScalarFunction {
  return {
    minArgs: m.arity,
    maxArgs: m.arity,
    deterministic: true,
    resultType: () => 'real',
    compile(args: CompiledArg[]): { fn: Fn; type: StaticType } {
      const f = m.f;
      if (m.arity === 0) return { type: 'real', fn: () => f() };
      if (m.arity === 1) {
        const a = args[0].fn;
        if (isNumeric(args[0].type)) {
          // Numeric statically: a number, a bigint (large INTEGER) or NULL.
          return {
            type: 'real',
            fn: (r) => {
              const v = a(r);
              return v === null ? null : real(f(typeof v === 'number' ? v : Number(v)));
            },
          };
        }
        return {
          type: 'real',
          fn: (r) => {
            const x = numericArg(a(r));
            return x === undefined ? null : real(f(x));
          },
        };
      }
      const a = args[0].fn;
      const b = args[1].fn;
      if (m.args === 'logBase') {
        return {
          type: 'real',
          fn: (r) => {
            const x = numericArg(a(r));
            return x === undefined ? null : real(f(x, doubleArg(b(r))));
          },
        };
      }
      return {
        type: 'real',
        fn: (r) => {
          const x = numericArg(a(r));
          if (x === undefined) return null;
          const y = numericArg(b(r));
          return y === undefined ? null : real(f(x, y));
        },
      };
    },
  };
}

/** log(X) and log(B, X). */
export const logScalar: ScalarFunction = {
  minArgs: 1,
  maxArgs: 2,
  deterministic: true,
  compile(args, ctx) {
    return mathScalar(args.length === 1 ? LOG1 : LOG2).compile(args, ctx);
  },
};

/** The result type of ceil/floor/trunc: an INTEGER stays one, a REAL stays one; otherwise either. */
export function roundingType(t: StaticType): StaticType {
  return t === 'int' || t === 'real' || t === 'null' ? t : 'num';
}

/** ceil, ceiling, floor, trunc. */
export function roundingScalar(g: (x: number) => number): ScalarFunction {
  return {
    minArgs: 1,
    maxArgs: 1,
    deterministic: true,
    resultType: ([arg]) => roundingType(arg.type),
    compile([arg]) {
      const a = arg.fn;
      const type = roundingType(arg.type);
      // An integral number is unchanged by rounding, so INTEGER and REAL numbers both go through g;
      // a bigint is a large INTEGER, returned unchanged.
      const num = (v: number | bigint): SqlValue => (typeof v === 'number' ? g(v) : v);
      if (isNumeric(arg.type)) return { type, fn: (r) => { const v = a(r); return v === null ? null : num(v as number | bigint); } };
      return {
        type,
        fn: (r) => {
          const v = a(r);
          if (typeof v === 'number' || typeof v === 'bigint') return num(v);
          if (typeof v !== 'string') return null;
          const n = applyNumericAffinity(v);
          return typeof n === 'number' || typeof n === 'bigint' ? num(n) : null;
        },
      };
    },
  };
}

/** What generated code needs to emit a math call inline (codegen.ts). */
export type InlineMath = { kind: 'real'; m: MathFunction } | { kind: 'rounding'; js: string };

const ROUNDING_JS: Record<string, string> = { ceil: 'Math.ceil', ceiling: 'Math.ceil', floor: 'Math.floor', trunc: 'Math.trunc' };

/** The math function `name` called with `nargs` arguments, if generated code can emit it inline. */
export function inlineMath(name: string, nargs: number): InlineMath | undefined {
  if (name === 'log') return { kind: 'real', m: nargs === 1 ? LOG1 : LOG2 };
  const m = MATH_FUNCTIONS.get(name);
  if (m) return m.arity === nargs ? { kind: 'real', m } : undefined;
  const js = ROUNDING_JS[name];
  return js !== undefined && nargs === 1 ? { kind: 'rounding', js } : undefined;
}
