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
 * - `setop` outputs the first input's columns;
 * - `window` outputs its input's columns, then one column per window call.
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

/** A window frame: `offset` bounds are expressions over constants and parameters. */
export interface WindowFrame {
  readonly unit: 'ROWS' | 'RANGE' | 'GROUPS';
  readonly start: { readonly kind: string; readonly offset?: PlanExpr };
  readonly end: { readonly kind: string; readonly offset?: PlanExpr };
  readonly exclude: 'NO OTHERS' | 'CURRENT ROW' | 'GROUP' | 'TIES';
}

/** A window function call: a ranking or navigation function, or an aggregate over the frame. */
export interface WindowCall {
  readonly fn: string;
  readonly args: readonly PlanExpr[];
  readonly star: boolean;
  readonly filter?: PlanExpr;
  readonly type: PlanType;
  readonly collation: CollationName;
}

export type JoinKind = 'inner' | 'left' | 'right' | 'full' | 'semi' | 'anti' | 'cross';

export type PlanOp =
  /** Rows of a table: `columns` lists table column indexes, -1 for the rowid. */
  | { readonly op: 'scan'; readonly table: string; readonly db?: 'main' | 'temp'; readonly columns: readonly number[] }
  /**
   * Rows that are not a table's: a table-valued function (`pragma_table_info(t)`), a virtual table
   * (`information_schema.*`, the TEMP catalog) or an external table. A function's arguments may read the columns of
   * the join's left input (a lateral source).
   */
  | { readonly op: 'source'; readonly kind: 'function' | 'virtual' | 'external'; readonly name: string; readonly schema?: string; readonly args: readonly PlanExpr[]; readonly types: readonly PlanType[] }
  /**
   * A recursive query: `init` gives the first rows; each step reads the rows of the previous one through `working`
   * (same `id`) until a step gives none. `distinct`: UNION (rows seen before are dropped); `order` / `limit` /
   * `offset` are the recursive CTE's own.
   */
  | {
      readonly op: 'iterate';
      readonly id: number;
      readonly init: PlanOp;
      readonly steps: readonly PlanOp[];
      readonly distinct: boolean;
      readonly collations: readonly CollationName[];
      readonly order?: readonly SortKey[];
      readonly limit?: PlanExpr;
      readonly offset?: PlanExpr;
    }
  /** The previous step's rows inside an `iterate` with the same `id`. */
  | { readonly op: 'working'; readonly id: number; readonly types: readonly PlanType[] }
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
  | { readonly op: 'distinct'; readonly input: PlanOp; readonly collations: readonly CollationName[] }
  /** One window (PARTITION BY, ORDER BY, frame): outputs its input's columns, then one column per call. */
  | {
      readonly op: 'window';
      readonly input: PlanOp;
      readonly partition: readonly { readonly expr: PlanExpr; readonly collation: CollationName }[];
      readonly order: readonly SortKey[];
      readonly frame: WindowFrame;
      readonly calls: readonly WindowCall[];
    };
