import {
  ConstraintError,
  type IndexSchema,
  type TableSchema,
  autoIndexName,
  buildIndexSchema,
  buildTableSchema,
  coerceForColumn,
  findColumn,
  isConstantDefault,
  literalValue,
} from './catalog/schema.js';
import { MisuseError, SmaltError } from './errors.js';
import { type StaticType, truthy } from './exec/convert.js';
import { type CompileScope, type Compiled, type Fn, compileExpr } from './exec/expr.js';
import { type FunctionContext, aggregateFunctions, scalarFunctions } from './exec/functions.js';
import { type ExecState, type Operator, explainAnalyze, explainRows } from './exec/operators.js';
import { Planner, type QueryPlan, Registers } from './exec/planner.js';
import { type ConflictMode, TableWriter } from './exec/write.js';
import type {
  AlterTableStmt,
  ColumnDef,
  ColumnExpr,
  CreateIndexStmt,
  FromItem,
  CreateTableStmt,
  CreateViewStmt,
  DeleteStmt,
  DropStmt,
  Expr,
  InsertStmt,
  ParsedStatement,
  PragmaStmt,
  ResultColumn,
  SelectStmt,
  Stmt,
  UpdateStmt,
  WithClause,
} from './sql/ast.js';
import { parse, parseOne } from './sql/parser.js';
import { BTree } from './storage/btree.js';
import { KeyEncoder, decodeKey, readRowidKey } from './storage/key-codec.js';
import { Pager, type PagerOptions } from './storage/pager.js';
import { RecordReader } from './storage/record.js';
import { analyzeIndex, analyzeTable, sampleTable, type TableStats } from './exec/stats.js';
import { type CatalogSnapshot, informationSchema } from './catalog/information-schema.js';
import { type SchemaLookup, applyEdits, renameColumnEdits, renameTableEdits } from './catalog/alter.js';
import { ForeignKeys } from './exec/fk.js';
import type { SqlValue } from './values.js';
import type { Vfs, VfsFile } from './vfs/types.js';

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface QueryResult {
  columns: string[];
  rows: SqlValue[][];
}

/** Parameters: positional array (slot 1 = index 0) or named object (`{ a: 1 }` matches `:a`, `@a`, `$a`). */
export type BindParams = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;

export interface DatabaseOptions extends PagerOptions {
  /** Prepared-statement cache entries for exec/query helpers (default 64). */
  statementCacheSize?: number;
  /** 'wal' (default): atomic, durable commits via `<path>-wal`. 'off': in-place writes (not crash-atomic). */
  journalMode?: 'wal' | 'off';
}

const CATALOG_SQL = 'CREATE TABLE smalt_schema(type TEXT, name TEXT, tbl_name TEXT, rootpage INTEGER, sql TEXT)';
const CATALOG_NAMES = new Set(['smalt_schema', 'sqlite_schema', 'sqlite_master']);

/** A view: its defining SELECT, expanded by the planner wherever the view is referenced. */
export interface ViewSchema {
  name: string;
  sql: string;
  columns?: string[];
  select: SelectStmt;
}

/** A compiled ON CONFLICT clause (target -1 = rowid, n = index position, null = any constraint). */
interface Upsert {
  target: number | null;
  update: { sets: { col: number; c: Compiled }[]; where: Fn | null; oldBase: number; oldRowid: number } | null;
}

interface CatalogEntry {
  type: 'table' | 'index' | 'view';
  name: string;
  rowid: number | bigint;
}

/** A compiled statement body, bound to one schema version. */
interface Program {
  regCount: number;
  /** Query plans produce rows; exec programs only side effects. */
  plan?: QueryPlan;
  exec?: (r: SqlValue[]) => RunResult;
  /** Statement is read-only (no write transaction needed). */
  readonly: boolean;
  /** Writes at most one row after all checks pass, so it needs no statement journal. */
  singleRowWrite?: boolean;
  /** Table sizes the cost-based plan assumed (root page -> estimated rows). */
  rowAssumptions?: Map<number, number>;
  /** Result rows for utility statements (PRAGMA, EXPLAIN) computed at run time. */
  rows?: (r: SqlValue[]) => SqlValue[][];
  columns: string[];
  columnTypes: StaticType[];
}

/**
 * The engine's synchronous core: one database file, one connection. Runs inside the engine worker
 * (or directly in Node for tests). See docs/ARCHITECTURE.md.
 */
export class Database implements FunctionContext {
  readonly pager: Pager;
  private readonly tables = new Map<string, TableSchema>();
  private readonly indexes = new Map<string, IndexSchema>();
  private readonly catalog = new Map<string, CatalogEntry>();
  private readonly views = new Map<string, ViewSchema>();
  private catalogTable!: TableSchema;
  /** Incremented on every schema change (prepared statements recompile). */
  schemaVersion = 0;
  private autocommit = true;
  private lastRowid: number | bigint = 0;
  private lastChanges = 0;
  private total = 0;
  private readonly state: ExecState = { epoch: 0 };
  private readonly cache = new Map<string, Statement>();
  private readonly trees = new Map<number, BTree>();
  private readonly cacheSize: number;
  /** Open read cursors (a write while one is open would invalidate it). */
  readonly activeCursors = new Set<RowCursor>();
  private closed = false;

  private constructor(file: VfsFile, options: DatabaseOptions, walFile?: VfsFile) {
    this.pager = Pager.open(file, options, walFile);
    this.cacheSize = options.statementCacheSize ?? 64;
    if (this.pager.catalogRoot === 0) {
      this.pager.catalogRoot = BTree.create(this.pager);
      this.pager.commit();
    }
    this.loadSchema();
  }

  static async open(vfs: Vfs, path: string, options: DatabaseOptions = {}): Promise<Database> {
    const file = await vfs.open(path);
    const wal = (options.journalMode ?? 'wal') === 'wal' ? await vfs.open(`${path}-wal`) : undefined;
    return new Database(file, options, wal);
  }

  /** Open from already-open files (pass `walFile` for WAL mode). */
  static openFile(file: VfsFile, options: DatabaseOptions = {}, walFile?: VfsFile): Database {
    return new Database(file, options, walFile);
  }

  /** Copy the WAL into the database file (also happens automatically and on close). */
  checkpoint(): void {
    if (!this.autocommit) throw new SmaltError('SMALT_BUSY', 'cannot checkpoint inside a transaction');
    this.pager.checkpoint();
  }

  /** Shared B+tree handle for a root page (BTree objects hold scratch buffers; reuse them). */
  tree(root: number): BTree {
    let t = this.trees.get(root);
    if (t === undefined) {
      t = new BTree(this.pager, root);
      this.trees.set(root, t);
    }
    return t;
  }

  // ---------------------------------------------------------------- FunctionContext

  lastInsertRowid(): number | bigint {
    return this.lastRowid;
  }
  changes(): number {
    return this.lastChanges;
  }
  totalChanges(): number {
    return this.total;
  }
  /** 'now' for date/time functions: read once per statement execution (reset in execute()). */
  now(): number {
    return (this.stmtNow ??= Date.now());
  }
  private stmtNow: number | undefined;

  get inTransaction(): boolean {
    return !this.autocommit;
  }

  // ---------------------------------------------------------------- public API

  /** Compile a single statement. */
  prepare(sql: string): Statement {
    this.checkOpen();
    return new Statement(this, parseOne(sql), sql);
  }

  /** Run one or more statements, discarding any rows. */
  exec(sql: string, params?: BindParams): void {
    this.checkOpen();
    const stmts = parse(sql);
    if (params !== undefined && stmts.length > 1) throw new MisuseError('parameters can only be bound with a single statement');
    for (const ps of stmts) new Statement(this, ps, ps.text).run(params);
  }

  /** Run a single statement and return all rows. */
  query(sql: string, params?: BindParams): QueryResult {
    const st = this.cached(sql);
    return { columns: st.columns, rows: st.all(params) };
  }

  run(sql: string, params?: BindParams): RunResult {
    return this.cached(sql).run(params);
  }

  close(): void {
    if (this.closed) return;
    for (const c of [...this.activeCursors]) c.close();
    this.pager.close();
    this.closed = true;
  }

  private cached(sql: string): Statement {
    let st = this.cache.get(sql);
    if (st) {
      this.cache.delete(sql);
      this.cache.set(sql, st);
      return st;
    }
    st = this.prepare(sql);
    this.cache.set(sql, st);
    if (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value!);
    return st;
  }

  private checkOpen(): void {
    if (this.closed) throw new MisuseError('database is closed');
  }

  // ---------------------------------------------------------------- schema

  getTable(name: string): TableSchema | undefined {
    const lower = name.toLowerCase();
    if (CATALOG_NAMES.has(lower)) return this.catalogTable;
    return this.tables.get(lower);
  }

  private fkInvolvedNow(name: string): boolean {
    const t = this.tables.get(name.toLowerCase());
    if (!t) return false;
    this.fk.sync(this.schemaVersion);
    return this.fk.involved(t);
  }

  /** Writer for user DML: deletions it makes (DELETE, REPLACE conflicts) run foreign-key processing. */
  private writerFor(table: TableSchema): TableWriter {
    const w = new TableWriter(table, this.pager, (root) => this.tree(root));
    w.beforeDelete = (row) => {
      if (this.fk.involved(table)) this.fk.beforeDelete(table, row);
    };
    w.onDelete = (row) => {
      if (this.fk.involved(table)) this.fk.afterDelete(table, row);
    };
    return w;
  }

  /** Foreign-key enforcement (on by default; PRAGMA foreign_keys = OFF disables it). */
  private readonly fk = new ForeignKeys({
    getTable: (n) => this.tables.get(n.toLowerCase()),
    allTables: () => [...this.tables.values()].filter((t) => !t.system),
    query: (sql, params) => this.internal(sql, params) ?? [],
    run: (sql, params) => void this.internal(sql, params),
  });

  private internalPrograms = new Map<string, { version: number; prog: Program }>();

  /**
   * Run an internal statement (foreign-key checks and actions) with positional parameters, inside
   * the current statement: no transaction handling, and changes() is not affected.
   */
  private internal(sql: string, params: SqlValue[]): SqlValue[][] | null {
    let c = this.internalPrograms.get(sql);
    if (!c || c.version !== this.schemaVersion) {
      const ps = parseOne(sql);
      c = { version: this.schemaVersion, prog: this.compile(ps) };
      this.internalPrograms.set(sql, c);
    }
    const p = c.prog;
    const regs: SqlValue[] = new Array(p.regCount).fill(null);
    params.forEach((v, i) => (regs[i] = v));
    const saved = [this.lastChanges, this.total, this.lastRowid] as const;
    try {
      if (p.exec) {
        p.exec(regs);
        return null;
      }
      const root = p.plan!.root;
      const out: SqlValue[][] = [];
      root.open(regs);
      try {
        while (root.next()) out.push(p.plan!.outRegs.map((g) => regs[g]));
      } finally {
        root.close();
      }
      return out;
    } finally {
      [this.lastChanges, this.total, this.lastRowid] = saved;
    }
  }

  /** @internal Virtual tables for the planner: information_schema views and pragma_*() functions. */
  virtualTable(schema: string | undefined, name: string): { columns: { name: string; type: StaticType }[]; rows: (args: SqlValue[]) => SqlValue[][] } | undefined {
    if (schema === 'information_schema') {
      const vt = informationSchema(name, this.catalogSnapshot());
      return vt && { columns: vt.columns, rows: () => vt.rows() };
    }
    const lower = name.toLowerCase();
    if (!lower.startsWith('pragma_')) return undefined;
    const pragma = lower.slice('pragma_'.length);
    let current: SqlValue[] = [];
    const p = this.pragmaTable(pragma, () => (current[0] === null || current[0] === undefined ? undefined : String(current[0])));
    if (!p) return undefined;
    return {
      columns: p.columns.map((c) => ({ name: c, type: 'any' as StaticType })),
      rows: (args) => {
        current = args;
        // Unlike PRAGMA, the table-valued form yields no rows for an unknown table.
        try {
          return p.rows();
        } catch (e) {
          if (e instanceof SmaltError && /^no such table/.test(e.message)) return [];
          throw e;
        }
      },
    };
  }

