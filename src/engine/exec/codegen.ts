import type { BoundExpr } from '../plan/expr.js';
import type { CollationName } from '../plan/types.js';
import type { SqlValue } from '../values.js';
import { isOpaque } from './sql-meta.js';
import { type InlineForm, traitsOf, withoutComparisonConversion } from './traits.js';
import { type StaticType, truthy } from './convert.js';
import { type InlineMath, type MathFunction, inlineMath, roundingType } from './math.js';

/**
 * Expression code generation (ADR 0001 decision 5). Arithmetic, numeric comparisons, boolean
 * logic and the math functions on numeric arguments (math.ts) are emitted as straight-line JavaScript with fast paths chosen from static types, so each
 * expression gets its own V8 type feedback and inlined register reads and constants. Closures
 * share feedback across all instances of a closure literal, so they cannot be specialized this way.
 * Any other node is delegated to the closure compiler (`fallback`), which defines the semantics;
 * generated fast paths must agree with it exactly (checked by the differential tests).
 */

/** Result of compiling a node with the closure compiler, as needed by the generator. */
export interface FallbackNode {
  fn: (r: SqlValue[]) => SqlValue;
  type: StaticType;
  constant: boolean;
  /** Set when the node is a plain register read. */
  reg?: number;
  /** Collation and affinity the closure compiler derived (for comparisons emitted here). */
  collation?: number;
  affinity?: string;
}

export interface CodegenHelpers {
  /** arith['+'], arith['+R'] (forced REAL), ... — the closure compiler's slow paths. */
  arith: Record<string, (x: SqlValue, y: SqlValue) => SqlValue>;
  negate: (v: SqlValue) => SqlValue;
}

/**
 * A generated value. When `nul` is set, `v` always holds a non-null JS value (0 placeholder when the
 * SQL value is NULL) and `nul` is a JS boolean expression for SQL NULL. Keeping NULL out of numeric
 * variables lets V8 keep them unboxed. Without `nul`, `v` may itself be `null`.
 */
interface Gen {
  v: string;
  type: StaticType;
  nul?: string;
  /** Always a JS number (a numeric literal read from K): generated code needs no typeof check for it. */
  num?: true;
}

/** JS boolean expression: the value is SQL NULL. */
function nullOf(g: Gen): string {
  return g.nul ?? `(${g.v} === null)`;
}

/** JS expression for the value as a nullable SqlValue. */
function plain(g: Gen): string {
  if (g.nul === undefined) return g.v;
  if (g.nul === 'false') return g.v;
  if (g.nul === 'true') return 'null';
  return `(${g.nul} ? null : ${g.v})`;
}

function orNull(a: string, b: string): string {
  if (a === 'false') return b;
  if (b === 'false') return a;
  if (a === 'true' || b === 'true') return 'true';
  return `(${a} || ${b})`;
}

/** The arithmetic and comparison forms generated inline (a function's `inline` trait), by operator. */
const ARITH_FORMS = new Set<InlineForm>(['+', '-', '*', '/', '%']);
const CMP_FORMS = new Set<InlineForm>(['=', '!=', '<', '<=', '>', '>=']);
/** A call's inline arithmetic operator, if it has one. */
const arithOf = (fn: string): string | undefined => {
  const f = traitsOf(fn).inline;
  return f !== undefined && ARITH_FORMS.has(f) ? f : undefined;
};
/** A call's inline comparison operator, if it has one. */
const cmpOf = (fn: string): string | undefined => {
  const f = traitsOf(fn).inline;
  return f !== undefined && CMP_FORMS.has(f) ? f : undefined;
};
const utf8Encoder = new TextEncoder();

/**
 * The operand of a comparison without its affinity conversion. Generated comparisons run only on statically numeric
 * operands (where the conversions change nothing) or on text under BINARY with neither operand converting to a
 * number (checked by `binaryTextOperands`), so they compare the operands themselves.
 */
const unconverted = (x: BoundExpr): BoundExpr => withoutComparisonConversion(x);
const isNum = (t: StaticType): boolean => t === 'int' || t === 'real' || t === 'num';

let enabled: boolean | undefined;

/** Code generation is used when the page's CSP allows `new Function` (and not disabled for tests). */
export function codegenEnabled(): boolean {
  if (enabled === undefined) {
    const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
    if (g.process?.env?.SMALT_NO_CODEGEN) enabled = false;
    else {
      try {
        enabled = new Function('return 1')() === 1;
      } catch {
        enabled = false;
      }
    }
  }
  return enabled;
}

/** Worth generating code for: arithmetic, numeric comparison, boolean logic or a math function at the root. */
export function isCodegenRoot(e: BoundExpr): boolean {
  if (isOpaque(e)) return false;
  switch (e.k) {
    case 'call':
      return traitsOf(e.fn).inline !== undefined || mathCall(e) !== undefined;
    case 'and':
    case 'or':
    case 'not':
      return true;
    default:
      return false;
  }
}

/** A call of a math function that generated code can emit inline. */
function mathCall(e: BoundExpr): InlineMath | undefined {
  if (e.k !== 'call' || e.fn.startsWith('sql.')) return undefined;
  return inlineMath(e.fn, e.args.length);
}

type Factory = (H: CodegenHelpers, K: unknown[], T: typeof truthy) => (r: SqlValue[]) => SqlValue;
const factories = new Map<string, Factory>();

class Emitter {
  lines: string[] = [];
  private n = 0;
  readonly consts: unknown[] = [];

  constructor(private readonly fallback: (e: BoundExpr) => FallbackNode) {}

  private tmp(): string {
    return 'v' + this.n++;
  }

  private konst(x: unknown): string {
    this.consts.push(x);
    return `K[${this.consts.length - 1}]`;
  }

  /** Numeric literals, read from K once per function instance (`head()`) instead of written into the source. */
  private readonly hoisted: string[] = [];

  /**
   * Pipelines write numeric literals into the source: they scan whole tables, so V8 specializing on the constant
   * matters more than reusing the compiled function for another literal.
   */
  inlineNumbers = false;

  private number(x: number): string {
    if (this.inlineNumbers) return `(${String(x)})`;
    const i = this.consts.push(x) - 1;
    this.hoisted.push(`const $c${i} = K[${i}];`);
    return `$c${i}`;
  }

  /**
   * Declarations of the literals of a per-row function: they live in K, not in the source, so statements that differ
   * only in their literals share one compiled function (and its type feedback), read once per instance.
   */
  head(): string {
    return this.hoisted.length ? this.hoisted.join(' ') + ' ' : '';
  }

