/**
 * Plan expressions (ADR 0014, section 1): typed, with columns referenced by input and position (never by name), and
 * no implicit conversions. Every conversion a language makes is an explicit `cast` or function call, and behaviour
 * that differs between languages lives in named functions the front end chooses (SQL's are `sql.*`, in
 * exec/sql-functions.ts).
 */
import type { SqlValue } from '../values.js';
import type { PlanOp } from './ops.js';
import type { CollationName, PlanType } from './types.js';

/**
 * What an expression's value carries for the comparisons and sorts that read it (ADR 0016 section 2), as plain fields
 * of the expression, so a plan says everything about its meaning:
 *
 * - `carries`: the collation the value carries and where it came from (an explicit one, or a column's). A comparison of
 *   two values uses the explicit one, else a column's, else its own `collation` (SQLite's rule). Absent: none.
 * - `affinity`: the conversion a comparison applies to this operand when the other side's affinity calls for it
 *   (SQLite's column affinity; the engine's `affinity_*` operations). Absent: none.
 * - `inline: false`: keep the node whole: optimizations don't split or rewrite it, and code generation leaves it to
 *   the closure compiler.
 */
export interface ExprMeaning {
  readonly carries?: { readonly collation: CollationName; readonly from: 'explicit' | 'column' };
  readonly affinity?: 'INTEGER' | 'REAL' | 'NUMERIC' | 'TEXT' | 'BLOB';
  readonly inline?: false;
  /**
   * Where the node came from, in the language that built the plan (a SQL text span, a smaltdf call site): plain data
   * the engine never reads, given back on errors that arise in the node (ADR 0016 section 10).
   */
  readonly origin?: PlanOrigin;
}

/** A node's origin: plain data (JSON values), defined by the language. */
export type PlanOrigin = string | number | boolean | null | readonly PlanOrigin[] | { readonly [key: string]: PlanOrigin };

/** A nested plan (the operation tree of a subquery). */
export type NestedPlan = PlanOp;

/**
 * Column `index` of input `input` of the operation that owns the expression (a join's inputs are 0..n-1; other
 * operations have one input, 0). `depth` 0 reads the operation's own input; `depth` d > 0 reads the input of the
 * operation d dependent evaluations out (a correlated reference).
 */
export interface ColExpr extends ExprMeaning { readonly k: 'col'; readonly input: number; readonly index: number; readonly depth: number; readonly type: PlanType; readonly collation: CollationName }
export interface LitExpr extends ExprMeaning { readonly k: 'lit'; readonly value: SqlValue; readonly type: PlanType }
/** Positional parameter, 0-based. A front end maps its own parameter syntax (SQL's `?NNN`, `:name`) to positions. */
export interface ParamExpr extends ExprMeaning { readonly k: 'param'; readonly index: number; readonly type: PlanType }
/** A registered function. `collation`: the explicit ordering rule of a comparison-like function. */
export interface CallExpr<E> extends ExprMeaning { readonly k: 'call'; readonly fn: string; readonly args: readonly E[]; readonly type: PlanType; readonly collation?: CollationName }
/** A conversion chosen by the language (`fn`, e.g. `cast_integer`). */
export interface CastExpr<E> extends ExprMeaning { readonly k: 'cast'; readonly fn: string; readonly to: PlanType; readonly arg: E }
/**
 * Three-valued logic over 0 / 1 / NULL. `type` (ADR 0018): `bool` (left out), or `int` for a language that wants 0 / 1
 * in its results (the same values).
 */
