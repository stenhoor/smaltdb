/**
 * Plan operations (ADR 0014, section 1, with the additions the owner accepted in #46): an immutable tree of
 * relational operations in the engine's own terms. Expressions reference the columns of an operation's inputs by
 * position (`col` in plan/expr.ts):
 *
 * - `filter`, `sort`, `limit` and `distinct` pass their input's columns through;
 * - `project` outputs its expressions;
 * - `join` outputs its inputs' columns concatenated (`semi` / `anti`: the left input's only); its condition reads
 *   input 0 (the left side) and input 1 (the right side);
 * - `aggregate` outputs its keys, then its aggregate calls, then its carried columns;
 * - `setop` outputs the first input's columns.
 *
 * Writing operations (`append`, `update`, `delete`), windows, recursion and external sources arrive with the later
 * steps of the ADR's order of work.
 */
import type { PlanExpr } from './expr.js';
import type { CollationName, PlanType } from './types.js';

export interface SortKey {
  readonly expr: PlanExpr;
  readonly desc: boolean;
  readonly nullsFirst: boolean;
  readonly collation: CollationName;
}

/** An aggregate function call: `fn` names a registered aggregate. */
export interface AggCall {
  readonly fn: string;
  readonly args: readonly PlanExpr[];
  readonly star: boolean;
  readonly distinct: boolean;
  readonly filter?: PlanExpr;
  readonly collation: CollationName;
  readonly type: PlanType;
}

export type JoinKind = 'inner' | 'left' | 'right' | 'full' | 'semi' | 'anti' | 'cross';

export type PlanOp =
  /** Rows of a table: `columns` lists table column indexes, -1 for the rowid. */
  | { readonly op: 'scan'; readonly table: string; readonly db?: 'main' | 'temp'; readonly columns: readonly number[] }
  /** Constant rows (VALUES, and the single empty row of a SELECT without FROM). */
  | { readonly op: 'values'; readonly rows: readonly (readonly PlanExpr[])[]; readonly types: readonly PlanType[] }
  | { readonly op: 'filter'; readonly input: PlanOp; readonly pred: PlanExpr }
  | { readonly op: 'project'; readonly input: PlanOp; readonly exprs: readonly PlanExpr[] }
  | { readonly op: 'limit'; readonly input: PlanOp; readonly count: PlanExpr; readonly offset?: PlanExpr }
  | { readonly op: 'join'; readonly kind: JoinKind; readonly inputs: readonly [PlanOp, PlanOp]; readonly on?: PlanExpr }
  | { readonly op: 'setop'; readonly kind: 'union' | 'unionAll' | 'intersect' | 'except'; readonly inputs: readonly [PlanOp, PlanOp]; readonly collations: readonly CollationName[] }
  | { readonly op: 'sort'; readonly input: PlanOp; readonly keys: readonly SortKey[] }
  | {
      readonly op: 'aggregate';
      readonly input: PlanOp;
      readonly keys: readonly { readonly expr: PlanExpr; readonly collation: CollationName }[];
      readonly aggs: readonly AggCall[];
      /** SQL's bare columns: input columns carried to the output, from the row SQLite picks (#46, decision 4). */
      readonly carry: readonly PlanExpr[];
    }
  | { readonly op: 'distinct'; readonly input: PlanOp; readonly collations: readonly CollationName[] };
