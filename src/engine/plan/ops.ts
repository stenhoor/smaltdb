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
import type { PlanExpr, PlanOrigin } from './expr.js';
import type { CollationName, PlanType } from './types.js';
import type { SqlValue } from '../values.js';

/** A typed array a column of values may be. */
export type ColumnArray = Float64Array | Float32Array | Int32Array | Int16Array | Int8Array | Uint32Array | Uint16Array | Uint8Array | BigInt64Array;

/**
 * A column of `values` given as data: a typed array (numbers; `BigInt64Array`: integers), an array of values, or
 * either with a null bitmap (`nulls`: bit `i % 8` of byte `i >> 3` set when value `i` is NULL, as results carry them).
 * NaN in a float array is NaN, a value of `real` (ADR 0018); NULL comes from the bitmap. An array may hold JS booleans,
 * the values of a `bool` column (1 / 0 at run time).
 */
/**
 * A value in a column of values: an engine value, a JS boolean (a `bool` column, ADR 0018), a JS `Date` (a `datetime`,
 * ADR 0019), or a JS array or object (a list or struct column, ADR 0020).
 */
export type ColumnValue = SqlValue | boolean | Date | readonly unknown[] | { readonly [field: string]: unknown };
export type ValueColumn = ColumnArray | readonly ColumnValue[] | { readonly data: ColumnArray | readonly ColumnValue[]; readonly nulls: Uint8Array };

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
  /**
   * Navigation functions (`lag`, `lead`, `first_value`, `last_value`, `nth_value`): count only rows whose value is not
   * NULL (ADR 0016 section 5). `lag(x, 2)` is then the second earlier non-NULL `x`; `first_value(x)` the frame's first
   * non-NULL `x`.
   */
  readonly ignoreNulls?: boolean;
}

export type JoinKind = 'inner' | 'left' | 'right' | 'full' | 'semi' | 'anti' | 'cross' | 'asof';

/**
 * An as-of join's match (ADR 0016 section 5): each left row takes the right row whose key is nearest its own in
 * `direction` (`backward`: the largest right key at or below the left's; `forward`: the smallest at or above; `nearest`:
 * the closest, ties to the smaller key), within `tolerance` when given, among the right rows the join's `on` matches.
 */
export interface AsofMatch {
  /** The left row's key (over input 0) and the right row's (over input 1). */
  readonly left: PlanExpr;
  readonly right: PlanExpr;
  readonly direction: 'backward' | 'forward' | 'nearest';
  /** The largest distance between the keys, an expression over no columns. */
  readonly tolerance?: PlanExpr;
}

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
  /** Where the operation came from, as an expression's `origin` (plan/expr.ts): given back on its errors. */
  readonly origin?: PlanOrigin;
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
  | {
      readonly op: 'values';
      /** Rows of expressions over no columns; empty when the values are given as `columns`. */
      readonly rows: readonly (readonly PlanExpr[])[];
      readonly types: readonly PlanType[];
      /** The values as one array per column, all of one length (ADR 0016 section 5): data, not expressions. */
      readonly columns?: readonly ValueColumn[];
    }
  | { readonly op: 'filter'; readonly input: PlanOp; readonly pred: PlanExpr }
  | { readonly op: 'project'; readonly input: PlanOp; readonly exprs: readonly PlanExpr[] }
  | {
      readonly op: 'limit';
      readonly input: PlanOp;
      readonly count: PlanExpr;
      readonly offset?: PlanExpr;
      /** Count the rows and the offset from the end: the last `count` rows before the last `offset`, in input order. */
      readonly fromEnd?: true;
    }
  | {
      readonly op: 'join';
      readonly kind: JoinKind;
      readonly inputs: readonly [PlanOp, PlanOp];
      readonly on?: PlanExpr;
      /** Keep the left input's order, and for each left row its matches in the right input's order (ADR 0016 section 4). */
      readonly ordered?: true;
      /** An `asof` join's match: required for that kind, and for no other. */
      readonly asof?: AsofMatch;
    }
  | { readonly op: 'setop'; readonly kind: 'union' | 'unionAll' | 'intersect' | 'except'; readonly inputs: readonly [PlanOp, PlanOp]; readonly collations: readonly CollationName[] }
  | { readonly op: 'sort'; readonly input: PlanOp; readonly keys: readonly SortKey[] }
  | {
      readonly op: 'aggregate';
      readonly input: PlanOp;
      readonly keys: readonly { readonly expr: PlanExpr; readonly collation: CollationName }[];
      readonly aggs: readonly AggCall[];
      /** SQL's bare columns: input columns carried to the output, from the row SQLite picks (#46, decision 4). */
      readonly carry: readonly PlanExpr[];
      /** Give the groups in the order of their first row (ADR 0016 section 4). */
      readonly ordered?: 'first';
    }
  | {
      readonly op: 'sample';
      readonly input: PlanOp;
      /** How many rows: `count`, or `fraction` of the input's (expressions over no columns); exactly one. */
      readonly count?: PlanExpr;
      readonly fraction?: PlanExpr;
      /** With replacement a row may be drawn more than once, and rows come in the order drawn. */
      readonly replace: boolean;
      /** The same seed gives the same rows from the same input. */
      readonly seed: number;
    }
  | {
      readonly op: 'pivot';
      readonly input: PlanOp;
      /** The columns that group rows: one output row per group. */
      readonly keys: readonly { readonly expr: PlanExpr; readonly collation: CollationName }[];
      /** The column whose values become output columns, and the collation it is compared by. */
      readonly on: PlanExpr;
      readonly collation: CollationName;
      /** The values of `on` that become columns, in order (dynamic pivot reads them first, then builds this). */
      readonly values: readonly SqlValue[];
      /** The aggregates computed over each group's rows with each value: one output column per value and call. */
      readonly aggs: readonly AggCall[];
      readonly ordered?: 'first';
    }
  | {
      /**
       * One row per element of a list column (ADR 0020): the input's columns with `column` replaced by each element, in
       * the input's order and then the list's. An empty or NULL list gives one row with NULL. With `position`, each row
       * also has the element's position (from 0) as a last column.
       */
      readonly op: 'explode';
      readonly input: PlanOp;
      readonly column: number;
      /** The list column's type (`list<T>`); the output column's is `T`. */
      readonly type: PlanType;
      readonly position?: boolean;
    }
  | {
      readonly op: 'unpivot';
      readonly input: PlanOp;
      /** Input columns kept on every output row. */
      readonly keep: readonly number[];
      /** Input columns whose values become rows: one output row per input row and column, in this order. */
      readonly columns: readonly number[];
      /** The name each of `columns` gives its rows (the output's name column). */
      readonly names: readonly string[];
      /** The plan type of the value column. */
      readonly type: PlanType;
    }
  | {
      readonly op: 'distinct';
      readonly input: PlanOp;
      readonly collations: readonly CollationName[];
      /** Give the distinct rows in the order of their first occurrence (ADR 0016 section 4). */
      readonly ordered?: 'first';
      /** The columns that decide which rows are duplicates (default: all of them). */
      readonly on?: readonly number[];
      /** Which row of each set of duplicates to keep, by input order; the kept rows come in input order. */
      readonly keep?: 'first' | 'last';
    }
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
