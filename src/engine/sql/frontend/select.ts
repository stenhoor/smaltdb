/**
 * The SQL front end (ADR 0014): turns a parsed statement into a plan (plan/ops.ts) whose expressions reference
 * columns by position: name resolution, view and CTE expansion, flattening, materialized-view matching and the
 * SQLite errors that go with them. Costing, access paths and operators are the physical planner's (exec/planner.ts).
 */
import { type TableSchema, findColumn, storageTypeFor } from '../../language-support.js';
import { SmaltError } from '../../language-support.js';
import { type Affinity, type StaticType, affinityOfStorage, staticTypeOfStorage } from '../../language-support.js';
import { CollSrc, boundMetadata, compileBoundExpr } from '../../language-support.js';
import { type ColumnBinding, type CompileScope, bindExpr as bindAst, conjuncts, withCompiledMeta as withCompiledMetaBound } from './bind-expr.js';
import { aggregateFunctions, scalarFunctions } from '../../language-support.js';
import { NAVIGATION, RANKING, WINDOW_ARITY } from '../../language-support.js';
import { flattenCore, flatteningDisabled } from './flatten.js';
import { sqlView } from './views.js';
import { aggregateCallName } from '../ast-util.js';
import { containsAggregate, containsWindow, coreReferences, exprEquals, firstAggregateCall, firstWindowCall, sameName, selectReferences } from './ast-helpers.js';
import { type BoundExpr, type PlanExpr, typeOf } from '../../language-support.js';
import { getMeta, markFlattened, setMeta } from '../../language-support.js';
import type { AggCall, ConflictAction, JoinKind, PlanOp, SortKey, WindowCall, WindowFrame } from '../../language-support.js';
import type { BindContext } from '../../language-support.js';
import type { CollationName } from '../../language-support.js';
import { Collation, type SqlValue } from '../../language-support.js';
import type { CallExpr, ColumnExpr, DeleteStmt, Expr, InsertStmt, UpdateStmt, UpsertClause, FrameBound, FromItem, JoinType, OrderingTerm, ResultColumn, SelectCore, SelectCoreSelect, SelectStmt, WindowSpec, WithClause } from '../ast.js';

/**
 * The binder, for the front end. Its result stands for columns by `slot`s until `resolveRefs` replaces them with `col`
 * references, before the plan leaves the front end (and `resolveRefs` rejects anything else that is not plan).
 */
const bindExpr = (e: Expr, scope: CompileScope): PlanExpr => bindAst(e, scope) as PlanExpr;
const withCompiledMeta = (e: PlanExpr, c: Parameters<typeof withCompiledMetaBound>[1]): PlanExpr => withCompiledMetaBound(e, c) as PlanExpr;

/** A result column, with the metadata SQL keeps beside the plan. */
export interface FrontEndColumn {
  name: string;
  type: StaticType;
  declType?: string;
  collation: Collation;
  affinity: Affinity;
}

export interface FrontEndResult {
  plan: PlanOp;
  columns: FrontEndColumn[];
}

/** A plan node's fields, writable (the front end completes its own plans in place). */
type Mutable<T> = T extends unknown ? { -readonly [K in keyof T]: T[K] } : never;

/** A source's hidden columns when it has none (replaced by a new set on the first USING / NATURAL column). */
const NO_HIDDEN: Set<string> = new Set();

/**
 * A table's source columns and scan columns (the rowid last when it has no alias), built once per table schema:
 * the front end only reads them, and DDL replaces the schema object.
 */
const tableShapes = new WeakMap<TableSchema, { cols: FeColumn[]; columns: number[] }>();
function tableShape(table: TableSchema): { cols: FeColumn[]; columns: number[] } {
  let s = tableShapes.get(table);
  if (s === undefined) {
    const cols: FeColumn[] = table.columns.map((c) => ({
      name: c.name,
      type: c.rowidAlias ? 'int' : staticTypeOfStorage(c.type),
      collation: c.collation,
      affinity: affinityOfStorage(c.type),
      declType: c.declaredType,
    }));
    const columns = table.columns.map((_c, i) => i);
    if (table.rowidAlias < 0) columns.push(-1);
    tableShapes.set(table, (s = { cols, columns }));
  }
  return s;
}

/** A join condition read a source after the one it joins (FrontEnd.from moves it to the WHERE, or rejects it). */
class LaterSource extends Error {}

/**
 * Plan a SELECT. `text` is the statement's SQL text (result columns are named from it). Throws SQLite's errors.
 */
export function toPlan(stmt: SelectStmt, text: string, catalog: BindContext): FrontEndResult {
  const fe = new FrontEnd(catalog, text);
  const r = fe.select(stmt, null);
  return { plan: fe.resolveRefs(r.plan), columns: r.columns };
}

/**
 * INSERT, UPDATE or DELETE as a write plan (`append`, `update`, `delete`; ADR 0015 step 6): the front end resolves
 * its own target (through `catalog.writeTarget`, which refuses what may not be written), the INSERT column list and
 * the statement's conflict action. `source`: an INSERT … SELECT's result columns.
 */
export function toWritePlan(stmt: InsertStmt | UpdateStmt | DeleteStmt, text: string, catalog: BindContext): FrontEndWrite & { source?: FrontEndColumn[] } {
  const fe = new FrontEnd(catalog, text);
  if (stmt.kind === 'insert') {
    // WITH ... INSERT: the CTEs belong to the row source.
    if (stmt.with) {
      if (stmt.source.kind !== 'select') throw new SmaltError('SMALT_UNSUPPORTED', 'WITH ... INSERT ... VALUES is not supported yet');
      const sel = stmt.source.select;
      const merged = sel.with ? { ...sel.with, recursive: sel.with.recursive || stmt.with.recursive, ctes: [...stmt.with.ctes, ...sel.with.ctes] } : stmt.with;
      stmt = { ...stmt, with: undefined, source: { kind: 'select', select: { ...sel, with: merged } } };
    }
    const table = catalog.writeTarget(stmt.table, stmt.schema);
    if (stmt.source.kind === 'default' && stmt.columns) throw new SmaltError('SMALT_ERROR', `0 values for ${stmt.columns.length} columns`);
    // DEFAULT VALUES supplies no values: every column takes its default. -1: the rowid (a table without an alias).
    const columns: number[] =
      stmt.source.kind === 'default'
        ? []
        : stmt.columns
          ? stmt.columns.map((name) => {
              const i = findColumn(table, name);
              if (i < 0) {
                if (ROWID_NAMES.has(name.toLowerCase()) && table.rowidAlias < 0) return -1;
                throw new SmaltError('SMALT_ERROR', `table ${table.name} has no column named ${name}`);
              }
              return i;
            })
          : table.columns.map((_, i) => i);
    const r = fe.insertPlan(stmt, table, columns);
    return { plan: withConflict(fe.resolveRefs(r.plan), stmt.or), returning: r.returning, source: r.source };
  }
  if (stmt.orderBy.length || stmt.limit) throw new SmaltError('SMALT_UNSUPPORTED', `${stmt.kind === 'update' ? 'UPDATE' : 'DELETE'} ... ORDER BY/LIMIT is not supported`);
  const table = catalog.writeTarget(stmt.table, stmt.schema);
  if (stmt.kind === 'update') {
    const r = fe.updatePlan(stmt, table);
    return { plan: withConflict(fe.resolveRefs(r.plan), stmt.or), returning: r.returning };
  }
  const r = fe.deletePlan(stmt, table);
  return { plan: fe.resolveRefs(r.plan), returning: r.returning };
}

/** A write plan with SQL's `OR` action (`INSERT OR REPLACE`, …) as its conflict action. */
function withConflict(plan: PlanOp, or: string | undefined): PlanOp {
  return or === undefined ? plan : ({ ...plan, onConflict: or.toLowerCase() as ConflictAction } as PlanOp);
}

/**
 * A table's own expression (a CHECK constraint, an index key or a partial-index WHERE) bound over one row of `table`
 * (ADR 0015 step 4): column `i` is `#0.i`, the rowid `#0.n` (n: the column count). `text`: the SQL the expression's
 * positions refer to (the table's or index's definition).
 */
export function toRowExpr(e: Expr, table: TableSchema, text: string, catalog: BindContext): PlanExpr {
  return new FrontEnd(catalog, text).rowExpr(e, table);
}

/** An expression that reads no columns: a column DEFAULT, a PRAGMA value. */
export function toValueExpr(e: Expr, text: string, catalog: BindContext): PlanExpr {
  return new FrontEnd(catalog, text).valueExpr(e);
}

/**
 * The constraint an ON CONFLICT clause (`n`th of `count`) targets: an index of `table`, -1 for its INTEGER PRIMARY
 * KEY, null for any; throws SQLite's errors.
 */
export function upsertTarget(u: UpsertClause, n: number, count: number, table: TableSchema): number | null {
  if (!u.target) {
    if (n !== count - 1) throw new SmaltError('SMALT_ERROR', 'a target-less ON CONFLICT clause must be the last one');
    return null;
  }
  if (u.target.where) throw new SmaltError('SMALT_UNSUPPORTED', 'ON CONFLICT targets with WHERE (partial indexes) are not supported yet');
  const cols = u.target.columns.map((ic) => {
    if (ic.expr.kind !== 'column' && !(ic.expr.kind === 'collate' && ic.expr.expr.kind === 'column')) throw new SmaltError('SMALT_ERROR', 'ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint');
    const name = ic.expr.kind === 'column' ? ic.expr.name : (ic.expr.expr as ColumnExpr).name;
    const i = findColumn(table, name);
    if (i < 0) throw new SmaltError('SMALT_ERROR', `no such column: ${name}`);
    return i;
  });
  const set = new Set(cols);
  if (cols.length === 1 && cols[0] === table.rowidAlias) return -1;
  const i = table.indexes.findIndex((idx) => idx.unique && idx.columns.length === set.size && idx.columns.every((c) => set.has(c.column)));
  if (i < 0) throw new SmaltError('SMALT_ERROR', 'ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint');
  return i;
}

