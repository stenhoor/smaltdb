import type { Expr } from '../sql/ast.js';
import type { SqlValue } from '../values.js';
import { type StaticType, truthy } from './convert.js';

/**
 * Expression code generation (ADR 0001 decision 5). Arithmetic, numeric comparisons and boolean
 * logic are emitted as straight-line JavaScript with fast paths chosen from static types, so each
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

const ARITH = new Set(['+', '-', '*', '/', '%']);
const utf8Encoder = new TextEncoder();
const CMP = new Set(['=', '!=', '<', '<=', '>', '>=']);
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

/** Worth generating code for: arithmetic, numeric comparison or boolean logic at the root. */
export function isCodegenRoot(e: Expr): boolean {
  if (e.kind === 'binary') return ARITH.has(e.op) || CMP.has(e.op) || e.op === 'AND' || e.op === 'OR';
  if (e.kind === 'unary') return e.op === 'NOT' || e.op === '-';
  return false;
}

type Factory = (H: CodegenHelpers, K: unknown[], T: typeof truthy) => (r: SqlValue[]) => SqlValue;
const factories = new Map<string, Factory>();

class Emitter {
  lines: string[] = [];
  private n = 0;
  readonly consts: unknown[] = [];

  constructor(
    private readonly fallback: (e: Expr) => FallbackNode,
    private readonly groupReg: (e: Expr) => { reg: number; type: StaticType } | undefined,
  ) {}

  private tmp(): string {
    return 'v' + this.n++;
  }

  private konst(x: unknown): string {
    this.consts.push(x);
    return `K[${this.consts.length - 1}]`;
  }

  /** How generated code reads register `reg` (fused pipelines map decoded columns to flagged locals). */
  regRef: (reg: number, type: StaticType) => { v: string; nul?: string } = (reg) => ({ v: `r[${reg}]` });
  /** Set when a closure-compiled node was emitted: it reads the register file directly. */
  usesRegisterFile = false;

  private reg(reg: number, type: StaticType): Gen {
    return { ...this.regRef(reg, type), type };
  }

  private viaFallback(e: Expr): Gen {
    const c = this.fallback(e);
    if (c.reg !== undefined) return this.reg(c.reg, c.type);
    if (c.constant) return this.literal(c.fn([]), c.type);
    this.usesRegisterFile = true;
    const v = this.tmp();
    this.lines.push(`const ${v} = ${this.konst(c.fn)}(r);`);
    return { v, type: c.type };
  }

  private literal(value: SqlValue, type: StaticType): Gen {
    if (value === null) return { v: '0', nul: 'true', type: 'null' };
    if (typeof value === 'number' && Number.isFinite(value)) return { v: Object.is(value, -0) ? '0' : `(${String(value)})`, nul: 'false', type };
    return { v: this.konst(value), nul: 'false', type };
  }