  /** How generated code reads register `reg` (fused pipelines map decoded columns to flagged locals). */
  regRef: (reg: number, type: StaticType) => { v: string; nul?: string } = (reg) => ({ v: `r[${reg}]` });
  /** Set when a closure-compiled node was emitted: it reads the register file directly. */
  usesRegisterFile = false;

  private reg(reg: number, type: StaticType): Gen {
    return { ...this.regRef(reg, type), type };
  }

  private viaFallback(e: BoundExpr): Gen {
    const c = this.fallback(e);
    if (c.reg !== undefined) return this.reg(c.reg, c.type);
    if (c.constant) return this.literal(c.fn([]), c.type);
    this.usesRegisterFile = true;
    const v = this.tmp();
    this.lines.push(`const ${v} = ${this.konst(c.fn)}(r);`);
    return { v, type: c.type };
  }

  /**
   * An integer literal divisor of `/` or `%` stays in the source: V8 turns division by a known constant into a
   * multiplication, and such divisors are usually part of the query's shape rather than values that vary.
   */
  private divisor(op: string, e: BoundExpr): Gen | undefined {
    if ((op !== '/' && op !== '%') || e.k !== 'lit' || typeof e.value !== 'number' || !Number.isSafeInteger(e.value) || Object.is(e.value, -0)) return undefined;
    return { v: `(${e.value})`, nul: 'false', type: e.type, num: true };
  }

  private literal(value: SqlValue, type: StaticType): Gen {
    if (value === null) return { v: '0', nul: 'true', type: 'null' };
    if (typeof value === 'number' && Number.isFinite(value)) return { v: Object.is(value, -0) ? '0' : this.number(value), nul: 'false', type, num: true };
    return { v: this.konst(value), nul: 'false', type };
  }

  /** Emit `e` (unsupported node kinds go through the closure compiler). */
  gen(e: BoundExpr): Gen {
    if (isOpaque(e)) return this.viaFallback(e);
    switch (e.k) {
      case 'slot':
        e.use?.();
        return this.reg(e.reg, e.type);
      case 'param':
        return this.reg(e.index, 'any');
      case 'lit':
        return this.literal(e.value, e.type);
      case 'and':
      case 'or':
        return this.logic(e.k === 'and' ? 'AND' : 'OR', e.args[0], e.args[1]);
      case 'not': {
        const a = this.gen(e.arg);
        const v = this.tmp();
        if (isNum(a.type) || a.type === 'null') {
          const nul = nullOf(a);
          this.lines.push(`const ${v}n = ${nul}; const ${v} = ${v}n ? 0 : (${a.v} != 0 ? 0 : 1);`);
          return { v, nul: `${v}n`, type: 'int' };
        }
        this.lines.push(`const ${v} = T(${plain(a)}); const n${v} = ${v} === null ? null : ${v} ? 0 : 1;`);
        return { v: 'n' + v, type: 'int' };
      }
      case 'call': {
        const arith = arithOf(e.fn);
        if (arith !== undefined) return this.arith(arith, this.gen(e.args[0]), this.divisor(arith, e.args[1]) ?? this.gen(e.args[1]));
        const cmp = cmpOf(e.fn);
        if (cmp !== undefined) {
          // Numeric comparisons only; anything involving text/affinity/collation uses the closure compiler.
          const left = unconverted(e.args[0]);
          const right = unconverted(e.args[1]);
          const saved = this.lines;
          this.lines = [];
          const a = this.gen(left);
          const b = this.gen(right);
          const inner = this.lines;
          this.lines = saved;
          if (isNum(a.type) && isNum(b.type)) {
            this.lines.push(...inner);
            return this.compare(cmp, a, b);
          }
          if ((cmp === '=' || cmp === '!=') && a.type === 'text' && b.type === 'text' && this.binaryTextOperands(left, right, e.collation)) {
            // Text = text under BINARY: UTF-16 equality is UTF-8 byte equality, so compare JS strings.
            this.lines.push(...inner);
            const v = this.tmp();
            const nul = orNull(nullOf(a), nullOf(b));
            this.lines.push(`const ${v}n = ${nul}; const ${v} = ${v}n ? 0 : (${a.v} ${cmp === '=' ? '===' : '!=='} ${b.v} ? 1 : 0);`);
            return { v, nul: `${v}n`, type: 'int' };
          }
          return this.viaFallback(e);
        }
        if (traitsOf(e.fn).inline === 'neg') {
          const a = this.gen(e.args[0]);
          const v = this.tmp();
          this.lines.push(
            `let ${v}n = ${nullOf(a)}; let ${v} = 0; if (!${v}n) { const x = ${a.v}; if (typeof x === 'number') ${v} = x === 0 ? 0 : -x; else { const s = H.negate(x); if (s === null) ${v}n = true; else ${v} = s; } }`,
          );
          return { v, nul: `${v}n`, type: isNum(a.type) ? a.type : 'num' };
        }
        const m = mathCall(e);
        if (m === undefined) return this.viaFallback(e);
        // A constant call (sqrt(4)) is folded by the closure compiler.
        const fb = this.fallback(e);
        if (fb.constant || fb.reg !== undefined) return this.viaFallback(e);
        const saved = this.lines;
        this.lines = [];
        const args = e.args.map((a) => this.gen(a));
        const inner = this.lines;
        this.lines = saved;
        // Non-numeric arguments (text affinity, blobs) take the closure compiler's general path.
        if (!args.every((a) => isNum(a.type) || a.type === 'null')) return this.viaFallback(e);
        this.lines.push(...inner);
        return m.kind === 'real' ? this.mathReal(m.m, args) : this.mathRounding(m.js, args[0]);
      }
      default:
        return this.viaFallback(e);
    }
  }

  /** A double from a numeric value (an INTEGER may be a bigint). */
  private double(a: Gen): string {
    return a.type === 'real' ? a.v : `(typeof ${a.v} === 'number' ? ${a.v} : Number(${a.v}))`;
  }