  private catalogSnapshot(): CatalogSnapshot {
    return {
      tables: [...this.tables.values()],
      views: [...this.views.values()].map((v) => ({ name: v.name, sql: v.sql, selectPos: v.select.pos })),
      viewColumns: (name) => {
        const v = this.views.get(name.toLowerCase());
        if (!v) return null;
        try {
          const planner = new Planner(
            { getTable: (n) => this.getTable(n), getView: (n) => this.getView(n), openTree: (root) => this.tree(root), funcCtx: this, state: this.state },
            new Registers(0),
          );
          planner.sqlText = v.sql;
          const plan = planner.planSelect(v.select, null);
          return plan.columns.map((c, i) => ({ name: v.columns?.[i] ?? c.name, declType: c.declType ?? '' }));
        } catch {
          return null;
        }
      },
      functions: [
        ...[...scalarFunctions].map(([name, f]) => ({ name, kind: 'FUNCTION' as const, deterministic: f.deterministic })),
        ...[...aggregateFunctions.keys()].map((name) => ({ name, kind: 'AGGREGATE' as const, deterministic: true })),
      ].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
  }

  /** @internal View by name (for the planner). */
  getView(name: string): ViewSchema | undefined {
    return this.views.get(name.toLowerCase());
  }

  tableNames(): string[] {
    return [...this.tables.values()].map((t) => t.name);
  }

  private loadSchema(): void {
    this.tables.clear();
    this.indexes.clear();
    this.views.clear();
    this.catalog.clear();
    const catStmt = parseOne(CATALOG_SQL).stmt as CreateTableStmt;
    this.catalogTable = { ...buildTableSchema(catStmt, CATALOG_SQL, this.pager.catalogRoot).table, system: true };
    const rows = this.scanCatalog();
    const autoRoots = new Map<string, number>();
    for (const r of rows) if (r.type === 'index' && r.sql === null) autoRoots.set(r.name.toLowerCase(), r.rootpage);
    for (const r of rows) {
      this.catalog.set(r.name.toLowerCase(), { type: r.type as CatalogEntry['type'], name: r.name, rowid: r.rowid });
      if (r.type === 'view') {
        const v = parseOne(r.sql!).stmt as CreateViewStmt;
        this.views.set(r.name.toLowerCase(), { name: r.name, sql: r.sql!, columns: v.columns, select: v.select });
        continue;
      }
      if (r.type !== 'table') continue;
      const stmt = parseOne(r.sql!).stmt as CreateTableStmt;
      const { table, implicitIndexes } = buildTableSchema(stmt, r.sql!, r.rootpage);
      implicitIndexes.forEach((spec, i) => {
        const name = autoIndexName(table.name, i + 1);
        const root = autoRoots.get(name.toLowerCase());
        if (root === undefined) throw new SmaltError('SMALT_CORRUPT', `missing automatic index ${name}`);
        const idx: IndexSchema = { name, table: table.name, rootPage: root, columns: spec.columns, unique: true, origin: spec.origin, constraintName: spec.constraintName };
        table.indexes.push(idx);
        this.indexes.set(name.toLowerCase(), idx);
      });
      this.tables.set(table.name.toLowerCase(), table);
    }
    for (const r of rows) {
      if (r.type !== 'index' || r.sql === null) continue;
      const stmt = parseOne(r.sql).stmt as CreateIndexStmt;
      const table = this.tables.get(r.tbl_name.toLowerCase());
      if (!table) throw new SmaltError('SMALT_CORRUPT', `index ${r.name} references missing table ${r.tbl_name}`);
      const idx = buildIndexSchema(stmt, r.sql, table, r.rootpage);
      this.prepareIndex(table, idx);
      table.indexes.push(idx);
      this.indexes.set(idx.name.toLowerCase(), idx);
    }
    this.loadStats();
    this.schemaVersion++;
  }

  private scanCatalog(): { rowid: number | bigint; type: string; name: string; tbl_name: string; rootpage: number; sql: string | null }[] {
    const tree = new BTree(this.pager, this.pager.catalogRoot);
    const reader = new RecordReader(this.catalogTable.layout);
    const out = [];
    const c = tree.cursor();
    for (let ok = c.first(); ok; ok = c.next()) {
      c.loadValue();
      reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
      c.loadKey();
      out.push({
        rowid: readRowidKey(c.keyBytes, c.keyOffset),
        type: reader.column(0) as string,
        name: reader.column(1) as string,
        tbl_name: reader.column(2) as string,
        rootpage: Number(reader.column(3)),
        sql: reader.column(4) as string | null,
      });
    }
    c.close();
    return out;
  }

  private catalogWriter(): TableWriter {
    return new TableWriter(this.catalogTable, this.pager, (root) => this.tree(root));
  }

  private addCatalogRow(type: string, name: string, tblName: string, root: number, sql: string | null): void {
    const w = this.catalogWriter();
    const rowid = w.newRowid();
    w.writeRow([type, name, tblName, root, sql], rowid);
    this.catalog.set(name.toLowerCase(), { type: type as CatalogEntry['type'], name, rowid });
  }

  private removeCatalogRow(name: string): void {
    const e = this.catalog.get(name.toLowerCase());
    if (!e) return;
    this.catalogWriter().deleteRow(e.rowid);
    this.catalog.delete(name.toLowerCase());
  }

  private schemaChanged(): void {
    this.pager.schemaCookie = (this.pager.schemaCookie + 1) >>> 0;
    this.schemaVersion++;
  }

  // ---------------------------------------------------------------- compilation

  /** @internal Compile a statement AST into a program for the current schema. */
  compile(ps: ParsedStatement): Program {
    const stmt = ps.stmt;
    const regs = new Registers(ps.paramCount);
    const planner = new Planner(
      { getTable: (n) => this.getTable(n), getView: (n) => this.getView(n), virtualTable: (schema, n) => this.virtualTable(schema, n), openTree: (root) => this.tree(root), sampledStats: (t) => this.sampledStats(t), funcCtx: this, state: this.state },
      regs,
    );
    planner.sqlText = ps.text;
    const done = (p: Omit<Program, 'regCount'>): Program => ({ ...p, regCount: regs.count, rowAssumptions: planner.rowAssumptions });
    switch (stmt.kind) {
      case 'select': {
        const plan = planner.planSelect(stmt, null);
        return done({ plan, readonly: true, columns: plan.columns.map((c) => c.name), columnTypes: plan.columns.map((c) => c.type) });
      }
      case 'insert': {
        const single = stmt.source.kind === 'values' && stmt.source.rows.length === 1 && (stmt.or ?? 'ABORT') !== 'REPLACE' && this.getTable(stmt.table)?.indexes.length === 0 && !stmt.upsert.length && !this.fkInvolvedNow(stmt.table);
        const c = this.compileInsert(stmt, planner);
        return done(this.dmlProgram(c, single));
      }
      case 'update':
        return done(this.dmlProgram(this.compileUpdate(stmt, planner)));
      case 'delete':
        return done(this.dmlProgram(this.compileDelete(stmt, planner)));
      case 'createTable':
        return done({ exec: () => this.createTable(stmt, ps.text), readonly: false, columns: [], columnTypes: [] });
      case 'createIndex':
        return done({ exec: () => this.createIndex(stmt, ps.text), readonly: false, columns: [], columnTypes: [] });
      case 'alterTable':
        return done({ exec: () => this.alterTable(stmt, ps.text), readonly: false, columns: [], columnTypes: [] });
      case 'createView':
        if (stmt.materialized) throw new SmaltError('SMALT_UNSUPPORTED', 'materialized views are not supported yet (M5)');
        if (stmt.temp) throw new SmaltError('SMALT_UNSUPPORTED', 'TEMP views are not supported yet');
        if (stmt.schema && stmt.schema.toLowerCase() !== 'main') throw new SmaltError('SMALT_ERROR', `unknown database ${stmt.schema}`);
        return done({ exec: () => this.createView(stmt, ps.text), readonly: false, columns: [], columnTypes: [] });
      case 'drop':
        return done({ exec: () => this.drop(stmt), readonly: false, columns: [], columnTypes: [] });
      case 'begin':
      case 'commit':
      case 'rollback':
      case 'savepoint':
      case 'release':
        return done({ exec: () => this.transactionControl(stmt), readonly: true, columns: [], columnTypes: [] });
      case 'explain': {
        if (stmt.stmt.kind !== 'select') throw new SmaltError('SMALT_UNSUPPORTED', 'EXPLAIN is only supported for SELECT statements');
        const plan = planner.planSelect(stmt.stmt as SelectStmt, null);
        if (stmt.analyze) {
          const round = (x: number): number => Math.round(x * 1000) / 1000;
          return done({
            readonly: true,
            rows: (r) => explainAnalyze(plan.root, r, planner.estimates).map((x) => [x.id, x.parent, x.detail, x.estRows === null ? null : Math.round(x.estRows), x.loops, x.rows, round(x.timeMs)]),
            columns: ['id', 'parent', 'detail', 'est_rows', 'loops', 'rows', 'time_ms'],
            columnTypes: ['int', 'int', 'text', 'int', 'int', 'int', 'real'],
          });
        }
        return done({
          readonly: true,
          rows: () => explainRows(plan.root).map((x) => [x.id, x.parent, 0, x.detail]),
          columns: ['id', 'parent', 'notused', 'detail'],
          columnTypes: ['int', 'int', 'int', 'text'],
        });
      }
      case 'pragma':
        return done(this.compilePragma(stmt, planner));
      case 'analyze':
        return done({ exec: () => this.analyze(stmt.target), readonly: false, columns: [], columnTypes: [] });
      default:
        throw new SmaltError('SMALT_UNSUPPORTED', `${stmt.kind} statements are not supported yet`);
    }
  }

  /** Program for a write statement; with RETURNING it produces rows (and still counts changes). */
  private dmlProgram(c: { exec: (r: SqlValue[], out?: SqlValue[][]) => RunResult; returning?: { columns: string[]; types: StaticType[] } }, singleRowWrite = false): Omit<Program, 'regCount'> {
    if (!c.returning) return { exec: (r) => c.exec(r), readonly: false, singleRowWrite, columns: [], columnTypes: [] };
    return {
      readonly: false,
      singleRowWrite,
      rows: (r) => {
        const out: SqlValue[][] = [];
        c.exec(r, out);
        return out;
      },
      columns: c.returning.columns,
      columnTypes: c.returning.types,
    };
  }

  /** Open SQL savepoints, oldest first, with their pager depth. */
  private readonly sqlSavepoints: { name: string; depth: number }[] = [];
  /** The transaction was started by SAVEPOINT (releasing the outermost savepoint commits). */
  private txnFromSavepoint = false;

  private transactionControl(stmt: Stmt): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    switch (stmt.kind) {
      case 'begin':
        if (!this.autocommit) throw new SmaltError('SMALT_ERROR', 'cannot start a transaction within a transaction');
        this.autocommit = false;
        this.txnFromSavepoint = false;
        break;
      case 'commit':
        if (this.autocommit) throw new SmaltError('SMALT_ERROR', 'cannot commit - no transaction is active');
        this.commitTransaction();
        break;
      case 'rollback':
        if (this.autocommit) throw new SmaltError('SMALT_ERROR', 'cannot rollback - no transaction is active');
        if (stmt.savepoint) {
          const i = this.findSavepoint(stmt.savepoint);
          this.pager.rollbackToSavepoint(this.sqlSavepoints[i].depth, true);
          this.sqlSavepoints.length = i + 1;
          this.loadSchema();
        } else this.rollbackTransaction();
        break;
      case 'savepoint':
        if (this.autocommit) {
          this.autocommit = false;
          this.txnFromSavepoint = true;
        }
        this.sqlSavepoints.push({ name: stmt.name, depth: this.pager.beginSavepoint() });
        break;
      case 'release': {
        const i = this.findSavepoint(stmt.name);
        this.pager.releaseSavepoint(this.sqlSavepoints[i].depth);
        this.sqlSavepoints.length = i;
        if (i === 0 && this.txnFromSavepoint) this.commitTransaction();
        break;
      }
    }
    return none;
  }