/** A write's plan, and its RETURNING columns. */
export interface FrontEndWrite {
  plan: PlanOp;
  returning?: { name: string; type: StaticType }[];
}

const ROWID_NAMES = new Set(['rowid', 'oid', '_rowid_']);
const TEMP_CATALOG = new Set(['sqlite_temp_schema', 'sqlite_temp_master']);
const COLLATION_NAMES: readonly CollationName[] = ['binary', 'nocase', 'rtrim'];
const collationName = (c: Collation): CollationName => COLLATION_NAMES[c];

interface FeColumn {
  name: string;
  type: StaticType;
  collation: Collation;
  affinity: Affinity;
  declType: string;
}

interface FeSource {
  name: string;
  cols: FeColumn[];
  /** Position of the source's first column in the FROM row. */
  offset: number;
  /** FROM-row position of the rowid (tables), or null. */
  rowid: number | null;
  /** FROM position (join input order). */
  position: number;
  /** Lower-cased column names merged by USING / NATURAL (hidden from unqualified lookup and `*`). */
  hidden: Set<string>;
  /** Width in the FROM row (columns, and the rowid of a table). */
  width: number;
}

class FeScope {
  sources: FeSource[] = [];
  width = 0;
  aliases: Map<string, Expr> | null = null;
  aliasScope: CompileScope | null = null;
  ctes = new Map<string, FeCte>();
  /** After aggregation: FROM-row position of a bare column -> its aggregate output position. */
  carry: ((rowIndex: number, type: StaticType, collation: Collation) => () => number) | null = null;
  /** While binding the ON condition of the join that adds source `onSource`. */
  onSource = -1;
  /** A WITH clause's scope: it holds CTEs, and no rows. */
  ctesOnly = false;
  constructor(readonly parent: FeScope | null) {}

  findCte(name: string): FeCte | undefined {
    const lower = name.toLowerCase();
    for (let s: FeScope | null = this; s; s = s.parent) {
      const c = s.ctes.get(lower);
      if (c) return c;
    }
    return undefined;
  }
}

/** A column reference made while binding: the slot's register is its index in `FrontEnd.refs`. */
interface Ref {
  depth: number;
  input: number;
  index: () => number;
  type: StaticType;
  collation: Collation;
}

interface FeCte {
  select: SelectStmt;
  columns?: string[];
  recursive?: boolean;
  /** Its body is being expanded: reaching it again is a circular reference. */
  expanding?: boolean;
  /** Inside a recursive step: the CTE's name means the previous step's rows. */
  working?: { id: number; columns: FrontEndColumn[] };
}

interface FeWindow {
  key: string;
  partition: { expr: PlanExpr; collation: CollationName }[];
  order: SortKey[];
  frame: WindowFrame;
  calls: WindowCall[];
}

interface CoreResult {
  plan: PlanOp;
  columns: FrontEndColumn[];
}

class FrontEnd {
  readonly refs: Ref[] = [];
  private nextIterate = 0;
  private readonly expandingViews = new Set<string>();
  private readonly expandingAliases = new Set<string>();

  constructor(
    private readonly catalog: BindContext,
    private text: string,
  ) {}

  // ---------------------------------------------------------------- statements

  select(stmt: SelectStmt, parent: FeScope | null): CoreResult {
    const withScope = new FeScope(parent);
    withScope.ctesOnly = true;
    if (stmt.with) this.registerCtes(stmt.with, withScope);
    const base = stmt.with ? withScope : parent;
    if (stmt.compound.length === 0) {
      const f = this.flatten(stmt.core, stmt.orderBy, base);
      const s = f.changed ? { ...stmt, core: f.core, orderBy: f.orderBy } : stmt;
      const r = this.core(f.core, base, s, undefined);
      const plan = this.limit(r.plan, s, base);
      if (f.changed) markFlattened(plan);
      return { plan, columns: r.columns };
    }
    const first = this.core(this.flatten(stmt.core, [], base).core, base, null, undefined);
    let plan = first.plan;
    for (const c of stmt.compound) {
      const next = this.core(this.flatten(c.core, [], base).core, base, null, first.columns.length);
      if (next.columns.length !== first.columns.length) {
        throw new SmaltError('SMALT_ERROR', `SELECTs to the left and right of ${c.op} do not have the same number of result columns`);
      }
      const kind = c.op === 'UNION ALL' ? 'unionAll' : c.op === 'UNION' ? 'union' : c.op === 'INTERSECT' ? 'intersect' : 'except';
      plan = { op: 'setop', kind, inputs: [plan, next.plan], collations: first.columns.map((x) => collationName(x.collation)) };
    }
    if (stmt.orderBy.length) {
      const keys: SortKey[] = stmt.orderBy.map((t) => {
        const idx = this.compoundOrderIndex(t, first.columns, stmt.core);
        const col = first.columns[idx];
        return { expr: { k: 'col', input: 0, index: idx, depth: 0, type: col.type, collation: collationName(col.collation) }, desc: t.desc, nullsFirst: t.nulls ? t.nulls === 'FIRST' : !t.desc, collation: collationName(col.collation) };
      });
      plan = { op: 'sort', input: plan, keys };
    }
    return { plan: this.limit(plan, stmt, base), columns: first.columns };
  }

  /**
   * Merge simple views and FROM subqueries into the core, with the planner's AST flattener (exec/flatten.ts) at the
   * same points as `Planner.planSelect`, so plans and SQL semantics are the planner's (ADR 0014, step 7a).
   */
  private flatten(core: SelectCore, orderBy: OrderingTerm[], scope: FeScope | null): { core: SelectCore; orderBy: OrderingTerm[]; changed: boolean } {
    if (core.kind !== 'select' || !core.from || flatteningDisabled()) return { core, orderBy, changed: false };
    return flattenCore(core, orderBy, {
      getTable: (n, schema) => this.catalog.getTable(n, schema),
      getView: (n, schema) => sqlView(this.catalog.getView?.(n, schema)),
      isCte: (n) => scope?.findCte(n) !== undefined,
      text: this.text,
    });
  }

  // ---------------------------------------------------------------- writes

  /** As `Database.compileInsert`: RETURNING, then the ON CONFLICT clauses, then the rows (their errors in that order). */
  insertPlan(stmt: InsertStmt, table: TableSchema, columns: number[]): { plan: PlanOp; returning?: { name: string; type: StaticType }[]; source?: FrontEndColumn[] } {
    const ncols = table.columns.length;
    const ret = stmt.returning ? this.returning(stmt.returning, table, stmt.alias) : undefined;
    const upserts = stmt.upsert.map((u, n) => {
      const target = upsertTarget(u, n, stmt.upsert.length, table);
      if (u.action.kind === 'nothing') return { target };
      if (!u.target) throw new SmaltError('SMALT_ERROR', 'ON CONFLICT DO UPDATE requires a conflict target');
      // DO UPDATE sees the existing row (table name/alias, unqualified) and `excluded.*` (the proposed row).
      const cs = this.rowScope([
        { table, names: [stmt.alias ?? table.name, table.name], offset: 0 },
        { table, names: ['excluded'], offset: ncols + 1 },
      ]);
      const sets: { column: number; value: PlanExpr }[] = [];
      for (const sc of u.action.set) {
        if (sc.columns.length !== 1) throw new SmaltError('SMALT_UNSUPPORTED', 'row-value assignments are not supported yet');
        const column = findColumn(table, sc.columns[0]);
        if (column < 0) throw new SmaltError('SMALT_ERROR', `no such column: ${sc.columns[0]}`);
        sets.push({ column, value: bindExpr(sc.value, cs) });
      }
      const where = u.action.where ? bindExpr(u.action.where, cs) : undefined;
      return { target, update: { sets, ...(where ? { where } : {}) } };
    });
    let input: PlanOp | null = null;
    let source: FrontEndColumn[] | undefined;
    if (stmt.source.kind === 'values') {
      const cs = this.compileScope(new FeScope(null));
      const rows = stmt.source.rows.map((row) => {
        if (row.length !== columns.length) throw new SmaltError('SMALT_ERROR', `table ${table.name} has ${ncols} columns but ${row.length} values were supplied`);
        return row.map((e) => bindExpr(e, cs));
      });
      input = { op: 'values', rows, types: rows[0].map((e) => typeOf(e)) };
    } else if (stmt.source.kind === 'select') {
      const r = this.select(stmt.source.select, null);
      if (r.columns.length !== columns.length) throw new SmaltError('SMALT_ERROR', `table ${table.name} has ${ncols} columns but ${r.columns.length} values were supplied`);
      input = r.plan;
      source = r.columns;
    }
    const plan: PlanOp = { op: 'append', table: table.name, db: table.temp ? 'temp' : 'main', input, columns, upserts, ...(ret ? { returning: ret.exprs } : {}) };
    return { plan, returning: ret?.columns, source };
  }

