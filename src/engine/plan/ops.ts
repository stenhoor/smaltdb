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

/** A relationship table a `paths` operation follows: `start` and `end` are its endpoint columns (column indexes). */
export interface PathEdges {
  readonly table: string;
  readonly db?: 'main' | 'temp';
  readonly start: number;
  readonly end: number;
}

/** The type of a `paths` operation's path column: per hop, its table's position in `edges`, its rowid, and the nodes it went from and to. */
export const PATH_TYPE = 'list<struct<edge int, rowid int, from int, to int>>';

/**
 * The columns of a `relationships` operation, in order: the node the relationship is at (`node`), the node at its other
 * end (`other`), its type's name (`type`), its rowid in its type's table (`id`), whether `node` is its start
 * (`outgoing`), and its catch-all properties (`props`: NULL for a type whose table has none).
 */
export const RELATIONSHIP_TYPES = ['int', 'int', 'text', 'int', 'bool', 'map<text, any>'] as const;

/**
 * A relationship a graph write is given (ADR 0042, section 1): its type's name and its rowid in that type's table,
 * each an expression over the write's input row. A NULL rowid names no relationship.
 */
export interface GraphRelationshipRef {
  readonly type: PlanExpr;
  readonly id: PlanExpr;
}

/**
 * An end of a relationship a `graphCreate` makes: a node the same operation makes for the row (`node`: its position
 * in the operation's `nodes`), or a node the row names (`id`: an expression over the input row that gives its id).
 */
export type GraphEnd = { readonly node: number } | { readonly id: PlanExpr };

/**
 * The table a graph write makes for a label or a relationship type it adds to the graph, where the plan names it: a
 * table of that name must not exist. Without one the table is named as `alterPropertyGraph` names it. A plan that
 * names tables reads them by those names, so it holds for the graph as it was when the plan was made.
 */
export type GraphNewTable = { readonly label: string; readonly table: string } | { readonly type: string; readonly table: string };

/** A node a `graphCreate` or `graphMerge` makes: its labels, and its properties (a map; a NULL value sets no key). */
export interface GraphNewNode {
  readonly labels: readonly string[];
  readonly props?: PlanExpr;
}

/** A relationship a `graphCreate` or `graphMerge` makes, from `start` to `end`. */
export interface GraphNewRelationship {
  readonly type: string;
  readonly start: GraphEnd;
  readonly end: GraphEnd;
  readonly props?: PlanExpr;
}

/**
 * What a `graphSet` changes of one node (`node`: an expression that gives its id) or one relationship
 * (`relationship`): exactly one of the two is given. A NULL node or relationship, and one that is not in the graph
 * (it was deleted), is left alone, and the item's `value` is not computed for it.
 *
 * - `property`: sets the key to `value`; a NULL `value` removes the key.
 * - `properties`: `value` is a map. Without `merge` it replaces the properties (its NULL values set no key); with
 *   `merge` its keys are set over the properties there are, and a NULL value removes its key.
 * - `labels` (a node's): adds the labels of `add` the node has not, and removes those of `remove` it has.
 */
export type GraphSetItem = ({ readonly node: PlanExpr; readonly relationship?: undefined } | { readonly relationship: GraphRelationshipRef; readonly node?: undefined }) &
  (
    | { readonly kind: 'property'; readonly key: string; readonly value: PlanExpr }
    | { readonly kind: 'properties'; readonly value: PlanExpr; readonly merge: boolean }
    | { readonly kind: 'labels'; readonly add: readonly string[]; readonly remove: readonly string[] }
  );

/**
 * What a `graphDelete` deletes for a row: a node (an expression that gives its id), a list of nodes (`list<int>`),
 * a relationship, the relationships of a list of hops ({@link PATH_TYPE}, as `paths` gives them: a hop's `edge` is
 * its type's position in the graph), or a path: the relationships of its hops, then its nodes (`start`, then each
 * hop's `to`). A NULL one, a NULL in a list, and one that is gone already, is passed over.
 */
export type GraphDeleteTarget =
  | { readonly node: PlanExpr }
  | { readonly nodes: PlanExpr }
  | { readonly relationship: GraphRelationshipRef }
  | { readonly hops: PlanExpr }
  | { readonly path: { readonly start: PlanExpr; readonly hops: PlanExpr } };