  /** A REAL-valued math function: NULL in, NULL out; a NaN result is NULL. */
  private mathReal(m: MathFunction, args: Gen[]): Gen {
    const v = this.tmp();
    const nul = args.reduce((acc, a) => orNull(acc, nullOf(a)), 'false');
    const xs = args.map((a) => this.double(a));
    const call = m.js !== undefined ? m.js.replace(/\$(\d)/g, (_s, i: string) => `x${i}`) : `${this.konst(m.f)}(${xs.map((_x, i) => `x${i}`).join(', ')})`;
    const bind = xs.map((x, i) => `const x${i} = ${x};`).join(' ');
    this.lines.push(`let ${v}n = ${nul}; let ${v} = 0; if (!${v}n) { ${bind} const z = ${call}; if (z === z) ${v} = z; else ${v}n = true; }`);
    return { v, nul: `${v}n`, type: 'real' };
  }

  /** ceil, floor, trunc: an INTEGER is unchanged (a bigint too), a REAL is rounded. */
  private mathRounding(js: string, a: Gen): Gen {
    const type = roundingType(a.type);
    if (type === 'null') return { v: '0', nul: 'true', type: 'null' };
    if (type === 'int') return a;
    const v = this.tmp();
    const value = type === 'real' ? `${js}(${a.v})` : `(typeof ${a.v} === 'number' ? ${js}(${a.v}) : ${a.v})`;
    this.lines.push(`const ${v}n = ${nullOf(a)}; const ${v} = ${v}n ? 0 : ${value};`);
    return { v, nul: `${v}n`, type };
  }

  /** JS boolean expression: the value is a true SQL condition (NULL and 0 are false). */
  isTrue(a: Gen): string {
    if (isNum(a.type) || a.type === 'null') return a.nul !== undefined ? `(!${a.nul} && ${a.v} != 0)` : `(${a.v} !== null && ${a.v} != 0)`;
    return `(T(${plain(a)}) === true)`;
  }

  /** JS expression for the value as a nullable SqlValue (for helpers and aggregate states). */
  value(a: Gen): string {
    return plain(a);
  }

  /** JS boolean expression: the value is SQL NULL. */
  isNull(a: Gen): string {
    return nullOf(a);
  }

  private truthyExpr(a: Gen): string {
    if (isNum(a.type) || a.type === 'null') return `(${nullOf(a)} ? null : ${a.v} != 0)`;
    return `T(${plain(a)})`;
  }

  private logic(op: 'AND' | 'OR', le: BoundExpr, re: BoundExpr): Gen {
    const a = this.gen(le);
    const ta = this.tmp();
    const v = this.tmp();
    this.lines.push(`const ${ta} = ${this.truthyExpr(a)}; let ${v};`);
    const saved = this.lines;
    this.lines = [];
    const b = this.gen(re);
    const inner = this.lines;
    this.lines = saved;
    const tb = this.tmp();
    const short = op === 'AND' ? 'false' : 'true';
    const shortVal = op === 'AND' ? 0 : 1;
    const longVal = op === 'AND' ? 1 : 0;
    this.lines.push(
      `if (${ta} === ${short}) ${v} = ${shortVal}; else { ${inner.join(' ')} const ${tb} = ${this.truthyExpr(b)};` +
        ` ${v} = ${tb} === ${short} ? ${shortVal} : (${ta} === null || ${tb} === null) ? null : ${longVal}; }`,
    );
    return { v, type: 'int' };
  }

  /** The closure compiler's view of `e` (type, register, collation, affinity). */
  fallbackOf(e: BoundExpr): FallbackNode {
    return this.fallback(e);
  }

  /** Register a constant; returns its JS expression. */
  constant(x: unknown): string {
    return this.konst(x);
  }

  /**
   * The comparison (its own `collation`, absent for BINARY) and both of its operands use BINARY collation, and neither
   * operand applies numeric affinity. A plan built without SQL gives its collation only on the call.
   */
  binaryTextOperands(l: BoundExpr, r: BoundExpr, collation: CollationName | undefined): boolean {
    if ((collation ?? 'binary') !== 'binary') return false;
    const ok = (c: FallbackNode): boolean => (c.collation ?? 0) === 0 && (c.affinity === undefined || c.affinity === 'TEXT' || c.affinity === 'NONE' || c.affinity === 'BLOB');
    const cl = this.fallback(l);
    const cr = this.fallback(r);
    return cl.collation !== undefined && cr.collation !== undefined && ok(cl) && ok(cr);
  }

  private compare(op: string, a: Gen, b: Gen): Gen {
    const jsOp = op === '=' ? '==' : op === '!=' ? '!=' : op;
    const v = this.tmp();
    const nul = orNull(nullOf(a), nullOf(b));
    this.lines.push(`const ${v}n = ${nul}; const ${v} = ${v}n ? 0 : (${a.v} ${jsOp} ${b.v} ? 1 : 0);`);
    return { v, nul: `${v}n`, type: 'int' };
  }

  private arith(op: string, a: Gen, b: Gen): Gen {
    const real = a.type === 'real' || b.type === 'real';
    const bothInt = a.type === 'int' && b.type === 'int';
    const type: StaticType = real ? 'real' : bothInt ? 'int' : 'num';
    const v = this.tmp();
    const vn = `${v}n`;
    const slowFn = `H.arith[${JSON.stringify(op + (real ? 'R' : ''))}]`;
    const x = 'x';
    const y = 'y';
    const slow = `{ const s = ${slowFn}(x, y); if (s === null) ${vn} = true; else ${v} = s; }`;
    let intFast: string;
    switch (op) {
      case '/':
        intFast = `if (y === 0) ${vn} = true; else if (x > -2147483648 && x < 2147483648 && y > -2147483648 && y < 2147483648) ${v} = Math.trunc(x / y) + 0; else ${slow}`;
        break;
      case '%':
        intFast = `if (y === 0) ${vn} = true; else if (y === -1) ${v} = 0; else ${v} = (x % y) + 0;`;
        break;
      default:
        intFast = `{ const z = x ${op} y; if (Number.isSafeInteger(z)) ${v} = z + 0; else ${slow} }`;
    }
    let realFast: string;
    switch (op) {
      case '/':
        realFast = `if (y === 0) ${vn} = true; else { const z = x / y; if (z === z) ${v} = z; else ${vn} = true; }`;
        break;
      case '%':
        realFast = slow;
        break;
      default:
        realFast = `{ const z = x ${op} y; if (z === z) ${v} = z; else ${vn} = true; }`;
    }
    const fast = real ? realFast : bothInt ? intFast : `if (Number.isSafeInteger(x) && Number.isSafeInteger(y)) { ${intFast} } else { ${realFast} }`;
    // A literal operand is known to be a number (V8 cannot see that through K).
    const checks = [a.num ? '' : `typeof x === 'number'`, b.num ? '' : `typeof y === 'number'`].filter((c) => c);
    const body = checks.length ? `if (${checks.join(' && ')}) { ${fast} } else ${slow}` : fast;
    this.lines.push(`let ${vn} = ${orNull(nullOf(a), nullOf(b))}; let ${v} = 0; if (!${vn}) { const ${x} = ${a.v}; const ${y} = ${b.v}; ${body} }`);
    return { v, nul: vn, type };
  }
}