  private findSavepoint(name: string): number {
    for (let i = this.sqlSavepoints.length - 1; i >= 0; i--) if (this.sqlSavepoints[i].name.toLowerCase() === name.toLowerCase()) return i;
    throw new SmaltError('SMALT_ERROR', `no such savepoint: ${name}`);
  }

  private commitTransaction(): void {
    // Deferred foreign-key violations keep the transaction open, as in SQLite.
    this.fk.checkCommit();
    if (this.sqlSavepoints.length) this.pager.releaseSavepoint(1);
    this.sqlSavepoints.length = 0;
    this.pager.commit();
    this.autocommit = true;
    this.txnFromSavepoint = false;
  }

  private rollbackTransaction(): void {
    this.fk.deferred = 0;
    this.sqlSavepoints.length = 0;
    this.txnFromSavepoint = false;
    this.pager.rollback();
    this.autocommit = true;
    // Reload the in-memory schema if DDL was rolled back.
    this.loadSchema();
  }

  /** @internal Run a write/utility program inside statement + (auto)transaction boundaries. */
  execute<T>(program: Program, body: () => T): T {
    if (!program.readonly && this.activeCursors.size > 0) {
      throw new SmaltError('SMALT_BUSY', 'cannot modify the database while a query cursor is open; finish or close it first');
    }
    this.state.epoch++;
    this.stmtNow = undefined;
    if (program.readonly) return body();
    const pager = this.pager;
    // A statement journal is only needed inside an explicit transaction (autocommit failures roll
    // back the whole transaction) and only for statements that can fail after writing.
    const journal = !this.autocommit && !program.singleRowWrite;
    if (journal) pager.beginStatement();
    let result: T;
    this.fk.sync(this.schemaVersion);
    this.fk.stmt = 0;
    const deferredBefore = this.fk.deferred;
    try {
      result = body();
      this.fk.checkStatement();
      if (this.autocommit) this.fk.checkCommit();
    } catch (e) {
      this.fk.stmt = 0;
      this.fk.deferred = this.autocommit ? 0 : deferredBefore;
      if (journal) pager.rollbackStatement();
      if (this.autocommit) pager.rollback();
      this.loadSchemaIfChanged();
      throw e;
    }
    if (journal) pager.commitStatement();
    if (this.autocommit) pager.commit();
    return result;
  }

  private loadedCookie = -1;
  private loadSchemaIfChanged(): void {
    // Cheap check: a rolled-back DDL statement changed the in-memory schema but not the stored one.
    if (this.loadedCookie !== this.pager.schemaCookie || this.dirtySchema) {
      this.loadSchema();
      this.loadedCookie = this.pager.schemaCookie;
      this.dirtySchema = false;
    }
  }
  private dirtySchema = false;

  // ---------------------------------------------------------------- statistics

  private static readonly STAT_SQL = 'CREATE TABLE smalt_stat(tbl TEXT, idx TEXT, stat TEXT)';

