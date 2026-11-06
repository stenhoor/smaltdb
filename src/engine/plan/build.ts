/**
 * Builders for plans (ADR 0014 section 4): thin constructors for plan operations and expressions that fill in the
 * usual values (BINARY collation, ascending keys, NULLs first). They check nothing: the engine validates every plan
 * it is given (plan/validate.ts), so a plan built by hand and one built here are treated alike.
 *
 * Columns are referenced by position (`col(input, index, type)`); the shapes are those of plan/ops.ts and
 * plan/expr.ts.
 */
import type { SqlValue } from '../values.js';
import { call, col, lit, param, type PlanExpr, typeOf } from './expr.js';
import type { AggCall, ConflictAction, JoinKind, PlanOp, SortKey } from './ops.js';
import type { CollationName, PlanType } from './types.js';

type Op<K extends PlanOp['op']> = Extract<PlanOp, { op: K }>;

// ------------------------------------------------------------------ expressions

export { call, col, lit, param };

export const and = (...args: PlanExpr[]): PlanExpr => ({ k: 'and', args });
export const or = (...args: PlanExpr[]): PlanExpr => ({ k: 'or', args });
export const not = (arg: PlanExpr): PlanExpr => ({ k: 'not', arg });
export const isNull = (arg: PlanExpr): PlanExpr => ({ k: 'isNull', arg, not: false });
export const isNotNull = (arg: PlanExpr): PlanExpr => ({ k: 'isNull', arg, not: true });
/** A conversion: `fn` names it (e.g. `sql.cast_integer`). */
export const cast = (fn: string, arg: PlanExpr, to: PlanType): PlanExpr => ({ k: 'cast', fn, to, arg });
/** Searched CASE: the first `when` that is true gives the value, else `otherwise` (default NULL). */
export const caseWhen = (whens: readonly { when: PlanExpr; then: PlanExpr }[], type: PlanType, otherwise: PlanExpr = lit(null)): PlanExpr => ({ k: 'case', whens, else: otherwise, type });
/** The first column of the nested plan's first row (NULL if none). */
export const scalar = (plan: PlanOp, type: PlanType, collation: CollationName = 'binary'): PlanExpr => ({ k: 'subquery', mode: 'scalar', plan, type, collation });
/** Whether the nested plan has a row. */
export const exists = (plan: PlanOp): PlanExpr => ({ k: 'subquery', mode: 'exists', plan, type: 'int', collation: 'binary' });
/** Whether `probe` is in the nested plan's single column: 1, 0 or NULL. */
export const inPlan = (probe: PlanExpr, plan: PlanOp, collation: CollationName = 'binary'): PlanExpr => ({ k: 'inSubquery', probe, plan, collation });

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

export const filter = (input: PlanOp, pred: PlanExpr): Op<'filter'> => ({ op: 'filter', input, pred });
export const project = (input: PlanOp, exprs: readonly PlanExpr[]): Op<'project'> => ({ op: 'project', input, exprs });
export const limit = (input: PlanOp, count: PlanExpr | number, offset?: PlanExpr | number): Op<'limit'> => ({ op: 'limit', input, count: expr(count), ...(offset !== undefined ? { offset: expr(offset) } : {}) });
export const sort = (input: PlanOp, keys: readonly SortKey[]): Op<'sort'> => ({ op: 'sort', input, keys });
/** A join; its condition reads input 0 (left) and input 1 (right). */
export const join = (kind: JoinKind, left: PlanOp, right: PlanOp, on?: PlanExpr, options: { ordered?: boolean } = {}): Op<'join'> => ({
  op: 'join',
  kind,
  inputs: [left, right],
  ...(on ? { on } : {}),
  ...(options.ordered ? { ordered: true as const } : {}),
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
/** Distinct rows of an input with `width` columns. */
export const distinct = (input: PlanOp, width: number, collations?: readonly CollationName[], options: { ordered?: 'first' } = {}): Op<'distinct'> => ({
  op: 'distinct',
  input,
  collations: collations ?? Array<CollationName>(width).fill('binary'),
  ...(options.ordered ? { ordered: options.ordered } : {}),
});
/** A set operation of two inputs with `width` columns each. */
export const setop = (kind: Op<'setop'>['kind'], left: PlanOp, right: PlanOp, width: number, collations?: readonly CollationName[]): Op<'setop'> => ({ op: 'setop', kind, inputs: [left, right], collations: collations ?? Array<CollationName>(width).fill('binary') });

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

const expr = (x: PlanExpr | number): PlanExpr => (typeof x === 'number' ? lit(x) : x);

const typeOfLit = (e: PlanExpr): PlanType => typeOf(e);

/** A literal from a JavaScript value (its type from the value). */
export const value = (v: SqlValue): PlanExpr => lit(v);