/**
 * The static type `generate` gives `e`, without generating a function (the SQL front end compares result types with
 * the planner's; a constant folded to NULL makes generated arithmetic `num`, for example).
 */
export function generatedType(e: BoundExpr, fallback: (e: BoundExpr) => FallbackNode): StaticType {
  return new Emitter(fallback).gen(e).type;
}

/** Generated sources recorded for tests (test/codegen-source.test.ts), or null when not recording. */
let traced: string[] | null = null;

/**
 * Start (`true`) or stop recording the source of every function generated from now on, and return what was recorded
 * since the last start. For tests that pin generated code: a change to the plan layer must not change it unnoticed.
 */
export function traceGeneratedCode(on: boolean): string[] {
  const out = traced ?? [];
  traced = on ? [] : null;
  return out;
}

/**
 * Generate a function for the bound expression `e`. `fallback` compiles a node with the closure compiler. GROUP BY
 * expressions in post-aggregation scopes are already register slots (the binder resolved them).
 */
export function generate(
  e: BoundExpr,
  helpers: CodegenHelpers,
  fallback: (e: BoundExpr) => FallbackNode,
): { fn: (r: SqlValue[]) => SqlValue; type: StaticType; source: string } {
  const em = new Emitter(fallback);
  const g = em.gen(e);
  const head = em.head();
  const body = `${em.lines.join('\n')}\nreturn ${em.value(g)};`;
  const key = head + body;
  traced?.push(`expression:\n${key}`);
  let factory = factories.get(key);
  if (factory === undefined) {
    factory = new Function('H', 'K', 'T', `"use strict"; ${head}return function smaltExpr(r) {\n${body}\n};`) as Factory;
    if (factories.size > 2000) factories.clear();
    factories.set(key, factory);
  }
  return { fn: factory(helpers, em.consts, truthy), type: g.type, source: body };
}

// ------------------------------------------------------------------ row decoders

export interface LoaderSpec {
  /** Storage type per table column. */
  types: readonly string[];
  /** Per column: offset within the fixed area (INTEGER/REAL) or index into the var table. */
  slots: Int32Array;
  fixedSize: number;
  varCount: number;
  /** [column, register] pairs to decode. */
  decode: readonly number[];
  /** Register(s) receiving the rowid, if any. */
  rowidRegs: readonly number[];
}

export interface LoaderHelpers {
  readInt64: (dv: DataView, off: number) => number | bigint;
  utf8: (b: Uint8Array, start: number, end: number) => string;
  tagged: (b: Uint8Array, dv: DataView, start: number, end: number) => SqlValue;
  rowid: (b: Uint8Array, off: number) => number | bigint;
}

/** Cursor surface used by generated decoders. */
export interface LoaderCursor {
  readonly page: { readonly bytes: Uint8Array; readonly view: DataView };
  cellOffset(): number;
}

type Loader = (c: LoaderCursor, r: SqlValue[]) => boolean;
const loaderFactories = new Map<string, (H: LoaderHelpers) => Loader>();

/**
 * Generate a row decoder that reads directly from the leaf page bytes, with column offsets and
 * types baked in. Returns false (caller uses the generic reader) for cells whose value is in
 * overflow pages or whose record has a different column count (older rows after ADD COLUMN).
 */
/**
 * Emit statements that decode the cell at byte offset `off` of a leaf page (`b`: bytes, `dv`: view)
 * into registers. Assumes the cell is inline and the record has all columns; the caller checks
 * `cellIsFast` first.
 */
/** Assignment of a decoded value: `assign(reg, expr)` returns a statement. Default writes the register file. */
type Assign = (reg: number, expr: string) => string;
const toRegister: Assign = (reg, expr) => `r[${reg}] = ${expr};`;

/** Byte bounds of a var-length column in the record being decoded (valid after the decode header). */
interface ColBounds {
  isNull: string;
  st: string;
  fin: string;
}

/** Called after the decode header with a bounds accessor; returns statements run before any column is decoded. */
type PreDecode = (bounds: (col: number) => ColBounds) => string[];

function emitDecode(spec: LoaderSpec, L: string[], assign: Assign = toRegister, pre?: PreDecode): void {
  const n = spec.types.length;
  const bitmap = (n + 7) >>> 3;
  // Leaf cell header (see btree.ts): 1-byte key length (rowid keys are 8), 1- or 2-byte value field.
  L.push('const ko = off + (b[off + 1] < 128 ? 2 : 3); const vo = ko + b[off];');
  if (spec.decode.length > 0) {
    L.push(`const bm = vo + 3; const fx = bm + ${bitmap}; const vt = fx + ${spec.fixedSize};`);
    const needsVar = spec.decode.some((_, i) => i % 2 === 0 && !(spec.types[spec.decode[i]] === 'INTEGER' || spec.types[spec.decode[i]] === 'REAL'));
    if (needsVar) L.push(`const wide = (b[vo] & 1) === 1; const vd = vt + ${spec.varCount} * (wide ? 4 : 2);`);
    const endOf = (j: number): string => `(wide ? dv.getUint32(vt + ${4 * j}, true) : (b[vt + ${2 * j}] | (b[vt + ${2 * j + 1}] << 8)))`;
    const bounds = (col: number): ColBounds => {
      const sl = spec.slots[col];
      return { isNull: `(b[bm + ${col >>> 3}] & ${1 << (col & 7)}) !== 0`, st: sl === 0 ? 'vd' : `vd + ${endOf(sl - 1)}`, fin: `vd + ${endOf(sl)}` };
    };
    if (pre && needsVar) L.push(...pre(bounds));
    for (let i = 0; i < spec.decode.length; i += 2) {
      const col = spec.decode[i];
      const reg = spec.decode[i + 1];
      const t = spec.types[col];
      const sl = spec.slots[col];
      const isNull = `(b[bm + ${col >>> 3}] & ${1 << (col & 7)}) !== 0`;
      let value: string;
      if (t === 'INTEGER') {
        // Values that fit in int32 are produced as int32 so V8 keeps them as small integers (fast % and /).
        value =
          `{ const o = fx + ${sl}; const lo = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24); const hi = b[o + 4] | (b[o + 5] << 8) | (b[o + 6] << 16) | (b[o + 7] << 24);` +
          ` ${assign(reg, '(hi === 0 && lo >= 0) || (hi === -1 && lo < 0) ? lo : (hi >= -2097152 && hi <= 2097151) ? hi * 4294967296 + (lo >>> 0) : H.readInt64(dv, o)')} }`;
      } else if (t === 'REAL') {
        value = assign(reg, `dv.getFloat64(fx + ${sl}, true)`);
      } else {
        const { st, fin } = bounds(col);
        if (t === 'TEXT') value = assign(reg, `H.utf8(b, ${st}, ${fin})`);
        else if (t === 'BLOB') value = assign(reg, `b.slice(${st}, ${fin})`);
        else value = assign(reg, `H.tagged(b, dv, ${st}, ${fin})`);
      }
      L.push(`if (${isNull}) { ${assign(reg, 'null')} } else { ${value} }`);
    }
  }
  if (spec.rowidRegs.length > 0) {
    L.push('{ const id = H.rowid(b, ko);');
    for (const reg of spec.rowidRegs) L.push(assign(reg, 'id'));
    L.push('}');
  }
}

