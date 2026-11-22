/**
 * Builders for plans (ADR 0014 section 4): thin constructors for plan operations and expressions that fill in the
 * usual values (BINARY collation, ascending keys, NULLs first). They check nothing: the engine validates every plan
 * it is given (plan/validate.ts), so a plan built by hand and one built here are treated alike.
 *
 * Columns are referenced by position (`col(input, index, type)`); the shapes are those of plan/ops.ts and
 * plan/expr.ts.
 */
import type { SqlValue } from '../values.js';
import { call, col, type EachAggCall, lit, param, type PlanExpr, typeOf } from './expr.js';
import { parseNested } from '../../shared/nested-types.js';
import type { AggCall, ConflictAction, GraphDeleteTarget, GraphNewNode, GraphNewRelationship, GraphNewTable, GraphSetItem, JoinKind, PathEdges, PlanOp, SortKey, ValueColumn, WindowCall, WindowFrame } from './ops.js';
import type { CollationName, PlanType } from './types.js';

type Op<K extends PlanOp['op']> = Extract<PlanOp, { op: K }>;

// ------------------------------------------------------------------ expressions

export { call, col, lit, param };

export const and = (...args: PlanExpr[]): PlanExpr => ({ k: 'and', args });
export const or = (...args: PlanExpr[]): PlanExpr => ({ k: 'or', args });
export const not = (arg: PlanExpr): PlanExpr => ({ k: 'not', arg });
export const isNull = (arg: PlanExpr): PlanExpr => ({ k: 'isNull', arg, not: false });
/** A logic node (`and`, `or`, `not`, `isNull`) typed `bool` (or `int`) explicitly (ADR 0018). */
export const typed = <E extends PlanExpr>(e: E, type: 'bool' | 'int'): E => ({ ...e, type }) as E;
export const isNotNull = (arg: PlanExpr): PlanExpr => ({ k: 'isNull', arg, not: true });
/** A conversion: `fn` names it (e.g. `cast_integer`). */
export const cast = (fn: string, arg: PlanExpr, to: PlanType): PlanExpr => ({ k: 'cast', fn, to, arg });
/** Searched CASE: the first `when` that is true gives the value, else `otherwise` (default NULL). */
export const caseWhen = (whens: readonly { when: PlanExpr; then: PlanExpr }[], type: PlanType, otherwise: PlanExpr = lit(null)): PlanExpr => ({ k: 'case', whens, else: otherwise, type });
/** The first column of the nested plan's first row (NULL if none). */
export const scalar = (plan: PlanOp, type: PlanType, collation: CollationName = 'binary'): PlanExpr => ({ k: 'subquery', mode: 'scalar', plan, type, collation });
/** Whether the nested plan has a row. */
export const exists = (plan: PlanOp): PlanExpr => ({ k: 'subquery', mode: 'exists', plan, type: 'int', collation: 'binary' });
/** Whether `probe` is in the nested plan's single column: 1, 0 or NULL. */
export const inPlan = (probe: PlanExpr, plan: PlanOp, collation: CollationName = 'binary'): PlanExpr => ({ k: 'inSubquery', probe, plan, collation });

