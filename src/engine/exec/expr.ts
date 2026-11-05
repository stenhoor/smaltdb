import { SmaltError } from '../errors.js';
import { storageTypeFor } from '../catalog/schema.js';
import type { CallExpr, ColumnExpr, Expr, SelectStmt } from '../sql/ast.js';
import { Collation, type SqlValue, collationByName } from '../values.js';
import {
  type Affinity,
  type StaticType,
  affinityOfStorage,
  applyNumericAffinity,
  applyTextAffinity,
  staticTypeOfStorage,
  truthy,
} from './convert.js';
import { currentTimeText } from './datetime.js';
import { ARITHMETIC_FUNCTIONS, BITWISE_FUNCTIONS, COMPARISON_FUNCTIONS, arithImpl, negate, sqlFunction } from './sql-functions.js';
import { type CompiledArg, type Fn, type FunctionContext, aggregateFunctions, scalarFunctions } from './functions.js';
import { type CodegenHelpers, type FallbackNode, codegenEnabled, generate, generatedType, isCodegenRoot } from './codegen.js';
import { WINDOW_ARITY } from './window.js';
import { type SqlMeta, getMeta, setMeta } from './sql-meta.js';
import { type BoundExpr, call, lit, param, typeOf } from '../plan/expr.js';
import type { CollationName } from '../plan/types.js';
import type { PlanOp } from '../plan/ops.js';
import { decodeTagged, decodeUtf8, readInt64 } from '../storage/record.js';
import { readRowidKey } from '../storage/key-codec.js';

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
  /** Set when the value is a plain register read (lets generated code inline it). */
  reg?: number;
}

export interface ColumnBinding {
  reg: number;
  type: StaticType;
  collation: Collation;
  affinity: Affinity;
  /** The name resolved to a select-list alias: use this compiled expression instead of a register. */
  compiled?: Compiled;
  /**
   * Resolved with `defer`: marks the column as read (projection pushdown), for when the expression is compiled.
   * Without `defer`, resolving marks it at once.
   */
  use?: () => void;
  /** The name resolved to a select-list alias, bound by the SQL front end: use this plan expression. */
  bound?: BoundExpr;
}

/** Name resolution and planner callbacks used while compiling expressions. */
export interface CompileScope {
  /**
   * Resolve a column name. With `defer`, the column is marked as read only when the binding's `use` runs (the binder
   * calls it from compiling); scopes that don't support deferring may ignore it and mark at once.
   */
  resolveColumn(e: ColumnExpr, defer?: boolean): ColumnBinding;
  /** Post-aggregation context: maps an aggregate call (or GROUP BY expression) to its register. */
  aggregateRef?(call: CallExpr): ColumnBinding;
  groupRef?(e: Expr): ColumnBinding | undefined;
  /** Result-column context of a query with window functions: maps an `f(...) OVER (...)` call to its register. */
  windowRef?(call: CallExpr): ColumnBinding;
  scalarSubquery(select: SelectStmt): Compiled;
  existsSubquery(select: SelectStmt): Fn;
  /** Returns membership test: 1, 0, or NULL (SQL IN semantics) for a probe value. */
  inSubquery(select: SelectStmt, probe: Compiled): Fn;
  /**
   * The SQL front end (ADR 0014, step 5): plan a subquery as a nested plan instead of compiling it. Given, the binder
   * produces `subquery` / `inSubquery` plan nodes; `column` is the scalar subquery's first result column.
   */
  planSubquery?(select: SelectStmt, mode: 'scalar' | 'exists' | 'in'): { plan: PlanOp; column: { type: StaticType; collation: Collation } };
  funcCtx: FunctionContext;
}

const NO_REGS: SqlValue[] = [];

function konst(v: SqlValue, type: StaticType, affinity: Affinity = 'NONE'): Compiled {
  return { fn: () => v, type, collation: Collation.Binary, collSrc: CollSrc.None, affinity, constant: true };
}

function literalType(v: SqlValue, isReal: boolean | undefined): StaticType {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'number':
      return isReal || !Number.isSafeInteger(v) ? 'real' : 'int';
    case 'bigint':
      return 'int';
    case 'string':
      return 'text';
    default:
      return 'blob';
  }
}