  updatePlan(stmt: UpdateStmt, table: TableSchema): { plan: PlanOp; returning?: { name: string; type: StaticType }[] } {
    // As `Database.planTarget`: the target (in its resolved schema), joined with the FROM sources, under the CTEs.
    const withScope = new FeScope(null);
    withScope.ctesOnly = true;
    if (stmt.with) this.registerCtes(stmt.with, withScope);
    const scope = new FeScope(stmt.with ? withScope : null);
    const db = table.temp ? 'temp' : 'main';
    const target: FromItem = { kind: 'table', pos: 0, schema: db, name: table.name, alias: stmt.alias, end: 0 };
    const item: FromItem = stmt.from ? { kind: 'join', joinType: 'INNER', natural: false, left: target, right: stmt.from, pos: 0, end: 0 } : target;
    const input = this.from(item, stmt.where, scope);
    const rowid = scope.sources[0].rowid!;
    // As `Database.compileUpdate`: each assignment's target column, then its value over the FROM row.
    const cs = this.compileScope(scope);
    const sets: { column: number; value: PlanExpr }[] = [];
    for (const s of stmt.set) {
      if (s.columns.length !== 1) throw new SmaltError('SMALT_UNSUPPORTED', 'row-value assignments are not supported yet');
      const name = s.columns[0];
      let column = table.columns.findIndex((c) => sameName(c.name, name));
      if (column < 0) {
        if (ROWID_NAMES.has(name.toLowerCase())) column = -1;
        else throw new SmaltError('SMALT_ERROR', `no such column: ${name}`);
      }
      sets.push({ column, value: bindExpr(s.value, cs) });
    }
    const ret = stmt.returning ? this.returning(stmt.returning, table, stmt.alias) : undefined;
    const plan: PlanOp = { op: 'update', table: table.name, db, input, rowid, sets, from: stmt.from !== undefined, ...(ret ? { returning: ret.exprs } : {}) };
    return { plan, returning: ret?.columns };
  }

  deletePlan(stmt: DeleteStmt, table: TableSchema): { plan: PlanOp; returning?: { name: string; type: StaticType }[] } {
    // As `Database.planTarget`: the target (in its resolved schema) in a scope under the statement's CTEs.
    const withScope = new FeScope(null);
    withScope.ctesOnly = true;
    if (stmt.with) this.registerCtes(stmt.with, withScope);
    const scope = new FeScope(stmt.with ? withScope : null);
    const db = table.temp ? 'temp' : 'main';
    const input = this.from({ kind: 'table', pos: 0, schema: db, name: table.name, alias: stmt.alias, end: 0 }, stmt.where, scope);
    const rowid = scope.sources[0].rowid!;
    const ret = stmt.returning ? this.returning(stmt.returning, table, stmt.alias) : undefined;
    const plan: PlanOp = { op: 'delete', table: table.name, db, input, rowid, ...(ret ? { returning: ret.exprs } : {}) };
    return { plan, returning: ret?.columns };
  }

  /**
   * A write's RETURNING list over one row of `table` (its columns, then its rowid), as `Database.compileReturning`
   * binds it (`Database.rowScope`).
   */
  private returning(list: ResultColumn[], table: TableSchema, alias: string | undefined): { exprs: PlanExpr[]; columns: { name: string; type: StaticType }[] } {
    const cs = this.rowScope([{ table, names: [alias ?? table.name, table.name], offset: 0 }]);
    const exprs: PlanExpr[] = [];
    const columns: { name: string; type: StaticType }[] = [];
    const q = alias ?? table.name;
    for (const rc of list) {
      if (rc.kind === 'star' || rc.kind === 'tableStar') {
        if (rc.kind === 'tableStar' && rc.table.toLowerCase() !== q.toLowerCase() && rc.table.toLowerCase() !== table.name.toLowerCase()) {
          throw new SmaltError('SMALT_ERROR', `no such table: ${rc.table}`);
        }
        for (const c of table.columns) {
          const b = bindExpr({ kind: 'column', table: q, name: c.name, pos: 0, end: 0 }, cs);
          exprs.push(b);
          columns.push({ name: c.name, type: typeOf(b) });
        }
        continue;
      }
      const agg = aggregateCallName(rc.expr);
      if (agg) throw new SmaltError('SMALT_ERROR', `misuse of aggregate function ${agg}()`);
      const b = bindExpr(rc.expr, cs);
      exprs.push(b);
      columns.push({ name: rc.alias ?? (rc.expr.kind === 'column' ? rc.expr.name : this.text.slice(rc.expr.pos, rc.expr.end)), type: boundMetadata(b, this.catalog.funcCtx).type });
    }
    return { exprs, columns };
  }

  rowExpr(e: Expr, table: TableSchema): PlanExpr {
    return this.resolveExpr(bindExpr(e, this.rowScope([{ table, names: [table.name], offset: 0 }])));
  }

  valueExpr(e: Expr): PlanExpr {
    return this.resolveExpr(bindExpr(e, this.compileScope(new FeScope(null))));
  }

  /**
   * Names over single rows of tables (a write's target row, `excluded` in upserts), as `Database.rowsScope`: each
   * source's columns, then its rowid, from `offset` in the row; unqualified names resolve to the first source that
   * has the column. Subqueries see no enclosing columns.
   */
  private rowScope(sources: { table: TableSchema; names: string[]; offset: number }[]): CompileScope {
    const outer = this.compileScope(new FeScope(null));
    const bind = (src: (typeof sources)[number], name: string): ColumnBinding | null => {
      const i = src.table.columns.findIndex((c) => sameName(c.name, name));
      let at: number;
      let type: StaticType;
      let collation: Collation;
      let affinity: Affinity;
      if (i >= 0) {
        const c = src.table.columns[i];
        type = c.rowidAlias ? 'int' : c.type === 'INTEGER' ? 'int' : c.type === 'REAL' ? 'real' : c.type === 'TEXT' ? 'text' : c.type === 'BLOB' ? 'blob' : 'any';
        affinity = (c.type === 'ANY' || c.type === 'BLOB' ? 'BLOB' : c.type) as Affinity;
        collation = c.collation;
        at = src.offset + i;
      } else if (ROWID_NAMES.has(name.toLowerCase())) {
        type = 'int';
        affinity = 'INTEGER';
        collation = Collation.Binary;
        at = src.offset + src.table.columns.length;
      } else return null;
      return { reg: this.ref({ depth: 0, input: 0, index: () => at, type, collation }), type, collation, affinity };
    };
    return {
      ...outer,
      resolveColumn: (e) => {
        if (e.table) {
          const q = e.table.toLowerCase();
          const src = sources.find((x) => x.names.some((n) => n.toLowerCase() === q));
          if (!src) throw new SmaltError('SMALT_ERROR', `no such column: ${e.table}.${e.name}`);
          const b = bind(src, e.name);
          if (!b) throw new SmaltError('SMALT_ERROR', `no such column: ${e.table}.${e.name}`);
          return b;
        }
        for (const src of sources) {
          const b = bind(src, e.name);
          if (b) return b;
        }
        throw new SmaltError('SMALT_ERROR', `no such column: ${e.name}`);
      },
    };
  }

  private registerCtes(w: WithClause, scope: FeScope): void {
    for (const c of w.ctes) {
      const recursive = w.recursive && selectReferences(c.select, c.name);
      scope.ctes.set(c.name.toLowerCase(), { select: c.select, columns: c.columns, recursive });
    }
  }

  /** A WITH RECURSIVE CTE: the initial part, then steps reading the previous step's rows, as the planner. */
  private recursive(name: string, cte: FeCte, parent: FeScope | null): CoreResult {
    const select = cte.select;
    const cores = [select.core, ...select.compound.map((c) => c.core)];
    const refs = cores.map((c) => coreReferences(c, name));
    const k = refs.indexOf(true);
    if (k <= 0) throw new SmaltError('SMALT_ERROR', `recursive reference in a subquery: ${name}`);
    for (let i = k; i < cores.length; i++) {
      if (!refs[i]) throw new SmaltError('SMALT_ERROR', `circular reference: ${name}`);
    }
    const ops = select.compound.slice(k - 1).map((c) => c.op);
    if (ops.some((op) => op !== 'UNION' && op !== 'UNION ALL')) throw new SmaltError('SMALT_ERROR', `recursive reference in a subquery: ${name}`);
    const distinct = ops.includes('UNION');
    const init: SelectStmt = { ...select, with: undefined, core: select.core, compound: select.compound.slice(0, k - 1), orderBy: [], limit: undefined, offset: undefined };
    const first = this.select(init, parent);
    if (cte.columns && cte.columns.length !== first.columns.length) {
      throw new SmaltError('SMALT_ERROR', `table ${name} has ${first.columns.length} values for ${cte.columns.length} columns`);
    }
    const columns = first.columns.map((c, i) => ({ ...c, name: cte.columns?.[i] ?? c.name }));
    const id = this.nextIterate++;
    const steps = cores.slice(k).map((core) => {
      // Holds the working rows' name only: not a query level, so outer columns keep their depth.
      const s = new FeScope(parent);
      s.ctesOnly = true;
      s.ctes.set(name.toLowerCase(), { select, columns: cte.columns, working: { id, columns } });
      const r = this.core(core, s, null, columns.length);
      if (r.columns.length !== columns.length) {
        throw new SmaltError('SMALT_ERROR', `SELECTs to the left and right of ${ops[0]} do not have the same number of result columns`);
      }
      return r.plan;
    });
    const order: SortKey[] = select.orderBy.map((t) => {
      const idx = this.compoundOrderIndex(t, columns, select.core);
      const c = columns[idx];
      return { expr: { k: 'col', input: 0, index: idx, depth: 0, type: c.type, collation: collationName(c.collation) }, desc: t.desc, nullsFirst: t.nulls ? t.nulls === 'FIRST' : !t.desc, collation: collationName(c.collation) };
    });
    const cs = this.compileScope(new FeScope(parent));
    const limit = select.limit ? bindExpr(select.limit, cs) : undefined;
    const offset = select.offset ? bindExpr(select.offset, cs) : undefined;
    const plan: PlanOp = {
      op: 'iterate',
      id,
      name,
      init: first.plan,
      steps,
      distinct,
      collations: columns.map((c) => collationName(c.collation)),
      ...(order.length ? { order } : {}),
      ...(limit ? { limit } : {}),
      ...(offset ? { offset } : {}),
    };
    return { plan, columns };
  }