/** The element type of list type `t` (`any` when `t` is not a list type). */
export function elementType(t: PlanType): PlanType {
  const n = parseNested(t);
  return n?.kind === 'list' ? (n.of as PlanType) : 'any';
}
/** In an `each` body: the element of the `each` `depth` levels out (0: the innermost). */
export const element = (type: PlanType, depth = 0): PlanExpr => ({ k: 'element', part: 'value', depth, type });
/** In an `each` body: the element's position, from 0. */
export const elementPosition = (depth = 0): PlanExpr => ({ k: 'element', part: 'position', depth, type: 'int' });
/** In a `listAgg` body: the result of its aggregate `index`. */
export const aggResult = (index: number, type: PlanType, depth = 0): PlanExpr => ({ k: 'eachAgg', index, depth, type });
/** The list of `body` for each element of `list` (ADR 0031). */
export const listMap = (list: PlanExpr, body: PlanExpr): PlanExpr => ({ k: 'each', mode: 'map', list, body, type: `list<${typeOf(body) === 'null' ? 'any' : typeOf(body)}>` as PlanType });
/** The elements of `list` for which `pred` is true, in order. */
export const listFilter = (list: PlanExpr, pred: PlanExpr): PlanExpr => ({ k: 'each', mode: 'filter', list, body: pred, type: typeOf(list) });
/** `body` over the results of aggregates `aggs` run over the elements of `list` (read them with `aggResult`). */
export const listAgg = (list: PlanExpr, aggs: readonly EachAggCall<PlanExpr>[], body: PlanExpr): PlanExpr => ({ k: 'each', mode: 'agg', list, aggs, body, type: typeOf(body) });

/** A sort key: ascending with NULLs first unless `options` say otherwise. */
export const asc = (expr: PlanExpr, options: { nullsFirst?: boolean; collation?: CollationName } = {}): SortKey => ({ expr, desc: false, nullsFirst: options.nullsFirst ?? true, collation: options.collation ?? 'binary' });
/** A descending sort key: NULLs last unless `options` say otherwise. */
export const desc = (expr: PlanExpr, options: { nullsFirst?: boolean; collation?: CollationName } = {}): SortKey => ({ expr, desc: true, nullsFirst: options.nullsFirst ?? false, collation: options.collation ?? 'binary' });

/** An aggregate call (`fn` a registered aggregate, e.g. `sum`, `count`). */
export const agg = (fn: string, args: readonly PlanExpr[], type: PlanType, options: { star?: boolean; distinct?: boolean; filter?: PlanExpr; collation?: CollationName } = {}): AggCall => ({
  fn,
  args,
  star: options.star ?? false,
  distinct: options.distinct ?? false,
  ...(options.filter ? { filter: options.filter } : {}),
  collation: options.collation ?? 'binary',
  type,
});

// ------------------------------------------------------------------ operations

/** Columns `columns` of a table (-1: the rowid). */
export const scan = (table: string, columns: readonly number[], options: { db?: 'main' | 'temp'; indexedBy?: string | null } = {}): Op<'scan'> => ({
  op: 'scan',
  table,
  ...(options.db ? { db: options.db } : {}),
  columns,
  ...(options.indexedBy !== undefined ? { indexedBy: options.indexedBy } : {}),
});

/** Constant rows; `types` default to the first row's. */
export const values = (rows: readonly (readonly PlanExpr[])[], types?: readonly PlanType[]): Op<'values'> => ({ op: 'values', rows, types: types ?? (rows[0] ?? []).map(typeOfLit) });

/** Rows given as one array per column (typed arrays, value arrays, or either with a null bitmap), of `types`. */
export const fromColumns = (columns: readonly ValueColumn[], types: readonly PlanType[]): Op<'values'> => ({ op: 'values', rows: [], types, columns });

export const filter = (input: PlanOp, pred: PlanExpr): Op<'filter'> => ({ op: 'filter', input, pred });
export const project = (input: PlanOp, exprs: readonly PlanExpr[]): Op<'project'> => ({ op: 'project', input, exprs });
export const limit = (input: PlanOp, count: PlanExpr | number, offset?: PlanExpr | number, options: { fromEnd?: boolean } = {}): Op<'limit'> => ({
  op: 'limit',
  input,
  count: expr(count),
  ...(offset !== undefined ? { offset: expr(offset) } : {}),
  ...(options.fromEnd ? { fromEnd: true as const } : {}),
});
export const sort = (input: PlanOp, keys: readonly SortKey[]): Op<'sort'> => ({ op: 'sort', input, keys });
/** A join; its condition reads input 0 (left) and input 1 (right). */
export const join = (kind: JoinKind, left: PlanOp, right: PlanOp, on?: PlanExpr, options: { ordered?: boolean } = {}): Op<'join'> => ({
  op: 'join',
  kind,
  inputs: [left, right],
  ...(on ? { on } : {}),
  ...(options.ordered ? { ordered: true as const } : {}),
});
/**
 * An as-of join: each left row, in left order, with the right row whose `rightKey` is nearest its `leftKey` in
 * `direction` (within `tolerance`) among those `on` matches, or NULLs when none does. Keys read input 0 (left) and 1.
 */