/** JS condition: the cell at `off` can be decoded by emitDecode (inline value, full-width record). */
function cellIsFast(spec: LoaderSpec): string {
  // Key length < 128, value field of at most 2 bytes without the overflow bit.
  const hdr = '(b[off] < 128 && (b[off + 1] & 1) === 0 && (b[off + 1] < 128 || b[off + 2] < 128))';
  if (spec.decode.length === 0) return hdr;
  const vo = '(off + (b[off + 1] < 128 ? 2 : 3) + b[off])';
  return `${hdr} && (b[${vo} + 1] | (b[${vo} + 2] << 8)) === ${spec.types.length}`;
}

/**
 * Generate a row decoder that reads directly from the leaf page bytes, with column offsets and
 * types baked in. Returns false (caller uses the generic reader) for cells whose value is in
 * overflow pages or whose record has a different column count (older rows after ADD COLUMN).
 */
/**
 * Loader factories by table layout (its slot array, shared by a table's readers) and then by decoded columns and
 * rowid registers: a statement over a known layout skips building the loader's source.
 */
const loaderBySpec = new WeakMap<Int32Array, Map<string, (H: LoaderHelpers) => Loader>>();

export function generateLoader(spec: LoaderSpec, helpers: LoaderHelpers): Loader {
  let byLayout = loaderBySpec.get(spec.slots);
  if (byLayout === undefined) loaderBySpec.set(spec.slots, (byLayout = new Map()));
  const key = `${spec.decode.join(',')}|${spec.rowidRegs.join(',')}`;
  const known = traced ? undefined : byLayout.get(key);
  if (known !== undefined) return known(helpers);
  const L: string[] = [];
  L.push('const p = c.page; const b = p.bytes; const dv = p.view; const off = c.cellOffset();');
  L.push(`if (!(${cellIsFast(spec)})) return false;`);
  emitDecode(spec, L);
  L.push('return true;');
  const body = L.join('\n');
  traced?.push(`loader:\n${body}`);
  let factory = loaderFactories.get(body);
  if (factory === undefined) {
    factory = new Function('H', `"use strict"; return function smaltLoad(c, r) {\n${body}\n};`) as (H: LoaderHelpers) => Loader;
    if (loaderFactories.size > 500) loaderFactories.clear();
    loaderFactories.set(body, factory);
  }
  if (byLayout.size > 200) byLayout.clear();
  byLayout.set(key, factory);
  return factory(helpers);
}

// ------------------------------------------------------------------ fused scan + filter + aggregate

export interface FusedAggSpec {
  kind: 'countStar' | 'count' | 'step' | 'step2';
  /** Argument expression (count/step/step2). */
  arg?: BoundExpr;
  /** Second argument expression (step2: two-argument aggregates such as corr and percentile). */
  arg2?: BoundExpr;
  filter?: BoundExpr;
}

export interface FusedHelpers extends LoaderHelpers, CodegenHelpers {
  /** First leaf page of the table (pinned), or null. */
  first(): { bytes: Uint8Array; view: DataView } | null;
  /** Release `page` and return the next leaf (pinned), or null. */
  next(page: { bytes: Uint8Array; view: DataView }): { bytes: Uint8Array; view: DataView } | null;
  release(page: { bytes: Uint8Array; view: DataView }): void;
  /** Generic decode of one cell (overflow values, short records). */
  slow(page: { bytes: Uint8Array; view: DataView }, off: number, r: SqlValue[]): void;
}

/**
 * Shared machinery for generated scan pipelines: maps registers of decoded columns to per-row JS
 * locals (numeric ones with separate NULL flags), emits WHERE conjuncts, and finally the decode
 * block. Expressions must be emitted before `finish()`, because column references are resolved
 * (and added to the scan's decode list) while emitting.
 */
class Pipeline {
  readonly em: Emitter;
  private readonly localRegs = new Map<number, boolean>(); // reg -> flagged
  readonly rowLines: string[] = [];

  constructor(fallback: (e: BoundExpr) => FallbackNode) {
    this.em = new Emitter(fallback);
    this.em.inlineNumbers = true;
    this.em.regRef = (reg, type) => {
      const flagged = type === 'int' || type === 'real';
      if (!this.localRegs.has(reg)) this.localRegs.set(reg, flagged);
      return this.localRegs.get(reg) ? { v: `c${reg}`, nul: `c${reg}n` } : { v: `c${reg}` };
    };
  }

  take(): string[] {
    const l = this.em.lines;
    this.em.lines = [];
    return l;
  }

  /** `column = 'text literal'` conjuncts (BINARY): checked on the raw UTF-8 bytes before decoding. */
  private readonly textEq: { reg: number; bytes: Uint8Array }[] = [];

  /** WHERE: every conjunct must be true (NULL counts as false). */
  addPredicates(preds: BoundExpr[]): void {
    for (const p of preds) {
      const eq = this.textEqualityConjunct(p);
      if (eq) this.textEq.push(eq);
      const g = this.em.gen(p);
      this.rowLines.push(...this.take(), `if (!${this.em.isTrue(g)}) continue;`);
    }
  }