export interface LogicExpr<E> extends ExprMeaning { readonly k: 'and' | 'or'; readonly args: readonly E[]; readonly type?: LogicType }
export interface NotExpr<E> extends ExprMeaning { readonly k: 'not'; readonly arg: E; readonly type?: LogicType }
export interface IsNullExpr<E> extends ExprMeaning { readonly k: 'isNull'; readonly arg: E; readonly not: boolean; readonly type?: LogicType }
/** The type a logic node gives: its values are 0 / 1 either way. */
export type LogicType = 'bool' | 'int';
/** Searched CASE: the first `when` that is true gives the value. */
export interface CaseExpr<E> extends ExprMeaning { readonly k: 'case'; readonly whens: readonly { readonly when: E; readonly then: E }[]; readonly else: E; readonly type: PlanType }
/** A dependent evaluation: the first column of the nested plan's first row, or whether it has a row. */
export interface SubqueryExpr extends ExprMeaning { readonly k: 'subquery'; readonly mode: 'scalar' | 'exists'; readonly plan: NestedPlan; readonly type: PlanType; readonly collation: CollationName }
/** Membership of `probe` in the nested plan's single column: 1, 0 or NULL. */
export interface InSubqueryExpr<E> extends ExprMeaning { readonly k: 'inSubquery'; readonly probe: E; readonly plan: NestedPlan; readonly collation: CollationName }

/**
 * An expression over a list's elements (ADR 0031, section 4). `map` gives the list of `body` for each element
 * (`list<typeOf(body)>`), `filter` the elements for which `body` (a `bool`) is true, and `agg` the value of `body` over
 * the results of `aggs`, the engine's aggregates run over the elements. `body` reads each element through `element`,
 * the aggregates' results (`agg` only) through `eachAgg`, and the row's columns as any expression does. A NULL list
 * gives NULL; an empty one `[]` (`map`, `filter`) or the aggregates of no rows (`agg`).
 */
export interface EachExpr<E> extends ExprMeaning {
  readonly k: 'each';
  readonly list: E;
  readonly mode: 'map' | 'filter' | 'agg';
  readonly body: E;
  readonly aggs?: readonly EachAggCall<E>[];
  readonly type: PlanType;
}
/** An aggregate of an `agg`-mode `each`: as an aggregate operation's call, its arguments over the elements. */
export interface EachAggCall<E> {
  readonly fn: string;
  readonly args: readonly E[];
  readonly star: boolean;
  readonly distinct: boolean;
  readonly filter?: E;
  readonly collation: CollationName;
  readonly type: PlanType;
}
/** In an `each` body: the element (`value`) or its position from 0 (`position`) of the `each` `depth` levels out (0 the innermost). */
export interface ElementExpr extends ExprMeaning { readonly k: 'element'; readonly part: 'value' | 'position'; readonly depth: number; readonly type: PlanType }
/** In an `agg`-mode `each` body: the result of aggregate `index` of the `each` `depth` levels out. */
export interface EachAggExpr extends ExprMeaning { readonly k: 'eachAgg'; readonly index: number; readonly depth: number; readonly type: PlanType }

/** A plan expression: what languages produce and plans carry. Serializable, with no closures. */
export type PlanExpr =
  | ColExpr | LitExpr | ParamExpr | CallExpr<PlanExpr> | CastExpr<PlanExpr> | LogicExpr<PlanExpr> | NotExpr<PlanExpr> | IsNullExpr<PlanExpr>
  | CaseExpr<PlanExpr> | SubqueryExpr | InSubqueryExpr<PlanExpr> | EachExpr<PlanExpr> | ElementExpr | EachAggExpr;

/**
 * An expression bound for compilation (`exec/`, never in a plan): a plan expression whose columns may be replaced by
 * the registers that hold them (`slot`) and whose parts may be compiled already (`native`).
 */
export type BoundExpr =
  | ColExpr | LitExpr | ParamExpr | CallExpr<BoundExpr> | CastExpr<BoundExpr> | LogicExpr<BoundExpr> | NotExpr<BoundExpr>
  | IsNullExpr<BoundExpr> | CaseExpr<BoundExpr> | SubqueryExpr | InSubqueryExpr<BoundExpr> | EachExpr<BoundExpr> | ElementExpr | EachAggExpr
  | SlotExpr | NativeExpr;