export const asofJoin = (left: PlanOp, right: PlanOp, leftKey: PlanExpr, rightKey: PlanExpr, options: { direction?: 'backward' | 'forward' | 'nearest'; tolerance?: PlanExpr | number; on?: PlanExpr } = {}): Op<'join'> => ({
  op: 'join',
  kind: 'asof',
  inputs: [left, right],
  ...(options.on ? { on: options.on } : {}),
  asof: { left: leftKey, right: rightKey, direction: options.direction ?? 'backward', ...(options.tolerance !== undefined ? { tolerance: expr(options.tolerance) } : {}) },
});

/** Rows grouped by `keys`: outputs the keys, then the aggregates, then the carried columns. */
export const aggregate = (input: PlanOp, keys: readonly PlanExpr[], aggs: readonly AggCall[], options: { collations?: readonly CollationName[]; carry?: readonly PlanExpr[]; ordered?: 'first' } = {}): Op<'aggregate'> => ({
  op: 'aggregate',
  input,
  keys: keys.map((e, i) => ({ expr: e, collation: options.collations?.[i] ?? 'binary' })),
  aggs,
  carry: options.carry ?? [],
  ...(options.ordered ? { ordered: options.ordered } : {}),
});
/**
 * Rows drawn from `input` at random, fixed by `seed`: `count` of them or a `fraction` of its rows. Without replacement
 * the rows keep their input order; with it they come in the order drawn.
 */
export const sample = (input: PlanOp, size: { count: PlanExpr | number } | { fraction: PlanExpr | number }, options: { replace?: boolean; seed?: number } = {}): Op<'sample'> => ({
  op: 'sample',
  input,
  ...('count' in size ? { count: expr(size.count) } : { fraction: expr(size.fraction) }),
  replace: options.replace ?? false,
  seed: options.seed ?? 0,
});

/**
 * Values of `on` as columns (a wide form): one row per group of `keys`, then for each of `values` and each of `aggs`
 * the aggregate over the group's rows whose `on` is that value.
 */
export const pivot = (input: PlanOp, keys: readonly PlanExpr[], on: PlanExpr, values: readonly SqlValue[], aggs: readonly AggCall[], options: { collations?: readonly CollationName[]; collation?: CollationName; ordered?: 'first' } = {}): Op<'pivot'> => ({
  op: 'pivot',
  input,
  keys: keys.map((e, i) => ({ expr: e, collation: options.collations?.[i] ?? 'binary' })),
  on,
  collation: options.collation ?? 'binary',
  values,
  aggs,
  ...(options.ordered ? { ordered: options.ordered } : {}),
});

/**
 * `input`'s `columns` as rows (a long form): each input row gives one row per column, in input order and then the
 * columns' order, with the `keep` columns, the column's name (from `names`) and its value (of `type`).
 */
/**
 * One row per element of list column `column` (typed `type`, a list type; ADR 0020). `position` adds the element's
 * position; `emptyAsNull` gives an empty list a NULL row; `keepNulls: false` drops NULL lists. `also` explodes more list
 * columns with it, zipped by position (their lists must be as long as its).
 */