/** What a statement's graph writes did (ADR 0042, section 1): given back with its result. */
export interface GraphWriteCounts {
  nodesCreated: number;
  nodesDeleted: number;
  relationshipsCreated: number;
  relationshipsDeleted: number;
  /** Keys set or removed, counted for each write that names one, whether or not it changed the value. */
  propertiesSet: number;
  labelsAdded: number;
  labelsRemoved: number;
}

/** The operations that write a property graph, and `eager`: a plan that holds one is a write statement's. */
export const GRAPH_WRITE_OPS: ReadonlySet<string> = new Set(['graphCreate', 'graphSet', 'graphDelete', 'graphMerge']);

export type PlanOp = OpMeaning & (
  /**
   * Rows of a table: `columns` lists table column indexes, -1 for the rowid. `db` names the schema when the query
   * did or the table is TEMP; `indexedBy` is SQL's INDEXED BY name, or null for NOT INDEXED.
   */
  | {
      readonly op: 'scan';
      readonly table: string;
      readonly db?: 'main' | 'temp';
      readonly columns: readonly number[];
      readonly indexedBy?: string | null;
      /**
       * Read the table as it was after a commit (ADR 0033, decision 14): `{ commit }` a commit id, or `{ time }` a time
       * in milliseconds since 1970, which reads it as of the last commit at or before then. The table must keep
       * history (`TableDef.history`). An expression over no columns.
       */
      readonly asOf?: { readonly commit: PlanExpr } | { readonly time: PlanExpr };
    }
  /**
   * The relationships of a property graph, as a relation (ADR 0040, section 2.2). Its columns are
   * {@link RELATIONSHIP_TYPES}: `node`, `other`, `type`, `id`, `outgoing`, `props`. `direction` says at which end a
   * relationship is given: `out`, once, at its start; `in`, once, at its end; `both`, at each end (a relationship from
   * a node to itself once, as outgoing). `types` keeps only these relationship types (all of the graph's when left
   * out; none gives no rows). `asOf` reads the graph as it was, as a scan's does: the graph must keep history.
   *
   * A join on `node` (and on `other`) reads only the relationships at that node: a hop of a pattern is one join. Rows
   * come in no promised order.
   */
  | {
      readonly op: 'relationships';
      readonly graph: string;
      readonly direction: 'out' | 'in' | 'both';
      readonly types?: readonly string[];
      readonly asOf?: { readonly commit: PlanExpr } | { readonly time: PlanExpr };
    }
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
      /**
       * Deduplicate on these output columns instead of the whole row (needs `distinct`): the first row seen for a key
       * wins or, with `order`, the lowest; a key taken from the queue is final (ADR 0033 G2). Shortest paths by hops
       * (no `order`) or by a cost column (`order` on it) keep one row per node. Without `order`, a step's row whose key
       * was seen may be dropped before its other columns are computed: an error one of them would raise is not.
       */
      readonly key?: readonly number[];
      /** Run the steps only for rows fewer than this many steps from `init`, whose rows are at depth 0. */
      readonly maxDepth?: number;
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
       * the input's order and then the list's. As Polars' `explode`: an empty list gives no row (one row with NULL with
       * `emptyAsNull`), a NULL list one row with NULL (none with `keepNulls: false`). With `position`, each row also has
       * the element's position (from 0) as a last column. `also` names more list columns exploded with `column`, zipped
       * by position: in each row they must have as many elements as `column`'s list (a NULL list matching only NULL),
       * else it is an error (`SMALT_RANGE`).
       */
      readonly op: 'explode';
      readonly input: PlanOp;
      readonly column: number;
      /** The list column's type (`list<T>`); the output column's is `T`. */
      readonly type: PlanType;
      readonly also?: readonly { readonly column: number; readonly type: PlanType }[];
      readonly position?: boolean;
      readonly emptyAsNull?: boolean;
      readonly keepNulls?: boolean;
    }
  /**
   * Paths through a graph (ADR 0033, G5): for each input row, the paths that start at the node in column `start` and
   * follow `edges` (each a table and its two endpoint columns, as table column indexes) in `direction`, with
   * `minHops` (default 1) to `maxHops` (default no limit) relationships. Each row is the input row followed by the
   * path's last node (`int`), its length in hops (`int`) and the path ({@link PATH_TYPE}: per hop, the position of its
   * table in `edges`, the relationship's rowid, and the nodes it went from and to). Rows keep the input's order; an
   * input row's paths come shortest first.
   *
   * `mode` limits what a path may repeat: `walk` anything, `trail` no relationship, `acyclic` no node, `simple` no node
   * except that the last may be the first. `selector` picks among each input row's paths to each last node: `all`,
   * `any` (one), `anyShortest` (one of the shortest), `allShortest`, or `{ shortest: k }` (the k shortest). A walk
   * with no `maxHops` needs `any` or `anyShortest`, which keep one path per node; everything else has an end.
   *
   * `target` (ADR 0040) names an input column: only paths that end at the node in it. A search for one path per node
   * then stops when it reaches that node.
   */
  | {
      readonly op: 'paths';
      readonly input: PlanOp;
      readonly start: number;
      readonly edges: readonly PathEdges[];
      readonly direction: 'out' | 'in' | 'both';
      readonly minHops?: number;
      readonly maxHops?: number;
      readonly mode?: 'walk' | 'trail' | 'acyclic' | 'simple';
      readonly selector?: 'all' | 'any' | 'anyShortest' | 'allShortest' | { readonly shortest: number };
      readonly target?: number;
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
  /**
   * Makes nodes and relationships of a property graph for each row of `input` (ADR 0042, section 1): first the
   * `nodes`, in order, then the `relationships`. A node's id is one more than the largest the graph has had; a
   * relationship's rowid one more than the largest across the graph's relationship tables. `props` reads the row as
   * far as it is made: the input's columns, then the ids of the nodes and relationships made before it. Outputs the
   * input's columns, then each new node's id, then each new relationship's rowid.
   *
   * A label or a relationship type the graph has not is added to it when the statement starts (`tables` names the
   * tables made for them, in the order they are added). A relationship whose end is NULL is an error.
   */
  | {
      readonly op: 'graphCreate';
      readonly graph: string;
      readonly input: PlanOp;
      readonly nodes: readonly GraphNewNode[];
      readonly relationships: readonly GraphNewRelationship[];
      readonly tables?: readonly GraphNewTable[];
    }
  /**
   * Changes properties and labels of the nodes and relationships each row of `input` names, item by item. A label it
   * adds that the graph has not is added to the graph when the statement starts, as a `graphCreate`'s. Outputs the
   * input's columns.
   */
  | { readonly op: 'graphSet'; readonly graph: string; readonly input: PlanOp; readonly items: readonly GraphSetItem[]; readonly tables?: readonly GraphNewTable[] }
  /**
   * Deletes what each row of `input` names, target by target in the order given, each before the next is looked at.
   * A node that still has relationships then is an error; with `detach` they are deleted first. Outputs the input's
   * columns.
   */
  | { readonly op: 'graphDelete'; readonly graph: string; readonly input: PlanOp; readonly targets: readonly GraphDeleteTarget[]; readonly detach: boolean }
  /**
   * For each row of `input`, runs `match`, a plan that reads the graph for the row: inside it, a `working` operation
   * with this operation's `id` gives the row, as a relation of that one row. If `match` gives rows, each is passed on
   * after `onMatch` is applied to it. If it gives none, the `nodes` and `relationships` are made as a `graphCreate`
   * makes them, `created` gives the columns `match` would have (expressions over the input's columns, then the new
   * nodes' ids, then the new relationships' rowids), and the row is passed on after `onCreate`. A row sees what
   * earlier rows made. Outputs the input's columns, then `match`'s; `onMatch` and `onCreate` read that row.
   */
  | {
      readonly op: 'graphMerge';
      readonly graph: string;
      readonly id: number;
      readonly input: PlanOp;
      readonly match: PlanOp;
      readonly nodes: readonly GraphNewNode[];
      readonly relationships: readonly GraphNewRelationship[];
      readonly created: readonly PlanExpr[];
      readonly onMatch: readonly GraphSetItem[];
      readonly onCreate: readonly GraphSetItem[];
      readonly tables?: readonly GraphNewTable[];
    }
  /**
   * Passes its input's rows on once it has read them all: what is below it is done before what is above it starts
   * (ADR 0042, section 1). Outputs the input's columns.
   */
  | { readonly op: 'eager'; readonly input: PlanOp }
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