  private textEqualityConjunct(p: BoundExpr): { reg: number; bytes: Uint8Array } | null {
    if (p.k !== 'call' || traitsOf(p.fn).compare !== '=' || isOpaque(p)) return null;
    const left = unconverted(p.args[0]);
    const right = unconverted(p.args[1]);
    for (const [col, lit] of [
      [left, right],
      [right, left],
    ] as const) {
      if (lit.k !== 'lit' || typeof lit.value !== 'string') continue;
      const c = this.em.fallbackOf(col);
      if (c.reg === undefined || c.type !== 'text' || !this.em.binaryTextOperands(col, lit, p.collation)) continue;
      return { reg: c.reg, bytes: utf8Encoder.encode(lit.value) };
    }
    return null;
  }

  /** Read a decoded register as a nullable JS value expression. */
  regValue(reg: number, type: StaticType): string {
    return this.em.value({ ...this.em.regRef(reg, type), type });
  }

  /** Produce the per-function prologue and the per-row decode block for the final decode list. */
  finish(spec: LoaderSpec): { prologue: string[]; rowStart: string[] } {
    const localRegs = this.localRegs;
    const decodedRegs = new Set<number>([...spec.rowidRegs]);
    for (let i = 1; i < spec.decode.length; i += 2) decodedRegs.add(spec.decode[i]);
    // Closure-compiled nodes read the register file, so then mirror decoded values into it.
    const mirror = this.em.usesRegisterFile;
    const assign: Assign = (reg, expr) => {
      const m = mirror ? (expr === 'null' ? ` r[${reg}] = null;` : ` r[${reg}] = c${reg};`) : '';
      if (!localRegs.has(reg)) return mirror ? `r[${reg}] = ${expr};` : '';
      if (!localRegs.get(reg)) return `c${reg} = ${expr};${m}`;
      return expr === 'null' ? `c${reg}n = true; c${reg} = 0;${m}` : `c${reg}n = false; c${reg} = ${expr};${m}`;
    };
    const dec: string[] = [];
    const textCol = new Map<number, number>(); // reg -> TEXT column decoded into it
    for (let i = 0; i < spec.decode.length; i += 2) if (spec.types[spec.decode[i]] === 'TEXT') textCol.set(spec.decode[i + 1], spec.decode[i]);
    const prefilters = this.textEq.filter((t) => textCol.has(t.reg));
    const pre: PreDecode | undefined = prefilters.length
      ? (bounds) =>
          prefilters.map((t) => {
            const bd = bounds(textCol.get(t.reg)!);
            const k = this.em.constant(t.bytes);
            const L = t.bytes.length;
            // NULL or a different byte string: the conjunct is not true, skip the row undecoded.
            // The literal's bytes live in K (not in the source), so statements differing only in the literal share code.
            const head = `if (${bd.isNull}) continue; { const s = ${bd.st}; if (${bd.fin} - s !== ${L}) continue; const q = ${k};`;
            if (L <= 16) return `${head}${L ? ` if (!(${Array.from(t.bytes, (_, j) => `b[s + ${j}] === q[${j}]`).join(' && ')})) continue;` : ''} }`;
            return `${head} let j = 0; while (j < ${L} && b[s + j] === q[j]) j++; if (j !== ${L}) continue; }`;
          })
      : undefined;
    emitDecode(spec, dec, assign, pre);
    // Registers referenced but not decoded here (e.g. outer-query columns) come from the register file.
    const outer = [...localRegs.keys()].filter((reg) => !decodedRegs.has(reg));
    const locals = [...localRegs.keys()].filter((reg) => decodedRegs.has(reg));
    const load = (reg: number): string =>
      localRegs.get(reg) ? `{ const t = r[${reg}]; c${reg}n = t === null; c${reg} = c${reg}n ? 0 : t; }` : `c${reg} = r[${reg}];`;
    const declLocals = locals.map((reg) => (localRegs.get(reg) ? `c${reg} = 0, c${reg}n = true` : `c${reg} = null`)).join(', ');
    return {
      prologue: outer.map((reg) => (localRegs.get(reg) ? `const c${reg}n = r[${reg}] === null; const c${reg} = c${reg}n ? 0 : r[${reg}];` : `const c${reg} = r[${reg}];`)),
      rowStart: [
        'const off = b[24 + 2 * i] | (b[25 + 2 * i] << 8);',
        locals.length ? `let ${declLocals};` : '',
        `if (${cellIsFast(spec)}) { ${dec.join(' ')} } else { H.slow(f, off, r); ${locals.map(load).join(' ')} }`,
      ],
    };
  }

