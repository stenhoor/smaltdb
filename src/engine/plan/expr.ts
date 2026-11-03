/**
 * Plan expressions (ADR 0014, section 1): typed, with columns referenced by input and position (never by name), and
 * no implicit conversions. Every conversion a language makes is an explicit `cast` or function call, and behaviour
 * that differs between languages lives in named functions the front end chooses (SQL's are `sql.*`, in
 * exec/sql-functions.ts).
 *
 * Nested plans (`subquery`, `inSubquery`) arrive with the plan operations in step 5 of the ADR's order of work;
 * until then they are typed by an opaque placeholder.
 */
import type { SqlValue } from '../values.js';
import type { CollationName, PlanType } from './types.js';

/** A nested plan. Placeholder until the plan operations exist (ADR 0014, step 5). */
export interface NestedPlan {
  readonly op: string;
}

export type PlanExpr =
  /**
   * Column `index` of input `input` of the operation that owns the expression (a join's inputs are 0..n-1; other
   * operations have one input, 0). `depth` 0 reads the operation's own input; `depth` d > 0 reads the input of the
   * operation d dependent evaluations out (a correlated reference).
   */
  | { readonly k: 'col'; readonly input: number; readonly index: number; readonly depth: number; readonly type: PlanType; readonly collation: CollationName }
  | { readonly k: 'lit'; readonly value: SqlValue; readonly type: PlanType }
  /** Positional parameter, 0-based. A front end maps its own parameter syntax (SQL's `?NNN`, `:name`) to positions. */
  | { readonly k: 'param'; readonly index: number; readonly type: PlanType }
  /** A registered function. `collation`: the explicit ordering rule of a comparison-like function. */
  | { readonly k: 'call'; readonly fn: string; readonly args: readonly PlanExpr[]; readonly type: PlanType; readonly collation?: CollationName }
  /** A conversion chosen by the language (`fn`, e.g. `sql.cast_integer`). */
  | { readonly k: 'cast'; readonly fn: string; readonly to: PlanType; readonly arg: PlanExpr }
  /** Three-valued logic over 0 / 1 / NULL. */
  | { readonly k: 'and' | 'or'; readonly args: readonly PlanExpr[] }
  | { readonly k: 'not'; readonly arg: PlanExpr }
  | { readonly k: 'isNull'; readonly arg: PlanExpr; readonly not: boolean }
  /** Searched CASE: the first `when` that is true gives the value. */
  | { readonly k: 'case'; readonly whens: readonly { readonly when: PlanExpr; readonly then: PlanExpr }[]; readonly else: PlanExpr; readonly type: PlanType }
  /** A dependent evaluation: the first column of the nested plan's first row, or whether it has a row. */
  | { readonly k: 'subquery'; readonly mode: 'scalar' | 'exists'; readonly plan: NestedPlan; readonly type: PlanType; readonly collation: CollationName }
  /** Membership of `probe` in the nested plan's single column: 1, 0 or NULL. */
  | { readonly k: 'inSubquery'; readonly probe: PlanExpr; readonly plan: NestedPlan; readonly collation: CollationName }
  /**
   * Internal, while the plan layer is built next to the current planner (ADR 0014, steps 3–5): a value the planner
   * keeps in a register (a column of a source, a GROUP BY key, an aggregate or window result). Never serialized,
   * rejected by the validator, and replaced by `col` when the SQL front end produces plans. `use` marks a source
   * column as read (projection pushdown) and runs when the slot is compiled.
   */
  | { readonly k: 'slot'; readonly reg: number; readonly type: PlanType; readonly use?: () => void }
  /**
   * Internal, as `slot`: a subexpression the current planner compiled itself (a subquery, or a select-list alias
   * that a name resolved to). `compiled` is an `exec/expr.ts` `Compiled`.
   */
  | { readonly k: 'native'; readonly compiled: object; readonly type: PlanType; readonly subquery?: true };

/** The static type of an expression. */
export function typeOf(e: PlanExpr): PlanType {
  switch (e.k) {
    case 'cast':
      return e.to;
    case 'and':
    case 'or':
    case 'not':
    case 'isNull':
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

export function call(fn: string, args: readonly PlanExpr[], type: PlanType, collation?: CollationName): PlanExpr {
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
