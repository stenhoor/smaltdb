/**
 * SQL's expression binder (ADR 0014, step 3b): an expression of the parser (sql/ast.ts) bound to a plan expression,
 * with its names resolved, typed, and SQL's rules made explicit (comparison collations, affinity conversions, the
 * `sql.*` function for each operator). The engine compiles plan expressions (exec/expr.ts `compilePlanExpr`).
 */
import { SmaltError } from '../../errors.js';
import { storageTypeFor } from '../../catalog/schema.js';
import type { CallExpr, ColumnExpr, Expr, SelectStmt } from '../ast.js';
import { Collation, type SqlValue, collationByName } from '../../values.js';
import { type Affinity, type StaticType, affinityOfStorage, applyNumericAffinity, staticTypeOfStorage } from '../../exec/convert.js';
import { ARITHMETIC_FUNCTIONS, BITWISE_FUNCTIONS, COMPARISON_FUNCTIONS } from '../../exec/sql-functions.js';
import { type Fn, type FunctionContext, aggregateFunctions, scalarFunctions } from '../../exec/functions.js';
import { WINDOW_ARITY } from '../../exec/window.js';
import { type SqlMeta, setMeta } from '../../exec/sql-meta.js';
import { type BoundExpr, call, lit, param, typeOf } from '../../plan/expr.js';
import type { PlanOp } from '../../plan/ops.js';
import { CollSrc, type Compiled, NO_META, type SqlOperand, collationName, comparisonCollation, comparisonConverters, compilePlanExpr, metaOf, withMeta } from '../../exec/expr.js';

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

function isNumericType(t: StaticType): boolean {
  return t === 'int' || t === 'real' || t === 'num';
}

// ------------------------------------------------------------------ binding and compiling

/**
 * The closure compiler (defines expression semantics): binds the parser's expression to a plan expression
 * (`bindExpr`), then compiles that (`compilePlanExpr`).
 */
export function compileNode(e: Expr, scope: CompileScope): Compiled {
  return compilePlanExpr(bindExpr(e, scope), scope.funcCtx);
}


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