  /**
   * Columnar counterpart of {@link finish}: per row group, bind each decoded column's chunk arrays;
   * per row, read values straight from them (see storage/columnar.ts for the chunk shapes).
   */
  finishColumnar(src: ColumnSource): { prologue: string[]; groupStart: string[]; rowStart: string[]; dense: { test: string; rowStart: string[] } | null } {
    const localRegs = this.localRegs;
    const decodedRegs = new Set<number>([...src.rowidRegs]);
    for (let i = 1; i < src.decode.length; i += 2) decodedRegs.add(src.decode[i]);
    const mirror = this.em.usesRegisterFile;
    const assign: Assign = (reg, expr) => {
      const m = mirror ? (expr === 'null' ? ` r[${reg}] = null;` : ` r[${reg}] = c${reg};`) : '';
      if (!localRegs.has(reg)) return mirror ? `r[${reg}] = ${expr};` : '';
      if (!localRegs.get(reg)) return `c${reg} = ${expr};${m}`;
      return expr === 'null' ? `c${reg}n = true; c${reg} = 0;${m}` : `c${reg}n = false; c${reg} = ${expr};${m}`;
    };
    const groupStart: string[] = [];
    const dec: string[] = [];
    // Dense variant: numeric columns without NULLs read straight from their arrays, with constant
    // NULL flags the JIT can fold away. Used per row group when every such chunk qualifies.
    const denseTests: string[] = [];
    const denseDec: string[] = [];
    let denseOk = !mirror;
    for (let k = 0; k < src.decode.length; k += 2) {
      const col = src.decode[k];
      const reg = src.decode[k + 1];
      if (!localRegs.has(reg) && !mirror) continue;
      const j = k >>> 1;
      groupStart.push(`const ch${j} = H.chunk(g, ${col}); const nb${j} = ch${j}.nulls; const nv${j} = ch${j}.num; const dc${j} = ch${j}.dict; const cd${j} = ch${j}.codes; const vs${j} = ch${j}.vals;`);
      const val = `nv${j} !== null ? nv${j}[i] : dc${j} !== null ? dc${j}[cd${j}[i]] : vs${j} !== null ? vs${j}[i] : null`;
      const generic = `if (nb${j} !== null && (nb${j}[i >>> 3] & (1 << (i & 7))) !== 0) { ${assign(reg, 'null')} } else { const x = ${val}; if (x === null) { ${assign(reg, 'null')} } else { ${assign(reg, 'x')} } }`;
      dec.push(generic);
      if (localRegs.get(reg)) {
        denseTests.push(`nb${j} === null && nv${j} !== null`);
        denseDec.push(`const c${reg}n = false; const c${reg} = nv${j}[i];`);
      } else if (localRegs.has(reg)) {
        denseDec.push(`let c${reg} = null; ${generic}`);
      }
    }
    const rowidExpr = src.segments ? 'rid[i]' : 'base + i + 1';
    const skip = src.segments ? ['if (dm !== null && dm[i] === 1) continue;'] : [];
    if (src.segments) {
      groupStart.push('const dm = H.deleted(g);');
      if (src.rowidRegs.length) groupStart.push('const rid = H.rowids(g);');
    }
    if (src.rowidRegs.length) {
      dec.push(`{ const id = ${rowidExpr};`);
      for (const reg of src.rowidRegs) dec.push(assign(reg, 'id'));
      dec.push('}');
    }
    const outer = [...localRegs.keys()].filter((reg) => !decodedRegs.has(reg));
    const locals = [...localRegs.keys()].filter((reg) => decodedRegs.has(reg));
    const declLocals = locals.map((reg) => (localRegs.get(reg) ? `c${reg} = 0, c${reg}n = true` : `c${reg} = null`)).join(', ');
    const rowidDecl = src.rowidRegs.filter((reg) => localRegs.has(reg));
    const dense =
      denseOk && denseTests.length > 0
        ? {
            test: denseTests.join(' && '),
            rowStart: [
              ...skip,
              ...denseDec,
              ...rowidDecl.map((reg) => (localRegs.get(reg) ? `const c${reg}n = false; const c${reg} = ${rowidExpr};` : `const c${reg} = ${rowidExpr};`)),
            ],
          }
        : null;
    return {
      prologue: outer.map((reg) => (localRegs.get(reg) ? `const c${reg}n = r[${reg}] === null; const c${reg} = c${reg}n ? 0 : r[${reg}];` : `const c${reg} = r[${reg}];`)),
      groupStart,
      rowStart: [...skip, locals.length ? `let ${declLocals};` : '', ...dec],
      dense,
    };
  }

  /** Emit aggregate steps into rowLines; `state(i)` is the JS expression for the i-th state. */
  addAggregates(aggs: FusedAggSpec[], state: (i: number) => string): void {
    const em = this.em;
    aggs.forEach((a, i) => {
      const body: string[] = [];
      if (a.kind === 'countStar') body.push(`${state(i)}.n++;`);
      else {
        const g = em.gen(a.arg!);
        if (a.kind === 'step2') {
          const g2 = em.gen(a.arg2!);
          body.push(...this.take());
          body.push(`${state(i)}.step2(${em.value(g)}, ${em.value(g2)});`);
        } else {
          body.push(...this.take());
          body.push(a.kind === 'count' ? `if (!${em.isNull(g)}) ${state(i)}.n++;` : `${state(i)}.step1(${em.value(g)});`);
        }
      }
      if (a.filter) {
        const f = em.gen(a.filter);
        this.rowLines.push(`{ ${this.take().join(' ')} if (${em.isTrue(f)}) { ${body.join(' ')} } }`);
      } else this.rowLines.push(`{ ${body.join(' ')} }`);
    });
  }
}

/** Compile generated source `return function ...` with the given parameter names and arguments. */
const pipelineFactories = new Map<string, (...args: unknown[]) => unknown>();

/**
 * Compile generated source `return function ...` with the given parameter names and arguments.
 * Factories are cached by source: statements with the same shape (constants live in `K`) reuse one
 * function literal, so V8 shares its feedback and optimized code instead of warming up again.
 */
function compileFn<T>(params: string[], src: string, args: unknown[]): T {
  const key = params.join(',') + '\n' + src;
  traced?.push(`pipeline(${params.join(', ')}):\n${src}`);
  let factory = pipelineFactories.get(key);
  if (factory === undefined) {
    factory = new Function(...params, `"use strict"; ${src}`) as (...args: unknown[]) => unknown;
    if (pipelineFactories.size > 500) pipelineFactories.clear();
    pipelineFactories.set(key, factory);
  }
  return factory(...args) as T;
}

/**
 * Generate one function that scans every leaf of a table, decodes the needed columns, evaluates
 * the WHERE conjuncts and steps the aggregates — no per-row operator calls.
 */
export function generateFusedAggregate(
  preds: BoundExpr[],
  aggs: FusedAggSpec[],
  source: PipelineSource,
  helpers: FusedHelpers | ColumnarHelpers,
  fallback: (e: BoundExpr) => FallbackNode,
): (r: SqlValue[], states: unknown[]) => void {
  const pl = new Pipeline(fallback);
  pl.addPredicates(preds);
  pl.addAggregates(aggs, (i) => `S${i}`);
  const src = [...aggs.map((_, i) => `const S${i} = S[${i}];`), ...scanLoop(pl, source)].join('\n');
  return compileFn(['H', 'K', 'T'], `return function smaltFusedAggregate(r, S) {\n${src}\n};`, [helpers, pl.em.consts, truthy]);
}

/** A columnar scan's decode list (column, register pairs) and rowid registers. */
export interface ColumnSource {
  decode: number[];
  rowidRegs: number[];
  /** Columnar table segments: rowids come from a stored column and deleted rows are skipped. */
  segments?: boolean;
}

/** Helpers for generated loops over a column store (one execution: `open` evaluates zone-map values). */
export interface ColumnarHelpers extends CodegenHelpers {
  open(r: SqlValue[]): void;
  /** Rows per full row group (rowid = rg * RG + i + 1). */
  readonly RG: number;
  groups(): number;
  /** False when the row group's zone maps rule it out. */
  keep(g: number): boolean;
  rows(g: number): number;
  chunk(g: number, col: number): unknown;
  /** Columnar table segments: stored rowids of a row group. */
  rowids?(g: number): ArrayLike<SqlValue>;
  /** Columnar table segments: per-row deleted flags of a row group (null: none deleted). */
  deleted?(g: number): Uint8Array | null;
}