  /** ANALYZE [table]: gather optimizer statistics and store them in smalt_stat. */
  private analyze(target: string | undefined): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    let tables = [...this.tables.values()].filter((t) => !t.system && t.name.toLowerCase() !== 'smalt_stat');
    if (target) {
      const t = this.tables.get(target.toLowerCase());
      const idx = this.indexes.get(target.toLowerCase());
      if (t) tables = [t];
      else if (idx) tables = [this.tables.get(idx.table.toLowerCase())!];
      else throw new SmaltError('SMALT_ERROR', `no such table or index: ${target}`);
    }
    if (!this.tables.has('smalt_stat')) {
      this.createTable(parseOne(Database.STAT_SQL).stmt as CreateTableStmt, Database.STAT_SQL, true);
    }
    const stat = this.tables.get('smalt_stat')!;
    const w = new TableWriter(stat, this.pager, (root) => this.tree(root));
    // Remove old rows for these tables.
    const names = new Set(tables.map((t) => t.name.toLowerCase()));
    const reader = new RecordReader(stat.layout, stat.recordDefaults);
    const stale: (number | bigint)[] = [];
    const c = this.tree(stat.rootPage).cursor();
    for (let ok = c.first(); ok; ok = c.next()) {
      c.loadValue();
      reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
      if (names.has(String(reader.column(0)).toLowerCase())) {
        c.loadKey();
        stale.push(readRowidKey(c.keyBytes, c.keyOffset));
      }
    }
    c.close();
    for (const id of stale) w.deleteRow(id);
    for (const t of tables) {
      const ts = analyzeTable(this.tree(t.rootPage), t);
      w.writeRow([t.name, null, JSON.stringify(ts)], w.newRowid());
      t.stats = ts;
      for (const ix of t.indexes) {
        const is = analyzeIndex(this.tree(ix.rootPage), ix);
        w.writeRow([t.name, ix.name, JSON.stringify(is)], w.newRowid());
        ix.stats = is;
      }
    }
    this.schemaChanged();
    return none;
  }

  /** Sampled statistics per table schema object (a schema reload drops them with the old objects). */
  private readonly sampled = new WeakMap<TableSchema, { stats: TableStats | undefined; at: number }>();

  /**
   * Statistics for a table that has not been ANALYZEd, computed on first use by the planner and
   * recomputed when the table's size (estimated from the tree shape) has changed 4x or more.
   */
  private sampledStats(t: TableSchema): TableStats | undefined {
    if (t.name.toLowerCase().startsWith('smalt_')) return undefined;
    const tree = this.tree(t.rootPage);
    const live = tree.estimateCount();
    const hit = this.sampled.get(t);
    if (hit && Math.max(live, 64) < Math.max(hit.at, 64) * 4 && Math.max(hit.at, 64) < Math.max(live, 64) * 4) return hit.stats;
    const stats = sampleTable(tree, t, live);
    this.sampled.set(t, { stats, at: live });
    return stats;
  }

  /** Attach persisted statistics (smalt_stat) to the in-memory schema. */
  private loadStats(): void {
    const stat = this.tables.get('smalt_stat');
    if (!stat) return;
    const reader = new RecordReader(stat.layout, stat.recordDefaults);
    const c = this.tree(stat.rootPage).cursor();
    try {
      for (let ok = c.first(); ok; ok = c.next()) {
        c.loadValue();
        reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
        const tbl = this.tables.get(String(reader.column(0)).toLowerCase());
        const idxName = reader.column(1);
        const json = reader.column(2);
        if (!tbl || typeof json !== 'string') continue;
        try {
          const parsed = JSON.parse(json);
          if (idxName === null) tbl.stats = parsed;
          else {
            const ix = tbl.indexes.find((i) => i.name.toLowerCase() === String(idxName).toLowerCase());
            if (ix) ix.stats = parsed;
          }
        } catch {
          /* ignore malformed stats */
        }
      }
    } finally {
      c.close();
    }
  }

  // ---------------------------------------------------------------- DDL

  private checkNewName(name: string, kind: string): void {
    const lower = name.toLowerCase();
    if (lower.startsWith('smalt_') || lower.startsWith('sqlite_')) throw new SmaltError('SMALT_ERROR', `object name reserved for internal use: ${name}`);
    const existing = this.catalog.get(lower);
    if (existing) throw new SmaltError('SMALT_ERROR', `${existing.type === kind ? kind : existing.type} ${name} already exists`);
  }

  private createView(stmt: CreateViewStmt, sql: string): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    if (stmt.ifNotExists && this.catalog.get(stmt.name.toLowerCase())?.type === 'view') return none;
    this.checkNewName(stmt.name, 'view');
    this.dirtySchema = true;
    // Like SQLite, the body is not resolved until the view is used (it may reference tables created later).
    this.addCatalogRow('view', stmt.name, stmt.name, 0, sql);
    this.views.set(stmt.name.toLowerCase(), { name: stmt.name, sql, columns: stmt.columns, select: stmt.select });
    this.schemaChanged();
    return none;
  }

  private createTable(stmt: CreateTableStmt, sql: string, internal = false): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    if (stmt.temp) throw new SmaltError('SMALT_UNSUPPORTED', 'TEMP tables are not supported yet');
    if (stmt.ifNotExists && this.catalog.has(stmt.name.toLowerCase())) return none;
    if (!internal) this.checkNewName(stmt.name, 'table');
    this.dirtySchema = true;
    const root = BTree.create(this.pager);
    const { table, implicitIndexes } = buildTableSchema(stmt, sql, root);
    this.addCatalogRow('table', table.name, table.name, root, sql);
    implicitIndexes.forEach((spec, i) => {
      const name = autoIndexName(table.name, i + 1);
      const iroot = BTree.create(this.pager);
      const idx: IndexSchema = { name, table: table.name, rootPage: iroot, columns: spec.columns, unique: true, origin: spec.origin, constraintName: spec.constraintName };
      table.indexes.push(idx);
      this.indexes.set(name.toLowerCase(), idx);
      this.addCatalogRow('index', name, table.name, iroot, null);
    });
    this.tables.set(table.name.toLowerCase(), table);
    this.schemaChanged();
    return none;
  }

  private createIndex(stmt: CreateIndexStmt, sql: string): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    if (stmt.ifNotExists && this.catalog.has(stmt.name.toLowerCase())) return none;
    const table = this.tables.get(stmt.table.toLowerCase());
    if (!table) throw new SmaltError('SMALT_ERROR', this.views.has(stmt.table.toLowerCase()) ? 'views may not be indexed' : `no such table: ${stmt.table}`);
    this.checkNewName(stmt.name, 'index');
    this.dirtySchema = true;
    const root = BTree.create(this.pager);
    const idx = buildIndexSchema(stmt, sql, table, root);
    this.prepareIndex(table, idx);
    // Populate from existing rows (expression values computed, partial-index rows filtered).
    const tree = new BTree(this.pager, table.rootPage);
    const itree = new BTree(this.pager, root);
    const reader = new RecordReader(table.layout, table.recordDefaults);
    const w = new TableWriter(table, this.pager, (r) => this.tree(r));
    const entries: Uint8Array[] = [];
    const c = tree.cursor();
    try {
      for (let ok = c.first(); ok; ok = c.next()) {
        c.loadKey();
        const rowid = readRowidKey(c.keyBytes, c.keyOffset);
        c.loadValue();
        reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
        const row = table.columns.map((_, i) => (i === table.rowidAlias ? rowid : reader.column(i)));
        const k = w.indexEntry(idx, row, rowid);
        if (k) entries.push(k);
      }
    } finally {
      c.close();
    }
    for (const k of entries) itree.put(k, new Uint8Array(0));
    table.indexes.push(idx);
    this.indexes.set(idx.name.toLowerCase(), idx);
    if (idx.unique) this.checkUniqueIndex(table, idx); // existing rows may already collide
    this.addCatalogRow('index', idx.name, table.name, root, sql);
    this.schemaChanged();
    return none;
  }

  /**
   * Validate and compile an index's expression columns and partial-index WHERE (like SQLite: no
   * subqueries, parameters or non-deterministic functions) into evaluators over a row.
   */
  private prepareIndex(table: TableSchema, idx: IndexSchema): void {
    idx.eval = undefined;
    if (!idx.where && !idx.columns.some((c) => c.expr)) return;
    const n = table.columns.length;
    const planner = new Planner({ getTable: (x) => this.getTable(x), openTree: (root) => this.tree(root), funcCtx: this, state: this.state }, new Registers(n + 1));
    const scope = this.rowScope(table, undefined, 0, n, planner);
    const check = (e: Expr, what: string): void => {
      const go = (x: unknown): void => {
        if (Array.isArray(x)) return x.forEach(go);
        if (typeof x !== 'object' || x === null || Object.getPrototypeOf(x) !== Object.prototype) return;
        const o = x as Record<string, unknown>;
        if ((o.kind === 'subquery' || o.kind === 'exists' || o.kind === 'inSelect') && 'select' in o) throw new SmaltError('SMALT_ERROR', `subqueries prohibited in ${what}`);
        if (o.kind === 'param') throw new SmaltError('SMALT_ERROR', `parameters prohibited in ${what}`);
        if (o.kind === 'call') {
          const name = String(o.name);
          const def = scalarFunctions.get(name);
          if ((def && !def.deterministic) || name === 'current_time' || name === 'current_date' || name === 'current_timestamp') {
            throw new SmaltError('SMALT_ERROR', `non-deterministic functions prohibited in ${what}`);
          }
        }
        for (const k of Object.keys(o)) go(o[k]);
      };
      go(e);
    };
    const cols = idx.columns.map((c) => {
      if (!c.expr) return null;
      check(c.expr, 'index expressions');
      return compileExpr(c.expr, scope).fn;
    });
    let where: Fn | undefined;
    if (idx.where) {
      check(idx.where, 'partial index WHERE clauses');
      where = compileExpr(idx.where, scope).fn;
    }
    const regs: SqlValue[] = new Array(Math.max(planner.regs.count, n + 1)).fill(null);
    const load = (row: readonly SqlValue[], rowid: number | bigint): SqlValue[] => {
      for (let i = 0; i < n; i++) regs[i] = row[i];
      regs[n] = rowid;
      return regs;
    };
    idx.eval = {
      cols: cols.map((f) => (f ? (row: readonly SqlValue[], rowid: number | bigint) => f(load(row, rowid)) : null)),
      where: where ? (row, rowid) => truthy(where!(load(row, rowid))) === true : undefined,
    };
  }

  private checkUniqueIndex(table: TableSchema, idx: IndexSchema): void {
    const itree = new BTree(this.pager, idx.rootPage);
    const c = itree.cursor();
    let prev: Uint8Array | null = null;
    try {
      for (let ok = c.first(); ok; ok = c.next()) {
        const k = c.key();
        const prefix = k.subarray(0, k.length - 11);
        if (prev && prefix.length === prev.length && prefix.every((b, i) => b === prev![i]) && !prefixHasNull(prefix)) {
          throw new ConstraintError('SMALT_CONSTRAINT_UNIQUE', idx.columns.some((ic) => ic.column < 0) ? `UNIQUE constraint failed: index '${idx.name}'` : `UNIQUE constraint failed: ${idx.columns.map((ic) => `${table.name}.${table.columns[ic.column].name}`).join(', ')}`);
        }
        prev = prefix.slice();
      }
    } finally {
      c.close();
    }
  }

  private drop(stmt: DropStmt): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    const lower = stmt.name.toLowerCase();
    const existing = this.catalog.get(lower);
    if (existing && (stmt.objectType === 'table' || stmt.objectType === 'view') && existing.type !== stmt.objectType && existing.type !== 'index') {
      throw new SmaltError('SMALT_ERROR', `use DROP ${existing.type.toUpperCase()} to delete ${existing.type} ${existing.name}`);
    }
    if (stmt.objectType === 'view') {
      const view = this.views.get(lower);
      if (!view) {
        if (stmt.ifExists) return none;
        throw new SmaltError('SMALT_ERROR', `no such view: ${stmt.name}`);
      }
      this.dirtySchema = true;
      this.removeCatalogRow(view.name);
      this.views.delete(lower);
      this.schemaChanged();
      return none;
    }
    if (stmt.objectType === 'table') {
      const table = this.tables.get(lower);
      if (!table) {
        if (stmt.ifExists) return none;
        throw new SmaltError('SMALT_ERROR', `no such table: ${stmt.name}`);
      }
      // Like SQLite, dropping a parent table first deletes its rows (applying foreign-key actions).
      if (this.fk.enabled && this.tables.size > 1 && [...this.tables.values()].some((t) => t !== table && t.foreignKeys.some((f) => f.table.toLowerCase() === lower))) {
        this.fk.sync(this.schemaVersion);
        this.internal(`DELETE FROM "${table.name.replace(/"/g, '""')}"`, []);
      }
      this.dirtySchema = true;
      for (const idx of table.indexes) {
        new BTree(this.pager, idx.rootPage).destroy();
        this.removeCatalogRow(idx.name);
        this.indexes.delete(idx.name.toLowerCase());
      }
      new BTree(this.pager, table.rootPage).destroy();
      this.removeCatalogRow(table.name);
      this.tables.delete(lower);
      this.schemaChanged();
      return none;
    }
    if (stmt.objectType === 'index') {
      const idx = this.indexes.get(lower);
      if (!idx) {
        if (stmt.ifExists) return none;
        throw new SmaltError('SMALT_ERROR', `no such index: ${stmt.name}`);
      }
      if (idx.origin !== 'c') throw new SmaltError('SMALT_ERROR', 'index associated with UNIQUE or PRIMARY KEY constraint cannot be dropped');
      this.dirtySchema = true;
      new BTree(this.pager, idx.rootPage).destroy();
      this.removeCatalogRow(idx.name);
      this.indexes.delete(lower);
      const table = this.tables.get(idx.table.toLowerCase())!;
      table.indexes = table.indexes.filter((i) => i !== idx);
      this.schemaChanged();
      return none;
    }
    throw new SmaltError('SMALT_UNSUPPORTED', `DROP ${stmt.objectType.toUpperCase()} is not supported yet`);
  }


  // ---------------------------------------------------------------- ALTER TABLE

  private alterTable(stmt: AlterTableStmt, sql: string): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    if (stmt.schema && stmt.schema.toLowerCase() !== 'main') throw new SmaltError('SMALT_ERROR', `unknown database ${stmt.schema}`);
    const lower = stmt.table.toLowerCase();
    if (CATALOG_NAMES.has(lower) || lower.startsWith('smalt_') || lower.startsWith('sqlite_')) {
      throw new SmaltError('SMALT_ERROR', `table ${CATALOG_NAMES.has(lower) ? 'sqlite_master' : stmt.table} may not be altered`);
    }
    if (this.views.has(lower)) {
      throw new SmaltError('SMALT_ERROR', stmt.action.kind === 'addColumn' ? 'Cannot add a column to a view' : `view ${stmt.table} may not be altered`);
    }
    const table = this.tables.get(lower);
    if (!table) throw new SmaltError('SMALT_ERROR', `no such table: ${stmt.table}`);
    this.dirtySchema = true;
    const a = stmt.action;
    switch (a.kind) {
      case 'renameTable':
        this.renameTable(table, a.newName);
        break;
      case 'renameColumn':
        this.renameColumn(table, a.column, a.newName);
        break;
      case 'addColumn':
        this.addColumn(table, a.column, sql);
        break;
      case 'dropColumn':
        this.dropColumn(table, a.column);
        break;
    }
    this.schemaChanged();
    return none;
  }

  /** Column names per table, for resolving references while rewriting SQL text. */
  private schemaLookup(): SchemaLookup {
    return {
      tableColumns: (name) => {
        const t = this.tables.get(name.toLowerCase());
        return t ? new Set(t.columns.map((c) => c.name.toLowerCase())) : undefined;
      },
    };
  }

  /** Rewrite catalog rows; `f` returns the new (type, name, tbl_name, sql) or null to keep a row. */
  private rewriteCatalog(f: (row: { type: string; name: string; tbl_name: string; rootpage: number; sql: string | null }) => { name?: string; tbl_name?: string; sql?: string | null } | null): void {
    const w = this.catalogWriter();
    for (const row of this.scanCatalog()) {
      const change = f(row);
      if (!change) continue;
      const next = [row.type, change.name ?? row.name, change.tbl_name ?? row.tbl_name, row.rootpage, change.sql === undefined ? row.sql : change.sql];
      w.deleteRow(row.rowid);
      w.writeRow(next, row.rowid);
    }
  }

  /**
   * Reload the schema from the (rewritten) catalog and check every object still resolves, reporting
   * the first failure the way SQLite does ("error in view v after drop column: ...").
   */
  private validateAfterAlter(suffix: string, viewSuffix = suffix): void {
    const rows = this.scanCatalog();
    const built = new Map<string, TableSchema>();
    for (const r of rows) {
      if (r.type !== 'table' || r.sql === null) continue;
      try {
        const { table } = buildTableSchema(parseOne(r.sql).stmt as CreateTableStmt, r.sql, r.rootpage);
        const planner = new Planner({ getTable: (n) => this.getTable(n), openTree: (root) => this.tree(root), funcCtx: this, state: this.state }, new Registers(0));
        const base = planner.regs.alloc(table.columns.length);
        this.compileChecks(table, this.rowScope(table, undefined, base, planner.regs.alloc(), planner), '');
        built.set(r.name.toLowerCase(), table);
      } catch (e) {
        throw new SmaltError('SMALT_ERROR', `error in table ${r.name}${suffix}: ${(e as Error).message}`);
      }
    }
    for (const r of rows) {
      if (r.type !== 'index' || r.sql === null) continue;
      try {
        const t = built.get(r.tbl_name.toLowerCase());
        if (!t) throw new SmaltError('SMALT_ERROR', `no such table: ${r.tbl_name}`);
        this.prepareIndex(t, buildIndexSchema(parseOne(r.sql).stmt as CreateIndexStmt, r.sql, t, r.rootpage));
      } catch (e) {
        throw new SmaltError('SMALT_ERROR', `error in index ${r.name}${suffix}: ${(e as Error).message}`);
      }
    }
    this.loadSchema();
    for (const v of this.views.values()) {
      try {
        const planner = new Planner(
          { getTable: (n) => this.getTable(n), getView: (n) => this.getView(n), openTree: (root) => this.tree(root), funcCtx: this, state: this.state },
          new Registers(0),
        );
        planner.sqlText = v.sql;
        planner.planSelect(v.select, null);
      } catch (e) {
        // A view that was already broken (e.g. dangling) stays as it was, like SQLite.
        if (!this.viewWasValid.has(v.name.toLowerCase())) continue;
        throw new SmaltError('SMALT_ERROR', `error in view ${v.name}${viewSuffix}: ${(e as Error).message}`);
      }
    }
  }

  /** Views that plan successfully right now (only those must keep working after an ALTER). */
  private viewWasValid = new Set<string>();
  private noteValidViews(): void {
    this.viewWasValid = new Set();
    for (const v of this.views.values()) {
      try {
        const planner = new Planner(
          { getTable: (n) => this.getTable(n), getView: (n) => this.getView(n), openTree: (root) => this.tree(root), funcCtx: this, state: this.state },
          new Registers(0),
        );
        planner.sqlText = v.sql;
        planner.planSelect(v.select, null);
        this.viewWasValid.add(v.name.toLowerCase());
      } catch {
        /* already broken */
      }
    }
  }

  private renameTable(table: TableSchema, newName: string): void {
    const lower = newName.toLowerCase();
    if (lower.startsWith('smalt_') || lower.startsWith('sqlite_')) throw new SmaltError('SMALT_ERROR', `object name reserved for internal use: ${newName}`);
    if (this.catalog.has(lower) && lower !== table.name.toLowerCase()) {
      throw new SmaltError('SMALT_ERROR', `there is already another table or index with this name: ${newName}`);
    }
    this.noteValidViews();
    const old = table.name;
    const lookup = this.schemaLookup();
    const autoPrefix = `smalt_autoindex_${old}_`.toLowerCase();
    this.rewriteCatalog((row) => {
      const ownRow = row.tbl_name.toLowerCase() === old.toLowerCase();
      const sql = row.sql === null ? null : applyEdits(row.sql, renameTableEdits(row.sql, old, newName, lookup));
      const name =
        row.type === 'table' && ownRow
          ? newName
          : row.type === 'index' && row.name.toLowerCase().startsWith(autoPrefix)
            ? autoIndexName(newName, Number(row.name.slice(autoPrefix.length)))
            : undefined;
      if (sql === row.sql && !ownRow) return null;
      return { name, tbl_name: ownRow ? newName : undefined, sql };
    });
    this.deleteStats(old);
    this.validateAfterAlter('', '');
  }

  private renameColumn(table: TableSchema, column: string, newName: string): void {
    const ci = findColumn(table, column);
    if (ci < 0) throw new SmaltError('SMALT_ERROR', `no such column: "${column}"`);
    const dup = findColumn(table, newName);
    if (dup >= 0 && dup !== ci) throw new SmaltError('SMALT_ERROR', `error in table ${table.name} after rename: duplicate column name: ${newName}`);
    this.noteValidViews();
    const lookup = this.schemaLookup();
    const colName = table.columns[ci].name;
    this.rewriteCatalog((row) => {
      if (row.sql === null) return null;
      const edits = renameColumnEdits(row.sql, table.name, colName, newName, lookup);
      return edits.length ? { sql: applyEdits(row.sql, edits) } : null;
    });
    this.validateAfterAlter(' after rename', '');
  }

  private addColumn(table: TableSchema, def: ColumnDef, alterSql: string): void {
    if (findColumn(table, def.name) >= 0) throw new SmaltError('SMALT_ERROR', `duplicate column name: ${def.name}`);
    const cons = def.constraints;
    if (cons.some((c) => c.kind === 'primaryKey')) throw new SmaltError('SMALT_ERROR', 'Cannot add a PRIMARY KEY column');
    if (cons.some((c) => c.kind === 'unique')) throw new SmaltError('SMALT_ERROR', 'Cannot add a UNIQUE column');
    if (cons.some((c) => c.kind === 'generated')) throw new SmaltError('SMALT_UNSUPPORTED', 'generated columns are not supported yet');
    const dflt = cons.find((c) => c.kind === 'default') as { expr: Expr } | undefined;
    if (dflt && !isConstantDefault(dflt.expr)) throw new SmaltError('SMALT_ERROR', 'Cannot add a column with non-constant default');
    if (cons.some((c) => c.kind === 'notNull') && literalValue(dflt?.expr) === null) {
      throw new SmaltError('SMALT_ERROR', 'Cannot add a NOT NULL column with default value NULL');
    }
    this.noteValidViews();
    const stmt = parseOne(table.sql).stmt as CreateTableStmt;
    const lastDef = stmt.columns[stmt.columns.length - 1];
    const defText = alterSql.slice(def.pos, def.end);
    const sql = table.sql.slice(0, lastDef.end) + ', ' + defText + table.sql.slice(lastDef.end);
    this.rewriteCatalog((row) => (row.type === 'table' && row.name.toLowerCase() === table.name.toLowerCase() ? { sql } : null));
    this.deleteStats(table.name);
    this.validateAfterAlter('');
    // Existing rows keep their shorter records: readers fill in the new column's constant default.
  }

  private dropColumn(table: TableSchema, column: string): void {
    const ci = findColumn(table, column);
    if (ci < 0) throw new SmaltError('SMALT_ERROR', `no such column: "${column}"`);
    const col = table.columns[ci];
    const stmt = parseOne(table.sql).stmt as CreateTableStmt;
    const def = stmt.columns[ci];
    if (col.primaryKey) throw new SmaltError('SMALT_ERROR', `cannot drop PRIMARY KEY column: "${col.name}"`);
    if (def.constraints.some((c) => c.kind === 'unique')) throw new SmaltError('SMALT_ERROR', `cannot drop UNIQUE column: "${col.name}"`);
    if (table.columns.length === 1) throw new SmaltError('SMALT_ERROR', `cannot drop column "${col.name}": no other columns exist`);
    this.noteValidViews();
    // Remove the column definition and the comma that separates it from its neighbour.
    const sql =
      ci > 0 ? table.sql.slice(0, stmt.columns[ci - 1].end) + table.sql.slice(def.end) : table.sql.slice(0, def.pos) + table.sql.slice(stmt.columns[1].pos);
    const oldTable = table;
    this.rewriteCatalog((row) => (row.type === 'table' && row.name.toLowerCase() === table.name.toLowerCase() ? { sql } : null));
    this.deleteStats(table.name);
    this.validateAfterAlter(' after drop column');
    // Rewrite every row without the column (index entries do not depend on record layout).
    const newTable = this.tables.get(oldTable.name.toLowerCase())!;
    const reader = new RecordReader(oldTable.layout, oldTable.recordDefaults);
    const rows: { rowid: number | bigint; row: SqlValue[] }[] = [];
    const c = this.tree(oldTable.rootPage).cursor();
    try {
      for (let ok = c.first(); ok; ok = c.next()) {
        c.loadValue();
        reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
        const row: SqlValue[] = [];
        for (let i = 0; i < oldTable.columns.length; i++) if (i !== ci) row.push(reader.column(i));
        c.loadKey();
        rows.push({ rowid: readRowidKey(c.keyBytes, c.keyOffset), row });
      }
    } finally {
      c.close();
    }
    const w = new TableWriter(newTable, this.pager, (root) => this.tree(root));
    for (const r of rows) {
      if (newTable.rowidAlias >= 0) r.row[newTable.rowidAlias] = r.rowid;
      w.rewriteRecord(r.row, r.rowid);
    }
  }

  /** Drop ANALYZE statistics of a table (they describe the old shape). */
  private deleteStats(tableName: string): void {
    const stat = this.tables.get('smalt_stat');
    if (!stat) return;
    const reader = new RecordReader(stat.layout, stat.recordDefaults);
    const stale: (number | bigint)[] = [];
    const c = this.tree(stat.rootPage).cursor();
    try {
      for (let ok = c.first(); ok; ok = c.next()) {
        c.loadValue();
        reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
        if (String(reader.column(0)).toLowerCase() === tableName.toLowerCase()) {
          c.loadKey();
          stale.push(readRowidKey(c.keyBytes, c.keyOffset));
        }
      }
    } finally {
      c.close();
    }
    const w = new TableWriter(stat, this.pager, (root) => this.tree(root));
    for (const id of stale) w.deleteRow(id);
  }

  // ---------------------------------------------------------------- DML

  private targetTable(name: string, schema?: string): TableSchema {
    if (schema && schema.toLowerCase() !== 'main') throw new SmaltError('SMALT_ERROR', `unknown database ${schema}`);
    const lower = name.toLowerCase();
    if (CATALOG_NAMES.has(lower) || lower === 'smalt_stat') throw new SmaltError('SMALT_ERROR', `table ${name} may not be modified`);
    const t = this.tables.get(lower);
    if (!t) {
      if (this.views.has(lower)) throw new SmaltError('SMALT_ERROR', `cannot modify ${name} because it is a view`);
      throw new SmaltError('SMALT_ERROR', `no such table: ${name}`);
    }
    return t;
  }

  /** Compile scope where the table's columns read registers `regs[i]` and the rowid `rowidReg`. */
  private rowScope(table: TableSchema, alias: string | undefined, base: number, rowidReg: number, planner: Planner): CompileScope {
    return this.rowsScope([{ table, names: [alias ?? table.name, table.name], base, rowidReg }], planner);
  }

  /**
   * Scope over one or more single-row sources held in registers (the target row of a write,
   * `excluded` in upserts). Unqualified names resolve to the first source that has the column.
   */
  private rowsScope(sources: { table: TableSchema; names: string[]; base: number; rowidReg: number }[], planner: Planner): CompileScope {
    const outer = planner.compileScope(planner.newScope());
    const bind = (src: (typeof sources)[number], name: string): ReturnType<CompileScope['resolveColumn']> | null => {
      const i = findColumn(src.table, name);
      if (i >= 0) {
        const c = src.table.columns[i];
        const type: StaticType = c.rowidAlias ? 'int' : c.type === 'INTEGER' ? 'int' : c.type === 'REAL' ? 'real' : c.type === 'TEXT' ? 'text' : c.type === 'BLOB' ? 'blob' : 'any';
        const aff = c.type === 'ANY' || c.type === 'BLOB' ? 'BLOB' : c.type;
        return { reg: src.base + i, type, collation: c.collation, affinity: aff as 'INTEGER' };
      }
      if (['rowid', 'oid', '_rowid_'].includes(name.toLowerCase())) return { reg: src.rowidReg, type: 'int', collation: 0, affinity: 'INTEGER' };
      return null;
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

  /** RETURNING list: result names/types and one function per output column. */
  private compileReturning(list: ResultColumn[], table: TableSchema, alias: string | undefined, scope: CompileScope, sqlText: string): { columns: string[]; types: StaticType[]; fns: Fn[] } {
    const columns: string[] = [];
    const types: StaticType[] = [];
    const fns: Fn[] = [];
    const q = alias ?? table.name;
    for (const rc of list) {
      if (rc.kind === 'star' || rc.kind === 'tableStar') {
        if (rc.kind === 'tableStar' && rc.table.toLowerCase() !== q.toLowerCase() && rc.table.toLowerCase() !== table.name.toLowerCase()) {
          throw new SmaltError('SMALT_ERROR', `no such table: ${rc.table}`);
        }
        for (const c of table.columns) {
          const b = scope.resolveColumn({ kind: 'column', table: q, name: c.name, pos: 0, end: 0 });
          columns.push(c.name);
          types.push(b.type);
          fns.push((r) => r[b.reg]);
        }
        continue;
      }
      const agg = aggregateCallName(rc.expr);
      if (agg) throw new SmaltError('SMALT_ERROR', `misuse of aggregate function ${agg}()`);
      const c = compileExpr(rc.expr, scope);
      columns.push(rc.alias ?? (rc.expr.kind === 'column' ? rc.expr.name : sqlText.slice(rc.expr.pos, rc.expr.end)));
      types.push(c.type);
      fns.push(c.fn);
    }
    return { columns, types, fns };
  }

  private validateRow(
    table: TableSchema,
    row: SqlValue[],
    real: boolean[],
    checks: { fn: Fn; name: string }[],
    regs: SqlValue[],
    base: number,
    mode: ConflictMode,
    defaults: (Fn | null)[],
  ): boolean {
    for (let i = 0; i < table.columns.length; i++) {
      const col = table.columns[i];
      if (col.rowidAlias) continue;
      let v = coerceForColumn(row[i], col, table.name, real[i]);
      if (v === null && col.notNull) {
        if (mode === 'IGNORE') return false;
        if (mode === 'REPLACE' && defaults[i]) v = coerceForColumn(defaults[i]!(regs), col, table.name);
        if (v === null) throw new ConstraintError('SMALT_CONSTRAINT_NOTNULL', `NOT NULL constraint failed: ${table.name}.${col.name}`);
      }
      row[i] = v;
    }
    if (checks.length) {
      for (let i = 0; i < row.length; i++) regs[base + i] = row[i];
      for (const c of checks) {
        const v = c.fn(regs);
        if (v !== null && truthy(v) === false) {
          if (mode === 'IGNORE') return false;
          throw new ConstraintError('SMALT_CONSTRAINT_CHECK', `CHECK constraint failed: ${c.name}`);
        }
      }
    }
    return true;
  }

  private compileChecks(table: TableSchema, scope: CompileScope, sql: string): { fn: Fn; name: string }[] {
    // Unnamed checks are reported by their text, which lives in the table's SQL (not the statement's).
    void sql;
    return table.checks.map((c) => ({ fn: compileExpr(c.expr, scope).fn, name: c.name ?? table.sql.slice(c.expr.pos, c.expr.end) }));
  }

  /** Normalize a rowid value (INTEGER PRIMARY KEY must hold an integer). */
  private toRowid(v: SqlValue, table: TableSchema): number | bigint {
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'bigint') return v;
    if (typeof v === 'string') {
      const n = coerceForColumn(v, { ...table.columns[table.rowidAlias], type: 'INTEGER' }, table.name);
      if (typeof n === 'number' || typeof n === 'bigint') return n;
    }
    throw new SmaltError('SMALT_MISMATCH', 'datatype mismatch');
  }

  private compileInsert(stmt: InsertStmt, planner: Planner): { exec: (r: SqlValue[], out?: SqlValue[][]) => RunResult; returning?: { columns: string[]; types: StaticType[] } } {
    // WITH ... INSERT: the CTEs belong to the row source.
    if (stmt.with) {
      if (stmt.source.kind !== 'select') throw new SmaltError('SMALT_UNSUPPORTED', 'WITH ... INSERT ... VALUES is not supported yet');
      const sel = stmt.source.select;
      const merged = sel.with ? { ...sel.with, recursive: sel.with.recursive || stmt.with.recursive, ctes: [...stmt.with.ctes, ...sel.with.ctes] } : stmt.with;
      stmt = { ...stmt, with: undefined, source: { kind: 'select', select: { ...sel, with: merged } } };
    }
    const table = this.targetTable(stmt.table, stmt.schema);
    const ncols = table.columns.length;
    const targets: number[] = stmt.columns
      ? stmt.columns.map((name) => {
          const i = findColumn(table, name);
          if (i < 0) {
            if (['rowid', 'oid', '_rowid_'].includes(name.toLowerCase()) && table.rowidAlias < 0) return -2;
            throw new SmaltError('SMALT_ERROR', `table ${table.name} has no column named ${name}`);
          }
          return i;
        })
      : table.columns.map((_, i) => i);
    const mode: ConflictMode = stmt.or ?? 'ABORT';
    const emptyScope = planner.compileScope(planner.newScope());
    const defaults: (Fn | null)[] = table.columns.map((c) => (c.defaultExpr ? compileExpr(c.defaultExpr, emptyScope).fn : null));
    const defaultReal = table.columns.map((c) => (c.defaultExpr ? compileExpr(c.defaultExpr, emptyScope).type === 'real' : false));
    const base = planner.regs.alloc(ncols);
    const rowidReg = planner.regs.alloc();
    const rowScope = this.rowScope(table, stmt.alias, base, rowidReg, planner);
    const checks = this.compileChecks(table, rowScope, planner.sqlText);
    const ret = stmt.returning ? this.compileReturning(stmt.returning, table, stmt.alias, rowScope, planner.sqlText) : undefined;
    const upserts = this.compileUpserts(stmt, table, base, rowidReg, planner);

    // Row source: each produces values for `targets`.
    let rowsFn: (r: SqlValue[], emit: (vals: SqlValue[], real: boolean[]) => void) => void;
    if (stmt.source.kind === 'default') {
      rowsFn = (_r, emit) => emit([], []);
    } else if (stmt.source.kind === 'values') {
      const rows = stmt.source.rows.map((row) => {
        if (row.length !== targets.length) throw new SmaltError('SMALT_ERROR', `table ${table.name} has ${ncols} columns but ${row.length} values were supplied`);
        return row.map((e) => compileExpr(e, emptyScope));
      });
      rowsFn = (r, emit) => {
        for (const row of rows) emit(row.map((c) => c.fn(r)), row.map((c) => c.type === 'real'));
      };
    } else {
      const plan = planner.planSelect(stmt.source.select, null);
      if (plan.outRegs.length !== targets.length) {
        throw new SmaltError('SMALT_ERROR', `table ${table.name} has ${ncols} columns but ${plan.outRegs.length} values were supplied`);
      }
      const reals = plan.columns.map((c) => c.type === 'real');
      const selfRef = JSON.stringify(stmt.source.select, (k, v) => (k === 'pos' || k === 'end' ? undefined : typeof v === 'bigint' ? v.toString() : v instanceof Uint8Array ? [...v] : v)).toLowerCase().includes(`"name":"${table.name.toLowerCase()}"`);
      rowsFn = (r, emit) => {
        const root = plan.root;
        if (selfRef) {
          // Read everything first: the SELECT reads the table being written.
          const buf: SqlValue[][] = [];
          root.open(r);
          while (root.next()) buf.push(plan.outRegs.map((g) => r[g]));
          root.close();
          for (const v of buf) emit(v, reals);
        } else {
          root.open(r);
          try {
            while (root.next()) emit(plan.outRegs.map((g) => r[g]), reals);
          } finally {
            root.close();
          }
        }
      };
    }

    let writer: TableWriter | null = null;
    const emitReturning = (r: SqlValue[], out: SqlValue[][] | undefined, row: SqlValue[], rowid: number | bigint): void => {
      if (!ret || !out) return;
      for (let i = 0; i < ncols; i++) r[base + i] = row[i];
      r[rowidReg] = rowid;
      out.push(ret.fns.map((f) => f(r)));
    };
    const exec = (r: SqlValue[], out?: SqlValue[][]): RunResult => {
      writer ??= this.writerFor(table);
      writer.resetStatement();
      const w = writer;
      let changes = 0;
      let last = this.lastRowid;
      rowsFn(r, (vals, reals) => {
        const row: SqlValue[] = new Array(ncols).fill(null);
        const real: boolean[] = new Array(ncols).fill(false);
        const given = new Array(ncols).fill(false);
        let explicitRowid: SqlValue = null;
        for (let i = 0; i < targets.length; i++) {
          const t = targets[i];
          if (t === -2) {
            explicitRowid = vals[i];
            continue;
          }
          row[t] = vals[i];
          real[t] = reals[i];
          given[t] = true;
        }
        for (let i = 0; i < ncols; i++) {
          if (!given[i] && defaults[i]) {
            row[i] = defaults[i]!(r);
            real[i] = defaultReal[i];
          }
        }
        let rowid: number | bigint;
        if (table.rowidAlias >= 0 && row[table.rowidAlias] !== null) rowid = this.toRowid(row[table.rowidAlias], table);
        else if (explicitRowid !== null) rowid = this.toRowid(explicitRowid, table);
        else rowid = w.newRowid();
        if (table.rowidAlias >= 0) row[table.rowidAlias] = rowid;
        r[rowidReg] = rowid;
        if (!this.validateRow(table, row, real, checks, r, base, mode, defaults)) return;
        if (upserts.length) {
          const done = this.applyUpsert(upserts, w, table, row, rowid, r, base, rowidReg, checks, defaults);
          if (done !== undefined) {
            if (done) {
              changes++;
              emitReturning(r, out, done.row, done.rowid);
            }
            return;
          }
        }
        if (!w.resolveConflicts(row, rowid, null, mode)) return;
        w.writeRow(row, rowid);
        if (this.fk.involved(table)) this.fk.afterInsert(table, row);
        changes++;
        last = rowid;
        emitReturning(r, out, row, rowid);
      });
      this.lastRowid = last;
      this.lastChanges = changes;
      this.total += changes;
      return { changes, lastInsertRowid: last };
    };
    return { exec, returning: ret && { columns: ret.columns, types: ret.types } };
  }

  /** Compiled ON CONFLICT clauses: which constraint each targets and what it does. */
  private compileUpserts(stmt: InsertStmt, table: TableSchema, base: number, rowidReg: number, planner: Planner): Upsert[] {
    if (!stmt.upsert.length) return [];
    const out: Upsert[] = [];
    stmt.upsert.forEach((u, n) => {
      let target: number | null = null;
      if (u.target) {
        if (u.target.where) throw new SmaltError('SMALT_UNSUPPORTED', 'ON CONFLICT targets with WHERE (partial indexes) are not supported yet');
        const cols = u.target.columns.map((ic) => {
          if (ic.expr.kind !== 'column' && !(ic.expr.kind === 'collate' && ic.expr.expr.kind === 'column')) throw new SmaltError('SMALT_ERROR', 'ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint');
          const name = ic.expr.kind === 'column' ? ic.expr.name : (ic.expr.expr as ColumnExpr).name;
          const i = findColumn(table, name);
          if (i < 0) throw new SmaltError('SMALT_ERROR', `no such column: ${name}`);
          return i;
        });
        const set = new Set(cols);
        if (cols.length === 1 && cols[0] === table.rowidAlias) target = -1;
        else {
          const i = table.indexes.findIndex((idx) => idx.unique && idx.columns.length === set.size && idx.columns.every((c) => set.has(c.column)));
          if (i < 0) throw new SmaltError('SMALT_ERROR', 'ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint');
          target = i;
        }
      } else if (n !== stmt.upsert.length - 1) {
        throw new SmaltError('SMALT_ERROR', 'a target-less ON CONFLICT clause must be the last one');
      }
      if (u.action.kind === 'nothing') {
        out.push({ target, update: null });
        return;
      }
      if (!u.target) throw new SmaltError('SMALT_ERROR', 'ON CONFLICT DO UPDATE requires a conflict target');
      // DO UPDATE sees the existing row (table name/alias, unqualified) and `excluded.*` (the proposed row).
      const ncols = table.columns.length;
      const oldBase = planner.regs.alloc(ncols);
      const oldRowid = planner.regs.alloc();
      const scope = this.rowsScope(
        [
          { table, names: [stmt.alias ?? table.name, table.name], base: oldBase, rowidReg: oldRowid },
          { table, names: ['excluded'], base, rowidReg },
        ],
        planner,
      );
      const sets: { col: number; c: Compiled }[] = [];
      for (const sc of u.action.set) {
        if (sc.columns.length !== 1) throw new SmaltError('SMALT_UNSUPPORTED', 'row-value assignments are not supported yet');
        const col = findColumn(table, sc.columns[0]);
        if (col < 0) throw new SmaltError('SMALT_ERROR', `no such column: ${sc.columns[0]}`);
        sets.push({ col, c: compileExpr(sc.value, scope) });
      }
      const where = u.action.where ? compileExpr(u.action.where, scope).fn : null;
      out.push({ target, update: { sets, where, oldBase, oldRowid } });
    });
    return out;
  }

  /**
   * Apply the first ON CONFLICT clause whose constraint the proposed row violates. Returns
   * undefined when no clause applies (insert normally), null when the row was skipped (DO NOTHING
   * or a false DO UPDATE ... WHERE), or the updated row.
   */
  private applyUpsert(
    upserts: Upsert[],
    w: TableWriter,
    table: TableSchema,
    row: SqlValue[],
    rowid: number | bigint,
    r: SqlValue[],
    base: number,
    rowidReg: number,
    checks: { fn: Fn; name: string }[],
    defaults: (Fn | null)[],
  ): { row: SqlValue[]; rowid: number | bigint } | null | undefined {
    for (const u of upserts) {
      let other: number | bigint | null;
      if (u.target === null) other = w.firstConflict(row, rowid, null)?.rowid ?? null;
      else other = w.conflictOn(u.target, row, rowid, null);
      if (other === null) continue;
      if (!u.update) return null;
      const ncols = table.columns.length;
      const old = w.readRow(other)!;
      const { sets, where, oldBase, oldRowid } = u.update;
      for (let i = 0; i < ncols; i++) {
        r[oldBase + i] = old[i];
        r[base + i] = row[i];
      }
      r[oldRowid] = other;
      r[rowidReg] = rowid;
      if (where && !truthy(where(r))) return null;
      const next = old.slice();
      const real: boolean[] = new Array(ncols).fill(false);
      for (const sc of sets) {
        next[sc.col] = sc.c.fn(r);
        real[sc.col] = sc.c.type === 'real';
      }
      let newRowid: number | bigint = other;
      if (table.rowidAlias >= 0) {
        if (next[table.rowidAlias] === null) throw new SmaltError('SMALT_MISMATCH', 'datatype mismatch');
        newRowid = this.toRowid(next[table.rowidAlias], table);
        next[table.rowidAlias] = newRowid;
      }
      r[rowidReg] = newRowid;
      this.validateRow(table, next, real, checks, r, base, 'ABORT', defaults);
      w.resolveConflicts(next, newRowid, other, 'ABORT');
      w.deleteRow(other, old, true);
      w.writeRow(next, newRowid);
      if (this.fk.involved(table)) this.fk.afterUpdate(table, old, next);
      return { row: next, rowid: newRowid };
    }
    return undefined;
  }

  /** Plan a scan of `table` filtered by `where`, decoding every column and the rowid. */
  private planTarget(
    table: TableSchema,
    alias: string | undefined,
    where: Expr | undefined,
    planner: Planner,
    from?: FromItem,
    w?: WithClause,
  ): { root: Operator; colRegs: number[]; rowidReg: number; scope: CompileScope } {
    const scope = planner.newScope(w ? planner.cteScope(w) : null);
    const target: FromItem = { kind: 'table', schema: 'main', name: table.name, alias, pos: 0, end: 0 };
    // UPDATE ... FROM: the target joined with the FROM sources (the WHERE holds the join conditions).
    const item: FromItem = from ? { kind: 'join', joinType: 'INNER', natural: false, left: target, right: from, pos: 0, end: 0 } : target;
    const root = planner.planFrom(item, where, scope);
    const cs = planner.compileScope(scope);
    const q = alias ?? table.name;
    const colRegs = table.columns.map((c) => {
      const b = cs.resolveColumn({ kind: 'column', table: q, name: c.name, pos: 0, end: 0 });
      return b.reg;
    });
    const rowidReg = cs.resolveColumn({ kind: 'column', table: q, name: 'rowid', pos: 0, end: 0 }).reg;
    return { root, colRegs, rowidReg, scope: cs };
  }

  private compileUpdate(stmt: UpdateStmt, planner: Planner): { exec: (r: SqlValue[], out?: SqlValue[][]) => RunResult; returning?: { columns: string[]; types: StaticType[] } } {
    if (stmt.orderBy.length || stmt.limit) throw new SmaltError('SMALT_UNSUPPORTED', 'UPDATE ... ORDER BY/LIMIT is not supported');
    const table = this.targetTable(stmt.table, stmt.schema);
    const { root, colRegs, rowidReg, scope } = this.planTarget(table, stmt.alias, stmt.where, planner, stmt.from, stmt.with);
    const sets: { col: number; c: Compiled }[] = [];
    for (const s of stmt.set) {
      if (s.columns.length !== 1) throw new SmaltError('SMALT_UNSUPPORTED', 'row-value assignments are not supported yet');
      const name = s.columns[0];
      let col = findColumn(table, name);
      if (col < 0) {
        if (['rowid', 'oid', '_rowid_'].includes(name.toLowerCase())) col = -2;
        else throw new SmaltError('SMALT_ERROR', `no such column: ${name}`);
      }
      sets.push({ col, c: compileExpr(s.value, scope) });
    }
    const mode: ConflictMode = stmt.or ?? 'ABORT';
    const ncols = table.columns.length;
    const emptyScope = planner.compileScope(planner.newScope());
    const defaults: (Fn | null)[] = table.columns.map((c) => (c.defaultExpr ? compileExpr(c.defaultExpr, emptyScope).fn : null));
    const base = planner.regs.alloc(ncols);
    const checkRowid = planner.regs.alloc();
    const newRowScope = this.rowScope(table, stmt.alias, base, checkRowid, planner);
    const checks = this.compileChecks(table, newRowScope, planner.sqlText);
    const ret = stmt.returning ? this.compileReturning(stmt.returning, table, stmt.alias, newRowScope, planner.sqlText) : undefined;
    const withFrom = stmt.from !== undefined;

    const exec = (r: SqlValue[], out?: SqlValue[][]): RunResult => {
      // Two passes, like SQLite: collect target rowids first (Halloween-safe), then update them in
      // ascending rowid order, computing new values from each row's *current* contents. With FROM,
      // values are computed during the join (from the first matching FROM row, as SQLite does).
      const rowids: (number | bigint)[] = [];
      const fromValues = new Map<number | bigint, SqlValue[]>();
      root.open(r);
      try {
        while (root.next()) {
          const id = r[rowidReg] as number | bigint;
          if (withFrom) {
            if (fromValues.has(id)) continue;
            fromValues.set(id, sets.map((s) => s.c.fn(r)));
          }
          rowids.push(id);
        }
      } finally {
        root.close();
      }
      rowids.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const writer = this.writerFor(table);
      let changes = 0;
      for (const rowid of rowids) {
        const old = writer.readRow(rowid);
        if (old === null) continue; // removed by an earlier REPLACE in this statement
        for (let i = 0; i < ncols; i++) r[colRegs[i]] = old[i];
        r[rowidReg] = rowid;
        const next = old.slice();
        const real: boolean[] = new Array(ncols).fill(false);
        let newRowidV: SqlValue = rowid;
        const pre = withFrom ? fromValues.get(rowid)! : null;
        sets.forEach((s, k) => {
          const v = pre ? pre[k] : s.c.fn(r);
          if (s.col === -2) newRowidV = v;
          else {
            next[s.col] = v;
            real[s.col] = s.c.type === 'real';
            if (s.col === table.rowidAlias) newRowidV = v;
          }
        });
        // Like SQLite: an UPDATE cannot set the rowid (or INTEGER PRIMARY KEY) to NULL.
        if (newRowidV === null) throw new SmaltError('SMALT_MISMATCH', 'datatype mismatch');
        const newRowid = this.toRowid(newRowidV, table);
        if (table.rowidAlias >= 0) next[table.rowidAlias] = newRowid;
        r[checkRowid] = newRowid;
        if (!this.validateRow(table, next, real, checks, r, base, mode, defaults)) continue;
        if (!writer.resolveConflicts(next, newRowid, rowid, mode)) continue;
        writer.deleteRow(rowid, old, true);
        writer.writeRow(next, newRowid);
        if (this.fk.involved(table)) this.fk.afterUpdate(table, old, next);
        changes++;
        if (ret && out) {
          for (let i = 0; i < ncols; i++) r[base + i] = next[i];
          r[checkRowid] = newRowid;
          out.push(ret.fns.map((f) => f(r)));
        }
      }
      this.lastChanges = changes;
      this.total += changes;
      return { changes, lastInsertRowid: this.lastRowid };
    };
    return { exec, returning: ret && { columns: ret.columns, types: ret.types } };
  }

  private compileDelete(stmt: DeleteStmt, planner: Planner): { exec: (r: SqlValue[], out?: SqlValue[][]) => RunResult; returning?: { columns: string[]; types: StaticType[] } } {
    if (stmt.orderBy.length || stmt.limit) throw new SmaltError('SMALT_UNSUPPORTED', 'DELETE ... ORDER BY/LIMIT is not supported');
    const table = this.targetTable(stmt.table, stmt.schema);
    const { root, colRegs, rowidReg } = this.planTarget(table, stmt.alias, stmt.where, planner, undefined, stmt.with);
    // DELETE without WHERE truncates, unless foreign keys need to see every row.
    const truncate = !stmt.where && !stmt.returning;
    const ncols = table.columns.length;
    const oldBase = planner.regs.alloc(ncols);
    const oldRowid = planner.regs.alloc();
    const ret = stmt.returning ? this.compileReturning(stmt.returning, table, stmt.alias, this.rowScope(table, stmt.alias, oldBase, oldRowid, planner), planner.sqlText) : undefined;
    const exec = (r: SqlValue[], out?: SqlValue[][]): RunResult => {
      if (truncate && !this.fk.involved(table)) {
        const n = new TableWriter(table, this.pager, (root) => this.tree(root)).truncate();
        this.lastChanges = n;
        this.total += n;
        return { changes: n, lastInsertRowid: this.lastRowid };
      }
      const pending: { rowid: number | bigint; row: SqlValue[] }[] = [];
      root.open(r);
      try {
        while (root.next()) pending.push({ rowid: r[rowidReg] as number | bigint, row: colRegs.map((g) => r[g]) });
      } finally {
        root.close();
      }
      const writer = this.writerFor(table);
      let changes = 0;
      for (const p of pending) {
        if (!writer.deleteRow(p.rowid, p.row)) continue;
        changes++;
        if (ret && out) {
          for (let i = 0; i < ncols; i++) r[oldBase + i] = p.row[i];
          r[oldRowid] = p.rowid;
          out.push(ret.fns.map((f) => f(r)));
        }
      }
      this.lastChanges = changes;
      this.total += changes;
      return { changes, lastInsertRowid: this.lastRowid };
    };
    return { exec, returning: ret && { columns: ret.columns, types: ret.types } };
  }

  // ---------------------------------------------------------------- PRAGMA

  /**
   * Schema pragmas usable both as `PRAGMA name(arg)` and as table-valued functions
   * (`pragma_name(arg)`): column names and a row producer.
   */
  pragmaTable(name: string, arg: () => string | undefined): { columns: string[]; rows: () => SqlValue[][] } | undefined {
    const tableArg = (): TableSchema => {
      const n = arg();
      const t = n ? this.getTable(n) : undefined;
      if (!t) throw new SmaltError('SMALT_ERROR', `no such table: ${n}`);
      return t;
    };
    const ro = (columns: string[], rows: () => SqlValue[][]): { columns: string[]; rows: () => SqlValue[][] } => ({ columns, rows });
    switch (name) {
      case 'table_info':
      case 'table_xinfo':
        return ro(['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk'], () => {
          const t = tableArg();
          let pkn = 0;
          const pkOrder = new Map<number, number>();
          const pkIdx = t.indexes.find((i) => i.origin === 'pk');
          if (t.rowidAlias >= 0) pkOrder.set(t.rowidAlias, 1);
          else pkIdx?.columns.forEach((c) => pkOrder.set(c.column, ++pkn));
          return t.columns.map((c, i) => [
            i,
            c.name,
            c.declaredType,
            c.declaredNotNull ? 1 : 0,
            c.defaultExpr ? t.sql.slice(c.defaultExpr.pos, c.defaultExpr.end) : null,
            pkOrder.get(i) ?? 0,
          ]);
        });
      case 'index_list':
        return ro(['seq', 'name', 'unique', 'origin', 'partial'], () => {
          const t = tableArg();
          return t.indexes.map((idx, i) => [i, idx.name, idx.unique ? 1 : 0, idx.origin, idx.where ? 1 : 0]);
        });
      case 'index_info':
        return ro(['seqno', 'cid', 'name'], () => {
          const name = arg() ?? '';
          const idx = this.indexes.get(name.toLowerCase());
          if (!idx) return [];
          const t = this.tables.get(idx.table.toLowerCase())!;
          return idx.columns.map((c, i) => (c.column < 0 ? [i, -2, null] : [i, c.column, t.columns[c.column].name]));
        });
      case 'index_xinfo':
        return ro(['seqno', 'cid', 'name', 'desc', 'coll', 'key'], () => {
          const idx = this.indexes.get((arg() ?? '').toLowerCase());
          if (!idx) return [];
          const t = this.tables.get(idx.table.toLowerCase())!;
          const keys = idx.columns.map((c, i) => [i, c.column < 0 ? -2 : c.column, c.column < 0 ? null : t.columns[c.column].name, c.desc ? 1 : 0, ['BINARY', 'NOCASE', 'RTRIM'][c.collation], 1]);
          return [...keys, [idx.columns.length, -1, null, 0, 'BINARY', 0]];
        });
      case 'foreign_key_list':
        return ro(['id', 'seq', 'table', 'from', 'to', 'on_update', 'on_delete', 'match'], () => {
          const t = tableArg();
          // SQLite lists the last-declared foreign key first.
          return t.foreignKeys
            .map((fk, id) => ({ fk, id: t.foreignKeys.length - 1 - id }))
            .reverse()
            .flatMap(({ fk, id }) => fk.columns.map((c, seq) => [id, seq, fk.table, t.columns[c].name, fk.refColumns?.[seq] ?? null, fk.onUpdate, fk.onDelete, 'NONE']));
        });
      default:
        return undefined;
    }
  }

  private compilePragma(stmt: PragmaStmt, planner: Planner): Omit<Program, 'regCount'> {
    const arg = (): string | undefined => {
      if (!stmt.value) return undefined;
      const v = compileExpr(stmt.value, planner.compileScope(planner.newScope())).fn([]);
      return v === null ? undefined : String(v);
    };
    const tableArg = (): TableSchema => {
      const name = arg();
      const t = name ? this.getTable(name) : undefined;
      if (!t) throw new SmaltError('SMALT_ERROR', `no such table: ${name}`);
      return t;
    };
    const ro = (columns: string[], rows: () => SqlValue[][]): Omit<Program, 'regCount'> => ({
      readonly: true,
      columns,
      columnTypes: columns.map(() => 'any' as StaticType),
      rows,
    });
    switch (stmt.name) {
      case 'table_info':
      case 'table_xinfo':
      case 'index_list':
      case 'index_info':
      case 'index_xinfo':
      case 'foreign_key_list': {
        const name = stmt.name;
        const p = this.pragmaTable(name, () => arg());
        return ro(p!.columns, p!.rows);
      }
      case 'foreign_keys': {
        if (stmt.value) {
          const v = arg()?.toLowerCase();
          const on = v === '1' || v === 'on' || v === 'true' || v === 'yes';
          return {
            readonly: true,
            columns: [],
            columnTypes: [],
            exec: () => {
              // Like SQLite, the setting cannot change inside a transaction.
              if (this.autocommit && on !== this.fk.enabled) {
                this.fk.enabled = on;
                this.schemaVersion++; // re-plan statements compiled under the other setting
              }
              return { changes: 0, lastInsertRowid: this.lastRowid };
            },
          };
        }
        return ro(['foreign_keys'], () => [[this.fk.enabled ? 1 : 0]]);
      }
      case 'page_size':
        return ro(['page_size'], () => [[this.pager.pageSize]]);
      case 'page_count':
        return ro(['page_count'], () => [[this.pager.pageCount]]);
      case 'freelist_count':
        return ro(['freelist_count'], () => [[this.pager.freelistCount]]);
      case 'schema_version':
        return ro(['schema_version'], () => [[this.pager.schemaCookie]]);
      case 'integrity_check':
        return ro(['integrity_check'], () => {
          const errors: string[] = [];
          const check = (root: number, what: string): number => {
            try {
              return new BTree(this.pager, root).checkIntegrity().pages;
            } catch (e) {
              errors.push(`${what}: ${(e as Error).message}`);
              return 0;
            }
          };
          let pages = 1 + check(this.pager.catalogRoot, 'smalt_schema');
          for (const t of this.tables.values()) {
            pages += check(t.rootPage, `table ${t.name}`);
            const n = new BTree(this.pager, t.rootPage).count();
            for (const i of t.indexes) {
              pages += check(i.rootPage, `index ${i.name}`);
              const m = new BTree(this.pager, i.rootPage).count();
              if (m !== n && !i.where) errors.push(`index ${i.name} has ${m} entries, table ${t.name} has ${n} rows`);
            }
          }
          if (pages + this.pager.freelistCount !== this.pager.pageCount) {
            errors.push(`page accounting: ${pages} in use + ${this.pager.freelistCount} free != ${this.pager.pageCount} total`);
          }
          return errors.length ? errors.map((e) => [e]) : [['ok']];
        });
      case 'journal_mode':
        return ro(['journal_mode'], () => [[this.pager.walStats ? 'wal' : 'off']]);
      case 'wal_checkpoint':
        return {
          readonly: true,
          columns: ['busy', 'log', 'checkpointed'],
          columnTypes: ['int', 'int', 'int'],
          rows: () => {
            if (!this.autocommit) return [[1, -1, -1]];
            const frames = Math.round(this.pager.walSize / (this.pager.pageSize + 24));
            this.pager.checkpoint();
            return [[0, frames, frames]];
          },
        };
      case 'foreign_keys':
        return ro(['foreign_keys'], () => [[0]]);
      default:
        throw new SmaltError('SMALT_UNSUPPORTED', `PRAGMA ${stmt.name} is not supported yet`);
    }
  }
}

