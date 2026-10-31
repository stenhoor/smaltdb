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
}

export interface CodegenHelpers {
  /** arith['+'], arith['+R'] (forced REAL), ... — the closure compiler's slow paths. */
  arith: Record<string, (x: SqlValue, y: SqlValue) => SqlValue>;
  negate: (v: SqlValue) => SqlValue;
}

interface Gen {
  /** JS expression (identifier or literal) holding the value. */
  v: string;
  type: StaticType;
}

const ARITH = new Set(['+', '-', '*', '/', '%']);
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

  private viaFallback(e: Expr): Gen {
    const c = this.fallback(e);
    if (c.reg !== undefined) return { v: `r[${c.reg}]`, type: c.type };
    if (c.constant) return this.literal(c.fn([]), c.type);
    const v = this.tmp();
    this.lines.push(`const ${v} = ${this.konst(c.fn)}(r);`);
    return { v, type: c.type };
  }

  private literal(value: SqlValue, type: StaticType): Gen {
    if (value === null) return { v: 'null', type: 'null' };
    if (typeof value === 'number' && Number.isFinite(value)) return { v: Object.is(value, -0) ? '0' : `(${String(value)})`, type };
    return { v: this.konst(value), type };
  }

  /** Emit `e`; returns null when the node is not natively supported (caller falls back). */
  gen(e: Expr): Gen {
    const g = this.groupReg(e);
    if (g) return { v: `r[${g.reg}]`, type: g.type };
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
          return this.viaFallback(e);
        }
        return this.viaFallback(e);
      case 'unary':
        if (e.op === 'NOT') {
          const a = this.gen(e.operand);
          const v = this.tmp();
          this.lines.push(`const ${v} = ${this.truthyExpr(a)}; const n${v} = ${v} === null ? null : ${v} ? 0 : 1;`);
          return { v: 'n' + v, type: 'int' };
        }
        if (e.op === '-') {
          const a = this.gen(e.operand);
          const v = this.tmp();
          this.lines.push(`const ${v} = (typeof ${a.v} === 'number' && ${a.v} !== 0) ? -${a.v} : H.negate(${a.v});`);
          return { v, type: isNum(a.type) ? a.type : 'num' };
        }
        return this.viaFallback(e);
      default:
        return this.viaFallback(e);
    }
  }

  private truthyExpr(a: Gen): string {
    if (isNum(a.type) || a.type === 'null') return `(${a.v} === null ? null : ${a.v} != 0)`;
    return `T(${a.v})`;
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

  private compare(op: string, a: Gen, b: Gen): Gen {
    const jsOp = op === '=' ? '==' : op === '!=' ? '!=' : op;
    const v = this.tmp();
    this.lines.push(`const ${v} = (${a.v} === null || ${b.v} === null) ? null : (${a.v} ${jsOp} ${b.v} ? 1 : 0);`);
    return { v, type: 'int' };
  }

  private arith(op: string, a: Gen, b: Gen): Gen {
    const real = a.type === 'real' || b.type === 'real';
    const bothInt = a.type === 'int' && b.type === 'int';
    const type: StaticType = real ? 'real' : bothInt ? 'int' : 'num';
    const slow = `H.arith[${JSON.stringify(op + (real ? 'R' : ''))}]`;
    const x = a.v;
    const y = b.v;
    const v = this.tmp();
    let intFast: string;
    switch (op) {
      case '/':
        intFast = `if (${y} === 0) ${v} = null; else if (${x} > -2147483648 && ${x} < 2147483648 && ${y} > -2147483648 && ${y} < 2147483648) ${v} = Math.trunc(${x} / ${y}) + 0; else ${v} = ${slow}(${x}, ${y});`;
        break;
      case '%':
        intFast = `if (${y} === 0) ${v} = null; else if (${y} === -1) ${v} = 0; else ${v} = (${x} % ${y}) + 0;`;
        break;
      default:
        intFast = `{ const z = ${x} ${op} ${y}; ${v} = Number.isSafeInteger(z) ? z + 0 : ${slow}(${x}, ${y}); }`;
    }
    let realFast: string;
    switch (op) {
      case '/':
        realFast = `if (${y} === 0) ${v} = null; else { const z = ${x} / ${y}; ${v} = z === z ? z : null; }`;
        break;
      case '%':
        realFast = `${v} = ${slow}(${x}, ${y});`;
        break;
      default:
        realFast = `{ const z = ${x} ${op} ${y}; ${v} = z === z ? z : null; }`;
    }
    const fast = real ? realFast : bothInt ? intFast : `if (Number.isSafeInteger(${x}) && Number.isSafeInteger(${y})) { ${intFast} } else { ${realFast} }`;
    this.lines.push(
      `let ${v}; if (${x} === null || ${y} === null) ${v} = null; else if (typeof ${x} === 'number' && typeof ${y} === 'number') { ${fast} } else ${v} = ${slow}(${x}, ${y});`,
    );
    return { v, type };
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
  const body = `${em.lines.join('\n')}\nreturn ${g.v};`;
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
export function generateLoader(spec: LoaderSpec, helpers: LoaderHelpers): Loader {
  const n = spec.types.length;
  const bitmap = (n + 7) >>> 3;
  const L: string[] = [];
  L.push('const p = c.page; const b = p.bytes; const dv = p.view; const off = c.cellOffset();');
  L.push('if (b[off + 2] & 1) return false;'); // overflow value
  L.push('const kl = b[off] | (b[off + 1] << 8); const vo = off + 7 + kl;');
  if (spec.decode.length > 0) {
    L.push(`if ((b[vo + 1] | (b[vo + 2] << 8)) !== ${n}) return false;`);
    L.push(`const bm = vo + 3; const fx = bm + ${bitmap}; const vt = fx + ${spec.fixedSize};`);
    const needsVar = spec.decode.some((_, i) => i % 2 === 0 && !(spec.types[spec.decode[i]] === 'INTEGER' || spec.types[spec.decode[i]] === 'REAL'));
    if (needsVar) L.push(`const wide = (b[vo] & 1) === 1; const vd = vt + ${spec.varCount} * (wide ? 4 : 2);`);
    for (let i = 0; i < spec.decode.length; i += 2) {
      const col = spec.decode[i];
      const reg = spec.decode[i + 1];
      const t = spec.types[col];
      const s = spec.slots[col];
      const isNull = `(b[bm + ${col >>> 3}] & ${1 << (col & 7)}) !== 0`;
      let value: string;
      if (t === 'INTEGER') {
        const o = `fx + ${s}`;
        value =
          // Values that fit in int32 are produced as int32 so V8 keeps them as small integers (fast % and /).
          `{ const o = ${o}; const lo = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24); const hi = b[o + 4] | (b[o + 5] << 8) | (b[o + 6] << 16) | (b[o + 7] << 24);` +
          ` r[${reg}] = (hi === 0 && lo >= 0) || (hi === -1 && lo < 0) ? lo : (hi >= -2097152 && hi <= 2097151) ? hi * 4294967296 + (lo >>> 0) : H.readInt64(dv, o); }`;
      } else if (t === 'REAL') {
        value = `r[${reg}] = dv.getFloat64(fx + ${s}, true);`;
      } else {
        const end = (j: number): string => `(wide ? dv.getUint32(vt + ${4 * j}, true) : (b[vt + ${2 * j}] | (b[vt + ${2 * j + 1}] << 8)))`;
        const start = s === 0 ? 'vd' : `vd + ${end(s - 1)}`;
        const fin = `vd + ${end(s)}`;
        if (t === 'TEXT') value = `r[${reg}] = H.utf8(b, ${start}, ${fin});`;
        else if (t === 'BLOB') value = `r[${reg}] = b.slice(${start}, ${fin});`;
        else value = `r[${reg}] = H.tagged(b, dv, ${start}, ${fin});`;
      }
      L.push(`if (${isNull}) r[${reg}] = null; else ${value}`);
    }
  }
  if (spec.rowidRegs.length > 0) {
    L.push('const id = H.rowid(b, off + 7);');
    for (const reg of spec.rowidRegs) L.push(`r[${reg}] = id;`);
  }
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