/**
 * Fold a node whose inputs are all constant (and deterministic). A node whose evaluation raises
 * is left unfolded (and no longer constant), so the error is raised only if it runs: it may sit in
 * a branch that never does, e.g. `CASE WHEN 1 THEN 1 ELSE abs(-9223372036854775808) END`.
 */
function fold(c: Compiled): Compiled {
  if (!c.constant) return c;
  let v: SqlValue;
  try {
    v = c.fn(NO_REGS);
  } catch {
    return { ...c, constant: false };
  }
  return { ...c, fn: () => v };
}

function isNumericType(t: StaticType): boolean {
  return t === 'int' || t === 'real' || t === 'num';
}

/** Compile a bound expression: generated code for arithmetic / comparison / logic roots, otherwise closures. */
export function compileBoundExpr(b: BoundExpr, ctx: FunctionContext): Compiled {
  if (!codegenEnabled() || !isCodegenRoot(b)) return compilePlanExpr(b, ctx);
  if (b.k === 'call' && !b.fn.startsWith('sql.')) {
    // A math call: keep the closure compiler's result when it is constant (folded) or a register read.
    const c = compilePlanExpr(b, ctx);
    if (c.constant || c.reg !== undefined) return c;
  }
  const g = generate(b, CODEGEN_HELPERS, (x) => compilePlanExpr(x, ctx));
  return { fn: g.fn, type: g.type, collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE', constant: false };
}

/**
 * The static metadata `compileBoundExpr` gives a bound expression (type, collation, affinity), without generating
 * code: the SQL front end (ADR 0014, step 5) derives its result columns' metadata exactly as the planner does.
 */
export function boundMetadata(b: BoundExpr, ctx: FunctionContext): Pick<Compiled, 'type' | 'collation' | 'collSrc' | 'affinity'> {
  if (!codegenEnabled() || !isCodegenRoot(b)) return compilePlanExpr(b, ctx);
  if (b.k === 'call' && !b.fn.startsWith('sql.')) {
    const c = compilePlanExpr(b, ctx);
    if (c.constant || c.reg !== undefined) return c;
  }
  // Generated code carries no collation or affinity.
  return { type: generatedType(b, (x) => compilePlanExpr(x, ctx)), collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE' };
}

/** How fused pipelines compile a node of a bound expression with the closure compiler. */
export function pipelineCompiler(ctx: FunctionContext): (e: BoundExpr) => FallbackNode {
  return (e) => compilePlanExpr(e, ctx);
}

/** True if a bound expression runs a subquery (fused pipelines leave those to the operators). */
export function planHasSubquery(e: BoundExpr): boolean {
  switch (e.k) {
    case 'native':
      return e.subquery === true;
    case 'call':
    case 'and':
    case 'or':
      return e.args.some(planHasSubquery);
    case 'cast':
    case 'not':
    case 'isNull':
      return planHasSubquery(e.arg);
    case 'case':
      return e.whens.some((w) => planHasSubquery(w.when) || planHasSubquery(w.then)) || planHasSubquery(e.else);
    case 'subquery':
    case 'inSubquery':
      return true;
    default:
      return false;
  }
}

const CODEGEN_HELPERS: CodegenHelpers = {
  arith: Object.fromEntries(['+', '-', '*', '/', '%'].flatMap((op) => [[op, arithImpl(op, false)], [op + 'R', arithImpl(op, true)]])),
  negate: (v) => negate(v),
};

// ------------------------------------------------------------------ binding and compiling

/**
 * The closure compiler (defines expression semantics): binds the parser's expression to a plan expression
 * (`bindExpr`), then compiles that (`compilePlanExpr`).
 */
export function compileNode(e: Expr, scope: CompileScope): Compiled {
  return compilePlanExpr(bindExpr(e, scope), scope.funcCtx);
}


const NO_META: SqlMeta = { collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE' };


const COLLATION_NAMES: readonly CollationName[] = ['binary', 'nocase', 'rtrim'];
const collationName = (c: Collation): CollationName => COLLATION_NAMES[c];
const collationId = (n: CollationName | undefined): Collation => (n === 'nocase' ? Collation.NoCase : n === 'rtrim' ? Collation.RTrim : Collation.Binary);

function withMeta<T extends BoundExpr>(e: T, m: SqlMeta): T {
  if (m.collation !== Collation.Binary || m.collSrc !== CollSrc.None || m.affinity !== 'NONE' || m.opaque) setMeta(e, m);
  return e;
}

const metaOf = (e: BoundExpr): SqlMeta => getMeta(e) ?? NO_META;

/** A copy of `e` carrying the SQL metadata of `c` (the SQL front end: a select-list alias, as the planner compiled it). */
export function withCompiledMeta(e: BoundExpr, c: Pick<Compiled, 'collation' | 'collSrc' | 'affinity'>): BoundExpr {
  const copy = { ...e };
  setMeta(copy, { ...metaOf(e), collation: c.collation, collSrc: c.collSrc, affinity: c.affinity });
  return copy;
}

/** Mark `e` as an SQL form that code generation leaves to the closure compiler (see SqlMeta.opaque). */
function opaque<T extends BoundExpr>(e: T): T {
  setMeta(e, { ...metaOf(e), opaque: true });
  return e;
}

/** The parts of a bound expression the SQL rules for comparisons read. */
const operand = (e: BoundExpr): SqlOperand => {
  const m = metaOf(e);
  return { type: typeOf(e), collation: m.collation, collSrc: m.collSrc, affinity: m.affinity };
};

const AFFINITY_CALLS = new Set(['sql.affinity_numeric', 'sql.affinity_text']);

/** `left op right` with SQLite's collation and affinity rules made explicit: a collation attribute and conversion calls. */
function bindComparison(op: string, a: BoundExpr, b: BoundExpr): BoundExpr {
  const oa = operand(a);
  const ob = operand(b);
  const coll = comparisonCollation(oa, ob);
  const [ca, cb] = comparisonConverters(oa, ob);
  const wrap = (x: BoundExpr, conv: unknown): BoundExpr =>
    conv === null ? x : call(conv === applyNumericAffinity ? 'sql.affinity_numeric' : 'sql.affinity_text', [x], typeOf(x));
  return call(COMPARISON_FUNCTIONS[op], [wrap(a, ca), wrap(b, cb)], 'int', collationName(coll));
}

/**
 * Bind an expression of the parser to a plan expression: resolve its names, type it, and make SQL's rules explicit
 * (comparison collations, affinity conversions, the `sql.*` function for each operator). Subqueries are planned and
 * select-list aliases compiled here, at the moment the closure compiler always did, so planning order, registers
 * and errors are unchanged.
 */
export function bindExpr(e: Expr, scope: CompileScope): BoundExpr {
  if (scope.groupRef) {
    const g = scope.groupRef(e);
    if (g) return withMeta({ k: 'slot', reg: g.reg, type: g.type }, { collation: g.collation, collSrc: g.collation ? CollSrc.Column : CollSrc.None, affinity: g.affinity });
  }
  switch (e.kind) {
    case 'literal':
      return lit(e.value, literalType(e.value, e.isReal));
    case 'param':
      return param(e.index - 1);
    case 'column': {
      const b = scope.resolveColumn(e, true);
      if (b.bound) return b.bound;
      if (b.compiled) return native(b.compiled);
      const slot: BoundExpr = b.use ? { k: 'slot', reg: b.reg, type: b.type, use: b.use } : { k: 'slot', reg: b.reg, type: b.type };
      return withMeta(slot, { collation: b.collation, collSrc: CollSrc.Column, affinity: b.affinity });
    }
    case 'collate': {
      const inner = bindExpr(e.expr, scope);
      const c = collationByName(e.collation);
      if (c === undefined) throw new SmaltError('SMALT_ERROR', `no such collation sequence: ${e.collation}`);
      return withMeta({ ...inner }, { ...metaOf(inner), collation: c, collSrc: CollSrc.Explicit, opaque: true });
    }
    case 'unary': {
      const x = bindExpr(e.operand, scope);
      switch (e.op) {
        case 'NOT':
          return { k: 'not', arg: x };
        case '-':
          return call('sql.neg', [x], isNumericType(typeOf(x)) ? typeOf(x) : 'num');
        case '~':
          return call('sql.bitnot', [x], 'int');
        case '+':
          // Unary plus is a no-op that strips affinity and collation (SQLite): the same value, without the metadata.
          return opaque(stripped({ ...x }));
        default:
          throw new SmaltError('SMALT_ERROR', `unknown unary operator ${(e as { op: string }).op}`);
      }
    }
    case 'binary':
      return bindBinary(e.op, bindExpr(e.left, scope), bindExpr(e.right, scope));
    case 'between': {
      const x = bindExpr(e.expr, scope);
      const lo = bindExpr(e.low, scope);
      const hi = bindExpr(e.high, scope);
      const both: BoundExpr = opaque({ k: 'and', args: [bindComparison('>=', x, lo), bindComparison('<=', x, hi)] });
      return e.not ? opaque({ k: 'not', arg: both }) : both;
    }
    case 'isNull':
      return { k: 'isNull', arg: bindExpr(e.expr, scope), not: e.not };
    case 'inList': {
      const x = bindExpr(e.expr, scope);
      const list = e.list.map((v) => bindExpr(v, scope));
      const inList = call('sql.in_list', [x, ...list], 'int');
      return e.not ? opaque({ k: 'not', arg: inList }) : inList;
    }
    case 'inSelect': {
      if (scope.planSubquery) {
        const probe = bindExpr(e.expr, scope);
        const sub = scope.planSubquery(e.select, 'in');
        const node: BoundExpr = { k: 'inSubquery', probe, plan: sub.plan, collation: 'binary' };
        return e.not ? { k: 'not', arg: node } : node;
      }
      const probe = compilePlanExpr(bindExpr(e.expr, scope), scope.funcCtx);
      const test = scope.inSubquery(e.select, probe);
      const fn: Fn = e.not
        ? (r) => {
            const v = test(r);
            return v === null ? null : v === 1 ? 0 : 1;
          }
        : test;
      return native({ fn, type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: false }, true);
    }
    case 'exists': {
      if (scope.planSubquery) {
        const node: BoundExpr = { k: 'subquery', mode: 'exists', plan: scope.planSubquery(e.select, 'exists').plan, type: 'int', collation: 'binary' };
        return e.not ? { k: 'not', arg: node } : node;
      }
      const f = scope.existsSubquery(e.select);
      const fn: Fn = e.not ? (r) => (f(r) === 1 ? 0 : 1) : f;
      return native({ fn, type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: false }, true);
    }
    case 'subquery': {
      if (scope.planSubquery) {
        const { plan, column } = scope.planSubquery(e.select, 'scalar');
        const node: BoundExpr = { k: 'subquery', mode: 'scalar', plan, type: column.type, collation: collationName(column.collation) };
        // As the compiled scalar subquery: its column's collation, from a column.
        return withMeta(node, { collation: column.collation, collSrc: column.collation ? CollSrc.Column : CollSrc.None, affinity: 'NONE' });
      }
      return native(scope.scalarSubquery(e.select), true);
    }
    case 'like': {
      const x = bindExpr(e.expr, scope);
      const pat = bindExpr(e.pattern, scope);
      const esc = e.escape ? bindExpr(e.escape, scope) : undefined;
      if (e.op !== 'LIKE' && e.op !== 'GLOB') throw new SmaltError('SMALT_ERROR', `no such function: ${e.op.toLowerCase()}`);
      const like = call(e.op === 'GLOB' ? 'sql.glob' : 'sql.like', esc ? [x, pat, esc] : [x, pat], 'int');
      return e.not ? opaque({ k: 'not', arg: like }) : like;
    }
    case 'case': {
      const base = e.base ? bindExpr(e.base, scope) : undefined;
      const whens = e.whens.map((w) => {
        const when = bindExpr(w.when, scope);
        return { when: base ? bindComparison('=', base, when) : when, then: bindExpr(w.then, scope) };
      });
      const els = e.else ? bindExpr(e.else, scope) : lit(null, 'null');
      const types = [...whens.map((w) => typeOf(w.then)), typeOf(els)].filter((t) => t !== 'null');
      let type: StaticType = types.length === 0 ? 'null' : types[0];
      for (const t of types) if (t !== type) type = isNumericType(t) && isNumericType(type) ? 'num' : 'any';
      return { k: 'case', whens, else: els, type };
    }
    case 'cast': {
      const x = bindExpr(e.expr, scope);
      const st = storageTypeFor(e.type);
      const affinity = st === 'ANY' ? 'NUMERIC' : affinityOfStorage(st);
      const to = st === 'ANY' || st === 'NUMERIC' ? 'num' : staticTypeOfStorage(st);
      const m = metaOf(x);
      return withMeta({ k: 'cast', fn: CAST_FUNCTIONS[st] ?? 'sql.cast_numeric', to, arg: x }, { collation: m.collation, collSrc: m.collSrc, affinity });
    }
    case 'call':
      return bindCall(e, scope);
  }
}

/** `e` with no SQL metadata, even where the node it copies had some (a compiled alias keeps its own otherwise). */
function stripped(e: BoundExpr): BoundExpr {
  setMeta(e, NO_META);
  return e;
}

function native(c: Compiled, subquery = false): BoundExpr {
  return subquery ? { k: 'native', compiled: c, type: c.type, subquery: true } : { k: 'native', compiled: c, type: c.type };
}

function bindBinary(op: string, a: BoundExpr, b: BoundExpr): BoundExpr {
  switch (op) {
    case 'AND':
      return { k: 'and', args: [a, b] };
    case 'OR':
      return { k: 'or', args: [a, b] };
    case '=':
    case '!=':
    case '<':
    case '<=':
    case '>':
    case '>=':
    case 'IS':
    case 'IS NOT':
      return bindComparison(op, a, b);
    case '+':
    case '-':
    case '*':
    case '/':
    case '%': {
      const ta = typeOf(a);
      const tb = typeOf(b);
      return call(ARITHMETIC_FUNCTIONS[op], [a, b], ta === 'real' || tb === 'real' ? 'real' : ta === 'int' && tb === 'int' ? 'int' : 'num');
    }
    case '||':
      return call('sql.concat', [a, b], 'text');
    case '&':
    case '|':
    case '<<':
    case '>>':
      return call(BITWISE_FUNCTIONS[op], [a, b], 'int');
    default:
      throw new SmaltError('SMALT_UNSUPPORTED', `operator ${op} is not supported yet`);
  }
}

const NO_FN: Fn = () => null;

function bindCall(e: CallExpr, scope: CompileScope): BoundExpr {
  if (e.over !== undefined) {
    if (!scope.windowRef) throw new SmaltError('SMALT_ERROR', `misuse of window function ${e.name}()`);
    const b = scope.windowRef(e);
    return withMeta({ k: 'slot', reg: b.reg, type: b.type }, { collation: b.collation, collSrc: CollSrc.None, affinity: 'NONE' });
  }
  const name = e.name;
  const isAgg = aggregateFunctions.has(name) && !((name === 'min' || name === 'max') && e.args.length > 1);
  if (isAgg) {
    if (!scope.aggregateRef) throw new SmaltError('SMALT_ERROR', `misuse of aggregate function ${name}()`);
    const b = scope.aggregateRef(e);
    return withMeta({ k: 'slot', reg: b.reg, type: b.type }, { collation: b.collation, collSrc: CollSrc.None, affinity: 'NONE' });
  }
  if (e.distinct || e.star || e.filter) throw new SmaltError('SMALT_ERROR', `DISTINCT/FILTER/* is only valid with aggregate functions`);
  if (name === 'current_time' || name === 'current_date' || name === 'current_timestamp') {
    // A plain call, so plans carry no closure: the clock is read when the statement runs.
    return call(`sql.${name}`, [], 'text');
  }
  const def = scalarFunctions.get(name);
  if (!def) {
    if (Object.hasOwn(WINDOW_ARITY, name)) {
      // A window-only function without OVER (SQLite checks the argument count first).
      const [lo, hi] = WINDOW_ARITY[name];
      if (e.args.length < lo || e.args.length > hi) throw new SmaltError('SMALT_ERROR', `wrong number of arguments to function ${name}()`);
      throw new SmaltError('SMALT_ERROR', `misuse of window function ${name}()`);
    }
    throw new SmaltError('SMALT_ERROR', `no such function: ${name}`);
  }
  const n = e.args.length;
  if (n < def.minArgs || (def.maxArgs >= 0 && n > def.maxArgs)) throw new SmaltError('SMALT_ERROR', `wrong number of arguments to function ${name}()`);
  if (name === 'likelihood') {
    // SQLite: the probability must be a REAL literal (not an integer, not negated) from 0.0 to 1.0.
    const p = e.args[1];
    if (p.kind !== 'literal' || !p.isReal || typeof p.value !== 'number' || Object.is(p.value, -0) || !(p.value >= 0 && p.value <= 1))
      throw new SmaltError('SMALT_ERROR', 'second argument to likelihood() must be a constant between 0.0 and 1.0');
  }
  const args = e.args.map((a) => bindExpr(a, scope));
  // A function's result type follows from its arguments' types. Functions without `resultType` are compiled once
  // to find out (compiling is cheap and never fails).
  const info = args.map((a) => ({ fn: NO_FN, type: typeOf(a), collation: metaOf(a).collation }));
  const type = def.resultType ? def.resultType(info) : def.compile(info, scope.funcCtx).type;
  // Collation of a function result: from its first argument when that argument carries one.
  const first = args[0] ? metaOf(args[0]) : NO_META;
  const explicit = first.collSrc === CollSrc.Explicit;
  return withMeta(call(name, args, type), { collation: explicit ? first.collation : Collation.Binary, collSrc: explicit ? CollSrc.Explicit : CollSrc.None, affinity: 'NONE' });
}

/** Compile a bound expression to a closure, with its SQL metadata. */
export function compilePlanExpr(e: BoundExpr, ctx: FunctionContext): Compiled {
  const c = compileBound(e, ctx);
  const m = getMeta(e);
  if (m === undefined) return c;
  // A compiled alias or subquery is shared: copy it. Everything else was built just now for this node.
  if (e.k === 'native') return { ...c, ...m };
  c.collation = m.collation;
  c.collSrc = m.collSrc;
  c.affinity = m.affinity;
  return c;
}

function compileBound(e: BoundExpr, ctx: FunctionContext): Compiled {
  const sub = (x: BoundExpr): Compiled => compilePlanExpr(x, ctx);
  switch (e.k) {
    case 'lit':
      return konst(e.value, e.type);
    case 'param': {
      const reg = e.index;
      return { fn: (r) => r[reg], type: 'any', collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE', constant: false, reg };
    }
    case 'slot':
      e.use?.();
      return { fn: regReader(e.reg), type: e.type, collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE', constant: false, reg: e.reg };
    case 'native':
      return e.compiled as Compiled;
    case 'not': {
      const a = e.arg;
      // NOT LIKE, NOT GLOB and NOT IN compile to one closure, as their own forms.
      if (a.k === 'call' && (a.fn === 'sql.like' || a.fn === 'sql.glob' || a.fn === 'sql.in_list')) return compileSqlCall(a, ctx, true);
      return compileUnary('NOT', sub(a));
    }
    case 'and':
      return and(sub(e.args[0]), sub(e.args[1]));
    case 'or':
      return or(sub(e.args[0]), sub(e.args[1]));
    case 'isNull': {
      const x = sub(e.arg);
      const f = x.fn;
      const not = e.not;
      return fold({ fn: (r) => ((f(r) === null) !== not ? 1 : 0), type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: x.constant });
    }
    case 'case':
      return compileCase(e, ctx);
    case 'cast': {
      const x = sub(e.arg);
      const { fn } = sqlFunction(e.fn).compile([x], {});
      return fold({ fn, type: e.to, collation: x.collation, collSrc: x.collSrc, affinity: 'NONE', constant: x.constant });
    }
    case 'call':
      return e.fn.startsWith('sql.') ? compileSqlCall(e, ctx, false) : compileScalarCall(e, ctx);
    case 'subquery':
    case 'inSubquery': {
      // Plans from the SQL front end are not executed yet (ADR 0014, step 6): compiling one gives its static
      // metadata, which the front end compares with the current planner's, and a closure that refuses to run.
      const fn: Fn = () => {
        throw new SmaltError('SMALT_INTERNAL', 'a plan from the SQL front end cannot run yet');
      };
      return { fn, type: typeOf(e), collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE', constant: false };
    }
    case 'col':
      throw new SmaltError('SMALT_INTERNAL', `plan expression ${e.k} cannot be compiled yet`);
  }
}

/** A call of an `sql.*` function: the closure the SQL rules always built for that operator. */
function compileSqlCall(e: Extract<BoundExpr, { k: 'call' }>, ctx: FunctionContext, negated: boolean): Compiled {
  const sub = (x: BoundExpr): Compiled => compilePlanExpr(x, ctx);
  const args = e.args;
  switch (e.fn) {
    case 'sql.in_list':
      return compileInList(negated, sub(args[0]), args.slice(1).map(sub));
    case 'sql.like':
    case 'sql.glob': {
      const [x, pat, esc] = args.map(sub);
      const { fn } = sqlFunction(e.fn).compile(esc ? [x, pat, esc] : [x, pat], { negated });
      return fold({ fn, type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: x.constant && pat.constant && (esc?.constant ?? true) });
    }
    case 'sql.current_date':
    case 'sql.current_time':
    case 'sql.current_timestamp': {
      const kind = e.fn.slice(4) as 'current_date' | 'current_time' | 'current_timestamp';
      return { fn: () => currentTimeText(kind, ctx.now()), type: 'text', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: false };
    }
    case 'sql.neg':
      return compileUnary('-', sub(args[0]));
    case 'sql.bitnot':
      return compileUnary('~', sub(args[0]));
    default:
      if (e.collation !== undefined) {
        // A comparison: its operands' affinity conversions run inside its closure, after the NULL checks.
        const ops = args.map((x) => {
          if (x.k === 'call' && AFFINITY_CALLS.has(x.fn)) {
            const inner = sub(x.args[0]);
            const real = inner.type === 'real';
            const convert = x.fn === 'sql.affinity_numeric' ? applyNumericAffinity : (v: SqlValue) => applyTextAffinity(v, real);
            return { c: inner, arg: { fn: inner.fn, type: inner.type, convert } };
          }
          const c = sub(x);
          return { c, arg: { fn: c.fn, type: c.type, convert: null } };
        });
        const { fn } = sqlFunction(e.fn).compile(
          ops.map((o) => o.arg),
          { collation: collationId(e.collation) },
        );
        return fold({ fn, type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: ops.every((o) => o.c.constant) });
      }
      return call2(e.fn, sub(args[0]), sub(args[1]));
  }
}

function compileScalarCall(e: Extract<BoundExpr, { k: 'call' }>, ctx: FunctionContext): Compiled {
  const def = scalarFunctions.get(e.fn)!;
  const args = e.args.map((a) => compilePlanExpr(a, ctx));
  const compiledArgs: CompiledArg[] = args.map((a) => ({ fn: a.fn, type: a.type, collation: a.collation }));
  const { fn, type } = def.compile(compiledArgs, ctx);
  return fold({ fn, type, collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: def.deterministic && args.every((a) => a.constant) });
}

function regReader(reg: number): Fn {
  return (r) => r[reg];
}

// ------------------------------------------------------------------ unary / logic

function compileUnary(op: string, x: Compiled): Compiled {
  const name = op === 'NOT' ? 'sql.not' : op === '-' ? 'sql.neg' : op === '~' ? 'sql.bitnot' : null;
  if (op === '+') {
    // Unary plus is a no-op that strips affinity and collation (SQLite).
    return fold({ ...x, affinity: 'NONE', collSrc: CollSrc.None, collation: Collation.Binary });
  }
  if (name === null) throw new SmaltError('SMALT_ERROR', `unknown unary operator ${op}`);
  const { fn, type } = sqlFunction(name).compile([x], {});
  return fold({ fn, type, collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: x.constant });
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

/** What the SQL comparison rules read of an operand. */
export type SqlOperand = Pick<Compiled, 'type' | 'affinity' | 'collation' | 'collSrc'>;

/** Collation for a comparison: explicit COLLATE wins, then column collation, left before right. */
export function comparisonCollation(a: SqlOperand, b: SqlOperand): Collation {
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
export function comparisonConverters(a: SqlOperand, b: SqlOperand): [((v: SqlValue) => SqlValue) | null, ((v: SqlValue) => SqlValue) | null] {
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

/** A two-argument `sql.*` function with no front-end options; the result has no affinity or collation. */
function call2(name: string, a: Compiled, b: Compiled): Compiled {
  const { fn, type } = sqlFunction(name).compile([a, b], {});
  return fold({ fn, type, collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: a.constant && b.constant });
}

/** A comparison: SQLite's collation and affinity rules pick the options of `sql.eq` and the others. */
function comparison(op: string, a: Compiled, b: Compiled): Compiled {
  const coll = comparisonCollation(a, b);
  const [ca, cb] = comparisonConverters(a, b);
  const { fn } = sqlFunction(COMPARISON_FUNCTIONS[op]).compile([{ fn: a.fn, type: a.type, convert: ca }, { fn: b.fn, type: b.type, convert: cb }], { collation: coll });
  return fold({ fn, type: 'int', collation: 0, collSrc: CollSrc.None, affinity: 'NONE', constant: a.constant && b.constant });
}

// ------------------------------------------------------------------ IN, LIKE, CASE, CAST

function compileInList(not: boolean, x: Compiled, list: Compiled[]): Compiled {
  const base = { type: 'int' as StaticType, collation: 0 as Collation, collSrc: CollSrc.None, affinity: 'NONE' as Affinity };
  if (list.length === 0) return konst(not ? 1 : 0, 'int');
  const f = sqlFunction('sql.in_list');
  // All-constant list: hash lookup with the probe's affinity and collation applied up front.
  if (list.every((c) => c.constant)) {
    const collation = x.collSrc !== CollSrc.None ? x.collation : Collation.Binary;
    const probeAffinity = isNumAff(x.affinity) ? 'NUMERIC' : x.affinity === 'TEXT' ? 'TEXT' : 'NONE';
    const { fn } = f.compile([x, ...list], { collation, probeAffinity, negated: not });
    return fold({ ...base, constant: x.constant, fn });
  }
  // Otherwise the probe is compared with each element by `=`.
  const tests = list.map((c) => ({ fn: comparison('=', x, c).fn, type: 'int' as StaticType, constant: false }));
  const { fn } = f.compile([x, ...tests], { negated: not });
  return { ...base, constant: false, fn };
}

function compileCase(e: Extract<BoundExpr, { k: 'case' }>, ctx: FunctionContext): Compiled {
  const whens = e.whens.map((w) => ({ test: compilePlanExpr(w.when, ctx).fn, then: compilePlanExpr(w.then, ctx) }));
  const els = compilePlanExpr(e.else, ctx);
  const thens = whens.map((w) => w.then.fn);
  const tests = whens.map((w) => w.test);
  const elseFn = els.fn;
  const n = tests.length;
  return fold({
    fn: (r) => {
      for (let i = 0; i < n; i++) {
        const v = tests[i](r);
        if (v !== null && truthy(v)) return thens[i](r);
      }
      return elseFn(r);
    },
    type: e.type,
    collation: 0,
    collSrc: CollSrc.None,
    affinity: 'NONE',
    constant: false,
  });
}

const CAST_FUNCTIONS: Record<string, string> = { INTEGER: 'sql.cast_integer', REAL: 'sql.cast_real', TEXT: 'sql.cast_text', BLOB: 'sql.cast_blob' };

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

/** Expression helpers plus row-decoding helpers, for fused pipelines. */
export const CODEGEN_HELPERS_FOR_FUSION = {
  get arith() {
    return CODEGEN_HELPERS.arith;
  },
  negate: (v: SqlValue) => negate(v),
  readInt64,
  utf8: decodeUtf8,
  tagged: decodeTagged,
  rowid: readRowidKey,
};