function prefixHasNull(prefix: Uint8Array): boolean {
  try {
    return decodeKey(prefix).some((v) => v === null);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ statements & cursors

/** A prepared statement. Recompiles automatically after schema changes. */
export class Statement {
  private program: Program | null = null;
  private version = -1;

  constructor(
    readonly db: Database,
    readonly parsed: ParsedStatement,
    readonly sql: string,
  ) {}

  private checkedAt = -1;

  private prog(): Program {
    if (this.program === null || this.version !== this.db.schemaVersion || this.statsDrifted(this.program)) {
      this.program = this.db.compile(this.parsed);
      this.version = this.db.schemaVersion;
      this.checkedAt = this.db.pager.changeCounter;
    }
    return this.program;
  }

  /**
   * After data changes (checked at most once per commit), re-plan if any table the plan costed has
   * grown or shrunk 4x or more: a plan made for an empty table should not survive it filling up.
   */
  private statsDrifted(p: Program): boolean {
    const cc = this.db.pager.changeCounter;
    if (cc === this.checkedAt || !p.rowAssumptions || p.rowAssumptions.size === 0) return false;
    this.checkedAt = cc;
    for (const [root, assumed] of p.rowAssumptions) {
      const now = this.db.tree(root).estimateCount();
      if (Math.max(now, 64) >= Math.max(assumed, 64) * 4 || Math.max(assumed, 64) >= Math.max(now, 64) * 4) return true;
    }
    return false;
  }

  get columns(): string[] {
    return this.prog().columns;
  }

  get readonly(): boolean {
    return this.prog().readonly;
  }

  get paramCount(): number {
    return this.parsed.paramCount;
  }

  private registers(params: BindParams | undefined): SqlValue[] {
    const p = this.prog();
    const regs: SqlValue[] = new Array(p.regCount).fill(null);
    const n = this.parsed.paramCount;
    if (params === undefined) {
      if (n > 0) throw new SmaltError('SMALT_RANGE', `statement expects ${n} parameter(s)`);
      return regs;
    }
    if (Array.isArray(params)) {
      if (params.length !== n) throw new SmaltError('SMALT_RANGE', `statement expects ${n} parameter(s), got ${params.length}`);
      for (let i = 0; i < n; i++) regs[i] = normalizeParam(params[i]);
    } else {
      const named = params as Record<string, SqlValue>;
      for (const [name, slot] of this.parsed.paramNames) {
        const bare = name.slice(1);
        const v = Object.prototype.hasOwnProperty.call(named, name) ? named[name] : named[bare];
        if (v === undefined) throw new SmaltError('SMALT_RANGE', `missing value for parameter ${name}`);
        regs[slot - 1] = normalizeParam(v);
      }
    }
    return regs;
  }

  /** Execute for side effects. */
  run(params?: BindParams): RunResult {
    const p = this.prog();
    const regs = this.registers(params);
    if (p.exec) return this.db.execute(p, () => p.exec!(regs));
    // A query run for side effects: drain it.
    this.db.execute(p, () => {
      if (p.rows) return p.rows(regs);
      const root = p.plan!.root;
      root.open(regs);
      try {
        while (root.next());
      } finally {
        root.close();
      }
      return null;
    });
    return { changes: 0, lastInsertRowid: this.db.lastInsertRowid() };
  }

  /** Execute and return every row as an array of values. */
  all(params?: BindParams): SqlValue[][] {
    const c = this.cursor(params);
    try {
      const out: SqlValue[][] = [];
      for (let row = c.next(); row !== null; row = c.next()) out.push(row);
      return out;
    } finally {
      c.close();
    }
  }

  /** Execute and return a cursor over the result rows. */
  cursor(params?: BindParams): RowCursor {
    const p = this.prog();
    const regs = this.registers(params);
    if (p.exec) {
      this.db.execute(p, () => p.exec!(regs));
      return new RowCursor(this.db, null, [], regs, p.columns);
    }
    if (p.rows) return new RowCursor(this.db, null, this.db.execute(p, () => p.rows!(regs)), regs, p.columns);
    this.db.execute(p, () => undefined); // bump epoch
    return new RowCursor(this.db, p.plan!, null, regs, p.columns);
  }
}

function normalizeParam(v: SqlValue | boolean | undefined): SqlValue {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) {
    if (ArrayBuffer.isView(v)) return new Uint8Array((v as ArrayBufferView).buffer, (v as ArrayBufferView).byteOffset, (v as ArrayBufferView).byteLength);
    throw new SmaltError('SMALT_MISMATCH', 'unsupported parameter type');
  }
  return v as SqlValue;
}

/** Iterates result rows. Holds b-tree pins until exhausted or closed. */
export class RowCursor {
  private open = false;
  private done = false;
  private i = 0;

  constructor(
    readonly db: Database,
    readonly plan: QueryPlan | null,
    readonly fixedRows: SqlValue[][] | null,
    readonly regs: SqlValue[],
    readonly columns: string[],
  ) {
    if (plan) {
      plan.root.open(regs);
      this.open = true;
      db.activeCursors.add(this);
    }
  }

  /** Next row as a fresh array, or null at the end. */
  next(): SqlValue[] | null {
    if (this.done) return null;
    if (this.fixedRows) {
      if (this.i < this.fixedRows.length) return this.fixedRows[this.i++];
      this.done = true;
      return null;
    }
    if (!this.plan) {
      this.done = true;
      return null;
    }
    let ok: boolean;
    try {
      ok = this.plan.root.next();
    } catch (e) {
      this.close();
      throw e;
    }
    if (!ok) {
      this.close();
      return null;
    }
    const out = this.plan.outRegs;
    const r = this.regs;
    const row = new Array(out.length);
    for (let j = 0; j < out.length; j++) row[j] = r[out[j]];
    return row;
  }

  /**
   * Fill column arrays with up to `max` rows (columnar output for the worker wire format).
   * Returns the number of rows written (0 at the end).
   */
  nextBatch(max: number, cols: SqlValue[][]): number {
    let n = 0;
    if (this.fixedRows || !this.plan) {
      for (let row = n < max ? this.next() : null; row !== null; row = n < max ? this.next() : null) {
        for (let j = 0; j < row.length; j++) cols[j].push(row[j]);
        if (++n >= max) break;
      }
      return n;
    }
    if (this.done) return 0;
    const out = this.plan.outRegs;
    const r = this.regs;
    const root = this.plan.root;
    try {
      while (n < max) {
        if (!root.next()) {
          this.close();
          break;
        }
        for (let j = 0; j < out.length; j++) cols[j].push(r[out[j]]);
        n++;
      }
    } catch (e) {
      this.close();
      throw e;
    }
    return n;
  }

  close(): void {
    this.done = true;
    if (this.open) {
      this.open = false;
      this.plan!.root.close();
      this.db.activeCursors.delete(this);
    }
  }
}

/** Name of an aggregate function called by `e` (outside nested SELECTs), if any. */
function aggregateCallName(e: Expr): string | undefined {
  let hit: string | undefined;
  const go = (x: unknown): void => {
    if (hit || x === null || typeof x !== 'object') return;
    if (Array.isArray(x)) return x.forEach(go);
    if (Object.getPrototypeOf(x) !== Object.prototype) return;
    const o = x as Record<string, unknown>;
    if (o.kind === 'select' && 'core' in o) return;
    if (o.kind === 'call' && aggregateFunctions.has(String(o.name)) && o.over === undefined && !((o.name === 'min' || o.name === 'max') && (o.args as unknown[]).length > 1)) {
      hit = String(o.name);
      return;
    }
    for (const k of Object.keys(o)) go(o[k]);
  };
  go(e);
  return hit;
}