/** Where a generated pipeline reads rows from: leaf pages of a row table, or a column store. */
export type PipelineSource = { rows: () => LoaderSpec } | { columns: () => ColumnSource };

/** The full scan loop around `pl.rowLines` for either source. */
function scanLoop(pl: Pipeline, source: PipelineSource): string[] {
  if ('rows' in source) {
    const { prologue, rowStart } = pl.finish(source.rows());
    return [
      ...prologue,
      'let f = H.first();',
      'try {',
      '  while (f !== null) {',
      '    const b = f.bytes; const dv = f.view; const n = b[2] | (b[3] << 8);',
      '    for (let i = 0; i < n; i++) {',
      ...rowStart.map((l) => '      ' + l),
      ...pl.rowLines.map((l) => '      ' + l),
      '    }',
      '    f = H.next(f);',
      '  }',
      '} finally { if (f !== null) H.release(f); }',
    ];
  }
  const { prologue, groupStart, rowStart, dense } = pl.finishColumnar(source.columns());
  const loop = (start: string[]): string[] => ['for (let i = 0; i < n; i++) {', ...start.map((l) => '  ' + l), ...pl.rowLines.map((l) => '  ' + l), '}'];
  return [
    ...prologue,
    'H.open(r);',
    'const ng = H.groups();',
    'for (let g = 0; g < ng; g++) {',
    '  if (!H.keep(g)) continue;',
    '  const n = H.rows(g); const base = g * H.RG;',
    ...groupStart.map((l) => '  ' + l),
    ...(dense ? [`  if (${dense.test}) {`, ...loop(dense.rowStart).map((l) => '    ' + l), '  } else {', ...loop(rowStart).map((l) => '    ' + l), '  }'] : loop(rowStart).map((l) => '  ' + l)),
    '}',
  ];
}

/** Resumable scan state for generated scan + filter pipelines. */
export interface ScanState {
  f: { bytes: Uint8Array; view: DataView } | null;
  i: number;
}

/**
 * Generate `fill(st, r, out)`: continues the scan from `st`, and for each row passing the WHERE
 * conjuncts writes the values of `outRegs` into `out` (row-major), up to `cap` rows. Returns the
 * number of rows written (0 = scan finished). The current leaf stays pinned in `st.f` between calls.
 */
export function generateScanFilter(
  preds: BoundExpr[],
  outRegs: { reg: number; type: StaticType }[],
  cap: number,
  loaderSpec: () => LoaderSpec,
  helpers: FusedHelpers,
  fallback: (e: BoundExpr) => FallbackNode,
): (st: ScanState, r: SqlValue[], out: SqlValue[]) => number {
  const pl = new Pipeline(fallback);
  pl.addPredicates(preds);
  const w = outRegs.length;
  const writes = outRegs.map((o, j) => `out[k * ${w} + ${j}] = ${pl.regValue(o.reg, o.type)};`);
  const { prologue, rowStart } = pl.finish(loaderSpec());
  const src = [
    ...prologue,
    'let f = st.f; let i = st.i; let k = 0;',
    'while (f !== null) {',
    '  const b = f.bytes; const dv = f.view; const n = b[2] | (b[3] << 8);',
    '  for (; i < n; i++) {',
    ...rowStart.map((l) => '    ' + l),
    ...pl.rowLines.map((l) => '    ' + l),
    `    ${writes.join(' ')}`,
    '    k++;',
    `    if (k === ${cap}) { st.i = i + 1; return k; }`,
    '  }',
    '  f = H.next(f); st.f = f; i = 0; st.i = 0;',
    '}',
    'return k;',
  ].join('\n');
  return compileFn(['H', 'K', 'T'], `return function smaltScanFilter(st, r, out) {\n${src}\n};`, [helpers, pl.em.consts, truthy]);
}

/** Group lookup helpers for generated GROUP BY pipelines. */
export interface GroupHelpers {
  hashKey: (v: SqlValue, collation: number) => unknown;
  hashKeyMulti: (values: SqlValue[], collations: number[]) => unknown;
}

/**
 * Generate `run(r, groups, order)`: scans the table, filters rows, computes the GROUP BY key,
 * finds or creates the group (`newGroup(keys)` returns `{ keys, st: AggregateState[] }`) and steps
 * its aggregates.
 */
export function generateGroupAggregate(
  preds: BoundExpr[],
  groupExprs: { expr: BoundExpr; collation: number }[],
  aggs: FusedAggSpec[],
  source: PipelineSource,
  helpers: (FusedHelpers | ColumnarHelpers) & GroupHelpers & { newGroup: (keys: SqlValue[]) => { keys: SqlValue[]; st: unknown[] } },
  fallback: (e: BoundExpr) => FallbackNode,
): (r: SqlValue[], groups: Map<unknown, unknown>, order: unknown[]) => void {
  const pl = new Pipeline(fallback);
  pl.addPredicates(preds);
  const em = pl.em;
  const keyLines: string[] = [];
  const keyVals: string[] = [];
  let keyExpr: string;
  const gens = groupExprs.map((g) => em.gen(g.expr));
  keyLines.push(...pl.take());
  gens.forEach((g, j) => keyLines.push(`const kv${j} = ${em.value(g)};`) && keyVals.push(`kv${j}`));
  if (gens.length === 1) {
    const g = gens[0];
    // Numbers hash to themselves (as hashKey does); other values go through hashKey (collations, blobs).
    keyExpr = isNum(g.type) ? `kv0` : `H.hashKey(kv0, ${groupExprs[0].collation})`;
  } else {
    keyExpr = `H.hashKeyMulti([${keyVals.join(', ')}], [${groupExprs.map((g) => g.collation).join(', ')}])`;
  }
  pl.rowLines.push(...keyLines, `const key = ${keyExpr};`, 'let G = groups.get(key);', `if (G === undefined) { G = H.newGroup([${keyVals.join(', ')}]); groups.set(key, G); order.push(G); }`, 'const GS = G.st;');
  pl.addAggregates(aggs, (i) => `GS[${i}]`);
  const src = scanLoop(pl, source).join('\n');
  return compileFn(['H', 'K', 'T'], `return function smaltGroupAggregate(r, groups, order) {\n${src}\n};`, [helpers, pl.em.consts, truthy]);
}
