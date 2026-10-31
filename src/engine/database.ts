import {
  ConstraintError,
  type IndexSchema,
  type TableSchema,
  autoIndexName,
  buildIndexSchema,
  buildTableSchema,
  coerceForColumn,
  findColumn,
} from './catalog/schema.js';
import { MisuseError, SmaltError } from './errors.js';
import { type StaticType, truthy } from './exec/convert.js';
import { type CompileScope, type Compiled, type Fn, compileExpr } from './exec/expr.js';
import type { FunctionContext } from './exec/functions.js';
import { type ExecState, type Operator, explainRows } from './exec/operators.js';
import { Planner, type QueryPlan, Registers } from './exec/planner.js';
import { type ConflictMode, TableWriter } from './exec/write.js';
import type {
  CreateIndexStmt,
  CreateTableStmt,
  DeleteStmt,
  DropStmt,
  Expr,
  InsertStmt,
  ParsedStatement,
  PragmaStmt,
  SelectStmt,
  Stmt,
  UpdateStmt,
} from './sql/ast.js';
import { parse, parseOne } from './sql/parser.js';
import { BTree } from './storage/btree.js';
import { KeyEncoder, decodeKey, readRowidKey } from './storage/key-codec.js';
import { Pager, type PagerOptions } from './storage/pager.js';
import { RecordReader } from './storage/record.js';
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
}

const CATALOG_SQL = 'CREATE TABLE smalt_schema(type TEXT, name TEXT, tbl_name TEXT, rootpage INTEGER, sql TEXT)';
const CATALOG_NAMES = new Set(['smalt_schema', 'sqlite_schema', 'sqlite_master']);

interface CatalogEntry {
  type: 'table' | 'index';
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
  private catalogTable!: TableSchema;
  /** Incremented on every schema change (prepared statements recompile). */
  schemaVersion = 0;
  private autocommit = true;
  private lastRowid: number | bigint = 0;
  private lastChanges = 0;
  private total = 0;
  private readonly state: ExecState = { epoch: 0 };
  private readonly cache = new Map<string, Statement>();
  private readonly cacheSize: number;
  /** Open read cursors (a write while one is open would invalidate it). */
  readonly activeCursors = new Set<RowCursor>();
  private closed = false;

  private constructor(file: VfsFile, options: DatabaseOptions) {
    this.pager = Pager.open(file, options);
    this.cacheSize = options.statementCacheSize ?? 64;
    if (this.pager.catalogRoot === 0) {
      this.pager.catalogRoot = BTree.create(this.pager);
      this.pager.commit();
    }
    this.loadSchema();
  }

  static async open(vfs: Vfs, path: string, options: DatabaseOptions = {}): Promise<Database> {
    return new Database(await vfs.open(path), options);
  }