  private limit(plan: PlanOp, stmt: SelectStmt, scope: FeScope | null): PlanOp {
    if (!stmt.limit) {
      if (stmt.offset) throw new SmaltError('SMALT_ERROR', 'OFFSET without LIMIT');
      return plan;
    }
    const cs = this.compileScope(new FeScope(scope));
    const count = bindExpr(stmt.limit, cs);
    const offset = stmt.offset ? bindExpr(stmt.offset, cs) : undefined;
    return offset ? { op: 'limit', input: plan, count, offset } : { op: 'limit', input: plan, count };
  }

  private compoundOrderIndex(t: OrderingTerm, cols: FrontEndColumn[], core: SelectCore): number {
    const e = t.expr;
    if (e.kind === 'literal' && typeof e.value === 'number' && Number.isInteger(e.value)) {
      if (e.value < 1 || e.value > cols.length) throw new SmaltError('SMALT_ERROR', `ORDER BY term out of range - should be between 1 and ${cols.length}`);
      return e.value - 1;
    }
    if (e.kind === 'column' && !e.table) {
      const i = cols.findIndex((c) => sameName(c.name, e.name));
      if (i >= 0) return i;
    }
    if (core.kind === 'select') {
      const i = core.columns.findIndex((rc) => rc.kind === 'expr' && exprEquals(rc.expr, e));
      if (i >= 0) return i;
    }
    throw new SmaltError('SMALT_ERROR', 'ORDER BY term does not match any column in the result set');
  }

  // ---------------------------------------------------------------- one SELECT core

  private core(core: SelectCore, parent: FeScope | null, stmt: SelectStmt | null, width: number | undefined): CoreResult {
    if (core.kind === 'values') return this.values(core.rows, parent, stmt);
    const scope = new FeScope(parent);
    let root = this.from(core.from, core.where, scope);
    const resultCols = this.expandResultColumns(core.columns, scope);
    for (const rc of resultCols) if (rc.alias) (scope.aliases ??= new Map()).set(rc.alias.toLowerCase(), rc.expr);

    const isAgg =
      core.groupBy.length > 0 || core.having !== undefined || resultCols.some((c) => containsAggregate(c.expr)) || (stmt?.orderBy.some((t) => containsAggregate(t.expr)) ?? false);

    const baseCs = this.compileScope(scope);
    let exprScope = baseCs;
    let agg: { keys: { expr: PlanExpr; collation: CollationName }[]; aggs: AggCall[]; carry: PlanExpr[] } | null = null;
    if (isAgg) {
      const groups = core.groupBy.map((g) => {
        const ast = this.resolveGroupAst(g, resultCols);
        if (containsAggregate(ast)) throw new SmaltError('SMALT_ERROR', 'aggregate functions are not allowed in the GROUP BY clause');
        const bound = bindExpr(ast, baseCs);
        const c = boundMetadata(bound, this.catalog.funcCtx);
        return { ast, bound, type: c.type, collation: c.collSrc !== CollSrc.None ? c.collation : Collation.Binary, affinity: c.affinity };
      });
      const keys = groups.map((g) => ({ expr: g.bound, collation: collationName(g.collation) }));
      const aggs: AggCall[] = [];
      const aggAsts: CallExpr[] = [];
      const aggTypes: { argTypes: StaticType[]; collation: Collation }[] = [];
      const carry: PlanExpr[] = [];
      const carried = new Map<number, number>();
      const a = { keys, aggs, carry };
      agg = a;
      const keyCount = keys.length;
      // Bare columns: the aggregate carries them (keys, then aggregates, then carried columns).
      // Registered when bound; the output position is known once every aggregate call has been seen.
      const carryOf = (rowIndex: number, type: StaticType, collation: Collation): (() => number) => {
        let i = carried.get(rowIndex);
        if (i === undefined) {
          i = carry.length;
          carried.set(rowIndex, i);
          carry.push({ k: 'col', input: 0, index: rowIndex, depth: 0, type, collation: collationName(collation) });
        }
        const at = i;
        return () => keyCount + aggs.length + at;
      };
      const outRef = (index: () => number, type: StaticType, collation: Collation): number => this.ref({ depth: 0, input: 0, index, type, collation });
      exprScope = {
        ...baseCs,
        groupRef: (e) => {
          const i = groups.findIndex((g) => exprEquals(g.ast, e));
          if (i < 0) return undefined;
          const g = groups[i];
          return { reg: outRef(() => i, g.type, g.collation), type: g.type, collation: g.collation, affinity: g.affinity };
        },
        aggregateRef: (call) => {
          const existing = aggAsts.findIndex((x) => exprEquals(x, call));
          const def = aggregateFunctions.get(call.name)!;
          if (existing >= 0) {
            const t = aggTypes[existing];
            const type = def.resultType(t.argTypes);
            return { reg: outRef(() => keyCount + existing, type, t.collation), type, collation: t.collation, affinity: 'NONE' };
          }
          if (call.star && call.name !== 'count') throw new SmaltError('SMALT_ERROR', `wrong number of arguments to function ${call.name}()`);
          const n = call.args.length;
          if (!call.star && (n < def.minArgs || n > def.maxArgs || (call.name === 'count' && n === 0))) {
            throw new SmaltError('SMALT_ERROR', `wrong number of arguments to function ${call.name}()`);
          }
          const inner = call.args.map(firstAggregateCall).find((x) => x !== undefined);
          if (inner) throw new SmaltError('SMALT_ERROR', `misuse of aggregate function ${inner.name}()`);
          if (call.orderBy?.length) throw new SmaltError('SMALT_UNSUPPORTED', 'ORDER BY inside aggregate functions is not supported yet');
          if (call.distinct && n !== 1) throw new SmaltError('SMALT_ERROR', 'DISTINCT aggregates must have exactly one argument');
          // Arguments read the FROM row, not the aggregate's output.
          const saved = scope.carry;
          scope.carry = null;
          let args: PlanExpr[];
          let filter: PlanExpr | undefined;
          try {
            args = call.args.map((x) => bindExpr(x, baseCs));
            filter = call.filter ? bindExpr(call.filter, baseCs) : undefined;
          } finally {
            scope.carry = saved;
          }
          const compiled = args.map((x) => boundMetadata(x, this.catalog.funcCtx));
          const argTypes = compiled.map((c) => c.type);
          const collation = compiled[0]?.collSrc ? compiled[0].collation : Collation.Binary;
          const type = def.resultType(argTypes);
          const at = aggs.length;
          aggs.push({ fn: call.name, args, star: call.star, distinct: call.distinct, ...(filter ? { filter } : {}), collation: collationName(collation), type });
          aggAsts.push(call);
          aggTypes.push({ argTypes, collation });
          return { reg: outRef(() => keyCount + at, type, collation), type, collation, affinity: 'NONE' };
        },
      };
      scope.aliasScope = exprScope;
      scope.carry = carryOf;
    }

    // Window functions: result columns and ORDER BY terms may call f(...) OVER (...).
    const noWindowScope = exprScope;
    const windows: FeWindow[] = [];
    const hasWindows = resultCols.some((c) => containsWindow(c.expr)) || (stmt?.orderBy.some((t) => containsWindow(t.expr)) ?? false);
    if (hasWindows) {
      const seen: { ast: CallExpr; binding: ColumnBinding }[] = [];
      const a = agg;
      // Window calls follow the window's input: the aggregate's output, or the FROM row.
      const inputWidth = (): number => (a ? a.keys.length + a.aggs.length + a.carry.length : scope.width);
      exprScope = { ...exprScope, windowRef: (call) => this.windowRef(call, core, noWindowScope, windows, seen, inputWidth) };
    }

    // Result expressions.
    const bound = resultCols.map((c) => bindExpr(c.expr, exprScope));
    const compiled = bound.map((b) => boundMetadata(b, this.catalog.funcCtx));
    if (width !== undefined && width !== bound.length) {
      throw new SmaltError('SMALT_ERROR', `SELECTs to the left and right of a compound operator do not have the same number of result columns`);
    }
    const columns: FrontEndColumn[] = resultCols.map((c, i) => ({
      name: c.name,
      type: compiled[i].type,
      declType: c.declType,
      collation: compiled[i].collSrc !== CollSrc.None ? compiled[i].collation : Collation.Binary,
      affinity: compiled[i].affinity,
    }));

    // ORDER BY (single core only): result positions, or extra expressions computed beside the result.
    const keys: SortKey[] = [];
    const extras: PlanExpr[] = [];
    if (stmt && stmt.compound.length === 0) {
      for (const t of stmt.orderBy) {
        const idx = this.orderByResultIndex(t.expr, resultCols);
        let pos: number;
        let coll: Collation;
        let type: StaticType;
        if (idx >= 0) {
          pos = idx;
          coll = t.expr.kind === 'collate' ? boundMetadata(bindExpr(t.expr, exprScope), this.catalog.funcCtx).collation : columns[idx].collation;
          type = columns[idx].type;
        } else {
          const b = bindExpr(t.expr, exprScope);
          const c = boundMetadata(b, this.catalog.funcCtx);
          pos = bound.length + extras.length;
          extras.push(b);
          coll = c.collSrc !== CollSrc.None ? c.collation : Collation.Binary;
          type = c.type;
        }
        keys.push({ expr: { k: 'col', input: 0, index: pos, depth: 0, type, collation: collationName(coll) }, desc: t.desc, nullsFirst: t.nulls ? t.nulls === 'FIRST' : !t.desc, collation: collationName(coll) });
      }
    }

    let having: PlanExpr | undefined;
    if (core.having) {
      if (!agg) throw new SmaltError('SMALT_ERROR', 'a GROUP BY clause is required before HAVING');
      having = bindExpr(core.having, exprScope);
    }

    if (agg) root = { op: 'aggregate', input: root, keys: agg.keys, aggs: agg.aggs, carry: agg.carry };
    if (having) root = { op: 'filter', input: root, pred: having };
    for (const w of windows) root = { op: 'window', input: root, partition: w.partition, order: w.order, frame: w.frame, calls: w.calls };
    root = { op: 'project', input: root, exprs: [...bound, ...extras] };
    if (core.distinct) root = { op: 'distinct', input: root, collations: columns.map((c) => collationName(c.collation)) };
    if (keys.length) root = { op: 'sort', input: root, keys };
    if (extras.length) root = { op: 'project', input: root, exprs: columns.map((c, i) => ({ k: 'col', input: 0, index: i, depth: 0, type: c.type, collation: collationName(c.collation) })) };
    return { plan: root, columns };
  }