  /** Emit `e` (unsupported node kinds go through the closure compiler). */
  gen(e: Expr): Gen {
    const g = this.groupReg(e);
    if (g) return this.reg(g.reg, g.type);
    switch (e.kind) {
      case 'literal':
        return this.literal(e.value, typeof e.value === 'number' ? (e.isReal || !Number.isSafeInteger(e.value) ? 'real' : 'int') : typeof e.value === 'bigint' ? 'int' : e.value === null ? 'null' : typeof e.value === 'string' ? 'text' : 'blob');
      case 'binary':
        if (ARITH.has(e.op)) return this.arith(e.op, this.gen(e.left), this.gen(e.right));
        if (e.op === 'AND' || e.op === 'OR') return this.logic(e.op, e.left, e.right);
        if (CMP.has(e.op)) {
          // Numeric comparisons only; anything involving text/affinity/collation uses the closure compiler.
          const saved = this.lines;
          this.lines = [];
          const a = this.gen(e.left);
          const b = this.gen(e.right);
          const inner = this.lines;
          this.lines = saved;
          if (isNum(a.type) && isNum(b.type)) {
            this.lines.push(...inner);
            return this.compare(e.op, a, b);
          }
          if ((e.op === '=' || e.op === '!=') && a.type === 'text' && b.type === 'text' && this.binaryTextOperands(e.left, e.right)) {
            // Text = text under BINARY: UTF-16 equality is UTF-8 byte equality, so compare JS strings.
            this.lines.push(...inner);
            const v = this.tmp();
            const nul = orNull(nullOf(a), nullOf(b));
            this.lines.push(`const ${v}n = ${nul}; const ${v} = ${v}n ? 0 : (${a.v} ${e.op === '=' ? '===' : '!=='} ${b.v} ? 1 : 0);`);
            return { v, nul: `${v}n`, type: 'int' };
          }
          return this.viaFallback(e);
        }
        return this.viaFallback(e);
      case 'unary':
        if (e.op === 'NOT') {
          const a = this.gen(e.operand);
          const v = this.tmp();
          if (isNum(a.type) || a.type === 'null') {
            const nul = nullOf(a);
            this.lines.push(`const ${v}n = ${nul}; const ${v} = ${v}n ? 0 : (${a.v} != 0 ? 0 : 1);`);
            return { v, nul: `${v}n`, type: 'int' };
          }
          this.lines.push(`const ${v} = T(${plain(a)}); const n${v} = ${v} === null ? null : ${v} ? 0 : 1;`);
          return { v: 'n' + v, type: 'int' };
        }
        if (e.op === '-') {
          const a = this.gen(e.operand);
          const v = this.tmp();
          this.lines.push(
            `let ${v}n = ${nullOf(a)}; let ${v} = 0; if (!${v}n) { const x = ${a.v}; if (typeof x === 'number') ${v} = x === 0 ? 0 : -x; else { const s = H.negate(x); if (s === null) ${v}n = true; else ${v} = s; } }`,
          );
          return { v, nul: `${v}n`, type: isNum(a.type) ? a.type : 'num' };
        }
        return this.viaFallback(e);
      default:
        return this.viaFallback(e);
    }
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

  private logic(op: 'AND' | 'OR', le: Expr, re: Expr): Gen {
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
  fallbackOf(e: Expr): FallbackNode {
    return this.fallback(e);
  }

  /** Register a constant; returns its JS expression. */
  constant(x: unknown): string {
    return this.konst(x);
  }

  /** Both comparison operands use BINARY collation and neither applies numeric affinity. */
  binaryTextOperands(l: Expr, r: Expr): boolean {
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
    this.lines.push(
      `let ${vn} = ${orNull(nullOf(a), nullOf(b))}; let ${v} = 0; if (!${vn}) { const ${x} = ${a.v}; const ${y} = ${b.v}; if (typeof x === 'number' && typeof y === 'number') { ${fast} } else ${slow} }`,
    );
    return { v, nul: vn, type };
  }
}

/**
 * Generate a function for `e`. `fallback` compiles a node with the closure compiler; `groupReg`
 * maps GROUP BY expressions to registers in post-aggregation scopes.
 */
export function generate(
  e: Expr,
  helpers: CodegenHelpers,
  fallback: (e: Expr) => FallbackNode,
  groupReg: (e: Expr) => { reg: number; type: StaticType } | undefined,
): { fn: (r: SqlValue[]) => SqlValue; type: StaticType; source: string } {
  const em = new Emitter(fallback, groupReg);
  const g = em.gen(e);
  const body = `${em.lines.join('\n')}\nreturn ${em.value(g)};`;
  let factory = factories.get(body);
  if (factory === undefined) {
    factory = new Function('H', 'K', 'T', `"use strict"; return function smaltExpr(r) {\n${body}\n};`) as Factory;
    if (factories.size > 2000) factories.clear();
    factories.set(body, factory);
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
export function generateLoader(spec: LoaderSpec, helpers: LoaderHelpers): Loader {
  const L: string[] = [];
  L.push('const p = c.page; const b = p.bytes; const dv = p.view; const off = c.cellOffset();');
  L.push(`if (!(${cellIsFast(spec)})) return false;`);
  emitDecode(spec, L);
  L.push('return true;');
  const body = L.join('\n');
  let factory = loaderFactories.get(body);
  if (factory === undefined) {
    factory = new Function('H', `"use strict"; return function smaltLoad(c, r) {\n${body}\n};`) as (H: LoaderHelpers) => Loader;
    if (loaderFactories.size > 500) loaderFactories.clear();
    loaderFactories.set(body, factory);
  }
  return factory(helpers);
}

// ------------------------------------------------------------------ fused scan + filter + aggregate

export interface FusedAggSpec {
  kind: 'countStar' | 'count' | 'step';
  /** Argument expression (count/step). */
  arg?: Expr;
  filter?: Expr;
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

  constructor(fallback: (e: Expr) => FallbackNode) {
    this.em = new Emitter(fallback, () => undefined);
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
  addPredicates(preds: Expr[]): void {
    for (const p of preds) {
      const eq = this.textEqualityConjunct(p);
      if (eq) this.textEq.push(eq);
      const g = this.em.gen(p);
      this.rowLines.push(...this.take(), `if (!${this.em.isTrue(g)}) continue;`);
    }
  }

  private textEqualityConjunct(p: Expr): { reg: number; bytes: Uint8Array } | null {
    if (p.kind !== 'binary' || p.op !== '=') return null;
    for (const [col, lit] of [
      [p.left, p.right],
      [p.right, p.left],
    ] as const) {
      if (lit.kind !== 'literal' || typeof lit.value !== 'string') continue;
      const c = this.em.fallbackOf(col);
      if (c.reg === undefined || c.type !== 'text' || !this.em.binaryTextOperands(col, lit)) continue;
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
        body.push(...this.take());
        body.push(a.kind === 'count' ? `if (!${em.isNull(g)}) ${state(i)}.n++;` : `${state(i)}.step1(${em.value(g)});`);
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
  preds: Expr[],
  aggs: FusedAggSpec[],
  source: PipelineSource,
  helpers: FusedHelpers | ColumnarHelpers,
  fallback: (e: Expr) => FallbackNode,
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
  preds: Expr[],
  outRegs: { reg: number; type: StaticType }[],
  cap: number,
  loaderSpec: () => LoaderSpec,
  helpers: FusedHelpers,
  fallback: (e: Expr) => FallbackNode,
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
  preds: Expr[],
  groupExprs: { expr: Expr; collation: number }[],
  aggs: FusedAggSpec[],
  source: PipelineSource,
  helpers: (FusedHelpers | ColumnarHelpers) & GroupHelpers & { newGroup: (keys: SqlValue[]) => { keys: SqlValue[]; st: unknown[] } },
  fallback: (e: Expr) => FallbackNode,
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