export const explode = (
  input: PlanOp,
  column: number,
  type: PlanType,
  options: { position?: boolean; emptyAsNull?: boolean; keepNulls?: boolean; also?: readonly { column: number; type: PlanType }[] } = {},
): Op<'explode'> => ({
  op: 'explode',
  input,
  column,
  type,
  ...(options.also?.length ? { also: options.also } : {}),
  ...(options.position ? { position: true } : {}),
  ...(options.emptyAsNull ? { emptyAsNull: true } : {}),
  ...(options.keepNulls === false ? { keepNulls: false } : {}),
});
/**
 * A property graph's relationships as a relation (ADR 0040; see the `relationships` operation): columns `node`,
 * `other`, `type`, `id`, `outgoing`, `props`. Join it on `node` for the relationships at a node.
 */
export const relationships = (
  graph: string,
  direction: 'out' | 'in' | 'both' = 'out',
  options: { types?: readonly string[]; asOf?: { readonly commit: PlanExpr } | { readonly time: PlanExpr } } = {},
): Op<'relationships'> => ({
  op: 'relationships',
  graph,
  direction,
  ...(options.types ? { types: options.types } : {}),
  ...(options.asOf ? { asOf: options.asOf } : {}),
});

/** Paths through a graph from the node in column `start` of each input row (ADR 0033, G5; see the `paths` operation). */
export const paths = (
  input: PlanOp,
  start: number,
  edges: readonly PathEdges[],
  options: {
    direction?: 'out' | 'in' | 'both';
    minHops?: number;
    maxHops?: number;
    mode?: 'walk' | 'trail' | 'acyclic' | 'simple';
    selector?: 'all' | 'any' | 'anyShortest' | 'allShortest' | { shortest: number };
    target?: number;
  } = {},
): Op<'paths'> => ({
  op: 'paths',
  input,
  start,
  edges,
  direction: options.direction ?? 'out',
  ...(options.minHops !== undefined ? { minHops: options.minHops } : {}),
  ...(options.maxHops !== undefined ? { maxHops: options.maxHops } : {}),
  ...(options.mode !== undefined ? { mode: options.mode } : {}),
  ...(options.selector !== undefined ? { selector: options.selector } : {}),
  ...(options.target !== undefined ? { target: options.target } : {}),
});
export const unpivot = (input: PlanOp, keep: readonly number[], columns: readonly number[], names: readonly string[], type: PlanType = 'any'): Op<'unpivot'> => ({ op: 'unpivot', input, keep, columns, names, type });
/** Distinct rows of an input with `width` columns. */
export const distinct = (input: PlanOp, width: number, collations?: readonly CollationName[], options: { ordered?: 'first'; on?: readonly number[]; keep?: 'first' | 'last' } = {}): Op<'distinct'> => ({
  op: 'distinct',
  input,
  collations: collations ?? Array<CollationName>(width).fill('binary'),
  ...(options.ordered ? { ordered: options.ordered } : {}),
  ...(options.on ? { on: options.on } : {}),
  ...(options.keep ? { keep: options.keep } : {}),
});
/** A set operation of two inputs with `width` columns each. */
export const setop = (kind: Op<'setop'>['kind'], left: PlanOp, right: PlanOp, width: number, collations?: readonly CollationName[]): Op<'setop'> => ({ op: 'setop', kind, inputs: [left, right], collations: collations ?? Array<CollationName>(width).fill('binary') });

// ------------------------------------------------------------------ windows

/** A frame bound: `unboundedPreceding`, `preceding(n)`, `currentRow`, `following(n)`, `unboundedFollowing`. */
export type FrameBound = WindowFrame['start'];
export const unboundedPreceding: FrameBound = { kind: 'unboundedPreceding' };
export const currentRow: FrameBound = { kind: 'currentRow' };
export const unboundedFollowing: FrameBound = { kind: 'unboundedFollowing' };
export const preceding = (offset: PlanExpr | number): FrameBound => ({ kind: 'preceding', offset: expr(offset) });
export const following = (offset: PlanExpr | number): FrameBound => ({ kind: 'following', offset: expr(offset) });
/** A window frame: its unit, bounds and exclusion. */
export const frame = (unit: WindowFrame['unit'], start: FrameBound, end: FrameBound, exclude: WindowFrame['exclude'] = 'NO OTHERS'): WindowFrame => ({ unit, start, end, exclude });

