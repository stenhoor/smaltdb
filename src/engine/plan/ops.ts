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

/**
 * What a write does when a row violates a constraint, for the whole statement (SQL's `INSERT OR …` / `UPDATE OR …`).
 * Absent: each constraint's own action applies (its ON CONFLICT clause, else abort).
 */
export type ConflictAction = 'rollback' | 'abort' | 'fail' | 'ignore' | 'replace';

/**
 * `decorrelate: false` on an operation: the planner does not decorrelate the subqueries of this plan (SQL marks a
 * SELECT whose views or FROM subqueries it merged, as decorrelation reads a subquery as it was written).
 */
export interface OpMeaning {
  readonly decorrelate?: false;
}

export type PlanOp = OpMeaning & (
  /**
   * Rows of a table: `columns` lists table column indexes, -1 for the rowid. `db` names the schema when the query
   * did or the table is TEMP; `indexedBy` is SQL's INDEXED BY name, or null for NOT INDEXED.
   */
  | { readonly op: 'scan'; readonly table: string; readonly db?: 'main' | 'temp'; readonly columns: readonly number[]; readonly indexedBy?: string | null }
  /**
   * Rows that are not a table's: a table-valued function (`pragma_table_info(t)`), a virtual table
   * (`information_schema.*`, the TEMP catalog) or an external table. A function's arguments may read the columns of
   * the join's left input (a lateral source).
   */
  | { readonly op: 'source'; readonly kind: 'function' | 'virtual' | 'external'; readonly name: string; readonly schema?: string; readonly args: readonly PlanExpr[]; readonly named?: Readonly<Record<string, PlanExpr>>; readonly types: readonly PlanType[] }
  /**
   * A recursive query: `init` gives the first rows; each step reads the rows of the previous one through `working`
   * (same `id`) until a step gives none. `distinct`: UNION (rows seen before are dropped); `order` / `limit` /
   * `offset` are the recursive CTE's own.
   */
  | {
      readonly op: 'iterate';
      readonly id: number;
      /** The recursive CTE's name, for EXPLAIN. */
      readonly name: string;
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
  /**
   * DELETE: deletes the rows of `table` whose rowids `input` gives in its column `rowid`. `returning` reads each
   * deleted row: the table's columns, then its rowid. Outputs the RETURNING rows.
   */
  | { readonly op: 'delete'; readonly table: string; readonly db: 'main' | 'temp'; readonly input: PlanOp; readonly rowid: number; readonly returning?: readonly PlanExpr[] }
  /**
   * INSERT: appends a row to `table` for each row of `input` (none: one row of defaults), its columns assigned to the
   * table's `columns` (-1: the rowid; the others take their defaults). Each of `upserts` handles a conflict on the
   * constraint `target` (an index of the table, -1 its INTEGER PRIMARY KEY, null any): nothing, or `update`, whose
   * expressions read the existing row (the table's columns, then its rowid) and then the proposed row (`excluded`,
   * likewise). `returning` reads each inserted or updated row. `onConflict`: the statement's conflict action.
   */
  | {
      readonly op: 'append';
      readonly table: string;
      readonly db: 'main' | 'temp';
      readonly onConflict?: ConflictAction;
      readonly input: PlanOp | null;
      readonly columns: readonly number[];
      readonly upserts: readonly {
        readonly target: number | null;
        readonly update?: { readonly sets: readonly { readonly column: number; readonly value: PlanExpr }[]; readonly where?: PlanExpr };
      }[];
      readonly returning?: readonly PlanExpr[];
    }
  /**
   * UPDATE: for each row of `input` (the target's rows, joined with the FROM sources when `from`), sets the target
   * row whose rowid is in column `rowid`: each of `sets` assigns `value` (over the input row) to the table's column
   * `column` (-1: the rowid). `returning` reads each updated row: the table's columns, then its rowid. `onConflict`:
   * the statement's conflict action.
   */
  | {
      readonly op: 'update';
      readonly table: string;
      readonly db: 'main' | 'temp';
      readonly onConflict?: ConflictAction;
      readonly input: PlanOp;
      readonly rowid: number;
      readonly sets: readonly { readonly column: number; readonly value: PlanExpr }[];
      readonly from: boolean;
      readonly returning?: readonly PlanExpr[];
    }
  /** One window (PARTITION BY, ORDER BY, frame): outputs its input's columns, then one column per call. */
  | {
      readonly op: 'window';
      readonly input: PlanOp;
      readonly partition: readonly { readonly expr: PlanExpr; readonly collation: CollationName }[];
      readonly order: readonly SortKey[];
      readonly frame: WindowFrame;
      readonly calls: readonly WindowCall[];
    }
);