  private resolveWindowSpec(over: WindowSpec | string, core: SelectCoreSelect): WindowSpec {
    const named = (name: string): WindowSpec => {
      const w = core.windows.find((x) => sameName(x.name, name));
      if (!w) throw new SmaltError('SMALT_ERROR', `no such window: ${name}`);
      return w.spec.base ? this.resolveWindowSpec(w.spec, core) : w.spec;
    };
    if (typeof over === 'string') return named(over);
    if (!over.base) return over;
    const base = named(over.base);
    if (over.partitionBy.length) throw new SmaltError('SMALT_ERROR', `cannot override PARTITION clause of window: ${over.base}`);
    if (over.orderBy.length && base.orderBy.length) throw new SmaltError('SMALT_ERROR', `cannot override ORDER BY clause of window: ${over.base}`);
    if (base.frame) throw new SmaltError('SMALT_ERROR', `cannot override frame specification of window: ${over.base}`);
    return { ...over, base: undefined, partitionBy: base.partitionBy, orderBy: over.orderBy.length ? over.orderBy : base.orderBy };
  }

  /** A window function call: one `window` operation per distinct (PARTITION BY, ORDER BY, frame), as the planner. */
  private windowRef(call: CallExpr, core: SelectCoreSelect, scope: CompileScope, defs: FeWindow[], seen: { ast: CallExpr; binding: ColumnBinding }[], inputWidth: () => number): ColumnBinding {
    const hit = seen.find((x) => exprEquals(x.ast, call));
    if (hit) return hit.binding;
    const name = call.name;
    const aggDef = aggregateFunctions.get(name);
    const builtin = WINDOW_ARITY[name];
    if (!builtin && !aggDef) {
      if (scalarFunctions.has(name)) throw new SmaltError('SMALT_ERROR', `${name}() may not be used as a window function`);
      throw new SmaltError('SMALT_ERROR', `no such function: ${name}`);
    }
    const n = call.args.length;
    const [minA, maxA] = builtin ?? [aggDef!.minArgs, aggDef!.maxArgs];
    if (call.star ? name !== 'count' : n < minA || n > maxA || (name === 'count' && n === 0)) {
      throw new SmaltError('SMALT_ERROR', `wrong number of arguments to function ${name}()`);
    }
    if (call.distinct) throw new SmaltError('SMALT_ERROR', 'DISTINCT is not supported for window functions');
    if (builtin && call.filter) throw new SmaltError('SMALT_ERROR', `FILTER clause may only be used with aggregate window functions`);
    for (const a of call.args) {
      const inner = firstWindowCall(a);
      if (inner) throw new SmaltError('SMALT_ERROR', `misuse of window function ${inner.name}()`);
    }
    const spec = this.resolveWindowSpec(call.over!, core);
    const args = call.args.map((a) => bindExpr(a, scope));
    const meta = args.map((a) => boundMetadata(a, this.catalog.funcCtx));
    const strip = (x: unknown): string => JSON.stringify(x, (k, v) => (k === 'pos' || k === 'end' ? undefined : typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v));
    const key = strip({ p: spec.partitionBy, o: spec.orderBy, f: spec.frame });
    let defIndex = defs.findIndex((d) => d.key === key);
    if (defIndex < 0) {
      const partition = spec.partitionBy.map((e) => {
        const b = bindExpr(e, scope);
        const m = boundMetadata(b, this.catalog.funcCtx);
        return { expr: b, collation: collationName(m.collSrc !== CollSrc.None ? m.collation : Collation.Binary) };
      });
      const order: SortKey[] = spec.orderBy.map((t) => {
        const b = bindExpr(t.expr, scope);
        const m = boundMetadata(b, this.catalog.funcCtx);
        return { expr: b, desc: t.desc, nullsFirst: t.nulls ? t.nulls === 'FIRST' : !t.desc, collation: collationName(m.collSrc !== CollSrc.None ? m.collation : Collation.Binary) };
      });
      const f = spec.frame;
      const bound = (b: FrameBound): { kind: string; offset?: PlanExpr } => ('offset' in b ? { kind: b.kind, offset: bindExpr(b.offset, scope) } : { kind: b.kind });
      const frame: WindowFrame = f
        ? { unit: f.unit, start: bound(f.start), end: f.end ? bound(f.end) : { kind: 'currentRow' }, exclude: f.exclude ?? 'NO OTHERS' }
        : order.length
          ? { unit: 'RANGE', start: { kind: 'unboundedPreceding' }, end: { kind: 'currentRow' }, exclude: 'NO OTHERS' }
          : { unit: 'ROWS', start: { kind: 'unboundedPreceding' }, end: { kind: 'unboundedFollowing' }, exclude: 'NO OTHERS' };
      const rank = (k: string): number => ['unboundedPreceding', 'preceding', 'currentRow', 'following', 'unboundedFollowing'].indexOf(k);
      if (frame.start.kind === 'unboundedFollowing' || frame.end.kind === 'unboundedPreceding' || rank(frame.start.kind) > rank(frame.end.kind)) {
        throw new SmaltError('SMALT_ERROR', 'unsupported frame specification');
      }
      if (frame.unit === 'RANGE' && (frame.start.offset || frame.end.offset) && order.length !== 1) {
        throw new SmaltError('SMALT_ERROR', 'RANGE with offset PRECEDING/FOLLOWING requires one ORDER BY expression');
      }
      defs.push({ key, partition, order, frame, calls: [] });
      defIndex = defs.length - 1;
    }
    const filter = call.filter ? bindExpr(call.filter, scope) : undefined;
    const kind = builtin ? name : 'aggregate';
    const t0 = meta[0]?.type ?? 'any';
    const type: StaticType =
      kind === 'aggregate'
        ? aggDef!.resultType(meta.map((m) => m.type))
        : kind === 'percent_rank' || kind === 'cume_dist'
          ? 'real'
          : RANKING.has(kind)
            ? 'int'
            : t0 === 'null'
              ? 'any'
              : kind === 'lag' || kind === 'lead'
                ? meta.length > 2 && meta[2].type !== t0
                  ? 'any'
                  : t0
                : t0;
    const callCollation = kind === 'aggregate' && meta[0]?.collSrc ? meta[0].collation : Collation.Binary;
    const collation = meta[0]?.collSrc && NAVIGATION.has(kind) ? meta[0].collation : Collation.Binary;
    const def = defs[defIndex];
    const at = def.calls.length;
    def.calls.push({ fn: name, args, star: call.star, ...(filter ? { filter } : {}), type, collation: collationName(callCollation) });
    const di = defIndex;
    const index = (): number => inputWidth() + defs.slice(0, di).reduce((n, d) => n + d.calls.length, 0) + at;
    const binding: ColumnBinding = { reg: this.ref({ depth: 0, input: 0, index, type, collation }), type, collation, affinity: 'NONE' };
    seen.push({ ast: call, binding });
    return binding;
  }

  private values(rows: Expr[][], parent: FeScope | null, stmt: SelectStmt | null): CoreResult {
    const width = rows[0].length;
    for (const r of rows) if (r.length !== width) throw new SmaltError('SMALT_ERROR', 'all VALUES must have the same number of terms');
    const cs = this.compileScope(new FeScope(parent));
    const bound = rows.map((r) => r.map((e) => bindExpr(e, cs)));
    const types = bound[0].map((b) => boundMetadata(b, this.catalog.funcCtx).type);
    const columns: FrontEndColumn[] = types.map((type, i) => ({ name: `column${i + 1}`, type, collation: Collation.Binary, affinity: 'NONE' }));
    let plan: PlanOp = { op: 'values', rows: bound, types };
    if (stmt && stmt.compound.length === 0 && stmt.orderBy.length) {
      const keys: SortKey[] = stmt.orderBy.map((t) => {
        const idx = this.compoundOrderIndex(t, columns, { kind: 'values', rows, pos: 0, end: 0 } as SelectCore);
        return { expr: { k: 'col', input: 0, index: idx, depth: 0, type: types[idx], collation: 'binary' }, desc: t.desc, nullsFirst: t.nulls ? t.nulls === 'FIRST' : !t.desc, collation: 'binary' };
      });
      plan = { op: 'sort', input: plan, keys };
    }
    return { plan, columns };
  }