/** A window call: a ranking or navigation function, or an aggregate over the frame. */
export const windowCall = (fn: string, args: readonly PlanExpr[], type: PlanType, options: { star?: boolean; filter?: PlanExpr; collation?: CollationName; ignoreNulls?: boolean } = {}): WindowCall => ({
  fn,
  args,
  star: options.star ?? false,
  type,
  collation: options.collation ?? 'binary',
  ...(options.filter ? { filter: options.filter } : {}),
  ...(options.ignoreNulls ? { ignoreNulls: true } : {}),
});

/**
 * The window `calls` over `input`: its columns, then one per call. Rows are grouped by `partition` and ordered by
 * `order` within it; the frame defaults to the partition's rows up to the current row and its peers (the whole
 * partition without an order).
 */
export const window = (
  input: PlanOp,
  calls: readonly WindowCall[],
  options: { partition?: readonly PlanExpr[]; collations?: readonly CollationName[]; order?: readonly SortKey[]; frame?: WindowFrame } = {},
): Op<'window'> => ({
  op: 'window',
  input,
  partition: (options.partition ?? []).map((e, i) => ({ expr: e, collation: options.collations?.[i] ?? 'binary' })),
  order: options.order ?? [],
  frame: options.frame ?? frame('RANGE', unboundedPreceding, currentRow),
  calls,
});

// ------------------------------------------------------------------ sources and recursion

/** Rows of a table function, a virtual table or an external table: `types` describes each of its columns. */
export const source = (kind: Op<'source'>['kind'], name: string, args: readonly PlanExpr[], types: readonly PlanType[], options: { schema?: string; named?: Readonly<Record<string, PlanExpr>> } = {}): Op<'source'> => ({
  op: 'source',
  kind,
  name,
  args,
  types,
  ...(options.schema !== undefined ? { schema: options.schema } : {}),
  ...(options.named ? { named: options.named } : {}),
});

/**
 * Recursion: `init`'s rows, then each step's over the rows the previous one gave (read with `working(id, types)`),
 * until a step gives none. `distinct` drops rows already given (by `collations`); with `key`, rows whose key columns were
 * already given (the first wins, or the lowest by `order`). `maxDepth` stops the steps that many steps from `init`.
 */
export const iterate = (
  id: number,
  name: string,
  init: PlanOp,
  steps: readonly PlanOp[],
  options: { distinct?: boolean; collations?: readonly CollationName[]; order?: readonly SortKey[]; limit?: PlanExpr | number; offset?: PlanExpr | number; key?: readonly number[]; maxDepth?: number } = {},
): Op<'iterate'> => ({
  op: 'iterate',
  id,
  name,
  init,
  steps,
  distinct: options.distinct ?? false,
  collations: options.collations ?? [],
  ...(options.order ? { order: options.order } : {}),
  ...(options.limit !== undefined ? { limit: expr(options.limit) } : {}),
  ...(options.offset !== undefined ? { offset: expr(options.offset) } : {}),
  ...(options.key ? { key: options.key } : {}),
  ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {}),
});
/** Inside `iterate` `id`: the rows the previous step gave. */
export const working = (id: number, types: readonly PlanType[]): Op<'working'> => ({ op: 'working', id, types });

/** Rows of `input` appended to `table`, its columns assigned to the table's `columns` (-1: the rowid). */
export const append = (table: string, input: PlanOp | null, columns: readonly number[], options: { db?: 'main' | 'temp'; onConflict?: ConflictAction; returning?: readonly PlanExpr[] } = {}): Op<'append'> => ({
  op: 'append',
  table,
  db: options.db ?? 'main',
  ...(options.onConflict ? { onConflict: options.onConflict } : {}),
  input,
  columns,
  upserts: [],
  ...(options.returning ? { returning: options.returning } : {}),
});