  static openFile(file: VfsFile, options: DatabaseOptions = {}): Database {
    return new Database(file, options);
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

  tableNames(): string[] {
    return [...this.tables.values()].map((t) => t.name);
  }

  private loadSchema(): void {
    this.tables.clear();
    this.indexes.clear();
    this.catalog.clear();
    const catStmt = parseOne(CATALOG_SQL).stmt as CreateTableStmt;
    this.catalogTable = { ...buildTableSchema(catStmt, CATALOG_SQL, this.pager.catalogRoot).table, system: true };
    const rows = this.scanCatalog();
    const autoRoots = new Map<string, number>();
    for (const r of rows) if (r.type === 'index' && r.sql === null) autoRoots.set(r.name.toLowerCase(), r.rootpage);
    for (const r of rows) {
      this.catalog.set(r.name.toLowerCase(), { type: r.type as 'table' | 'index', name: r.name, rowid: r.rowid });
      if (r.type !== 'table') continue;
      const stmt = parseOne(r.sql!).stmt as CreateTableStmt;
      const { table, implicitIndexes } = buildTableSchema(stmt, r.sql!, r.rootpage);
      implicitIndexes.forEach((spec, i) => {
        const name = autoIndexName(table.name, i + 1);
        const root = autoRoots.get(name.toLowerCase());
        if (root === undefined) throw new SmaltError('SMALT_CORRUPT', `missing automatic index ${name}`);
        const idx: IndexSchema = { name, table: table.name, rootPage: root, columns: spec.columns, unique: true, origin: spec.origin };
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
      table.indexes.push(idx);
      this.indexes.set(idx.name.toLowerCase(), idx);
    }
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
    return new TableWriter(this.catalogTable, this.pager);
  }

  private addCatalogRow(type: string, name: string, tblName: string, root: number, sql: string | null): void {
    const w = this.catalogWriter();
    const rowid = w.newRowid();
    w.writeRow([type, name, tblName, root, sql], rowid);
    this.catalog.set(name.toLowerCase(), { type: type as 'table' | 'index', name, rowid });
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
      { getTable: (n) => this.getTable(n), openTree: (root) => new BTree(this.pager, root), funcCtx: this, state: this.state },
      regs,
    );
    planner.sqlText = ps.text;
    const done = (p: Omit<Program, 'regCount'>): Program => ({ ...p, regCount: regs.count });
    switch (stmt.kind) {
      case 'select': {
        const plan = planner.planSelect(stmt, null);
        return done({ plan, readonly: true, columns: plan.columns.map((c) => c.name), columnTypes: plan.columns.map((c) => c.type) });
      }
      case 'insert':
        return done({ exec: this.compileInsert(stmt, planner), readonly: false, columns: [], columnTypes: [] });
      case 'update':
        return done({ exec: this.compileUpdate(stmt, planner), readonly: false, columns: [], columnTypes: [] });
      case 'delete':
        return done({ exec: this.compileDelete(stmt, planner), readonly: false, columns: [], columnTypes: [] });
      case 'createTable':
        return done({ exec: () => this.createTable(stmt, ps.text), readonly: false, columns: [], columnTypes: [] });
      case 'createIndex':
        return done({ exec: () => this.createIndex(stmt, ps.text), readonly: false, columns: [], columnTypes: [] });
      case 'drop':
        return done({ exec: () => this.drop(stmt), readonly: false, columns: [], columnTypes: [] });
      case 'begin':
      case 'commit':
      case 'rollback':
        return done({ exec: () => this.transactionControl(stmt), readonly: true, columns: [], columnTypes: [] });
      case 'explain': {
        if (stmt.analyze) throw new SmaltError('SMALT_UNSUPPORTED', 'EXPLAIN ANALYZE is not supported yet');
        if (stmt.stmt.kind !== 'select') throw new SmaltError('SMALT_UNSUPPORTED', 'EXPLAIN is only supported for SELECT statements');
        const plan = planner.planSelect(stmt.stmt as SelectStmt, null);
        return done({
          readonly: true,
          rows: () => explainRows(plan.root).map((x) => [x.id, x.parent, 0, x.detail]),
          columns: ['id', 'parent', 'notused', 'detail'],
          columnTypes: ['int', 'int', 'int', 'text'],
        });
      }
      case 'pragma':
        return done(this.compilePragma(stmt, planner));
      default:
        throw new SmaltError('SMALT_UNSUPPORTED', `${stmt.kind} statements are not supported yet`);
    }
  }

  private transactionControl(stmt: Stmt): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    if (stmt.kind === 'begin') {
      if (!this.autocommit) throw new SmaltError('SMALT_ERROR', 'cannot start a transaction within a transaction');
      this.autocommit = false;
    } else if (stmt.kind === 'commit') {
      if (this.autocommit) throw new SmaltError('SMALT_ERROR', 'cannot commit - no transaction is active');
      this.pager.commit();
      this.autocommit = true;
    } else if (stmt.kind === 'rollback') {
      if (stmt.savepoint) throw new SmaltError('SMALT_UNSUPPORTED', 'savepoints are not supported yet');
      if (this.autocommit) throw new SmaltError('SMALT_ERROR', 'cannot rollback - no transaction is active');
      this.rollbackTransaction();
    }
    return none;
  }

  private rollbackTransaction(): void {
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
    if (program.readonly) return body();
    const pager = this.pager;
    pager.beginStatement();
    let result: T;
    try {
      result = body();
    } catch (e) {
      pager.rollbackStatement();
      if (this.autocommit) {
        pager.rollback();
      }
      this.loadSchemaIfChanged();
      throw e;
    }
    pager.commitStatement();
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

  // ---------------------------------------------------------------- DDL

  private checkNewName(name: string, kind: string): void {
    const lower = name.toLowerCase();
    if (lower.startsWith('smalt_') || lower.startsWith('sqlite_')) throw new SmaltError('SMALT_ERROR', `object name reserved for internal use: ${name}`);
    const existing = this.catalog.get(lower);
    if (existing) throw new SmaltError('SMALT_ERROR', `${existing.type === kind ? kind : existing.type} ${name} already exists`);
  }

  private createTable(stmt: CreateTableStmt, sql: string): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    if (stmt.temp) throw new SmaltError('SMALT_UNSUPPORTED', 'TEMP tables are not supported yet');
    if (stmt.ifNotExists && this.catalog.has(stmt.name.toLowerCase())) return none;
    this.checkNewName(stmt.name, 'table');
    this.dirtySchema = true;
    const root = BTree.create(this.pager);
    const { table, implicitIndexes } = buildTableSchema(stmt, sql, root);
    this.addCatalogRow('table', table.name, table.name, root, sql);
    implicitIndexes.forEach((spec, i) => {
      const name = autoIndexName(table.name, i + 1);
      const iroot = BTree.create(this.pager);
      const idx: IndexSchema = { name, table: table.name, rootPage: iroot, columns: spec.columns, unique: true, origin: spec.origin };
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
    if (!table) throw new SmaltError('SMALT_ERROR', `no such table: ${stmt.table}`);
    this.checkNewName(stmt.name, 'index');
    if (stmt.where) throw new SmaltError('SMALT_UNSUPPORTED', 'partial indexes are not supported yet');
    this.dirtySchema = true;
    const root = BTree.create(this.pager);
    const idx = buildIndexSchema(stmt, sql, table, root);
    // Populate from existing rows.
    const tree = new BTree(this.pager, table.rootPage);
    const itree = new BTree(this.pager, root);
    const reader = new RecordReader(table.layout, table.recordDefaults);
    const enc = new KeyEncoder();
    const entries: Uint8Array[] = [];
    const c = tree.cursor();
    try {
      for (let ok = c.first(); ok; ok = c.next()) {
        c.loadKey();
        const rowid = readRowidKey(c.keyBytes, c.keyOffset);
        c.loadValue();
        reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
        enc.reset();
        for (const ic of idx.columns) enc.add(ic.column === table.rowidAlias ? rowid : reader.column(ic.column), ic);
        enc.add(rowid);
        entries.push(enc.finish());
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

  private checkUniqueIndex(table: TableSchema, idx: IndexSchema): void {
    const itree = new BTree(this.pager, idx.rootPage);
    const c = itree.cursor();
    let prev: Uint8Array | null = null;
    try {
      for (let ok = c.first(); ok; ok = c.next()) {
        const k = c.key();
        const prefix = k.subarray(0, k.length - 11);
        if (prev && prefix.length === prev.length && prefix.every((b, i) => b === prev![i]) && !prefixHasNull(prefix)) {
          throw new ConstraintError('SMALT_CONSTRAINT_UNIQUE', `UNIQUE constraint failed: ${idx.columns.map((ic) => `${table.name}.${table.columns[ic.column].name}`).join(', ')}`);
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
    if (stmt.objectType === 'table') {
      const table = this.tables.get(lower);
      if (!table) {
        if (stmt.ifExists) return none;
        throw new SmaltError('SMALT_ERROR', `no such table: ${stmt.name}`);
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

  // ---------------------------------------------------------------- DML

  private targetTable(name: string, schema?: string): TableSchema {
    if (schema && schema.toLowerCase() !== 'main') throw new SmaltError('SMALT_ERROR', `unknown database ${schema}`);
    const lower = name.toLowerCase();
    if (CATALOG_NAMES.has(lower)) throw new SmaltError('SMALT_ERROR', `table ${name} may not be modified`);
    const t = this.tables.get(lower);
    if (!t) throw new SmaltError('SMALT_ERROR', `no such table: ${name}`);
    return t;
  }

  /** Compile scope where the table's columns read registers `regs[i]` and the rowid `rowidReg`. */
  private rowScope(table: TableSchema, alias: string | undefined, base: number, rowidReg: number, planner: Planner): CompileScope {
    const outer = planner.compileScope(planner.newScope());
    const qualifier = (alias ?? table.name).toLowerCase();
    return {
      ...outer,
      resolveColumn: (e) => {
        if (e.table && e.table.toLowerCase() !== qualifier && e.table.toLowerCase() !== table.name.toLowerCase()) {
          throw new SmaltError('SMALT_ERROR', `no such column: ${e.table}.${e.name}`);
        }
        const i = findColumn(table, e.name);
        if (i >= 0) {
          const c = table.columns[i];
          const type: StaticType = c.rowidAlias ? 'int' : c.type === 'INTEGER' ? 'int' : c.type === 'REAL' ? 'real' : c.type === 'TEXT' ? 'text' : c.type === 'BLOB' ? 'blob' : 'any';
          const aff = c.type === 'ANY' || c.type === 'BLOB' ? 'BLOB' : c.type;
          return { reg: base + i, type, collation: c.collation, affinity: aff as 'INTEGER' };
        }
        if (['rowid', 'oid', '_rowid_'].includes(e.name.toLowerCase())) return { reg: rowidReg, type: 'int', collation: 0, affinity: 'INTEGER' };
        throw new SmaltError('SMALT_ERROR', `no such column: ${e.name}`);
      },
    };
  }

  /** Coerce, NOT NULL- and CHECK-validate a full row; `real[i]` marks semantically REAL values. */
  private validateRow(table: TableSchema, row: SqlValue[], real: boolean[], checks: { fn: Fn; name: string }[], regs: SqlValue[], base: number): void {
    for (let i = 0; i < table.columns.length; i++) {
      const col = table.columns[i];
      if (col.rowidAlias) continue;
      const v = coerceForColumn(row[i], col, table.name, real[i]);
      if (v === null && col.notNull) throw new ConstraintError('SMALT_CONSTRAINT_NOTNULL', `NOT NULL constraint failed: ${table.name}.${col.name}`);
      row[i] = v;
    }
    if (checks.length) {
      for (let i = 0; i < row.length; i++) regs[base + i] = row[i];
      for (const c of checks) {
        const v = c.fn(regs);
        if (v !== null && truthy(v) === false) throw new ConstraintError('SMALT_CONSTRAINT_CHECK', `CHECK constraint failed: ${c.name}`);
      }
    }
  }

  private compileChecks(table: TableSchema, scope: CompileScope, sql: string): { fn: Fn; name: string }[] {
    return table.checks.map((c) => ({ fn: compileExpr(c.expr, scope).fn, name: c.name ?? sql.slice(c.expr.pos, c.expr.end) }));
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

  private compileInsert(stmt: InsertStmt, planner: Planner): (r: SqlValue[]) => RunResult {
    if (stmt.upsert.length) throw new SmaltError('SMALT_UNSUPPORTED', 'ON CONFLICT (upsert) clauses are not supported yet');
    if (stmt.returning) throw new SmaltError('SMALT_UNSUPPORTED', 'RETURNING is not supported yet');
    if (stmt.with) throw new SmaltError('SMALT_UNSUPPORTED', 'WITH ... INSERT is not supported yet');
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
    const checks = this.compileChecks(table, this.rowScope(table, undefined, base, rowidReg, planner), planner.sqlText);

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

    return (r) => {
      const writer = new TableWriter(table, this.pager);
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
        else rowid = writer.newRowid();
        if (table.rowidAlias >= 0) row[table.rowidAlias] = rowid;
        r[rowidReg] = rowid;
        this.validateRow(table, row, real, checks, r, base);
        if (!writer.resolveConflicts(row, rowid, null, mode)) return;
        writer.writeRow(row, rowid);
        changes++;
        last = rowid;
      });
      this.lastRowid = last;
      this.lastChanges = changes;
      this.total += changes;
      return { changes, lastInsertRowid: last };
    };
  }

  /** Plan a scan of `table` filtered by `where`, decoding every column and the rowid. */
  private planTarget(table: TableSchema, alias: string | undefined, where: Expr | undefined, planner: Planner): { root: Operator; colRegs: number[]; rowidReg: number; scope: CompileScope } {
    const scope = planner.newScope();
    const root = planner.planFrom({ kind: 'table', name: table.name, alias, pos: 0, end: 0 }, where, scope);
    const cs = planner.compileScope(scope);
    const q = alias ?? table.name;
    const colRegs = table.columns.map((c) => {
      const b = cs.resolveColumn({ kind: 'column', table: q, name: c.name, pos: 0, end: 0 });
      return b.reg;
    });
    const rowidReg = cs.resolveColumn({ kind: 'column', table: q, name: 'rowid', pos: 0, end: 0 }).reg;
    return { root, colRegs, rowidReg, scope: cs };
  }

  private compileUpdate(stmt: UpdateStmt, planner: Planner): (r: SqlValue[]) => RunResult {
    if (stmt.from) throw new SmaltError('SMALT_UNSUPPORTED', 'UPDATE ... FROM is not supported yet');
    if (stmt.returning) throw new SmaltError('SMALT_UNSUPPORTED', 'RETURNING is not supported yet');
    if (stmt.orderBy.length || stmt.limit) throw new SmaltError('SMALT_UNSUPPORTED', 'UPDATE ... ORDER BY/LIMIT is not supported');
    if (stmt.with) throw new SmaltError('SMALT_UNSUPPORTED', 'WITH ... UPDATE is not supported yet');
    const table = this.targetTable(stmt.table, stmt.schema);
    const { root, colRegs, rowidReg, scope } = this.planTarget(table, stmt.alias, stmt.where, planner);
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
    const base = planner.regs.alloc(ncols);
    const checkRowid = planner.regs.alloc();
    const checks = this.compileChecks(table, this.rowScope(table, stmt.alias, base, checkRowid, planner), planner.sqlText);

    return (r) => {
      // Phase 1: collect target rows and new values (Halloween-safe).
      const pending: { rowid: number | bigint; old: SqlValue[]; next: SqlValue[]; real: boolean[]; newRowid: SqlValue }[] = [];
      root.open(r);
      try {
        while (root.next()) {
          const rowid = r[rowidReg] as number | bigint;
          const old = colRegs.map((g) => r[g]);
          const next = old.slice();
          const real: boolean[] = new Array(ncols).fill(false);
          let newRowid: SqlValue = rowid;
          for (const s of sets) {
            const v = s.c.fn(r);
            if (s.col === -2) newRowid = v;
            else {
              next[s.col] = v;
              real[s.col] = s.c.type === 'real';
              if (s.col === table.rowidAlias) newRowid = v;
            }
          }
          pending.push({ rowid, old, next, real, newRowid });
        }
      } finally {
        root.close();
      }
      // Phase 2: apply.
      const writer = new TableWriter(table, this.pager);
      let changes = 0;
      for (const p of pending) {
        if (p.newRowid === null) {
          if (table.rowidAlias >= 0) throw new ConstraintError('SMALT_CONSTRAINT_NOTNULL', `NOT NULL constraint failed: ${table.name}.${table.columns[table.rowidAlias].name}`);
          throw new SmaltError('SMALT_MISMATCH', 'datatype mismatch');
        }
        const newRowid = this.toRowid(p.newRowid, table);
        if (table.rowidAlias >= 0) p.next[table.rowidAlias] = newRowid;
        r[checkRowid] = newRowid;
        this.validateRow(table, p.next, p.real, checks, r, base);
        // The row may have been deleted by an earlier REPLACE in this statement.
        if (!writer.rowExists(p.rowid)) continue;
        if (!writer.resolveConflicts(p.next, newRowid, p.rowid, mode)) continue;
        writer.deleteRow(p.rowid, p.old);
        writer.writeRow(p.next, newRowid);
        changes++;
      }
      this.lastChanges = changes;
      this.total += changes;
      return { changes, lastInsertRowid: this.lastRowid };
    };
  }

  private compileDelete(stmt: DeleteStmt, planner: Planner): (r: SqlValue[]) => RunResult {
    if (stmt.returning) throw new SmaltError('SMALT_UNSUPPORTED', 'RETURNING is not supported yet');
    if (stmt.orderBy.length || stmt.limit) throw new SmaltError('SMALT_UNSUPPORTED', 'DELETE ... ORDER BY/LIMIT is not supported');
    if (stmt.with) throw new SmaltError('SMALT_UNSUPPORTED', 'WITH ... DELETE is not supported yet');
    const table = this.targetTable(stmt.table, stmt.schema);
    if (!stmt.where) {
      return () => {
        const n = new TableWriter(table, this.pager).truncate();
        this.lastChanges = n;
        this.total += n;
        return { changes: n, lastInsertRowid: this.lastRowid };
      };
    }
    const { root, colRegs, rowidReg } = this.planTarget(table, stmt.alias, stmt.where, planner);
    return (r) => {
      const pending: { rowid: number | bigint; row: SqlValue[] }[] = [];
      root.open(r);
      try {
        while (root.next()) pending.push({ rowid: r[rowidReg] as number | bigint, row: colRegs.map((g) => r[g]) });
      } finally {
        root.close();
      }
      const writer = new TableWriter(table, this.pager);
      let changes = 0;
      for (const p of pending) if (writer.deleteRow(p.rowid, p.row)) changes++;
      this.lastChanges = changes;
      this.total += changes;
      return { changes, lastInsertRowid: this.lastRowid };
    };
  }

  // ---------------------------------------------------------------- PRAGMA

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
            c.notNull ? 1 : 0,
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
          return idx.columns.map((c, i) => [i, c.column, t.columns[c.column].name]);
        });
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
              if (m !== n) errors.push(`index ${i.name} has ${m} entries, table ${t.name} has ${n} rows`);
            }
          }
          if (pages + this.pager.freelistCount !== this.pager.pageCount) {
            errors.push(`page accounting: ${pages} in use + ${this.pager.freelistCount} free != ${this.pager.pageCount} total`);
          }
          return errors.length ? errors.map((e) => [e]) : [['ok']];
        });
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

  private prog(): Program {
    if (this.program === null || this.version !== this.db.schemaVersion) {
      this.program = this.db.compile(this.parsed);
      this.version = this.db.schemaVersion;
    }
    return this.program;
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