  private orderByResultIndex(e: Expr, cols: { alias?: string; expr: Expr; name: string }[]): number {
    let inner = e;
    if (inner.kind === 'collate') inner = inner.expr;
    if (inner.kind === 'literal' && typeof inner.value === 'number' && Number.isInteger(inner.value)) {
      if (inner.value < 1 || inner.value > cols.length) throw new SmaltError('SMALT_ERROR', `ORDER BY term out of range - should be between 1 and ${cols.length}`);
      return inner.value - 1;
    }
    if (inner.kind === 'column' && !inner.table) {
      const name = inner.name;
      const i = cols.findIndex((c) => c.alias !== undefined && sameName(c.alias, name));
      if (i >= 0) return i;
    }
    return cols.findIndex((c) => exprEquals(c.expr, inner));
  }

  private resolveGroupAst(g: Expr, cols: { alias?: string; expr: Expr }[]): Expr {
    if (g.kind === 'literal' && typeof g.value === 'number' && Number.isInteger(g.value)) {
      if (g.value < 1 || g.value > cols.length) throw new SmaltError('SMALT_ERROR', `GROUP BY term out of range - should be between 1 and ${cols.length}`);
      return cols[g.value - 1].expr;
    }
    return g;
  }

  private expandResultColumns(cols: ResultColumn[], scope: FeScope): { expr: Expr; name: string; alias?: string; declType?: string }[] {
    const out: { expr: Expr; name: string; alias?: string; declType?: string }[] = [];
    for (const rc of cols) {
      if (rc.kind === 'star' || rc.kind === 'tableStar') {
        if (scope.sources.length === 0) throw new SmaltError('SMALT_ERROR', 'no tables specified');
        let found = false;
        for (const src of scope.sources) {
          if (rc.kind === 'tableStar' && !sameName(src.name, rc.table)) continue;
          found = true;
          for (const c of src.cols) {
            if (rc.kind === 'star' && src.hidden.size > 0 && src.hidden.has(c.name.toLowerCase())) continue;
            out.push({ expr: { kind: 'column', table: src.name, name: c.name, pos: rc.pos, end: rc.end }, name: c.name, declType: c.declType || undefined });
          }
        }
        if (!found) throw new SmaltError('SMALT_ERROR', `no such table: ${(rc as { table: string }).table}`);
      } else {
        const e = rc.expr;
        let name = rc.alias;
        let declType: string | undefined;
        if (e.kind === 'column') {
          name ??= e.name;
          const c = this.peekColumn(e, scope);
          declType = c?.declType || undefined;
        }
        name ??= this.text.slice(e.pos, e.end);
        out.push({ expr: e, name, alias: rc.alias, declType });
      }
    }
    return out;
  }

  private peekColumn(e: ColumnExpr, scope: FeScope): FeColumn | undefined {
    for (const s of scope.sources) {
      if (e.table && !sameName(e.table, s.name)) continue;
      const c = s.cols.find((c) => sameName(c.name, e.name));
      if (c) return c;
    }
    return undefined;
  }

  // ---------------------------------------------------------------- FROM / WHERE

  private from(from: FromItem | undefined, where: Expr | undefined, scope: FeScope): PlanOp {
    if (!from) {
      let root: PlanOp = { op: 'values', rows: [[]], types: [] };
      if (where) root = { op: 'filter', input: root, pred: bindExpr(where, this.compileScope(scope)) };
      return root;
    }
    const items: { item: FromItem; joinType: JoinType; on?: Expr; using?: string[]; natural: boolean }[] = [];
    this.flattenFrom(from, 'INNER', undefined, undefined, false, items);
    const inputs = items.map((it) => this.addSource(it.item, scope));
    // USING / NATURAL become equality conjuncts in the ON clause, and hide the right side's copy of the column.
    const ons: Expr[][] = items.map(() => []);
    items.forEach((it, p) => {
      const src = scope.sources[p];
      if (it.on) ons[p].push(...conjuncts(it.on));
      let using = it.using;
      if (it.natural) {
        using = src.cols
          .filter((c) => scope.sources.slice(0, p).some((s) => s.cols.some((x) => sameName(x.name, c.name) && !s.hidden.has(x.name.toLowerCase()))))
          .map((c) => c.name);
      }
      for (const name of using ?? []) {
        const left = scope.sources.slice(0, p).find((s) => s.cols.some((c) => sameName(c.name, name)) && !s.hidden.has(name.toLowerCase()));
        if (!left || !src.cols.some((c) => sameName(c.name, name))) {
          throw new SmaltError('SMALT_ERROR', `cannot join using column ${name} - column not present in both tables`);
        }
        if (src.hidden === NO_HIDDEN) src.hidden = new Set();
        src.hidden.add(name.toLowerCase());
        ons[p].push({ kind: 'binary', op: '=', left: { kind: 'column', table: left.name, name, pos: 0, end: 0 }, right: { kind: 'column', table: src.name, name, pos: 0, end: 0 }, pos: 0, end: 0 });
      }
    });
    if (items.some((it) => (it.using || it.natural) && (it.joinType === 'RIGHT' || it.joinType === 'FULL')) && items.some((it) => it.joinType === 'RIGHT' || it.joinType === 'FULL')) {
      throw new SmaltError('SMALT_UNSUPPORTED', 'USING / NATURAL with RIGHT or FULL JOIN is not supported yet');
    }
    let root = inputs[0];
    // Inner-join conditions that read a later source of this FROM apply once that source is joined: in the WHERE, as
    // SQLite treats them. An outer join's condition cannot (SQLite: "ON clause references tables to its right").
    const later: Expr[] = [];
    for (let p = 1; p < items.length; p++) {
      const it = items[p];
      const outer = it.joinType === 'LEFT' || it.joinType === 'RIGHT' || it.joinType === 'FULL';
      const parts: PlanExpr[] = [];
      scope.onSource = p;
      try {
        const cs = this.compileScope(scope);
        for (const c of ons[p]) {
          try {
            parts.push(bindExpr(c, cs));
          } catch (e) {
            if (!(e instanceof LaterSource)) throw e;
            if (outer) throw new SmaltError('SMALT_ERROR', 'ON clause references tables to its right');
            later.push(c);
          }
        }
      } finally {
        scope.onSource = -1;
      }
      const kind: JoinKind = it.joinType === 'LEFT' ? 'left' : it.joinType === 'RIGHT' ? 'right' : it.joinType === 'FULL' ? 'full' : parts.length ? 'inner' : 'cross';
      const on = parts.length ? parts.reduce((x, y) => ({ k: 'and', args: [x, y] })) : undefined;
      root = on ? { op: 'join', kind, inputs: [root, inputs[p]], on } : { op: 'join', kind, inputs: [root, inputs[p]] };
    }
    const filters = [...later, ...(where ? [where] : [])];
    if (filters.length) {
      const cs = this.compileScope(scope);
      const pred = filters.map((e) => bindExpr(e, cs)).reduce((x, y) => ({ k: 'and', args: [x, y] }));
      root = { op: 'filter', input: root, pred };
    }
    return root;
  }

  private flattenFrom(
    item: FromItem,
    joinType: JoinType,
    on: Expr | undefined,
    using: string[] | undefined,
    natural: boolean,
    out: { item: FromItem; joinType: JoinType; on?: Expr; using?: string[]; natural: boolean }[],
  ): void {
    if (item.kind === 'join') {
      this.flattenFrom(item.left, joinType, on, using, natural, out);
      if (item.right.kind === 'join') {
        if (item.joinType === 'LEFT') throw new SmaltError('SMALT_UNSUPPORTED', 'LEFT JOIN with a parenthesized join on the right is not supported yet');
        this.flattenFrom(item.right, 'INNER', undefined, undefined, false, out);
        if (item.on) out[out.length - 1].on = out[out.length - 1].on ? ({ kind: 'binary', op: 'AND', left: out[out.length - 1].on!, right: item.on, pos: 0, end: 0 } as Expr) : item.on;
      } else {
        out.push({ item: item.right, joinType: item.joinType === 'CROSS' ? 'INNER' : item.joinType, on: item.on, using: item.using, natural: item.natural });
      }
      return;
    }
    out.push({ item, joinType, on, using, natural });
  }