/** For each row of `input`, sets the row of `table` whose rowid is in column `rowid`. */
export const update = (table: string, input: PlanOp, rowid: number, sets: readonly { column: number; value: PlanExpr }[], options: { db?: 'main' | 'temp'; onConflict?: ConflictAction; returning?: readonly PlanExpr[] } = {}): Op<'update'> => ({
  op: 'update',
  table,
  db: options.db ?? 'main',
  ...(options.onConflict ? { onConflict: options.onConflict } : {}),
  input,
  rowid,
  sets,
  from: false,
  ...(options.returning ? { returning: options.returning } : {}),
});

/** Deletes the rows of `table` whose rowids `input` gives in column `rowid`. */
export const remove = (table: string, input: PlanOp, rowid: number, options: { db?: 'main' | 'temp'; returning?: readonly PlanExpr[] } = {}): Op<'delete'> => ({
  op: 'delete',
  table,
  db: options.db ?? 'main',
  input,
  rowid,
  ...(options.returning ? { returning: options.returning } : {}),
});

/**
 * For each row of `input`: makes `nodes`, then `relationships`, in the property graph `graph` (ADR 0042). `tables`
 * names the tables of the labels and types it adds to the graph.
 */
export const graphCreate = (graph: string, input: PlanOp, nodes: readonly GraphNewNode[], relationships: readonly GraphNewRelationship[] = [], tables?: readonly GraphNewTable[]): Op<'graphCreate'> => ({
  op: 'graphCreate',
  graph,
  input,
  nodes,
  relationships,
  ...(tables ? { tables } : {}),
});

/** For each row of `input`: changes the properties and labels its `items` name. */
export const graphSet = (graph: string, input: PlanOp, items: readonly GraphSetItem[], tables?: readonly GraphNewTable[]): Op<'graphSet'> => ({
  op: 'graphSet',
  graph,
  input,
  items,
  ...(tables ? { tables } : {}),
});

/** For each row of `input`: deletes its `targets`, in order (`detach`: a node's relationships first). */
export const graphDelete = (graph: string, input: PlanOp, targets: readonly GraphDeleteTarget[], options: { detach?: boolean } = {}): Op<'graphDelete'> => ({
  op: 'graphDelete',
  graph,
  input,
  targets,
  detach: options.detach ?? false,
});

/**
 * For each row of `input`: the rows of `match` (which reads the row through `working(id, …)`), or, when it gives
 * none, `nodes` and `relationships` made and `created` in `match`'s columns.
 */
export const graphMerge = (
  graph: string,
  id: number,
  input: PlanOp,
  match: PlanOp,
  make: { nodes?: readonly GraphNewNode[]; relationships?: readonly GraphNewRelationship[]; created: readonly PlanExpr[]; onMatch?: readonly GraphSetItem[]; onCreate?: readonly GraphSetItem[]; tables?: readonly GraphNewTable[] },
): Op<'graphMerge'> => ({
  op: 'graphMerge',
  graph,
  id,
  input,
  match,
  nodes: make.nodes ?? [],
  relationships: make.relationships ?? [],
  created: make.created,
  onMatch: make.onMatch ?? [],
  onCreate: make.onCreate ?? [],
  ...(make.tables ? { tables: make.tables } : {}),
});

/** `input`'s rows, passed on once all of them are read. */
export const eager = (input: PlanOp): Op<'eager'> => ({ op: 'eager', input });

const expr = (x: PlanExpr | number): PlanExpr => (typeof x === 'number' ? lit(x) : x);

const typeOfLit = (e: PlanExpr): PlanType => typeOf(e);

/** A literal from a JavaScript value (its type from the value). */
export const value = (v: SqlValue): PlanExpr => lit(v);