/**
 * A value the planner keeps in a register (a column of a source, a GROUP BY key, an aggregate or window result).
 * `use` marks a source column as read (projection pushdown) and runs when the slot is compiled.
 */
export type SlotExpr = ExprMeaning & { readonly k: 'slot'; readonly reg: number; readonly type: PlanType; readonly use?: () => void };

/** A subexpression compiled already (a planned subquery, a select-list alias). `compiled` is an `exec/expr.ts` `Compiled`. */
export type NativeExpr = ExprMeaning & { readonly k: 'native'; readonly compiled: object; readonly type: PlanType; readonly subquery?: true };

/** The static type of an expression. */
export function typeOf(e: BoundExpr): PlanType {
  switch (e.k) {
    case 'cast':
      return e.to;
    case 'and':
    case 'or':
    case 'not':
    case 'isNull':
      return e.type ?? 'bool';
    case 'inSubquery':
      return 'int';
    default:
      return e.type;
  }
}

// ------------------------------------------------------------------ builders

export const col = (input: number, index: number, type: PlanType, collation: CollationName = 'binary', depth = 0): PlanExpr => ({ k: 'col', input, index, depth, type, collation });

export function lit(value: SqlValue, type?: PlanType): PlanExpr {
  return { k: 'lit', value, type: type ?? literalType(value) };
}

export const param = (index: number, type: PlanType = 'any'): PlanExpr => ({ k: 'param', index, type });

export function call(fn: string, args: readonly PlanExpr[], type: PlanType, collation?: CollationName): PlanExpr;
export function call(fn: string, args: readonly BoundExpr[], type: PlanType, collation?: CollationName): BoundExpr;
export function call(fn: string, args: readonly BoundExpr[], type: PlanType, collation?: CollationName): BoundExpr {
  return collation === undefined ? { k: 'call', fn, args, type } : { k: 'call', fn, args, type, collation };
}

/** The type of a literal value: a JavaScript number that is a safe integer is `int`. */
function literalType(v: SqlValue): PlanType {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'number':
      return Number.isSafeInteger(v) ? 'int' : 'real';
    case 'bigint':
      return 'int';
    case 'string':
      return 'text';
    default:
      return 'blob';
  }
}

/** Calls `f` for each column reference of `e` (not those inside nested plans). */
export function forEachCol(e: BoundExpr, f: (c: ColExpr) => void): void {
  switch (e.k) {
    case 'col':
      f(e);
      return;
    case 'call':
    case 'and':
    case 'or':
      for (const a of e.args) forEachCol(a, f);
      return;
    case 'cast':
    case 'not':
    case 'isNull':
      forEachCol(e.arg, f);
      return;
    case 'case':
      for (const w of e.whens) {
        forEachCol(w.when, f);
        forEachCol(w.then, f);
      }
      forEachCol(e.else, f);
      return;
    case 'inSubquery':
      forEachCol(e.probe, f);
      return;
    case 'each':
      for (const x of eachParts(e)) forEachCol(x, f);
      return;
    default:
      return;
  }
}

/** The expressions inside an `each`: its list, its body, and its aggregates' arguments and filters. */
export function eachParts<E>(e: EachExpr<E>): E[] {
  const out: E[] = [e.list, e.body];
  for (const a of e.aggs ?? []) {
    out.push(...a.args);
    if (a.filter !== undefined) out.push(a.filter);
  }
  return out;
}

/** `e` with each expression inside it mapped by `f` (as `eachParts` lists them). */
export function mapEach<E, F>(e: EachExpr<E>, f: (x: E) => F): EachExpr<F> {
  const aggs = e.aggs?.map((a) => ({ ...a, args: a.args.map(f), ...(a.filter !== undefined ? { filter: f(a.filter) } : {}) }));
  return { ...e, list: f(e.list), body: f(e.body), ...(aggs ? { aggs } : {}) } as EachExpr<F>;
}