  /** Add a FROM item's columns to the scope; returns the plan that produces its rows. */
  private addSource(item: FromItem, scope: FeScope): PlanOp {
    const position = scope.sources.length;
    if (item.kind === 'join') throw new SmaltError('SMALT_ERROR', 'unexpected join');
    // External data: external tables and read_csv()-style functions (their columns come from the data).
    if (item.kind === 'function' && this.catalog.isExternalFunction?.(item.name)) return this.externalFunction(item, scope, position);
    if (item.kind === 'table' && (!item.schema || item.schema.toLowerCase() === 'main') && !(!item.schema && scope.findCte(item.name))) {
      const ext = this.catalog.externalColumns?.(item.name);
      if (ext) {
        const cols: FeColumn[] = ext.map((c) => ({ name: c.name, type: c.type, collation: Collation.Binary, affinity: affinityOfStorage(storageTypeFor(c.declType)), declType: c.declType ?? '' }));
        this.push(scope, { name: item.alias ?? item.name, cols, offset: 0, rowid: null, position, width: cols.length, hidden: NO_HIDDEN });
        return { op: 'source', kind: 'external', name: item.name, args: [], types: cols.map((c) => c.type) };
      }
    }
    const isInfoSchema = item.kind === 'table' && item.schema?.toLowerCase() === 'information_schema';
    const tempCatalog =
      item.kind === 'table' &&
      (item.schema === undefined
        ? !scope.findCte(item.name) && TEMP_CATALOG.has(item.name.toLowerCase())
        : item.schema.toLowerCase() === 'temp' && (TEMP_CATALOG.has(item.name.toLowerCase()) || ['sqlite_schema', 'sqlite_master'].includes(item.name.toLowerCase())));
    if (tempCatalog) {
      const vt = this.catalog.virtualTable?.('temp', 'sqlite_schema');
      if (vt) {
        const cols: FeColumn[] = vt.columns.map((c) => ({ name: c.name, type: c.type, collation: Collation.Binary, affinity: 'NONE', declType: '' }));
        this.push(scope, { name: (item as { alias?: string }).alias ?? item.name, cols, offset: 0, rowid: null, position, width: cols.length, hidden: NO_HIDDEN });
        return { op: 'source', kind: 'virtual', schema: 'temp', name: 'sqlite_schema', args: [], types: cols.map((c) => c.type) };
      }
    }
    if (item.kind === 'function' || isInfoSchema) {
      const vt = this.catalog.virtualTable?.(isInfoSchema ? 'information_schema' : undefined, item.name);
      if (!vt) {
        if (isInfoSchema) throw new SmaltError('SMALT_ERROR', `no such table: information_schema.${item.name}`);
        throw new SmaltError('SMALT_ERROR', `no such table-valued function: ${item.name}`);
      }
      // Arguments may read earlier sources of this FROM (a lateral source: input 0 of the join that adds it).
      let args: PlanExpr[] = [];
      if (item.kind === 'function') {
        scope.onSource = position;
        try {
          const cs = this.compileScope(scope);
          args = item.args.map((a) => bindExpr(a, cs));
        } finally {
          scope.onSource = -1;
        }
      }
      const cols: FeColumn[] = vt.columns.map((c) => ({ name: c.name, type: c.type, collation: Collation.Binary, affinity: 'NONE', declType: '' }));
      this.push(scope, { name: item.alias ?? item.name, cols, offset: 0, rowid: null, position, width: cols.length, hidden: NO_HIDDEN });
      return isInfoSchema
        ? { op: 'source', kind: 'virtual', schema: 'information_schema', name: item.name, args, types: cols.map((c) => c.type) }
        : { op: 'source', kind: 'function', name: item.name, args, types: cols.map((c) => c.type) };
    }
    const view =
      item.kind === 'table' && (!item.schema || ['main', 'temp'].includes(item.schema.toLowerCase())) && !(!item.schema && scope.findCte(item.name)) && !this.catalog.getTable(item.name, item.schema)
        ? sqlView(this.catalog.getView?.(item.name, item.schema))
        : undefined;
    if (item.kind === 'subquery' || view || (item.kind === 'table' && !item.schema && scope.findCte(item.name))) {
      let names: string[] | undefined;
      let alias: string | undefined;
      let sub: CoreResult;
      if (item.kind === 'subquery') {
        alias = item.alias;
        sub = this.select(item.select, scope.parent);
      } else if (view) {
        const key = view.name.toLowerCase();
        if (this.expandingViews.has(key)) throw new SmaltError('SMALT_ERROR', `view ${view.name} is circularly defined`);
        this.expandingViews.add(key);
        // Result-column names come from the view's own SQL text.
        const outerText = this.text;
        this.text = view.sql;
        try {
          sub = this.select(view.select, null);
        } finally {
          this.text = outerText;
          this.expandingViews.delete(key);
        }
        names = view.columns;
        alias = (item as { alias?: string }).alias ?? (item as { name: string }).name;
        if (names && names.length !== sub.columns.length) {
          throw new SmaltError('SMALT_ERROR', `expected ${names.length} columns for '${view.name}' but got ${sub.columns.length}`);
        }
      } else {
        const cteName = (item as { name: string }).name;
        const cte = scope.findCte(cteName)!;
        names = cte.columns;
        alias = (item as { alias?: string }).alias ?? cteName;
        if (cte.working) {
          // The recursive step's working table: the previous step's rows.
          const w = cte.working;
          const cols: FeColumn[] = w.columns.map((c) => ({ name: c.name, type: c.type, collation: c.collation, affinity: c.affinity, declType: c.declType ?? '' }));
          this.push(scope, { name: alias, cols, offset: 0, rowid: null, position, width: cols.length, hidden: NO_HIDDEN });
          return { op: 'working', id: w.id, types: cols.map((c) => c.type) };
        }
        if (cte.recursive) sub = this.recursive(cteName, cte, scope.parent);
        else {
          // As SQLite: a CTE's body sees every CTE of its WITH clause, and reaching itself again is an error.
          if (cte.expanding) throw new SmaltError('SMALT_ERROR', `circular reference: ${cteName}`);
          cte.expanding = true;
          try {
            sub = this.select(cte.select, scope.parent);
          } finally {
            cte.expanding = false;
          }
        }
        if (cte.recursive) names = undefined; // already applied to the plan's columns
      }
      if (names && names.length !== sub.columns.length) {
        throw new SmaltError('SMALT_ERROR', `table ${alias} has ${sub.columns.length} values for ${names.length} columns`);
      }
      const cols: FeColumn[] = sub.columns.map((c, i) => ({ name: names ? names[i] : c.name, type: c.type, collation: c.collation, affinity: c.affinity, declType: c.declType ?? '' }));
      this.push(scope, { name: alias ?? `(subquery-${position + 1})`, cols, offset: 0, rowid: null, position, width: cols.length, hidden: NO_HIDDEN });
      return sub.plan;
    }
    if (item.schema && !['main', 'temp'].includes(item.schema.toLowerCase())) throw new SmaltError('SMALT_ERROR', `unknown database ${item.schema}`);
    const table = this.catalog.getTable(item.name, item.schema);
    if (!table) throw new SmaltError('SMALT_ERROR', `no such table: ${item.schema ? `${item.schema}.` : ''}${item.name}`);
    if (typeof item.indexedBy === 'string' && !table.indexes.some((i) => sameName(i.name, item.indexedBy!))) throw new SmaltError('SMALT_ERROR', `no such index: ${item.indexedBy}`);
    const name = item.alias ?? table.name;
    for (const s of scope.sources) if (sameName(s.name, name)) throw new SmaltError('SMALT_ERROR', `ambiguous table name: ${name}`);
    const { cols, columns } = tableShape(table);
    const n = table.columns.length;
    const hasAlias = table.rowidAlias >= 0;
    this.push(scope, { name, cols, offset: 0, rowid: hasAlias ? table.rowidAlias : n, position, width: hasAlias ? n : n + 1, hidden: NO_HIDDEN });
    const db = table.temp ? 'temp' : item.schema?.toLowerCase() === 'main' ? 'main' : undefined;
    const scan: Mutable<Extract<PlanOp, { op: 'scan' }>> = db ? { op: 'scan', table: table.name, db, columns } : { op: 'scan', table: table.name, columns };
    if (item.indexedBy !== undefined) scan.indexedBy = item.indexedBy;
    return scan;
  }

  /**
   * An external table function call (`read_csv('…')`): its constant arguments name the data, whose columns come from
   * the catalog (the data is loaded before the statement is planned).
   */
  private externalFunction(item: Extract<FromItem, { kind: 'function' }>, scope: FeScope, position: number): PlanOp {
    const cs = this.compileScope(scope);
    const constant = (e: Expr): { b: PlanExpr; v: SqlValue } => {
      const b = bindExpr(e, cs);
      const c = compileBoundExpr(b, this.catalog.funcCtx);
      if (!c.constant) throw new SmaltError('SMALT_ERROR', `${item.name}() arguments must be constants`);
      return { b, v: c.fn([]) };
    };
    const args = item.args.map(constant);
    const named = Object.entries(item.named ?? {}).map(([k, e]) => [k, constant(e)] as const);
    const ext = this.catalog.externalFunctionColumns?.(item.name, args.map((a) => a.v), Object.fromEntries(named.map(([k, a]) => [k, a.v])));
    if (!ext) throw new SmaltError('SMALT_ERROR', `no such table-valued function: ${item.name}`);
    const cols: FeColumn[] = ext.map((c) => ({ name: c.name, type: c.type, collation: Collation.Binary, affinity: affinityOfStorage(storageTypeFor(c.declType)), declType: c.declType ?? '' }));
    this.push(scope, { name: item.alias ?? item.name, cols, offset: 0, rowid: null, position, width: cols.length, hidden: NO_HIDDEN });
    const op: Mutable<Extract<PlanOp, { op: 'source' }>> = { op: 'source', kind: 'function', name: item.name, args: args.map((a) => a.b), types: cols.map((c) => c.type) };
    if (named.length > 0) op.named = Object.fromEntries(named.map(([k, a]) => [k, a.b]));
    return op;
  }

  private push(scope: FeScope, src: FeSource): void {
    src.offset = scope.width;
    if (src.rowid !== null) src.rowid += scope.width;
    scope.width += src.width;
    scope.sources.push(src);
  }

  // ---------------------------------------------------------------- names

  private ref(r: Ref): number {
    this.refs.push(r);
    return this.refs.length - 1;
  }

  compileScope(scope: FeScope): CompileScope {
    const refuse = (): never => {
      throw new SmaltError('SMALT_INTERNAL', 'the SQL front end plans subqueries');
    };
    return {
      resolveColumn: (e) => this.resolveColumn(e, scope),
      scalarSubquery: refuse,
      existsSubquery: refuse,
      inSubquery: refuse,
      planSubquery: (select, mode) => {
        const r = this.select(select, scope);
        if (mode !== 'exists' && r.columns.length !== 1) throw new SmaltError('SMALT_ERROR', `sub-select returns ${r.columns.length} columns - expected 1`);
        return { plan: r.plan, column: { type: r.columns[0]?.type ?? 'any', collation: r.columns[0]?.collation ?? Collation.Binary } };
      },
      funcCtx: this.catalog.funcCtx,
    };
  }

  private resolveColumn(e: ColumnExpr, scope: FeScope): ColumnBinding {
    let depth = 0;
    // A column's depth counts the operations it is evaluated out from, not the scopes that only hold CTEs.
    for (let s: FeScope | null = scope; s; depth += s.ctesOnly ? 0 : 1, s = s.parent) {
      const hit = this.resolveIn(e, s);
      if (hit) return this.binding(hit, s, depth);
    }
    // Fallback: a select-list alias.
    if (!e.table) {
      const key = e.name.toLowerCase();
      for (let s: FeScope | null = scope; s; s = s.parent) {
        const aliased = s.aliases?.get(key);
        if (aliased && !this.expandingAliases.has(key)) {
          this.expandingAliases.add(key);
          try {
            const b = bindExpr(aliased, s.aliasScope ?? this.compileScope(s));
            const c = boundMetadata(b, this.catalog.funcCtx);
            return { reg: -1, type: c.type, collation: c.collation, affinity: c.affinity, bound: withCompiledMeta(b, c) };
          } finally {
            this.expandingAliases.delete(key);
          }
        }
      }
    }
    const name = e.table ? `${e.table}.${e.name}` : e.name;
    const quoted = !e.table && this.text[e.pos] === '"';
    throw new SmaltError('SMALT_ERROR', quoted ? `no such column: "${e.name}" - should this be a string literal in single-quotes?` : `no such column: ${name}`);
  }

  private resolveIn(e: ColumnExpr, scope: FeScope): { src: FeSource; col: number | 'rowid' } | undefined {
    if (e.table) {
      const src = scope.sources.find((s) => sameName(s.name, e.table!));
      if (!src) return undefined;
      const c = src.cols.findIndex((c) => sameName(c.name, e.name));
      if (c >= 0) return { src, col: c };
      if (src.rowid !== null && ROWID_NAMES.has(e.name.toLowerCase())) return { src, col: 'rowid' };
      throw new SmaltError('SMALT_ERROR', `no such column: ${e.table}.${e.name}`);
    }
    let found: { src: FeSource; col: number } | undefined;
    for (const src of scope.sources) {
      if (src.hidden.size > 0 && src.hidden.has(e.name.toLowerCase())) continue;
      const c = src.cols.findIndex((c) => sameName(c.name, e.name));
      if (c < 0) continue;
      if (found) throw new SmaltError('SMALT_ERROR', `ambiguous column name: ${e.name}`);
      found = { src, col: c };
    }
    if (found) return found;
    if (ROWID_NAMES.has(e.name.toLowerCase())) {
      const tables = scope.sources.filter((s) => s.rowid !== null);
      if (tables.length === 1) return { src: tables[0], col: 'rowid' };
      if (tables.length > 1) throw new SmaltError('SMALT_ERROR', `ambiguous column name: ${e.name}`);
    }
    return undefined;
  }

  private binding(hit: { src: FeSource; col: number | 'rowid' }, scope: FeScope, depth: number): ColumnBinding {
    const { src, col } = hit;
    const c = col === 'rowid' ? { type: 'int' as StaticType, collation: Collation.Binary, affinity: 'INTEGER' as Affinity } : src.cols[col];
    const rowIndex = col === 'rowid' ? src.rowid! : src.offset + col;
    let input = 0;
    let index: () => number = () => rowIndex;
    if (depth === 0 && scope.onSource >= 0) {
      // A join condition: input 0 is the left side (the sources before), input 1 the source being joined.
      if (src.position > scope.onSource) throw new LaterSource();
      if (src.position === scope.onSource) {
        input = 1;
        const local = rowIndex - src.offset;
        index = () => local;
      }
    } else if (scope.carry) {
      index = scope.carry(rowIndex, c.type, c.collation);
    }
    return { reg: this.ref({ depth, input, index, type: c.type, collation: c.collation }), type: c.type, collation: c.collation, affinity: c.affinity };
  }

  // ---------------------------------------------------------------- positions

  /**
   * Replace the binder's register slots with positional column references, through nested plans too. The plan is the
   * front end's own until it is returned, so this replaces them in place (a slot shared by two parents is replaced in
   * both: it is the same column).
   */
  resolveRefs(op: PlanOp): PlanOp {
    const o = op as Mutable<PlanOp>;
    const ex = (e: PlanExpr): PlanExpr => this.resolveExpr(e);
    const list = (xs: readonly PlanExpr[]): void => {
      const w = xs as PlanExpr[];
      for (let i = 0; i < w.length; i++) w[i] = ex(w[i]);
    };
    const keys = (ks: readonly { expr: PlanExpr }[]): void => {
      for (const k of ks) (k as { expr: PlanExpr }).expr = ex(k.expr);
    };
    switch (o.op) {
      case 'scan':
      case 'working':
        break;
      case 'source':
        list(o.args);
        break;
      case 'iterate':
        this.resolveRefs(o.init);
        for (const x of o.steps) this.resolveRefs(x);
        if (o.order) keys(o.order);
        if (o.limit) o.limit = ex(o.limit);
        if (o.offset) o.offset = ex(o.offset);
        break;
      case 'values':
        for (const r of o.rows) list(r);
        break;
      case 'filter':
        this.resolveRefs(o.input);
        o.pred = ex(o.pred);
        break;
      case 'project':
        this.resolveRefs(o.input);
        list(o.exprs);
        break;
      case 'limit':
        this.resolveRefs(o.input);
        o.count = ex(o.count);
        if (o.offset) o.offset = ex(o.offset);
        break;
      case 'join':
        this.resolveRefs(o.inputs[0]);
        this.resolveRefs(o.inputs[1]);
        if (o.on) o.on = ex(o.on);
        break;
      case 'setop':
        this.resolveRefs(o.inputs[0]);
        this.resolveRefs(o.inputs[1]);
        break;
      case 'sort':
        this.resolveRefs(o.input);
        keys(o.keys);
        break;
      case 'aggregate':
        this.resolveRefs(o.input);
        keys(o.keys);
        for (const c of o.aggs as Mutable<AggCall>[]) {
          list(c.args);
          if (c.filter) c.filter = ex(c.filter);
        }
        list(o.carry);
        break;
      case 'distinct':
        this.resolveRefs(o.input);
        break;
      case 'delete':
        this.resolveRefs(o.input);
        if (o.returning) list(o.returning);
        break;
      case 'append':
        if (o.input) this.resolveRefs(o.input);
        for (const u of o.upserts) {
          if (!u.update) continue;
          for (const x of u.update.sets) (x as { value: PlanExpr }).value = ex(x.value);
          if (u.update.where) (u.update as { where?: PlanExpr }).where = ex(u.update.where);
        }
        if (o.returning) list(o.returning);
        break;
      case 'update':
        this.resolveRefs(o.input);
        for (const x of o.sets) (x as { value: PlanExpr }).value = ex(x.value);
        if (o.returning) list(o.returning);
        break;
      case 'window': {
        this.resolveRefs(o.input);
        keys(o.partition);
        keys(o.order);
        for (const b of [o.frame.start, o.frame.end] as { offset?: PlanExpr }[]) if (b.offset) b.offset = ex(b.offset);
        for (const c of o.calls as Mutable<WindowCall>[]) {
          list(c.args);
          if (c.filter) c.filter = ex(c.filter);
        }
        break;
      }
    }
    return op;
  }

  /** `e` with its slots replaced (in place, below the root; the root itself when it is a slot is returned replaced). */
  private resolveExpr(e: BoundExpr): PlanExpr {
    const w = e as Mutable<BoundExpr>;
    switch (w.k) {
      case 'slot': {
        const r = this.refs[w.reg];
        if (!r) throw new SmaltError('SMALT_INTERNAL', 'a register the front end does not know reached a plan');
        // The slot's SQL metadata (collation source, affinity) stays with the column, for the physical planner.
        const c: PlanExpr = { k: 'col', input: r.input, index: r.index(), depth: r.depth, type: r.type, collation: collationName(r.collation) };
        const m = getMeta(e);
        if (m) setMeta(c, m);
        return c;
      }
      case 'call':
      case 'and':
      case 'or': {
        const args = w.args as PlanExpr[];
        for (let i = 0; i < args.length; i++) args[i] = this.resolveExpr(args[i]);
        return e as PlanExpr;
      }
      case 'cast':
      case 'not':
      case 'isNull':
        w.arg = this.resolveExpr(w.arg);
        return e as PlanExpr;
      case 'case':
        for (const x of w.whens as { when: PlanExpr; then: PlanExpr }[]) {
          x.when = this.resolveExpr(x.when);
          x.then = this.resolveExpr(x.then);
        }
        w.else = this.resolveExpr(w.else);
        return e as PlanExpr;
      case 'subquery':
        this.resolveRefs(w.plan);
        return e as PlanExpr;
      case 'inSubquery':
        w.probe = this.resolveExpr(w.probe);
        this.resolveRefs(w.plan);
        return e as PlanExpr;
      case 'native':
        // Plans are serializable: a compiled closure never leaves the front end.
        throw new SmaltError('SMALT_INTERNAL', 'a compiled expression reached a plan');
      default:
        return e as PlanExpr;
    }
  }
}
