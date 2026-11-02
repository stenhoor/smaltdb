import {
  ConstraintError,
  type IndexSchema,
  type MatViewInfo,
  type TableSchema,
  storageTypeFor,
  autoIndexName,
  buildIndexSchema,
  buildTableSchema,
  checkConstraintExprs,
  checkNewTable,
  coerceForColumn,
  findColumn,
  isColumnar,
  isConstantDefault,
  literalValue,
} from './catalog/schema.js';
import { MisuseError, SmaltError } from './errors.js';
import { type StaticType, truthy } from './exec/convert.js';
import { type CompileScope, type Compiled, type Fn, compileExpr } from './exec/expr.js';
import { type FunctionContext, aggregateFunctions, scalarFunctions } from './exec/functions.js';
import { type ExecState, type Operator, explainAnalyze, explainRows } from './exec/operators.js';
import { EXTERNAL_FUNCTIONS, type ExternalScan, Planner, type QueryPlan, Registers, markUnordered } from './exec/planner.js';
import { DEFAULT_WORK_MEM, SpillArea, openSpillFile } from './exec/spill.js';
import { COMPACT_ROWS, ColumnarTableWriter, deletedBitmap, loadDeleted } from './exec/columnar-table.js';
import { type MorselQuery, analyzeMorsels } from './exec/morsel.js';
import { type MatviewCandidate, matchMatview } from './exec/mv-match.js';
import { type ConflictMode, TableWriter } from './exec/write.js';
import type { ReaderSettings } from '../shared/protocol.js';
import type {
  AlterTableStmt,
  RefreshStmt,
  ColumnDef,
  ColumnExpr,
  CreateIndexStmt,
  FromItem,
  CreateTableStmt,
  CreateViewStmt,
  CreateConnectionStmt,
  CreateExternalTableStmt,
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
import {
  AsyncRequiredError,
  type ConnectionInfo,
  type CredentialProvider,
  type ExternalColumn,
  type ExternalSource,
  ExternalRegistry,
  type FetchFn,
  type FileSource,
  checkReaderOptions,
  externalError,
  formatOf,
} from './external/external.js';
import { BTree } from './storage/btree.js';
import { ColumnStore, ColumnStoreAppender, ColumnStoreWriter, ROW_GROUP_ROWS, chunkValue } from './storage/columnar.js';
import { KeyEncoder, type KeyColumn, ROWID_KEY_SIZE, decodeKey, readRowidKey, rowidSuffixStart, writeRowidKey } from './storage/key-codec.js';
import { compareRanges } from './util/bytes.js';
import { Pager, type PagerOptions } from './storage/pager.js';
import { RecordEncoder, RecordReader } from './storage/record.js';
import { analyzeIndex, analyzeTable, sampleTable, type TableStats } from './exec/stats.js';
import { type CatalogSnapshot, informationSchema } from './catalog/information-schema.js';
import { type SchemaLookup, applyEdits, quoteIdent as quoteIdentIfNeeded, renameColumnEdits, renameTableEdits } from './catalog/alter.js';
import { ForeignKeys } from './exec/fk.js';
import { Collation, type SqlValue } from './values.js';
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
  /**
   * Open the files with shared (OPFS `readwrite-unsafe`) handles so reader workers can open them
   * too (parallel readers). Exclusive access must then be ensured otherwise (the multi-tab lock).
   */
  sharedHandles?: boolean;
  /**
   * Estimated heap bytes a sort or hash aggregate may hold before it spills to the scratch file
   * (default 256 MiB; 0 never spills). `PRAGMA work_mem` changes it at runtime.
   */
  workMem?: number;
  /**
   * Scratch file for spilling sorts and hash aggregates: default `<path>-spill` for a writable
   * file database; false for none (operators then stay in memory). Readers get none unless given
   * a path. In-memory databases never spill.
   */
  spillPath?: string | false;
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

/** An external table (M8): columns as declared or inferred at creation, and its WITH options. */
interface ExternalTableDef {
  name: string;
  columns: ExternalColumn[];
  options: Record<string, SqlValue>;
  sql: string;
}

/** For Parquet, the source of its schema only (the footer): what planning and column inference need. */
const schemaSourceOf = (s: ExternalSource): ExternalSource => (s.format === 'parquet' ? { ...s, key: `${s.key}|schema`, schemaOnly: true } : s);

/** An external source a materialized view read at its last refresh (smalt_extcache). */
interface ExternalCacheEntry {
  label: string;
  location: string;
  format: 'csv' | 'json' | 'parquet';
  options: Record<string, SqlValue>;
  connection: string | null;
  validator: string | null;
}

/** Catalog key of a connection (connections have their own namespace). */
const connectionKey = (name: string): string => `\u0000connection:${name.toLowerCase()}`;
const quoteIdent = (name: string): string => '"' + name.replace(/"/g, '""') + '"';
const sqlLiteral = (v: SqlValue): string => (v === null ? 'NULL' : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v));
/** Options of each connection type (M8.1 http, M8.2 s3 and azure). Never secrets: those come from credentials providers. */
const CONNECTION_OPTIONS: Record<string, ReadonlySet<string>> = {
  http: new Set(['type', 'url', 'credentials']),
  s3: new Set(['type', 'region', 'bucket', 'endpoint', 'url_style', 'credentials']),
  azure: new Set(['type', 'account', 'container', 'endpoint', 'credentials']),
};

/** A connection's type: the `type` option lower-cased, default 'http'; 'https' is another name for 'http'. */
function connectionType(options: Record<string, SqlValue>): string {
  const type = String(options.type ?? 'http').toLowerCase();
  return type === 'https' ? 'http' : type;
}

interface CatalogEntry {
  type: 'table' | 'index' | 'view' | 'matview' | 'external' | 'connection';
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
  /** External sources the statement reads (M8): loaded by the async API before it runs. */
  externals?: ExternalSource[];
  /** Result rows for utility statements (PRAGMA, EXPLAIN) computed at run time. */
  rows?: (r: SqlValue[]) => SqlValue[][];
  columns: string[];
  columnTypes: StaticType[];
}

/**
 * The engine's synchronous core: one database file, one connection. Runs inside the engine worker
 * (or directly in Node for tests). See docs/ARCHITECTURE.md.
 */
/** Root page numbers at or above this live in the memory store (see Database.mem). */
const MEM_BASE = 2 ** 30;

export class Database implements FunctionContext {
  readonly pager: Pager;
  private readonly tables = new Map<string, TableSchema>();
  private readonly indexes = new Map<string, IndexSchema>();
  private readonly catalog = new Map<string, CatalogEntry>();
  private readonly views = new Map<string, ViewSchema>();
  /** M8: connections and external tables (lower-cased names). */
  private readonly connections = new Map<string, ConnectionInfo & { sql: string }>();
  private readonly externals = new Map<string, ExternalTableDef>();
  /** M8: registered files, credential providers and the data loaded for running statements. */
  readonly external = new ExternalRegistry();
  /** TEMP views: this connection only, never stored (they shadow main-schema views, like SQLite's temp schema). */
  private readonly tempViews = new Map<string, ViewSchema>();
  /** Creation order of TEMP tables, indexes and views: temp.sqlite_schema lists them in it, as SQLite does. */
  private readonly tempSeq = new WeakMap<object, number>();
  private nextTempSeq = 0;
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

  /**
   * Memory store (M7, ADR 0010): pages of memory-resident objects (TEMP tables, `location =
   * 'memory'` materialized views) of a file-backed database. Their root page numbers are offset by
   * {@link MEM_BASE}; {@link tree} routes them here. Null for in-memory databases (everything is
   * in memory already).
   */
  private readonly mem: Pager | null;
  /** TEMP tables (by lower-case name); they shadow main tables of the same name. */
  private tempTables = new Map<string, TableSchema>();
  /**
   * Memory-resident materialized views: runtime roots and refresh state (the catalog records only
   * the definition, with root {@link MEM_BASE} as a marker).
   */
  private memViews = new Map<string, MemView>();
  /** Temp DDL / memory refreshes happened in the current statement (restore on failure). */
  private memDirty = false;
  /** Memory-object state at BEGIN, and at each SQL savepoint (parallel to sqlSavepoints). */
  private txnMem: MemSnapshot | null = null;
  private memSnapshots: MemSnapshot[] = [];

  private snapshotMem(): MemSnapshot {
    if (this.tempTables.size === 0 && this.memViews.size === 0) return EMPTY_MEM_SNAPSHOT;
    return {
      temps: [...this.tempTables].map(([k, t]) => [k, t, [...t.indexes]]),
      views: [...this.memViews].map(([k, v]) => [k, { ...v, indexRoots: new Map(v.indexRoots) }]),
    };
  }

  /** Put back temp tables and memory-view roots (their pages were rolled back with the store). */
  private restoreMem(snap: MemSnapshot): void {
    this.tempTables = new Map(
      snap.temps.map(([k, t, ix]) => {
        t.indexes = ix;
        return [k, t];
      }),
    );
    this.memViews = new Map(snap.views.map(([k, v]) => [k, { ...v, indexRoots: new Map(v.indexRoots) }]));
  }

  /** Scratch area for sorts and hash aggregates that outgrow work_mem (M7.2). */
  private readonly spill: SpillArea;

  private constructor(file: VfsFile | null, options: DatabaseOptions, walFile?: VfsFile, reader = false, spillFile: { file: VfsFile; release: () => void } | null = null) {
    this.pager = file === null ? Pager.openMemory(options) : reader ? Pager.openReader(file, walFile!, options) : Pager.open(file, options, walFile);
    this.spill = new SpillArea(spillFile?.file ?? null, options.workMem ?? DEFAULT_WORK_MEM, spillFile?.release ?? null);
    this.mem = file === null ? null : Pager.openMemory({ pageSize: this.pager.pageSize });
    this.cacheSize = options.statementCacheSize ?? 64;
    if (this.pager.catalogRoot === 0) {
      if (reader) throw new SmaltError('SMALT_CANTOPEN', 'reader: the database has no catalog yet');
      this.pager.catalogRoot = BTree.create(this.pager);
      this.pager.commit();
    }
    this.loadSchema();
    if (!reader) this.rebuildMemoryViews();
  }

  /**
   * Memory-resident materialized views lose their rows when the database closes: recompute them at
   * open (in the memory store only; nothing is written to the file). A view whose query fails stays
   * unpopulated.
   */
  private rebuildMemoryViews(): void {
    if (!this.mem) return;
    let pending = [...this.tables.values()].filter((t) => t.matview && t.rootPage >= MEM_BASE && !t.matview.populated);
    // The rebuild recomputes the rows the views held (their committed inputs are unchanged), so
    // views over them stay as fresh as they were: nothing is marked stale and the file is not written.
    this.rebuilding = true;
    try {
      while (pending.length > 0) {
        // Views over other pending memory views wait for those (dependency order, not catalog order).
        const waiting = new Set(pending.map((t) => t.name.toLowerCase()));
        const ready = pending.filter((t) => ![...this.selectDeps(t.matview!.select)].some((d) => d !== t.name.toLowerCase() && waiting.has(d)));
        const batch = ready.length > 0 ? ready : pending; // a cycle: try the rest anyway
        for (const t of batch) {
          try {
            this.fillMatview(t);
          } catch {
            // leave it unpopulated: reading it reports why it needs a refresh
          }
        }
        pending = pending.filter((t) => !batch.includes(t));
      }
    } finally {
      this.rebuilding = false;
    }
    this.mem.commit();
  }

  /** Memory views are being rebuilt at open (see {@link rebuildMemoryViews}). */
  private rebuilding = false;

  /** `path` ':memory:' opens a new in-memory database (see {@link openMemory}). */
  static async open(vfs: Vfs, path: string, options: DatabaseOptions = {}): Promise<Database> {
    if (path === ':memory:') return Database.openMemory(options);
    const shared = options.sharedHandles === true;
    const file = await vfs.open(path, { shared });
    const wal = (options.journalMode ?? 'wal') === 'wal' ? await vfs.open(`${path}-wal`, { shared }) : undefined;
    return new Database(file, options, wal, false, await Database.openSpill(vfs, options.spillPath ?? `${path}-spill`));
  }

  /**
   * A read-only snapshot reader of a WAL-mode database written by another handle (parallel reader
   * workers). Call {@link refreshSnapshot} before each query to see the latest commit.
   */
  static async openReader(vfs: Vfs, path: string, options: DatabaseOptions = {}): Promise<Database> {
    const file = await vfs.open(path, { shared: true, create: false });
    const wal = await vfs.open(`${path}-wal`, { shared: true, create: false });
    return new Database(file, options, wal, true, await Database.openSpill(vfs, options.spillPath ?? false));
  }

  /** The scratch file, or null (none wanted, or it cannot be opened: then nothing spills). */
  private static async openSpill(vfs: Vfs, path: string | false): Promise<{ file: VfsFile; release: () => void } | null> {
    return path === false ? null : openSpillFile(vfs, path);
  }

  /** Reader: move to the latest committed state (reloads the schema if it changed). */
  refreshSnapshot(): void {
    if (this.pager.refreshSnapshot()) this.loadSchemaIfChanged();
  }

  /** Parallel readers: checkpoints are skipped while `gate` returns false. */
  setCheckpointGate(gate: (() => boolean) | null): void {
    this.pager.checkpointGate = gate;
  }

  /**
   * A new in-memory database: no file, no write-ahead log, no page checksums. Transactions and
   * statements still roll back; the data is gone when the database is closed.
   */
  static openMemory(options: DatabaseOptions = {}): Database {
    return new Database(null, options);
  }

  /** Open from already-open files (pass `walFile` for WAL mode). */
  static openFile(file: VfsFile, options: DatabaseOptions = {}, walFile?: VfsFile): Database {
    return new Database(file, options, walFile);
  }

  /**
   * Whether a statement reads memory-resident objects (TEMP tables, memory materialized views),
   * directly or through views: those exist only in this connection, so parallel readers cannot
   * answer it. PRAGMAs count too: settings (work_mem, foreign_keys) belong to this connection.
   */
  usesMemoryObjects(parsed: ParsedStatement): boolean {
    if (parsed.stmt.kind === 'pragma') return true;
    if (this.tempTables.size === 0 && this.memViews.size === 0 && this.tempViews.size === 0) return false;
    const seen = new Set<string>();
    const walk = (x: unknown): boolean => {
      if (Array.isArray(x)) return x.some(walk);
      if (typeof x !== 'object' || x === null || Object.getPrototypeOf(x) !== Object.prototype) return false;
      const o = x as Record<string, unknown>;
      if (o.kind === 'table' && typeof o.name === 'string') {
        const lower = o.name.toLowerCase();
        const t = this.tables.get(lower);
        if (t && t.rootPage >= MEM_BASE) return true;
        if ((!o.schema || String(o.schema).toLowerCase() === 'temp') && this.tempViews.has(lower)) return true; // TEMP views exist in this connection only
        const v = this.getView(lower);
        if (v && !seen.has(lower)) {
          seen.add(lower);
          if (walk(v.select)) return true;
        }
      }
      return Object.keys(o).some((k) => walk(o[k]));
    };
    return walk(parsed.stmt);
  }

  /**
   * @internal Changes when committed data changes, in the file or in the memory store (TEMP
   * tables): statements re-check their row-count assumptions when it moves.
   */
  changeStamp(): string {
    return this.mem ? `${this.pager.changeCounter}/${this.mem.changeCounter}` : String(this.pager.changeCounter);
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
      t = this.freshTree(root);
      this.trees.set(root, t);
    }
    return t;
  }

  /** A new B+tree handle for `root`, in the store the root number belongs to. */
  freshTree(root: number): BTree {
    if (root >= MEM_BASE) {
      if (!this.mem) throw new SmaltError('SMALT_CORRUPT', `memory root ${root} in an in-memory database`);
      return new BTree(this.mem, root - MEM_BASE);
    }
    return new BTree(this.pager, root);
  }

  /** Create an empty B+tree in the main or the memory store; returns its (routable) root number. */
  private createTree(memory: boolean): number {
    return memory && this.mem ? BTree.create(this.mem) + MEM_BASE : BTree.create(this.pager);
  }

  /** Transaction boundaries apply to both stores (the memory store commits after the main one). */
  private readonly tx = {
    beginStatement: (): void => {
      this.pager.beginStatement();
      this.mem?.beginStatement();
    },
    commitStatement: (): void => {
      this.pager.commitStatement();
      this.mem?.commitStatement();
    },
    rollbackStatement: (): void => {
      this.pager.rollbackStatement();
      this.mem?.rollbackStatement();
      this.dropColumnarCaches();
    },
    commit: (): void => {
      this.pager.commit();
      this.mem?.commit();
    },
    rollback: (): void => {
      this.pager.rollback();
      this.mem?.rollback();
      this.dropColumnarCaches();
    },
    releaseAllPins: (): void => {
      this.pager.releaseAllPins();
      this.mem?.releaseAllPins();
    },
    beginSavepoint: (): number => {
      const d = this.pager.beginSavepoint();
      this.mem?.beginSavepoint();
      return d;
    },
    releaseSavepoint: (d: number): void => {
      this.pager.releaseSavepoint(d);
      this.mem?.releaseSavepoint(d);
    },
    rollbackToSavepoint: (d: number, keep: boolean): void => {
      this.pager.rollbackToSavepoint(d, keep);
      this.mem?.rollbackToSavepoint(d, keep);
      this.dropColumnarCaches();
    },
  };

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

  /**
   * Install a check that runs periodically while statements execute (every few hundred page
   * fetches). Throwing from it aborts the statement like any error (it is rolled back); throw a
   * SmaltError with code SMALT_INTERRUPT to signal cancellation. The check must clear its own
   * trigger before throwing, so the rollback is not interrupted again.
   */
  setInterruptCheck(check: (() => void) | null): void {
    this.pager.interrupt = check;
    if (this.mem) this.mem.interrupt = check;
    this.spill.interrupt = check;
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

  // ---------------------------------------------------------------- external data (M8)

  /**
   * Run one statement that may read external tables or `read_csv` / `read_json`, returning all
   * rows. Its sources are fetched first (concurrently), then it runs like `query`.
   */
  async queryAsync(sql: string, params?: BindParams, options: { signal?: AbortSignal } = {}): Promise<QueryResult> {
    this.checkOpen();
    const st = this.prepare(sql);
    return this.runExternal(options.signal, st, () => ({ columns: st.columns, rows: st.all(params) }));
  }

  /** `run` for a statement that may read external data. */
  async runAsync(sql: string, params?: BindParams, options: { signal?: AbortSignal } = {}): Promise<RunResult> {
    this.checkOpen();
    const st = this.prepare(sql);
    return this.runExternal(options.signal, st, () => st.run(params));
  }

  /** `exec` for statements that may read external data (CREATE EXTERNAL TABLE, materialized views over it, …). */
  async execAsync(sql: string, params?: BindParams, options: { signal?: AbortSignal } = {}): Promise<void> {
    this.checkOpen();
    const stmts = parse(sql);
    if (params !== undefined && stmts.length > 1) throw new MisuseError('parameters can only be bound with a single statement');
    for (const ps of stmts) {
      const st = new Statement(this, ps, ps.text);
      await this.runExternal(options.signal, st, () => st.run(params));
    }
  }

  /** `withExternal` for the async API; `REFRESH … IF CHANGED` first checks its view's sources. */
  private async runExternal<T>(signal: AbortSignal | undefined, st: Statement, run: () => T): Promise<T> {
    const s = st.parsed.stmt;
    if (s.kind !== 'refresh' || !s.ifChanged) return this.withExternal(signal, st, run);
    // Revalidate the view's sources first (HEAD requests, stats): the refresh runs only if needed.
    const key = s.name.toLowerCase();
    this.refreshDecisions.set(key, await this.matviewChanged(s.name, signal));
    try {
      return await this.withExternal(signal, st, run);
    } finally {
      this.refreshDecisions.delete(key);
    }
  }

  /**
   * Load the external sources `st` reads, then `run` it. A source discovered only while running
   * (a view over `read_csv`, a materialized view's query) is loaded and the statement retried; each
   * attempt is atomic, so a retry starts from a clean state.
   */
  /** @internal (also used by the export functions) */
  async withExternal<T>(signal: AbortSignal | undefined, st: Statement, run: () => T): Promise<T> {
    const held = new Set<string>();
    const load = async (sources: ExternalSource[]): Promise<boolean> => {
      const need = sources.filter((s) => !held.has(s.key));
      if (need.length === 0) return false;
      for (const k of await this.external.acquire(need, signal)) held.add(k);
      return true;
    };
    try {
      // First round: every source known before running, fetched together. `read_csv('…')` calls with
      // constant arguments are found in the statement text (planning needs their columns).
      const first = this.literalExternalSources(st.parsed.stmt);
      try {
        first.push(...st.externalSources);
      } catch (e) {
        if (!(e instanceof AsyncRequiredError)) throw e;
        first.push(...e.sources);
      }
      await load(first);
      for (;;) {
        try {
          await load(st.externalSources);
          return run();
        } catch (e) {
          // Retry only when it is new data that is missing (never loop on the same sources).
          if (!(e instanceof AsyncRequiredError) || !(await load(e.sources))) throw e;
        }
      }
    } finally {
      this.external.release([...held]);
    }
  }

  /** Make `file` readable as `file:<name>` (a File, Blob, file handle, bytes or text); null removes it. */
  registerFile(name: string, file: FileSource | null): void {
    if (file === null) this.external.files.delete(name);
    else this.external.files.set(name, file);
  }

  /**
   * Credentials a connection refers to by name (`credentials = 'name'`): headers for requests to
   * URLs that start with `provider.endpoint` (never sent elsewhere). null removes them.
   */
  registerCredentials(name: string, provider: CredentialProvider | null): void {
    if (provider === null) this.external.credentials.delete(name);
    else this.external.credentials.set(name, provider);
  }

  /** Transport for http(s) sources (default: the global fetch). */
  setFetch(fetchFn: FetchFn | null): void {
    this.external.fetchFn = fetchFn;
  }

  close(): void {
    if (this.closed) return;
    for (const c of [...this.activeCursors]) c.close();
    this.pager.close();
    this.mem?.close();
    this.spill.close();
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

  /**
   * A table by name. Unqualified names see a TEMP table before a main table of the same name;
   * `schema` 'main' or 'temp' asks for that schema's table only.
   */
  getTable(name: string, schema?: string): TableSchema | undefined {
    const lower = name.toLowerCase();
    const s = schema?.toLowerCase();
    // temp.sqlite_schema is the TEMP catalog, a virtual table (see tempSchemaRows).
    if (CATALOG_NAMES.has(lower)) return s === 'temp' ? undefined : this.catalogTable;
    const t = this.tables.get(lower);
    if (s === 'main') return t?.temp ? this.shadowedMain.get(lower) : t;
    if (s === 'temp') return t?.temp ? t : undefined;
    return t;
  }

  /** Main tables currently shadowed by a TEMP table of the same name (reachable as `main.name`). */
  private shadowedMain = new Map<string, TableSchema>();

  private fkInvolvedNow(name: string): boolean {
    const t = this.tables.get(name.toLowerCase());
    if (!t) return false;
    this.fk.sync(this.schemaVersion);
    return this.fk.involved(t);
  }

  /** Writer for user DML: deletions it makes (DELETE, REPLACE conflicts) run foreign-key processing. */
  private writerFor(table: TableSchema): TableWriter {
    this.touchTable(table);
    const c = table.columnar;
    const w = c
      ? new ColumnarTableWriter(table, this.pager, (root) => this.tree(root), () => this.storeOf(table, true), this.tree(c.delRoot), (dDelta, dDeleted) => {
          this.columnarTouched.add(table);
          if (dDeleted !== 0) c.delVersion = (c.delVersion ?? 0) + 1;
          if (c.counts) {
            c.counts.delta += dDelta;
            c.counts.deleted += dDeleted;
          }
        })
      : new TableWriter(table, this.pager, (root) => this.tree(root));
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
      try {
        root.open(regs);
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
    if (schema === undefined && name.toLowerCase() === 'smalt_partials' && this.morsel !== null) {
      // The partial aggregates being merged (morsel parallelism).
      const m = this.morsel;
      const columns = [...Array.from({ length: m.keys }, (_, i) => `k${i}`), ...Array.from({ length: m.width - m.keys }, (_, i) => `a${i}`)];
      // Typed like the partial query's columns: a REAL partial (max(x) = 2.0) stays REAL when merged.
      // Rows are read when the plan runs (merge statements are cached and reused).
      return { columns: columns.map((c, i) => ({ name: c, type: m.types[i] ?? ('any' as StaticType) })), rows: () => this.morsel?.rows ?? [] };
    }
    if (schema === 'information_schema') {
      const vt = informationSchema(name, this.catalogSnapshot());
      return vt && { columns: vt.columns, rows: () => vt.rows() };
    }
    if (schema === 'temp') {
      // temp.sqlite_schema (sqlite_temp_schema): the TEMP catalog, which is never stored.
      if (!CATALOG_NAMES.has(name.toLowerCase())) return undefined;
      const types: StaticType[] = ['text', 'text', 'text', 'int', 'text'];
      return { columns: ['type', 'name', 'tbl_name', 'rootpage', 'sql'].map((c, i) => ({ name: c, type: types[i] })), rows: () => this.tempSchemaRows() };
    }
    // As in SQLite, a schema qualifier on a pragma function (main.pragma_table_info) changes nothing.
    const lower = name.toLowerCase().replace(/^(main|temp)\./, '');
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

  /** Rows of temp.sqlite_schema, in creation order. rootpage is the root page in the memory store. */
  private tempSchemaRows(): SqlValue[][] {
    const page = (root: number): number => (root >= MEM_BASE ? root - MEM_BASE : root);
    const out: [number, SqlValue[]][] = [];
    const seq = (o: object): number => this.tempSeq.get(o) ?? 0;
    for (const t of this.tempTables.values()) {
      out.push([seq(t), ['table', t.name, t.name, page(t.rootPage), t.sql]]);
      for (const ix of t.indexes) out.push([seq(ix), ['index', ix.name, t.name, page(ix.rootPage), ix.sql ?? null]]);
    }
    for (const v of this.tempViews.values()) out.push([seq(v), ['view', v.name, v.name, 0, v.sql]]);
    return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  }

  private catalogSnapshot(): CatalogSnapshot {
    for (const t of this.tables.values()) if (t.matview) this.matviewPolicy(t.matview);
    return {
      tables: [...this.tables.values(), ...this.shadowedMain.values()],
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
      externals: [...this.externals.values()].map((x) => {
        const { location, format, connection, ...rest } = x.options;
        // The format in effect (given, or from the file extension; tsv reads as csv with tabs).
        let fmt: string | null = format === undefined || format === null ? null : String(format).toLowerCase();
        if (fmt === null) {
          try {
            const f = formatOf(String(location), x.options, x.name);
            fmt = f.delimiter === '\t' ? 'tsv' : f.format;
          } catch {
            fmt = null;
          }
        }
        return { name: x.name, columns: x.columns, location: String(location), format: fmt, connection: connection === undefined || connection === null ? null : String(connection), options: JSON.stringify(rest) };
      }),
      connections: [...this.connections.values()].map((c) => ({
        name: c.name,
        type: connectionType(c.options),
        url: c.options.url === undefined || c.options.url === null ? null : String(c.options.url),
        credentials: c.options.credentials === undefined || c.options.credentials === null ? null : String(c.options.credentials),
        options: JSON.stringify(Object.fromEntries(Object.entries(c.options).filter(([k]) => !['type', 'url', 'credentials'].includes(k)))),
      })),
    };
  }

  /** @internal View by name (for the planner); `schema` 'main' or 'temp' asks for that schema's view only. */
  getView(name: string, schema?: string): ViewSchema | undefined {
    const s = schema?.toLowerCase();
    if (s === 'main') return this.views.get(name.toLowerCase());
    if (s === 'temp') return this.tempViews.get(name.toLowerCase());
    return this.tempViews.get(name.toLowerCase()) ?? this.views.get(name.toLowerCase());
  }

  tableNames(): string[] {
    return [...this.tables.values()].map((t) => t.name);
  }

  private loadSchema(): void {
    this.tables.clear();
    this.indexes.clear();
    this.views.clear();
    this.connections.clear();
    this.externals.clear();
    this.catalog.clear();
    const catStmt = parseOne(CATALOG_SQL).stmt as CreateTableStmt;
    this.catalogTable = { ...buildTableSchema(catStmt, CATALOG_SQL, this.pager.catalogRoot).table, system: true };
    const rows = this.scanCatalog();
    const autoRoots = new Map<string, number>();
    for (const r of rows) if (r.type === 'index' && r.sql === null) autoRoots.set(r.name.toLowerCase(), r.rootpage);
    for (const r of rows) {
      if (r.type === 'connection') {
        const c = parseOne(r.sql!).stmt as CreateConnectionStmt;
        this.catalog.set(connectionKey(r.name), { type: 'connection', name: r.name, rowid: r.rowid });
        this.connections.set(r.name.toLowerCase(), { name: r.name, options: c.with, sql: r.sql! });
        continue;
      }
      this.catalog.set(r.name.toLowerCase(), { type: r.type as CatalogEntry['type'], name: r.name, rowid: r.rowid });
      if (r.type === 'external') {
        const x = parseOne(r.sql!).stmt as CreateExternalTableStmt;
        this.externals.set(r.name.toLowerCase(), { name: r.name, columns: x.columns.map((c) => ({ name: c.name, declType: c.type ?? '' })), options: x.with, sql: r.sql! });
        continue;
      }
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
    this.loadMatviews(rows.filter((r) => r.type === 'matview'));
    this.loadColumnar();
    for (const r of rows) {
      if (r.type !== 'index' || r.sql === null) continue;
      const stmt = parseOne(r.sql).stmt as CreateIndexStmt;
      const table = this.tables.get(r.tbl_name.toLowerCase());
      if (!table) throw new SmaltError('SMALT_CORRUPT', `index ${r.name} references missing table ${r.tbl_name}`);
      let root = r.rootpage;
      if (root === MEM_BASE) {
        // Index of a memory-resident view: its runtime root (an empty tree after reopening).
        const mv = this.memViews.get(table.name.toLowerCase());
        root = mv?.indexRoots.get(r.name.toLowerCase()) ?? this.createTree(true);
        mv?.indexRoots.set(r.name.toLowerCase(), root);
      }
      const idx = buildIndexSchema(stmt, r.sql, table, root);
      this.prepareIndex(table, idx);
      table.indexes.push(idx);
      this.indexes.set(idx.name.toLowerCase(), idx);
    }
    // TEMP tables live outside the catalog: re-add them (they shadow main tables of the same name).
    this.shadowedMain.clear();
    for (const [lower, t] of this.tempTables) {
      const main = this.tables.get(lower);
      if (main) this.shadowedMain.set(lower, main);
      this.tables.set(lower, t);
      for (const idx of t.indexes) this.indexes.set(idx.name.toLowerCase(), idx);
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

  private addCatalogRow(type: string, name: string, tblName: string, root: number, sql: string | null, key = name.toLowerCase()): void {
    const w = this.catalogWriter();
    const rowid = w.newRowid();
    w.writeRow([type, name, tblName, root, sql], rowid);
    this.catalog.set(key, { type: type as CatalogEntry['type'], name, rowid });
  }

  private removeCatalogRow(name: string, key = name.toLowerCase()): void {
    const e = this.catalog.get(key);
    if (!e) return;
    this.catalogWriter().deleteRow(e.rowid);
    this.catalog.delete(key);
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
    const planner = new Planner(this.plannerDeps(this.rewritePolicy(stmt)), regs);
    planner.sqlText = ps.text;
    const done = (p: Omit<Program, 'regCount'>): Program => ({ ...p, regCount: regs.count, rowAssumptions: planner.rowAssumptions, externals: planner.finishExternals() });
    switch (stmt.kind) {
      case 'select': {
        const plan = planner.planSelect(stmt, null);
        return done({ plan, readonly: true, columns: plan.columns.map((c) => c.name), columnTypes: plan.columns.map((c) => c.type) });
      }
      case 'insert': {
        const single = stmt.source.kind === 'values' && stmt.source.rows.length === 1 && (stmt.or ?? 'ABORT') !== 'REPLACE' && !stmt.upsert.length && !this.fkInvolvedNow(stmt.table);
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
      case 'createConnection':
        return done({ exec: () => this.createConnection(stmt, ps.text), readonly: false, columns: [], columnTypes: [] });
      case 'createExternalTable':
        return done({ exec: () => this.createExternalTable(stmt, ps.text), readonly: false, columns: [], columnTypes: [] });
      case 'createView':
        if (stmt.materialized) return done({ exec: () => this.createMatview(stmt, ps.text), readonly: false, columns: [], columnTypes: [] });
        if (stmt.schema && !['main', 'temp'].includes(stmt.schema.toLowerCase())) throw new SmaltError('SMALT_ERROR', `unknown database ${stmt.schema}`);
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
        return done({ exec: () => this.analyze(stmt.target, stmt.schema), readonly: false, columns: [], columnTypes: [] });
      case 'refresh':
        return done({ exec: () => this.refreshMatview(stmt), readonly: false, columns: [], columnTypes: [] });
      default:
        throw new SmaltError('SMALT_UNSUPPORTED', `${stmt.kind} statements are not supported yet`);
    }
  }

  /**
   * Whether the SELECTs a statement plans (top level, subqueries, CTEs, views) may be answered from
   * materialized views, and which tables' views are excluded. SELECT and EXPLAIN: yes. INSERT …
   * SELECT: yes, except views over the table being written (the statement changes it while it
   * reads) and when foreign keys may change other tables. UPDATE, DELETE and the rest: no.
   */
  private rewritePolicy(stmt: Stmt): { exclude: string | null } | null {
    if (!this.matviewRewriteOn) return null;
    if (stmt.kind === 'select' || (stmt.kind === 'explain' && stmt.stmt.kind === 'select')) return { exclude: null };
    if (stmt.kind === 'insert' && stmt.source.kind === 'select' && !this.fkInvolvedNow(stmt.table)) return { exclude: stmt.table.toLowerCase() };
    return null;
  }

  /** What the planner reads from the database. Unpopulated materialized views cannot be read. */
  private plannerDeps(rewrite: { exclude: string | null } | null = null): ConstructorParameters<typeof Planner>[0] {
    return {
      rewriteSelect: rewrite ? (select, text) => this.matviewRewrite(select, text, rewrite.exclude) : undefined,
      externalTable: (n) => this.externalTableScan(n),
      externalFunction: (n, args, named) => this.externalFunctionScan(n, args, named),
      getTable: (n, schema) => {
        const t = this.getTable(n, schema);
        if (t?.matview && !t.matview.populated) {
          throw new SmaltError('SMALT_ERROR', `materialized view "${t.name}" has not been populated (use REFRESH MATERIALIZED VIEW)`);
        }
        return t;
      },
      getView: (n, schema) => this.getView(n, schema),
      virtualTable: (schema, n) => this.virtualTable(schema, n),
      openTree: (root) => this.tree(root),
      sampledStats: (t) => this.sampledStats(t),
      columnStore: (t) => this.storeOf(t, true),
      liveRows: (t) => this.liveRows(t),
      deletedRows: (t) => this.deletedRowsOf(t),
      funcCtx: this,
      state: this.state,
      spill: this.spill,
    };
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
        this.txnMem = this.snapshotMem();
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
          this.tx.rollbackToSavepoint(this.sqlSavepoints[i].depth, true);
          this.sqlSavepoints.length = i + 1;
          this.restoreMem(this.memSnapshots[i]);
          this.memSnapshots.length = i + 1;
          this.loadSchema();
        } else this.rollbackTransaction();
        break;
      case 'savepoint':
        if (this.autocommit) {
          this.txnMem = this.snapshotMem();
          this.autocommit = false;
          this.txnFromSavepoint = true;
        }
        this.memSnapshots.push(this.snapshotMem());
        this.sqlSavepoints.push({ name: stmt.name, depth: this.tx.beginSavepoint() });
        break;
      case 'release': {
        const i = this.findSavepoint(stmt.name);
        this.tx.releaseSavepoint(this.sqlSavepoints[i].depth);
        this.sqlSavepoints.length = i;
        this.memSnapshots.length = i;
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
    if (this.sqlSavepoints.length) this.tx.releaseSavepoint(1);
    this.sqlSavepoints.length = 0;
    this.memSnapshots.length = 0;
    this.txnMem = null;
    this.tx.commit();
    this.autocommit = true;
    this.txnFromSavepoint = false;
  }

  private rollbackTransaction(): void {
    this.fk.deferred = 0;
    this.sqlSavepoints.length = 0;
    this.txnFromSavepoint = false;
    this.tx.rollback();
    if (this.txnMem) this.restoreMem(this.txnMem);
    this.txnMem = null;
    this.memSnapshots.length = 0;
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
    const pager = this.tx;
    // A statement journal is only needed inside an explicit transaction (autocommit failures roll
    // back the whole transaction) and only for statements that can fail after writing.
    const journal = !this.autocommit && !program.singleRowWrite;
    if (journal) pager.beginStatement();
    let result: T;
    // Temp DDL and memory-view refreshes are not in the pages alone: restore them on failure. (In
    // an in-memory database temp tables live in the main pager, but their maps still need this.)
    const memBefore = this.snapshotMem();
    this.memDirty = false;
    this.fk.sync(this.schemaVersion);
    this.fk.stmt = 0;
    const deferredBefore = this.fk.deferred;
    this.columnarTouched.clear();
    try {
      result = body();
      // Columnar tables written by this statement: move full row groups out of the delta store.
      // Needs a way to undo a failure part-way: a statement journal or the autocommit transaction.
      if (this.columnarTouched.size > 0 && (journal || this.autocommit)) this.compactTouched();
      this.fk.checkStatement();
      if (this.autocommit) this.fk.checkCommit();
    } catch (e) {
      this.fk.stmt = 0;
      this.fk.deferred = this.autocommit ? 0 : deferredBefore;
      // Writes never run while a read cursor is open, so no page may legitimately stay pinned: a
      // failure part-way through B+tree maintenance (an interrupt, an I/O error) can leave pins.
      pager.releaseAllPins();
      if (journal) pager.rollbackStatement();
      if (this.autocommit) pager.rollback();
      if (this.memDirty) {
        this.restoreMem(memBefore);
        this.memDirty = false;
        this.loadSchema();
      } else this.loadSchemaIfChanged();
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

  // ---------------------------------------------------------------- materialized views

  private static readonly MATVIEW_SQL = 'CREATE TABLE smalt_matview(name TEXT, layout TEXT, populated INTEGER, refreshed_at TEXT)';
  /** M8.1: the external sources a materialized view read at its last refresh, with their validators (JSON). */
  private static readonly EXTCACHE_SQL = 'CREATE TABLE smalt_extcache(name TEXT, sources TEXT)';

  /**
   * CREATE MATERIALIZED VIEW: the result columns become a table (types from the query), filled by
   * running the query unless `WITH NO DATA`.
   */
  private createMatview(stmt: CreateViewStmt, sql: string): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    if (stmt.temp || stmt.schema?.toLowerCase() === 'temp') throw new SmaltError('SMALT_ERROR', 'materialized views cannot be temporary');
    if (stmt.ifNotExists && this.catalog.get(stmt.name.toLowerCase())?.type === 'matview') return none;
    const tempDep = this.tempDependency(stmt.select);
    if (tempDep) throw new SmaltError('SMALT_ERROR', `materialized view ${stmt.name} cannot reference TEMP object ${tempDep}`);
    const opts = stmt.with ?? {};
    for (const k of Object.keys(opts)) if (!['storage', 'refresh', 'location', 'refresh_every', 'refresh_on_reconnect'].includes(k)) throw new SmaltError('SMALT_ERROR', `unknown materialized view option: ${k}`);
    if (opts.refresh_every !== undefined && opts.refresh_every !== null && !(Number(opts.refresh_every) > 0)) throw new SmaltError('SMALT_ERROR', 'refresh_every must be a positive number of seconds');
    const location = String(opts.location ?? 'file').toLowerCase();
    if (location !== 'file' && location !== 'memory') throw new SmaltError('SMALT_ERROR', `location must be 'file' or 'memory'`);
    const inMemory = location === 'memory' && this.mem !== null;
    const storage = String(opts.storage ?? 'row').toLowerCase();
    if (storage !== 'row' && storage !== 'columnar') throw new SmaltError('SMALT_ERROR', `storage must be 'row' or 'columnar'`);
    const refresh = String(opts.refresh ?? 'manual').toLowerCase();
    if (refresh !== 'manual') throw new SmaltError('SMALT_UNSUPPORTED', `refresh = '${refresh}' is not supported yet (only 'manual')`);
    this.checkNewName(stmt.name, 'materialized view');
    this.dirtySchema = true;
    const layout = this.matviewLayout(stmt.name, stmt.select, sql, stmt.columns);
    if (!this.tables.has('smalt_matview')) {
      this.createTable(parseOne(Database.MATVIEW_SQL).stmt as CreateTableStmt, Database.MATVIEW_SQL, true);
    }
    const root = this.createTree(inMemory);
    const { table } = buildTableSchema(parseOne(layout).stmt as CreateTableStmt, layout, root);
    table.matview = { sql, select: stmt.select, storage, populated: false, refreshedAt: null };
    // A memory-resident view's root is assigned at runtime: the catalog records a marker.
    this.addCatalogRow('matview', table.name, table.name, inMemory ? MEM_BASE : root, sql);
    if (inMemory) {
      this.memViews.set(table.name.toLowerCase(), { root, indexRoots: new Map(), populated: false, refreshedAt: null, fresh: false });
      this.memDirty = true;
    }
    this.tables.set(table.name.toLowerCase(), table);
    this.writeMatviewMeta(table.name, { layout, populated: false, refreshedAt: null });
    let changes = 0;
    if (stmt.withData !== false) changes = this.fillMatview(table);
    this.schemaChanged();
    return { changes, lastInsertRowid: this.lastRowid };
  }

  /** REFRESH MATERIALIZED VIEW [CONCURRENTLY] name [WITH [NO] DATA]. */
  private refreshMatview(stmt: RefreshStmt): RunResult {
    if (stmt.schema && stmt.schema.toLowerCase() !== 'main') throw new SmaltError('SMALT_ERROR', `unknown database ${stmt.schema}`);
    const mv = this.tables.get(stmt.name.toLowerCase());
    if (!mv?.matview) throw new SmaltError('SMALT_ERROR', `no such materialized view: ${stmt.name}`);
    if (stmt.concurrently && !stmt.withData) throw new SmaltError('SMALT_ERROR', 'REFRESH ... CONCURRENTLY cannot be used with WITH NO DATA');
    if (stmt.ifChanged) {
      const changed = this.refreshDecisions.get(mv.name.toLowerCase());
      if (changed === undefined) throw new SmaltError('SMALT_ASYNC_REQUIRED', `REFRESH … IF CHANGED checks the sources of ${mv.name}: run it with execAsync, or through the worker client`);
      if (!changed) return { changes: 0, lastInsertRowid: this.lastRowid };
    }
    const memory = mv.rootPage >= MEM_BASE;
    // A memory-resident view changes no stored schema: the file (and its cookie) stay untouched.
    if (!memory) this.dirtySchema = true;
    let changes = 0;
    if (stmt.withData) changes = this.fillMatview(mv);
    else {
      this.swapMatviewTrees(mv, this.createTree(memory), mv.indexes.map(() => this.createTree(memory)));
      mv.matview.populated = false;
      mv.matview.fresh = false;
      this.writeMatviewMeta(mv.name, { populated: false, refreshedAt: mv.matview.refreshedAt });
    }
    if (memory) this.schemaVersion++;
    else this.schemaChanged();
    return { changes, lastInsertRowid: this.lastRowid };
  }

  /**
   * Recompute a materialized view into new trees, then swap them in (copy-on-write: the old rows
   * stay intact until the swap, which is what makes REFRESH ... CONCURRENTLY safe for readers).
   * Returns the number of rows.
   */
  private fillMatview(mv: TableSchema): number {
    const info = mv.matview!;
    this.touchTable(mv); // views over this view
    const memory = mv.rootPage >= MEM_BASE;
    const root = this.createTree(memory);
    const target: TableSchema = { ...mv, rootPage: root, indexes: [] };
    const cols = mv.columns;
    const ncols = cols.length;
    const types = cols.map((c) => c.type);
    // Rows go straight from the query's registers into column buffers (columnar) or a bottom-up
    // B+tree build (row): no per-row arrays, descents or splits.
    const columnar = info.storage === 'columnar' ? new ColumnStoreWriter(this.tree(root), ncols) : null;
    const loader = columnar ? null : this.tree(root).bulkLoader();
    const enc = columnar ? null : new RecordEncoder(mv.layout);
    const vals: SqlValue[] = new Array(ncols).fill(null);
    const key = new Uint8Array(ROWID_KEY_SIZE);
    let rowid = 0;
    let sources: ExternalSource[] = [];
    try {
      sources = this.runSelect(info.select, info.sql, (r, outRegs) => {
        if (outRegs.length !== ncols) throw new SmaltError('SMALT_ERROR', `materialized view ${mv.name}: the query now returns ${outRegs.length} columns, the view has ${ncols}`);
        for (let i = 0; i < ncols; i++) {
          const v = r[outRegs[i]];
          if (v !== null && !fitsStorage(v, types[i])) {
            throw new SmaltError('SMALT_MISMATCH', `materialized view ${mv.name}: column ${cols[i].name} is ${types[i]} but the query produced ${describeValue(v)} (add a CAST to the view)`);
          }
          if (!columnar) vals[i] = v;
        }
        rowid++;
        if (columnar) columnar.addFrom(r, outRegs);
        else {
          writeRowidKey(key, 0, rowid);
          loader!.add(key, 0, ROWID_KEY_SIZE, enc!.encode(vals));
        }
      });
      if (columnar) columnar.finish();
      else loader!.finish();
    } catch (e) {
      // Release the page being filled; the rollback reclaims the rest.
      if (columnar) columnar.abort();
      else loader!.abort();
      throw e;
    }
    const indexRoots = mv.indexes.map((idx) => {
      const r = this.createTree(memory);
      const copy: IndexSchema = { ...idx, rootPage: r };
      this.populateIndex(target, copy, r);
      if (idx.unique) this.checkUniqueIndex(target, copy);
      return r;
    });
    this.swapMatviewTrees(mv, root, indexRoots);
    info.populated = true;
    info.fresh = true;
    info.refreshedAt = new Date().toISOString();
    this.writeMatviewMeta(mv.name, { populated: true, refreshedAt: info.refreshedAt, fresh: true });
    this.writeExternalCache(mv.name, sources);
    return rowid;
  }

  /**
   * Record what a materialized view's last refresh read from external sources and their validators
   * (for `REFRESH … IF CHANGED`); a view over local data only has no row. Memory views keep it at
   * runtime only (their rows are gone after reopening anyway).
   */
  private writeExternalCache(name: string, sources: ExternalSource[]): void {
    const unique = [...new Map(sources.map((s) => [s.key, s])).values()];
    const entries = unique.map((s) => ({
      label: s.label,
      location: s.location,
      format: s.format,
      options: s.options,
      connection: s.connection?.name ?? null,
      validator: this.external.data(s).validator,
    }));
    const lower = name.toLowerCase();
    if (this.memViews.has(lower)) {
      if (entries.length) this.memExtCache.set(lower, entries);
      else this.memExtCache.delete(lower);
      return;
    }
    let t = this.tables.get('smalt_extcache');
    if (!t) {
      if (entries.length === 0) return;
      this.createTable(parseOne(Database.EXTCACHE_SQL).stmt as CreateTableStmt, Database.EXTCACHE_SQL, true);
      t = this.tables.get('smalt_extcache')!;
    }
    this.upsertMetaRow(t, name, entries.length ? () => [name, JSON.stringify(entries)] : null);
  }

  private readonly memExtCache = new Map<string, ExternalCacheEntry[]>();

  /** The external sources of a materialized view's last refresh (empty for local-only views). */
  private externalCacheOf(name: string): ExternalCacheEntry[] {
    const lower = name.toLowerCase();
    const mem = this.memExtCache.get(lower);
    if (mem) return mem;
    if (!this.tables.has('smalt_extcache')) return [];
    const rows = this.query('SELECT sources FROM smalt_extcache WHERE lower(name) = ?', [lower]).rows;
    return rows.length ? (JSON.parse(rows[0][0] as string) as ExternalCacheEntry[]) : [];
  }

  /**
   * Whether `REFRESH … IF CHANGED` must refresh: the view is unpopulated or stale (a base table
   * changed), or an external source it read has a different validator now (or has none, like a
   * registered Blob). Revalidating is a HEAD request or a stat, not a download.
   */
  private async matviewChanged(name: string, signal?: AbortSignal): Promise<boolean> {
    const mv = this.tables.get(name.toLowerCase());
    if (!mv?.matview) throw new SmaltError('SMALT_ERROR', `no such materialized view: ${name}`);
    if (!mv.matview.populated || !mv.matview.fresh) return true;
    const entries = this.externalCacheOf(mv.name);
    const checks = await Promise.all(
      entries.map(async (e) => {
        if (e.validator === null) return true;
        const conn = e.connection === null ? undefined : this.connections.get(e.connection.toLowerCase());
        if (e.connection !== null && !conn) return true; // gone: the refresh reports it
        const source: ExternalSource = { key: `check:${e.location}`, label: e.label, location: e.location, format: e.format, options: e.options, connection: conn && { name: conn.name, options: conn.options } };
        return (await this.external.currentValidator(source, signal)) !== e.validator;
      }),
    );
    return checks.some(Boolean);
  }

  /** Decisions of `REFRESH … IF CHANGED` statements about to run (set by execAsync after checking). */
  private readonly refreshDecisions = new Map<string, boolean>();

  /** @internal Refresh policy of a materialized view (`refresh_every`, `refresh_on_reconnect`). */
  matviewPolicy(info: NonNullable<TableSchema['matview']>): { every: number | null; onReconnect: boolean } {
    if (!info.policy) {
      const w = (parseOne(info.sql).stmt as CreateViewStmt).with ?? {};
      const every = w.refresh_every === undefined || w.refresh_every === null ? null : Number(w.refresh_every);
      const r = w.refresh_on_reconnect;
      info.policy = { every, onReconnect: r !== undefined && r !== null && ['1', 'true', 'yes', 'on'].includes(String(r).toLowerCase()) };
    }
    return info.policy;
  }

  /**
   * @internal Materialized views with an automatic refresh policy, for the engine worker's
   * scheduler: name, policy and the time of the last refresh (ms; 0 if never).
   */
  refreshPolicies(): { name: string; every: number | null; onReconnect: boolean; refreshedAt: number }[] {
    const out = [];
    for (const t of this.tables.values()) {
      if (!t.matview) continue;
      const p = this.matviewPolicy(t.matview);
      if (p.every === null && !p.onReconnect) continue;
      out.push({ name: t.name, ...p, refreshedAt: t.matview.refreshedAt ? Date.parse(t.matview.refreshedAt) : 0 });
    }
    return out;
  }

  /** @internal The outcome of an automatic refresh (shown in information_schema.materialized_views). */
  noteRefreshResult(name: string, error: string | null): void {
    const mv = this.tables.get(name.toLowerCase());
    if (mv?.matview) mv.matview.lastRefreshError = error;
  }

  /** Point a materialized view (and its indexes) at new trees and free the old ones. */
  private swapMatviewTrees(mv: TableSchema, root: number, indexRoots: number[]): void {
    mv.matview!.store = undefined; // cached chunks belong to the old segments
    const memView = root >= MEM_BASE ? this.memViews.get(mv.name.toLowerCase()) : undefined;
    this.freshTree(mv.rootPage).destroy();
    mv.rootPage = root;
    if (memView) {
      memView.root = root;
      this.memDirty = true;
    } else this.setCatalogRoot(mv.name, root);
    mv.indexes.forEach((idx, i) => {
      this.freshTree(idx.rootPage).destroy();
      idx.rootPage = indexRoots[i];
      if (memView) memView.indexRoots.set(idx.name.toLowerCase(), indexRoots[i]);
      else this.setCatalogRoot(idx.name, indexRoots[i]);
    });
  }

  private setCatalogRoot(name: string, root: number): void {
    const e = this.catalog.get(name.toLowerCase())!;
    const w = this.catalogWriter();
    const row = w.readRow(e.rowid)!;
    row[3] = root;
    w.writeRow(row, e.rowid);
  }

  /** The storage table definition (CREATE TABLE text) for a materialized view's query. */
  private matviewLayout(name: string, select: SelectStmt, sql: string, names?: string[]): string {
    const planner = new Planner(this.plannerDeps(), new Registers(0));
    planner.sqlText = sql;
    const plan = planner.planSelect(select, null);
    if (names && names.length !== plan.columns.length) {
      throw new SmaltError('SMALT_ERROR', `materialized view ${name} has ${names.length} column names but its query returns ${plan.columns.length} columns`);
    }
    const seen = new Set<string>();
    const q = (x: string): string => `"${x.replace(/"/g, '""')}"`;
    const defs = plan.columns.map((c, i) => {
      const colName = names?.[i] ?? c.name;
      if (seen.has(colName.toLowerCase())) throw new SmaltError('SMALT_ERROR', `column "${colName}" specified more than once (name it with AS)`);
      seen.add(colName.toLowerCase());
      // A column copied from a table keeps its declared type; computed values get their static type.
      const st = c.declType ? storageTypeFor(c.declType) : ({ int: 'INTEGER', real: 'REAL', text: 'TEXT', blob: 'BLOB' } as Record<string, string>)[c.type] ?? 'ANY';
      const coll = c.collation === Collation.NoCase ? ' COLLATE NOCASE' : c.collation === Collation.RTrim ? ' COLLATE RTRIM' : '';
      return `${q(colName)} ${st}${coll}`;
    });
    return `CREATE TABLE ${q(name)}(${defs.join(', ')})`;
  }

  /** Run a query to completion; `emit` reads each result row from the registers `r[outRegs[i]]`. */
  /** Run `select`, passing each row to `emit`; returns the external sources it read (M8). */
  private runSelect(select: SelectStmt, sql: string, emit: (r: SqlValue[], outRegs: number[]) => void): ExternalSource[] {
    const regs = new Registers(0);
    const planner = new Planner(this.plannerDeps(), regs);
    planner.sqlText = sql;
    const plan = planner.planSelect(select, null);
    const externals = planner.finishExternals();
    const r: SqlValue[] = new Array(regs.count).fill(null);
    const root = plan.root;
    try {
      root.open(r);
      const out = plan.outRegs;
      while (root.next()) emit(r, out);
    } finally {
      root.close();
    }
    return externals;
  }

  /** Upsert (or with `meta` null, delete) a view's row in smalt_matview. */
  private writeMatviewMeta(name: string, meta: { layout?: string; populated: boolean; refreshedAt: string | null; fresh?: boolean } | null): void {
    const t = this.tables.get('smalt_matview');
    if (!t) return;
    const mv = this.memViews.get(name.toLowerCase());
    if (mv && meta && meta.layout === undefined) {
      // Memory-resident: refresh state is runtime-only (the file is not written).
      mv.populated = meta.populated;
      mv.refreshedAt = meta.refreshedAt;
      mv.fresh = meta.fresh === true;
      this.memDirty = true;
      return;
    }
    // populated: 0 = no, 1 = yes, 2 = yes and fresh (no base table changed since the refresh).
    this.upsertMetaRow(t, name, meta && ((old) => [name, meta.layout ?? old?.[1] ?? null, meta.populated ? (meta.fresh ? 2 : 1) : 0, meta.refreshedAt]));
  }

  /**
   * Replace (or with `row` null, delete) the row named `name` (column 0, case-insensitive) of the
   * system table `t`, keeping its rowid. `row` gets the old row's values, if there was one.
   */
  private upsertMetaRow(t: TableSchema, name: string, row: ((old: SqlValue[] | null) => SqlValue[]) | null): void {
    const w = new TableWriter(t, this.pager, (root) => this.tree(root));
    const reader = new RecordReader(t.layout, t.recordDefaults);
    let found: { rowid: number | bigint; values: SqlValue[] } | null = null;
    const c = this.tree(t.rootPage).cursor();
    try {
      for (let ok = c.first(); ok; ok = c.next()) {
        c.loadValue();
        reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
        if (String(reader.column(0)).toLowerCase() === name.toLowerCase()) {
          c.loadKey();
          found = { rowid: readRowidKey(c.keyBytes, c.keyOffset), values: t.columns.map((_, i) => reader.column(i)) };
          break;
        }
      }
    } finally {
      c.close();
    }
    if (found) w.deleteRow(found.rowid);
    if (row) w.writeRow(row(found?.values ?? null), found?.rowid ?? w.newRowid());
  }

  // ---------------------------------------------------------------- morsel parallelism (M7.4)

  /** `PRAGMA matview_rewrite`: answer queries from fresh materialized views (M7.5; off by default). */
  private matviewRewriteOn = false;

  /** The query rewritten to read a fresh materialized view, when one provably answers it. */
  private matviewRewrite(stmt: SelectStmt, text: string, exclude: string | null = null): SelectStmt | null {
    if (!this.matviewRewriteOn) return null;
    const views: MatviewCandidate[] = [];
    for (const t of this.tables.values()) {
      const m = t.matview;
      if (!m?.populated || !m.fresh) continue;
      // A TEMP table or view shadowing something the view read: the query's names mean the temp object.
      const deps = (m.deps ??= this.selectDeps(m.select));
      if ([...deps].some((d) => this.tempTables.has(d) || this.tempViews.has(d))) continue;
      // A view over the table the statement writes (INSERT … SELECT into its base table).
      if (exclude !== null && deps.has(exclude)) continue;
      // External data changes without the database noticing: such a view is a cache, refreshed explicitly.
      if (this.externals.size > 0 && [...deps].some((d) => this.externals.has(d))) continue;
      const from = m.select.core.kind === 'select' && m.select.core.from?.kind === 'table' ? this.getTable(m.select.core.from.name, m.select.core.from.schema) : undefined;
      views.push({ name: t.name, select: m.select, columns: t.columns.map((c) => c.name), baseColumns: from ? from.columns.map((c) => c.name) : [] });
    }
    if (views.length === 0) return null;
    const m = matchMatview(stmt, text, views, (name) => {
      const t = this.getTable(name);
      if (!t || t.system) return undefined;
      return {
        hasColumn: (c) => findColumn(t, c) >= 0,
        binaryColumn: (c) => {
          const i = findColumn(t, c);
          return i >= 0 && (t.columns[i].collation ?? Collation.Binary) === Collation.Binary;
        },
      };
    });
    return m ? m.stmt : null;
  }

  private setMatviewRewrite(on: boolean): void {
    if (on !== this.matviewRewriteOn) {
      this.matviewRewriteOn = on;
      this.schemaVersion++; // re-plan statements compiled under the other setting
    }
  }

  /**
   * This connection's settings that parallel readers must use too (they are separate connections):
   * the server sends them with each query and morsel it hands to a reader.
   */
  get readerSettings(): ReaderSettings {
    return { workMem: this.spill.workMem, matviewRewrite: this.matviewRewriteOn };
  }

  /** A reader: take the owner's settings before running a query or morsel for it. */
  applyReaderSettings(s: ReaderSettings): void {
    this.spill.workMem = s.workMem;
    this.setMatviewRewrite(s.matviewRewrite);
  }

  /** `PRAGMA parallel_aggregates`: whether large aggregates may run as morsels on parallel readers. */
  private parallelAggregates = true;
  private morselCache = new Map<string, MorselEntry | null>();
  /** Partial rows being merged: the `smalt_partials()` source of the merge query. */
  private morsel: { rows: SqlValue[][]; keys: number; width: number; types: StaticType[] } | null = null;

  private morselQuery(sql: string): MorselEntry | null {
    const hit = this.morselCache.get(sql);
    if (hit !== undefined && (hit === null || hit.version === this.schemaVersion)) {
      // Least recently used goes first: move this one to the end.
      this.morselCache.delete(sql);
      this.morselCache.set(sql, hit);
      return hit;
    }
    let entry: MorselEntry | null = null;
    try {
      const parsed = parseOne(sql);
      if (parsed.stmt.kind === 'select') {
        const q = analyzeMorsels(parsed.stmt, parsed.text, (name) => {
          const t = this.getTable(name);
          // Readers open the file: memory-resident objects and system tables stay on the owner.
          if (!t || t.temp || t.system || t.rootPage >= MEM_BASE || (t.matview && !t.matview.populated)) return undefined;
          return {
            hasColumn: (c) => findColumn(t, c) >= 0,
            binaryColumn: (c) => {
              const i = findColumn(t, c);
              return i >= 0 && (t.columns[i].collation ?? Collation.Binary) === Collation.Binary;
            },
          };
        });
        if (q) entry = { version: this.schemaVersion, parsed, q };
      }
    } catch {
      entry = null; // let the normal path report the error
    }
    this.morselCache.delete(sql);
    if (this.morselCache.size >= 64) this.morselCache.delete(this.morselCache.keys().next().value!);
    this.morselCache.set(sql, entry);
    return entry;
  }

  /** Smallest and largest rowid of a table (numbers only), or null. */
  private rowidBounds(t: TableSchema): { min: number; max: number } | null {
    if (t.matview?.storage === 'columnar') {
      const n = this.storeOf(t).rows;
      return n > 0 ? { min: 1, max: n } : null;
    }
    let min = Infinity;
    let max = -Infinity;
    const c = this.tree(t.rootPage).cursor();
    try {
      if (c.first()) {
        c.loadKey();
        min = Number(readRowidKey(c.keyBytes, c.keyOffset));
        c.last();
        c.loadKey();
        max = Number(readRowidKey(c.keyBytes, c.keyOffset));
      }
    } finally {
      c.close();
    }
    if (t.columnar) {
      const store = this.storeOf(t, true);
      const rc = t.columns.length;
      for (let rg = 0; rg < store.rowGroups; rg++) {
        const z = store.meta(rg).zones[rc];
        if (z.numMin === undefined || z.numMax === undefined) return null;
        min = Math.min(min, z.numMin);
        max = Math.max(max, z.numMax);
      }
    }
    if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)) return null;
    return { min, max };
  }


  /**
   * Morsel parallelism: when `sql` is an aggregate over one table of at least `minRows` rows whose
   * aggregates merge exactly, rowid ranges for `parts` partial queries ({@link runPartial});
   * otherwise null (run it normally).
   */
  parallelSplit(sql: string, parts: number, minRows = 200_000): { lo: number; hi: number }[] | null {
    if (parts < 2 || !this.parallelAggregates) return null;
    const m = this.morselQuery(sql);
    if (!m) return null;
    // A fresh materialized view answers it more cheaply than any split of the base table.
    if (m.parsed.stmt.kind === 'select' && this.matviewRewrite(m.parsed.stmt, m.parsed.text)) return null;
    const t = this.getTable(m.q.table)!;
    const rows = this.liveRows(t);
    if (rows < minRows) return null;
    const b = this.rowidBounds(t);
    if (!b) return null;
    const span = b.max - b.min + 1;
    const out: { lo: number; hi: number }[] = [];
    for (let i = 0; i < parts; i++) {
      const lo = b.min + Math.floor((span * i) / parts);
      const hi = i === parts - 1 ? b.max + 1 : b.min + Math.floor((span * (i + 1)) / parts);
      if (hi > lo) out.push({ lo, hi });
    }
    return out.length > 1 ? out : null;
  }

  /** The partial aggregates of `sql` over rowids in [lo, hi) (one row per group). */
  runPartial(sql: string, params: BindParams | undefined, lo: number, hi: number): SqlValue[][] {
    const m = this.morselQuery(sql);
    if (!m) throw new SmaltError('SMALT_ERROR', 'statement cannot run as partial aggregates');
    return new Statement(this, { ...m.parsed, stmt: m.q.partial(lo, hi) }, sql).all(params) as SqlValue[][];
  }

  /** Merge partial rows (from {@link runPartial} over every range) into the result of `sql`. */
  mergePartials(sql: string, params: BindParams | undefined, partials: SqlValue[][]): QueryResult {
    const m = this.morselQuery(sql);
    if (!m) throw new SmaltError('SMALT_ERROR', 'statement cannot run as partial aggregates');
    // Partial column types and the merge statement are compiled once per query text and schema.
    const types = (m.types ??= new Statement(this, { ...m.parsed, stmt: m.q.partial(0, 1) }, sql).columnTypes);
    this.morsel = { rows: partials, keys: m.q.keyCount, width: m.q.width, types };
    try {
      const st = (m.final ??= new Statement(this, { ...m.parsed, stmt: m.q.final }, sql));
      return { columns: st.columns, rows: st.all(params) as SqlValue[][] };
    } finally {
      this.morsel = null;
    }
  }

  /**
   * Keep writes out (they fail with SMALT_BUSY, like during an open query cursor) until the
   * returned release function is called: morsels running on readers must all see one commit.
   */
  holdReads(): () => void {
    const token = { close: () => void this.activeCursors.delete(token as unknown as RowCursor) };
    this.activeCursors.add(token as unknown as RowCursor);
    return token.close;
  }

  /** {@link parallelSplit} + {@link runPartial} + {@link mergePartials} in this thread (tests, fallback). */
  queryMorsels(sql: string, params?: BindParams, parts = 4, minRows = 0): QueryResult | null {
    const ranges = this.parallelSplit(sql, parts, minRows);
    if (!ranges) return null;
    const partials: SqlValue[][] = [];
    for (const r of ranges) partials.push(...this.runPartial(sql, params, r.lo, r.hi));
    return this.mergePartials(sql, params, partials);
  }

  // ---------------------------------------------------------------- columnar tables (M7.3)

  private static readonly COLUMNAR_SQL = 'CREATE TABLE smalt_columnar(name TEXT, seg_root INTEGER, del_root INTEGER)';

  /** Columnar tables written by the running statement (compacted at its end). */
  private readonly columnarTouched = new Set<TableSchema>();

  /**
   * The segment reader of a columnar table or columnar materialized view. `fresh`: re-read the
   * header (a columnar table's compaction appends row groups; a view's segments only change by
   * refresh, which replaces the reader).
   */
  private storeOf(t: TableSchema, fresh = false): ColumnStore {
    const c = t.columnar;
    if (!c) return (t.matview!.store ??= new ColumnStore(this.tree(t.rootPage)));
    if (c.store === undefined) c.store = new ColumnStore(this.tree(c.segRoot));
    else if (fresh) c.store.refreshHeader();
    return c.store;
  }

  /** Estimated rows of a table (columnar: segment rows, plus the delta store for a columnar table). */
  private liveRows(t: TableSchema): number {
    if (t.matview?.storage === 'columnar') return this.storeOf(t).rows;
    const tree = this.tree(t.rootPage).estimateCount();
    return t.columnar ? this.storeOf(t, true).rows + tree : tree;
  }

  /**
   * Decoded chunks may describe rolled-back row groups (their keys get reused): drop them. Segments
   * written by committed statements never change in place, so the caches survive everything else.
   */
  private dropColumnarCaches(): void {
    for (const t of [...this.tables.values(), ...this.shadowedMain.values()]) {
      if (t.columnar) {
        t.columnar.store = undefined;
        t.columnar.counts = undefined;
        t.columnar.deleted = undefined;
      }
    }
  }

  /**
   * The deleted rowids of a columnar table, cached until deletions change in this connection or a
   * new commit is visible (a reader's refresh, another connection's writes).
   */
  private deletedRowsOf(t: TableSchema): Set<number | bigint> | null {
    const c = t.columnar!;
    const key = `${this.pager.changeCounter}:${c.delVersion ?? 0}:${c.delRoot}`;
    if (c.deleted?.key !== key) c.deleted = { key, set: loadDeleted(this.tree(c.delRoot)) };
    return c.deleted.set;
  }

  /** Upsert (or with `info` null, delete) a table's row in smalt_columnar. */
  private writeColumnarMeta(name: string, info: { segRoot: number; delRoot: number } | null): void {
    this.upsertMetaRow(this.tables.get('smalt_columnar')!, name, info && (() => [name, info.segRoot, info.delRoot]));
  }

  /** Attach segment and deletion roots to columnar tables (from smalt_columnar). */
  private loadColumnar(): void {
    const meta = this.tables.get('smalt_columnar');
    const roots = new Map<string, { segRoot: number; delRoot: number }>();
    if (meta) {
      const reader = new RecordReader(meta.layout, meta.recordDefaults);
      const c = this.tree(meta.rootPage).cursor();
      try {
        for (let ok = c.first(); ok; ok = c.next()) {
          c.loadValue();
          reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
          roots.set(String(reader.column(0)).toLowerCase(), { segRoot: Number(reader.column(1)), delRoot: Number(reader.column(2)) });
        }
      } finally {
        c.close();
      }
    }
    for (const t of this.tables.values()) {
      if (t.matview || t.system || !/storage/i.test(t.sql) || tableStorage(parseOne(t.sql).stmt as CreateTableStmt) !== 'columnar') continue;
      const r = roots.get(t.name.toLowerCase());
      if (!r) throw new SmaltError('SMALT_CORRUPT', `columnar table ${t.name} has no segments`);
      t.columnar = { ...r };
    }
  }

  /** Values of every delta-store row of `t`, in rowid order, with the rowid appended. */
  private *deltaRows(t: TableSchema): Generator<{ rowid: number | bigint; row: SqlValue[] }> {
    const reader = new RecordReader(t.layout, t.recordDefaults);
    const ncols = t.columns.length;
    const c = this.tree(t.rootPage).cursor();
    try {
      for (let ok = c.first(); ok; ok = c.next()) {
        c.loadKey();
        const rowid = readRowidKey(c.keyBytes, c.keyOffset);
        c.loadValue();
        reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
        const row: SqlValue[] = new Array(ncols + 1);
        for (let i = 0; i < ncols; i++) row[i] = i === t.rowidAlias ? null : reader.column(i);
        row[ncols] = rowid;
        yield { rowid, row };
      }
    } finally {
      c.close();
    }
  }

  /**
   * End of a statement that wrote columnar tables: once the delta store holds a row group's worth
   * of rows, move whole row groups into the segments; rewrite the segments when deletions pile up.
   */
  private compactTouched(): void {
    for (const t of this.columnarTouched) {
      if (!t.columnar || this.getTable(t.name, 'main') !== t) continue; // dropped meanwhile
      const store = this.storeOf(t, true);
      // Running counts (kept by the writer); counted once when missing (after a rollback or reload).
      const counts = (t.columnar.counts ??= { delta: this.tree(t.rootPage).count(), deleted: this.tree(t.columnar.delRoot).count() });
      const deltaCount = counts.delta;
      const delCount = counts.deleted;
      if (delCount > Math.max(COMPACT_ROWS, store.rows / 4)) {
        this.rewriteColumnar(t, true);
        continue;
      }
      if (deltaCount < COMPACT_ROWS) continue;
      t.columnar.counts = undefined; // rows move out of the delta store: recount next time
      if (!this.appendDelta(t)) this.rewriteColumnar(t, true);
    }
    this.columnarTouched.clear();
  }

  /**
   * Move delta rows into new row groups, in whole row groups, oldest rowids first. Rows whose
   * rowid is also hidden in the segments (updated segment rows) stay: the deletion tree would hide
   * them too. Returns false when fewer than a row group's worth could move (rewrite instead).
   */
  private appendDelta(t: TableSchema): boolean {
    const c = t.columnar!;
    const ncols = t.columns.length + 1;
    const deleted = loadDeleted(this.tree(c.delRoot));
    const cols: SqlValue[][] = Array.from({ length: ncols }, () => new Array<SqlValue>(ROW_GROUP_ROWS));
    const moved: (number | bigint)[] = [];
    let batch: (number | bigint)[] = [];
    let n = 0;
    let appender: ColumnStoreAppender | null = null;
    for (const { rowid, row } of this.deltaRows(t)) {
      if (deleted?.has(rowid)) continue;
      for (let k = 0; k < ncols; k++) cols[k][n] = row[k];
      batch.push(rowid);
      if (++n === ROW_GROUP_ROWS) {
        (appender ??= new ColumnStoreAppender(this.tree(c.segRoot))).addRowGroup(cols, n);
        moved.push(...batch);
        batch = [];
        n = 0;
      }
    }
    if (appender === null) return false;
    appender.finish();
    const delta = this.tree(t.rootPage);
    if (n === 0 && deleted === null) delta.clear();
    else {
      const key = new Uint8Array(ROWID_KEY_SIZE);
      for (const id of moved) {
        writeRowidKey(key, 0, id);
        delta.delete(key);
      }
    }
    this.storeOf(t, true);
    return true;
  }

  /**
   * Rewrite a columnar table's segments: live segment rows and all delta rows go into a new column
   * store (`keep` false: an empty one, for DELETE without WHERE); the delta store and deletions are
   * emptied. A new segment root changes the schema (readers reload it). Returns the rows dropped
   * (`keep` false) or 0.
   */
  private rewriteColumnar(t: TableSchema, keep: boolean): number {
    const c = t.columnar!;
    const ncols = t.columns.length;
    const store = this.storeOf(t, true);
    const delTree = this.tree(c.delRoot);
    const delta = this.tree(t.rootPage);
    const deleted = loadDeleted(delTree);
    const segRoot = BTree.create(this.pager);
    let dropped = 0;
    if (keep) {
      const w = new ColumnStoreWriter(this.tree(segRoot), ncols + 1);
      const row: SqlValue[] = new Array(ncols + 1);
      try {
        for (let rg = 0; rg < store.rowGroups; rg++) {
          const rows = store.meta(rg).rows;
          const gone = deletedBitmap(store, rg, ncols, deleted);
          const chunks = Array.from({ length: ncols + 1 }, (_, k) => store.chunk(rg, k));
          for (let i = 0; i < rows; i++) {
            if (gone !== null && gone[i] === 1) continue;
            for (let k = 0; k <= ncols; k++) row[k] = chunkValue(chunks[k], i);
            w.add(row);
          }
        }
        for (const { row: r } of this.deltaRows(t)) w.add(r);
        w.finish();
      } catch (e) {
        w.abort();
        throw e;
      }
    } else {
      dropped = delta.count() + store.rows - delTree.count();
    }
    this.freshTree(c.segRoot).destroy();
    delTree.clear();
    delta.clear();
    c.segRoot = segRoot;
    c.store = undefined;
    c.counts = { delta: 0, deleted: 0 };
    c.delVersion = (c.delVersion ?? 0) + 1;
    c.deleted = undefined;
    this.writeColumnarMeta(t.name, c);
    this.dirtySchema = true;
    this.schemaChanged();
    return dropped;
  }

  /** Build materialized views' table schemas from catalog rows and smalt_matview. */
  private loadMatviews(rows: { name: string; rootpage: number; sql: string | null }[]): void {
    if (rows.length === 0) return;
    const t = this.tables.get('smalt_matview');
    if (!t) throw new SmaltError('SMALT_CORRUPT', 'materialized views without smalt_matview');
    const meta = new Map<string, { layout: string; populated: boolean; fresh: boolean; refreshedAt: string | null }>();
    const reader = new RecordReader(t.layout, t.recordDefaults);
    const c = this.tree(t.rootPage).cursor();
    for (let ok = c.first(); ok; ok = c.next()) {
      c.loadValue();
      reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
      const p = reader.column(2);
      meta.set(String(reader.column(0)).toLowerCase(), { layout: String(reader.column(1)), populated: p === 1 || p === 2, fresh: p === 2, refreshedAt: reader.column(3) as string | null });
    }
    c.close();
    for (const r of rows) {
      const m = meta.get(r.name.toLowerCase());
      if (!m) throw new SmaltError('SMALT_CORRUPT', `missing metadata for materialized view ${r.name}`);
      const def = parseOne(r.sql!).stmt as CreateViewStmt;
      let root = r.rootpage;
      let populated = m.populated;
      let fresh = m.fresh;
      let refreshedAt = m.refreshedAt;
      if (root === MEM_BASE) {
        // Memory-resident: the runtime root, or a new empty tree after reopening (rebuilt at open).
        let mv = this.memViews.get(r.name.toLowerCase());
        if (!mv) {
          mv = { root: this.createTree(true), indexRoots: new Map(), populated: false, refreshedAt: null, fresh: false };
          this.memViews.set(r.name.toLowerCase(), mv);
        }
        root = mv.root;
        populated = mv.populated;
        fresh = mv.fresh;
        refreshedAt = mv.refreshedAt;
      }
      const { table } = buildTableSchema(parseOne(m.layout).stmt as CreateTableStmt, m.layout, root);
      const storage = String(def.with?.storage ?? 'row').toLowerCase() as MatViewInfo['storage'];
      table.matview = { sql: r.sql!, select: def.select, storage, populated, refreshedAt, fresh };
      this.tables.set(table.name.toLowerCase(), table);
    }
  }

  /**
   * Tables and views a SELECT reads (lower-case names), through views. CTE references are
   * excluded where the CTE is in scope: a CTE's name is visible to the CTEs after it and the
   * statement body, and inside its own body only when it is RECURSIVE (otherwise `WITH t AS
   * (SELECT * FROM t)` reads the table t).
   */
  private selectDeps(select: SelectStmt, seen = new Set<string>()): Set<string> {
    const out = new Set<string>();
    const visit = (x: unknown, ctes: ReadonlySet<string>): void => {
      if (Array.isArray(x)) {
        for (const y of x) visit(y, ctes);
        return;
      }
      if (typeof x !== 'object' || x === null || x instanceof Uint8Array) return;
      const o = x as Record<string, unknown>;
      if (o.kind === 'select' && 'core' in o && o.with) {
        const w = o.with as { recursive: boolean; ctes: { name: string; select: SelectStmt }[] };
        const inner = new Set(ctes);
        if (w.recursive) for (const c of w.ctes) inner.add(c.name.toLowerCase());
        for (const c of w.ctes) {
          visit(c.select, inner);
          inner.add(c.name.toLowerCase());
        }
        for (const [k, v] of Object.entries(o)) if (k !== 'with') visit(v, inner);
        return;
      }
      if (o.kind === 'table' && typeof o.name === 'string') {
        const n = o.name.toLowerCase();
        if (o.schema || !ctes.has(n)) {
          out.add(n);
          const view = this.getView(n);
          if (view && !seen.has(n)) {
            seen.add(n);
            for (const d of this.selectDeps(view.select, seen)) out.add(d);
          }
        }
      }
      for (const v of Object.values(o)) visit(v, ctes);
    };
    visit(select, new Set());
    return out;
  }

  /**
   * An object named `name` was created, dropped, renamed or redefined: materialized views that
   * read that name are no longer known to be fresh, and cached dependencies (which expand views)
   * are recomputed.
   */
  private objectChanged(name: string): void {
    for (const t of this.tables.values()) if (t.matview) t.matview.deps = undefined;
    this.touchName(name.toLowerCase());
  }

  /**
   * A write to `table` is about to happen: materialized views over it stop being fresh (in this
   * transaction, so a rollback makes them fresh again). Readers reload the schema to notice.
   */
  private touchTable(table: TableSchema): void {
    this.touchName(table.name.toLowerCase());
  }

  /** Mark fresh materialized views that read the object named `lower` stale. */
  /** Materialized views (cached per schema version: touchName runs for every DML statement). */
  private matviewTables(): TableSchema[] {
    if (this.mvList?.version !== this.schemaVersion) this.mvList = { version: this.schemaVersion, list: [...this.tables.values()].filter((t) => t.matview) };
    return this.mvList.list;
  }
  private mvList: { version: number; list: TableSchema[] } | null = null;

  private touchName(lower: string): void {
    if (this.rebuilding) return;
    let changed = false;
    for (const t of this.matviewTables()) {
      const m = t.matview!;
      if (!m.fresh || !(m.deps ??= this.selectDeps(m.select)).has(lower)) continue;
      m.fresh = false;
      this.writeMatviewMeta(t.name, { populated: m.populated, refreshedAt: m.refreshedAt, fresh: false });
      changed = true;
    }
    if (changed) {
      this.dirtySchema = true;
      this.schemaChanged();
    }
  }

  private static readonly STAT_SQL = 'CREATE TABLE smalt_stat(tbl TEXT, idx TEXT, stat TEXT)';

  /** ANALYZE [schema | [schema.]table-or-index]: gather optimizer statistics and store them in smalt_stat. */
  private analyze(target: string | undefined, schema?: string): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    // Main tables only (shadowed ones included): statistics are stored in the file, keyed by name.
    const mainTables = [...this.tables.values(), ...this.shadowedMain.values()].filter((t) => !t.temp);
    let tables = mainTables.filter((t) => !t.system && t.name.toLowerCase() !== 'smalt_stat' && !isColumnar(t));
    const s = schema?.toLowerCase();
    if (s !== undefined && s !== 'main' && s !== 'temp') throw new SmaltError('SMALT_ERROR', `unknown database ${schema}`);
    // As in SQLite, a bare schema name analyzes that schema (TEMP tables are never analyzed).
    if (s === undefined && target?.toLowerCase() === 'temp') return none;
    if (s === undefined && target?.toLowerCase() === 'main') target = undefined;
    if (target) {
      const lower = target.toLowerCase();
      const t = s === 'temp' ? undefined : this.getTable(target, 'main');
      const idx = this.indexes.get(lower);
      const idxOwner = idx && this.tables.get(idx.table.toLowerCase());
      const tempTarget = this.tempTables.has(lower) || idxOwner?.temp === true;
      if (!t && tempTarget && s !== 'main') return none; // TEMP tables are not analyzed
      if (t) tables = isColumnar(t) ? [] : [t];
      else if (idxOwner && !idxOwner.temp && s !== 'temp') tables = [idxOwner];
      else throw new SmaltError('SMALT_ERROR', `no such table or index: ${s ? `${schema}.` : ''}${target}`);
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
    if (t.name.toLowerCase().startsWith('smalt_') || isColumnar(t)) return undefined;
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
        const tbl = this.getTable(String(reader.column(0)), 'main');
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
    const label = (t: string): string => (t === 'external' ? 'external table' : t === 'matview' ? 'materialized view' : t);
    if (existing) throw new SmaltError('SMALT_ERROR', `${label(existing.type === kind ? kind : existing.type)} ${name} already exists`);
  }

  /** A TEMP table or view that `select` reads (directly or through views), if any. */
  private tempDependency(select: SelectStmt): string | undefined {
    if (this.tempTables.size === 0 && this.tempViews.size === 0) return undefined;
    return [...this.selectDeps(select)].find((d) => this.tempTables.has(d) || this.tempViews.has(d));
  }

  // ---------------------------------------------------------------- connections and external tables (M8)

  private createConnection(stmt: CreateConnectionStmt, sql: string): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    const lower = stmt.name.toLowerCase();
    if (this.connections.has(lower)) {
      if (stmt.ifNotExists) return none;
      throw new SmaltError('SMALT_ERROR', `connection ${stmt.name} already exists`);
    }
    const type = connectionType(stmt.with);
    const allowed = CONNECTION_OPTIONS[type];
    if (!allowed) throw new SmaltError('SMALT_ERROR', `connection ${stmt.name}: type '${type}' is not supported (http, s3, azure)`);
    for (const k of Object.keys(stmt.with)) if (!allowed.has(k)) throw new SmaltError('SMALT_ERROR', `connection ${stmt.name}: unknown option '${k}' for type ${type} (${[...allowed].join(', ')})`);
    for (const k of ['url', 'endpoint']) {
      const v = stmt.with[k];
      if (v !== undefined && v !== null && !/^https?:\/\//i.test(String(v))) throw new SmaltError('SMALT_ERROR', `connection ${stmt.name}: ${k} must be an http(s) URL`);
    }
    if (type === 'azure' && !stmt.with.account) throw new SmaltError('SMALT_ERROR', `connection ${stmt.name}: an azure connection needs account (the storage account name)`);
    const style = stmt.with.url_style;
    if (style !== undefined && style !== null && !['path', 'virtual'].includes(String(style).toLowerCase())) throw new SmaltError('SMALT_ERROR', `connection ${stmt.name}: url_style must be 'path' or 'virtual'`);
    this.dirtySchema = true;
    this.addCatalogRow('connection', stmt.name, stmt.name, 0, sql, connectionKey(stmt.name));
    this.connections.set(lower, { name: stmt.name, options: stmt.with, sql });
    this.schemaChanged();
    return none;
  }

  private dropConnection(stmt: DropStmt): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    const c = this.connections.get(stmt.name.toLowerCase());
    if (!c) {
      if (stmt.ifExists) return none;
      throw new SmaltError('SMALT_ERROR', `no such connection: ${stmt.name}`);
    }
    const user = [...this.externals.values()].find((x) => String(x.options.connection ?? '').toLowerCase() === c.name.toLowerCase());
    if (user) throw new SmaltError('SMALT_ERROR', `connection ${c.name} is used by external table ${user.name}`);
    this.dirtySchema = true;
    this.removeCatalogRow(c.name, connectionKey(c.name));
    this.connections.delete(c.name.toLowerCase());
    this.schemaChanged();
    return none;
  }

  /** The connection named by an external table's or table function's `connection` option. */
  private connectionOf(options: Record<string, SqlValue>, label: string): ConnectionInfo | undefined {
    const name = options.connection;
    if (name === undefined || name === null) return undefined;
    const c = this.connections.get(String(name).toLowerCase());
    if (!c) throw new SmaltError('SMALT_ERROR', `${label}: no such connection: ${name}`);
    return { name: c.name, options: c.options };
  }

  /** What to fetch for an external table (reader options without location / connection). */
  private externalSourceOf(def: Omit<ExternalTableDef, 'sql' | 'columns'>, columns: ExternalColumn[] | undefined): ExternalSource {
    const { location, connection: _c, ...options } = def.options;
    if (typeof location !== 'string' || location === '') throw new SmaltError('SMALT_ERROR', `external table ${def.name}: location is required`);
    const fmt = formatOf(location, def.options, def.name);
    return { key: `table:${def.name.toLowerCase()}`, label: def.name, location, format: fmt.format, options, connection: this.connectionOf(def.options, def.name), columns };
  }

  private createExternalTable(stmt: CreateExternalTableStmt, sql: string): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    const lower = stmt.name.toLowerCase();
    if (stmt.ifNotExists && this.externals.has(lower)) return none;
    this.checkNewName(stmt.name, 'external');
    checkReaderOptions(stmt.with, new Set(['location', 'connection']), stmt.name);
    const seen = new Set<string>();
    for (const c of stmt.columns) {
      if (c.constraints.length > 0) throw new SmaltError('SMALT_ERROR', `external table ${stmt.name}: columns cannot have constraints`);
      if (seen.has(c.name.toLowerCase())) throw new SmaltError('SMALT_ERROR', `duplicate column name: ${c.name}`);
      seen.add(c.name.toLowerCase());
    }
    let columns: ExternalColumn[] = stmt.columns.map((c) => ({ name: c.name, declType: c.type ?? '' }));
    const source = this.externalSourceOf({ name: stmt.name, options: stmt.with }, columns.length ? columns : undefined);
    let text = sql;
    if (columns.length === 0) {
      // Columns inferred from the source now (fetched by the async API; Parquet: only its footer), and stored with the table.
      const data = this.external.data(schemaSourceOf(source));
      if (data.columns.length === 0) throw externalError(source, 'no columns found (the source is empty)');
      columns = data.columns.map((c) => ({ name: c.name, declType: c.declType || 'ANY' }));
      const cols = columns.map((c) => `${quoteIdent(c.name)} ${c.declType}`).join(', ');
      const opts = Object.entries(stmt.with).map(([k, v]) => `${quoteIdentIfNeeded(k)} = ${sqlLiteral(v)}`).join(', ');
      text = `CREATE EXTERNAL TABLE ${quoteIdent(stmt.name)} (${cols}) WITH (${opts})`;
    }
    this.dirtySchema = true;
    this.addCatalogRow('external', stmt.name, stmt.name, 0, text);
    this.externals.set(lower, { name: stmt.name, columns, options: stmt.with, sql: text });
    this.objectChanged(stmt.name);
    this.schemaChanged();
    return none;
  }

  /** @internal An external table as the planner scans it. */
  private externalTableScan(name: string): ExternalScan | undefined {
    const def = this.externals.get(name.toLowerCase());
    if (!def) return undefined;
    const source = this.externalSourceOf(def, def.columns);
    return {
      label: `${def.name} (${source.location})`,
      source,
      // Declared types are conversions, not guarantees (text that does not convert stays text).
      columns: def.columns.map((c) => ({ name: c.name, declType: c.declType, type: 'any' as StaticType })),
      rows: () => this.external.data(source).rows,
    };
  }

  /** @internal `read_csv(location, …)` / `read_json(location, …)`: columns come from the loaded data. */
  private externalFunctionScan(name: string, args: SqlValue[], named: Record<string, SqlValue>): ExternalScan | undefined {
    const source = this.externalFunctionSource(name, args, named);
    const data = this.external.data(schemaSourceOf(source));
    return { label: source.label, source, columns: data.columns, rows: () => this.external.data(source).rows };
  }

  /**
   * `read_csv` / `read_json` calls with literal arguments in `stmt` (not inside views): fetched up
   * front with the statement's other sources, instead of one by one as planning reaches them.
   */
  private literalExternalSources(stmt: Stmt): ExternalSource[] {
    const out: ExternalSource[] = [];
    const lit = (e: { kind: string; value?: SqlValue }): boolean => e.kind === 'literal';
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) return x.forEach(walk);
      if (typeof x !== 'object' || x === null || Object.getPrototypeOf(x) !== Object.prototype) return;
      const o = x as Record<string, unknown>;
      if (o.kind === 'function' && EXTERNAL_FUNCTIONS.has(o.name as string)) {
        const f = o as unknown as { name: string; args: { kind: string; value?: SqlValue }[]; named?: Record<string, { kind: string; value?: SqlValue }> };
        const named = Object.entries(f.named ?? {});
        if (f.args.every(lit) && named.every(([, e]) => lit(e))) {
          try {
            out.push(schemaSourceOf(this.externalFunctionSource(f.name, f.args.map((a) => a.value!), Object.fromEntries(named.map(([k, e]) => [k, e.value!])))));
          } catch {
            // Planning reports it.
          }
        }
      }
      for (const k of Object.keys(o)) walk(o[k]);
    };
    walk(stmt);
    return out;
  }

  /** What a `read_csv` / `read_json` call reads. */
  private externalFunctionSource(name: string, args: SqlValue[], named: Record<string, SqlValue>): ExternalSource {
    if (args.length !== 1 || typeof args[0] !== 'string') throw new SmaltError('SMALT_ERROR', `${name}() takes a location (text) and named options`);
    const location = args[0];
    const label = `${name}('${location}')`;
    checkReaderOptions(named, new Set(['connection']), label);
    const { connection: _c, ...options } = named;
    if (options.format === undefined || options.format === null) {
      options.format = name === 'read_json' ? 'json' : name === 'read_parquet' ? 'parquet' : /\.tsv([?#]|$)/i.test(location) ? 'tsv' : 'csv';
    }
    const fmt = formatOf(location, options, label);
    const key = `fn:${name}:${JSON.stringify([location, Object.entries(named).sort()], (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`;
    return { key, label, location, format: fmt.format, options, connection: this.connectionOf(named, label) };
  }

  private createView(stmt: CreateViewStmt, sql: string): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    if (stmt.temp && stmt.schema?.toLowerCase() === 'main') throw new SmaltError('SMALT_ERROR', 'temporary table name must be unqualified');
    // A view over TEMP objects is itself TEMP (as in SQLite); asked for in main, it is an error.
    const tempDep = stmt.temp || stmt.schema?.toLowerCase() === 'temp' ? undefined : this.tempDependency(stmt.select);
    if (tempDep && stmt.schema?.toLowerCase() === 'main') throw new SmaltError('SMALT_ERROR', `view ${stmt.name} cannot reference TEMP object ${tempDep}`);
    if (stmt.temp || stmt.schema?.toLowerCase() === 'temp' || tempDep) {
      const lower = stmt.name.toLowerCase();
      if (this.tempViews.has(lower)) {
        if (stmt.ifNotExists) return none;
        throw new SmaltError('SMALT_ERROR', `view ${stmt.name} already exists`);
      }
      const view: ViewSchema = { name: stmt.name, sql, columns: stmt.columns, select: stmt.select };
      this.tempViews.set(lower, view);
      this.tempSeq.set(view, this.nextTempSeq++);
      this.schemaVersion++; // re-plan statements; nothing is stored
      return none;
    }
    if (stmt.ifNotExists && this.catalog.get(stmt.name.toLowerCase())?.type === 'view') return none;
    this.checkNewName(stmt.name, 'view');
    this.dirtySchema = true;
    // Like SQLite, the body is not resolved until the view is used (it may reference tables created later).
    this.addCatalogRow('view', stmt.name, stmt.name, 0, sql);
    this.views.set(stmt.name.toLowerCase(), { name: stmt.name, sql, columns: stmt.columns, select: stmt.select });
    this.objectChanged(stmt.name);
    this.schemaChanged();
    return none;
  }

  private createTable(stmt: CreateTableStmt, sql: string, internal = false): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    const columnar = tableStorage(stmt) === 'columnar';
    const schema = stmt.schema?.toLowerCase();
    if (schema !== undefined && schema !== 'main' && schema !== 'temp') throw new SmaltError('SMALT_ERROR', `unknown database ${stmt.schema}`);
    if (stmt.temp && schema === 'main') throw new SmaltError('SMALT_ERROR', 'temporary table name must be unqualified');
    if (stmt.temp || schema === 'temp') {
      if (columnar) throw new SmaltError('SMALT_UNSUPPORTED', 'TEMP tables cannot be columnar');
      return this.createTempTable(stmt, sql);
    }
    if (stmt.ifNotExists && this.catalog.has(stmt.name.toLowerCase())) return none;
    if (!internal) this.checkNewName(stmt.name, 'table');
    this.dirtySchema = true;
    const root = BTree.create(this.pager);
    const { table, implicitIndexes } = buildTableSchema(stmt, sql, root);
    if (!internal) checkNewTable(stmt, table);
    if (columnar) {
      // Columnar tables are scanned, not probed: no secondary structures to keep in step.
      if (implicitIndexes.length > 0) throw new SmaltError('SMALT_UNSUPPORTED', 'columnar tables support no UNIQUE or PRIMARY KEY constraints other than INTEGER PRIMARY KEY');
      if (table.foreignKeys.length > 0) throw new SmaltError('SMALT_UNSUPPORTED', 'columnar tables cannot have foreign keys');
      if (!this.tables.has('smalt_columnar')) {
        this.createTable(parseOne(Database.COLUMNAR_SQL).stmt as CreateTableStmt, Database.COLUMNAR_SQL, true);
      }
      table.columnar = { segRoot: BTree.create(this.pager), delRoot: BTree.create(this.pager) };
      this.writeColumnarMeta(table.name, table.columnar);
    }
    for (const fk of table.foreignKeys) {
      if (this.tables.get(fk.table.toLowerCase())?.columnar) throw new SmaltError('SMALT_UNSUPPORTED', `foreign keys cannot reference columnar table ${fk.table}`);
    }
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

  /**
   * CREATE TEMP TABLE: lives in the memory store, outside the persisted catalog, for this
   * connection only (like SQLite's temp schema); it shadows a main table of the same name.
   */
  private createTempTable(stmt: CreateTableStmt, sql: string): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    const lower = stmt.name.toLowerCase();
    if (this.tempTables.has(lower)) {
      if (stmt.ifNotExists) return none;
      throw new SmaltError('SMALT_ERROR', `table ${stmt.name} already exists`);
    }
    if (lower.startsWith('smalt_') || lower.startsWith('sqlite_')) throw new SmaltError('SMALT_ERROR', `object name reserved for internal use: ${stmt.name}`);
    const { table, implicitIndexes } = buildTableSchema(stmt, sql, this.createTree(true));
    checkNewTable(stmt, table);
    table.temp = true;
    implicitIndexes.forEach((spec, i) => {
      const name = autoIndexName(table.name, i + 1);
      table.indexes.push({ name, table: table.name, rootPage: this.createTree(true), columns: spec.columns, unique: true, origin: spec.origin, constraintName: spec.constraintName });
    });
    this.tempTables.set(lower, table);
    this.tempSeq.set(table, this.nextTempSeq++);
    for (const idx of table.indexes) this.tempSeq.set(idx, this.nextTempSeq++);
    this.memDirty = true;
    const main = this.tables.get(lower);
    if (main && !main.temp) this.shadowedMain.set(lower, main);
    this.tables.set(lower, table);
    for (const idx of table.indexes) this.indexes.set(idx.name.toLowerCase(), idx);
    this.schemaVersion++;
    return none;
  }

  private createIndex(stmt: CreateIndexStmt, sql: string): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    if (stmt.ifNotExists && this.catalog.has(stmt.name.toLowerCase())) return none;
    // The qualifier names the index's schema, which must be its table's (as in SQLite).
    const schema = stmt.schema?.toLowerCase();
    if (schema !== undefined && schema !== 'main' && schema !== 'temp') throw new SmaltError('SMALT_ERROR', `unknown database ${stmt.schema}`);
    const table = schema === undefined ? this.tables.get(stmt.table.toLowerCase()) : this.getTable(stmt.table, schema);
    if (!table) {
      if (schema === 'temp' && this.getTable(stmt.table, 'main')) throw new SmaltError('SMALT_ERROR', `cannot create a TEMP index on non-TEMP table "${stmt.table}"`);
      if (this.views.has(stmt.table.toLowerCase())) throw new SmaltError('SMALT_ERROR', 'views may not be indexed');
      if (schema !== 'temp' && this.externals.has(stmt.table.toLowerCase())) throw new SmaltError('SMALT_ERROR', `table ${stmt.table} may not be indexed`);
      throw new SmaltError('SMALT_ERROR', `no such table: ${schema === 'main' ? 'main.' : ''}${stmt.table}`);
    }
    if (table.matview?.storage === 'columnar') throw new SmaltError('SMALT_ERROR', `columnar materialized view ${table.name} cannot be indexed (zone maps prune its scans)`);
    if (table.columnar) throw new SmaltError('SMALT_UNSUPPORTED', `columnar table ${table.name} cannot be indexed (zone maps prune its scans)`);
    if (table.temp) {
      if (this.indexes.has(stmt.name.toLowerCase())) throw new SmaltError('SMALT_ERROR', `index ${stmt.name} already exists`);
    } else {
      this.checkNewName(stmt.name, 'index');
      // One namespace with TEMP indexes too (DROP INDEX resolves names through it).
      if (this.indexes.has(stmt.name.toLowerCase())) throw new SmaltError('SMALT_ERROR', `index ${stmt.name} already exists`);
    }
    this.dirtySchema = !table.temp;
    // A temp index changes in-memory schema only: if anything below fails (a UNIQUE violation), the
    // statement's failure path must restore the temp maps along with the rolled-back pages.
    if (table.temp) this.memDirty = true;
    const memory = table.rootPage >= MEM_BASE;
    const root = this.createTree(memory);
    const idx = buildIndexSchema(stmt, sql, table, root);
    this.prepareIndex(table, idx);
    this.populateIndex(table, idx, root);
    table.indexes.push(idx);
    this.indexes.set(idx.name.toLowerCase(), idx);
    if (idx.unique) this.checkUniqueIndex(table, idx); // existing rows may already collide
    if (table.temp) {
      this.tempSeq.set(idx, this.nextTempSeq++);
      this.schemaVersion++;
      return none;
    }
    const mv = memory ? this.memViews.get(table.name.toLowerCase()) : undefined;
    if (mv) {
      mv.indexRoots.set(idx.name.toLowerCase(), root);
      this.memDirty = true;
    }
    this.addCatalogRow('index', idx.name, table.name, memory ? MEM_BASE : root, sql);
    this.schemaChanged();
    return none;
  }

  /**
   * Fill the empty index tree at `root` from the rows of `table` (expression values computed,
   * partial-index rows filtered): entries are packed, sorted and bulk-loaded.
   */
  private populateIndex(table: TableSchema, idx: IndexSchema, root: number): void {
    const tree = this.freshTree(table.rootPage);
    const itree = this.freshTree(root);
    const reader = new RecordReader(table.layout, table.recordDefaults);
    const w = new TableWriter(table, this.pager, (r) => this.tree(r));
    const enc = new KeyEncoder();
    // Entries packed into one buffer (entry i = keys[offs[i] .. offs[i + 1])): no object per entry.
    let keys = new Uint8Array(1 << 16);
    let offs = new Int32Array(1024);
    let count = 0;
    let used = 0;
    const push = (k: Uint8Array): void => {
      if (used + k.length > keys.length) {
        const next = new Uint8Array(Math.max(keys.length * 2, used + k.length));
        next.set(keys.subarray(0, used));
        keys = next;
      }
      if (count + 2 > offs.length) {
        const next = new Int32Array(offs.length * 2);
        next.set(offs);
        offs = next;
      }
      keys.set(k, used);
      offs[count] = used;
      used += k.length;
      count++;
      offs[count] = used;
    };
    const c = tree.cursor();
    const row: SqlValue[] = new Array(table.columns.length).fill(null);
    try {
      for (let ok = c.first(); ok; ok = c.next()) {
        c.loadKey();
        const rowid = readRowidKey(c.keyBytes, c.keyOffset);
        c.loadValue();
        reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
        if (idx.eval) {
          // Expression / partial index: decode only the columns it reads.
          for (const i of idx.eval.deps) row[i] = i === table.rowidAlias ? rowid : reader.column(i);
          const k = w.indexEntry(idx, row, rowid);
          if (k) push(k);
          continue;
        }
        // Plain columns: decode only the indexed ones.
        enc.reset();
        for (const ic of idx.columns) enc.add(ic.column === table.rowidAlias ? rowid : reader.column(ic.column), ic);
        enc.addRowid(rowid);
        push(enc.view());
      }
    } finally {
      c.close();
    }
    // Sort, then build the tree bottom-up from the sorted entries.
    itree.bulkLoadKeys(keys, offs, sortPackedKeys(keys, offs, count));
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
    // Columns read by the index (plain columns, expression and WHERE references).
    const deps = new Set<number>();
    const walk = (x: unknown): void => {
      if (Array.isArray(x)) return x.forEach(walk);
      if (typeof x !== 'object' || x === null || Object.getPrototypeOf(x) !== Object.prototype) return;
      const o = x as Record<string, unknown>;
      if (o.kind === 'column' && typeof o.name === 'string') {
        const ci = findColumn(table, o.name);
        if (ci >= 0) deps.add(ci);
      }
      for (const k of Object.keys(o)) walk(o[k]);
    };
    for (const c of idx.columns) {
      if (c.expr) walk(c.expr);
      else deps.add(c.column);
    }
    if (idx.where) walk(idx.where);
    idx.eval = {
      cols: cols.map((f) => (f ? (row: readonly SqlValue[], rowid: number | bigint) => f(load(row, rowid)) : null)),
      where: where ? (row, rowid) => truthy(where!(load(row, rowid))) === true : undefined,
      deps: [...deps],
    };
  }

  private checkUniqueIndex(table: TableSchema, idx: IndexSchema): void {
    const itree = this.freshTree(idx.rootPage);
    const c = itree.cursor();
    let prev: Uint8Array | null = null;
    try {
      for (let ok = c.first(); ok; ok = c.next()) {
        const k = c.key();
        const prefix = k.subarray(0, rowidSuffixStart(k, k.length));
        if (prev && prefix.length === prev.length && prefix.every((b, i) => b === prev![i]) && !prefixHasNull(prefix, idx.columns)) {
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
    const kindOf = (t: CatalogEntry['type']): string => (t === 'matview' ? 'materialized view' : t === 'external' ? 'external table' : t);
    if (stmt.objectType === 'connection') return this.dropConnection(stmt);
    if (existing && stmt.objectType !== 'index' && existing.type !== 'index' && kindOf(existing.type) !== stmt.objectType) {
      throw new SmaltError('SMALT_ERROR', `use DROP ${kindOf(existing.type).toUpperCase()} to delete ${kindOf(existing.type)} ${existing.name}`);
    }
    if (stmt.objectType === 'external table') {
      const x = this.externals.get(lower);
      if (!x) {
        if (stmt.ifExists) return none;
        throw new SmaltError('SMALT_ERROR', `no such external table: ${stmt.name}`);
      }
      this.dirtySchema = true;
      this.objectChanged(x.name);
      this.removeCatalogRow(x.name);
      this.externals.delete(lower);
      this.schemaChanged();
      return none;
    }
    if (stmt.objectType === 'materialized view') {
      const mv = this.tables.get(lower);
      if (!mv?.matview) {
        if (stmt.ifExists) return none;
        throw new SmaltError('SMALT_ERROR', `no such materialized view: ${stmt.name}`);
      }
      this.dirtySchema = true;
      for (const idx of mv.indexes) {
        this.freshTree(idx.rootPage).destroy();
        this.removeCatalogRow(idx.name);
        this.indexes.delete(idx.name.toLowerCase());
      }
      this.objectChanged(mv.name);
      this.freshTree(mv.rootPage).destroy();
      this.removeCatalogRow(mv.name);
      this.writeMatviewMeta(mv.name, null);
      this.writeExternalCache(mv.name, []);
      if (this.memViews.delete(lower)) this.memDirty = true;
      this.tables.delete(lower);
      this.schemaChanged();
      return none;
    }
    if (stmt.objectType === 'view' && this.tempViews.has(lower) && (!stmt.schema || stmt.schema.toLowerCase() === 'temp')) {
      this.tempViews.delete(lower);
      this.schemaVersion++;
      return none;
    }
    if (stmt.objectType === 'view') {
      const view = this.views.get(lower);
      if (!view) {
        if (stmt.ifExists) return none;
        throw new SmaltError('SMALT_ERROR', `no such view: ${stmt.name}`);
      }
      this.dirtySchema = true;
      this.objectChanged(view.name);
      this.removeCatalogRow(view.name);
      this.views.delete(lower);
      this.schemaChanged();
      return none;
    }
    if (stmt.objectType === 'table' && this.tempTables.has(lower) && stmt.schema?.toLowerCase() !== 'main') {
      const table = this.tempTables.get(lower)!;
      for (const idx of table.indexes) this.freshTree(idx.rootPage).destroy();
      this.freshTree(table.rootPage).destroy();
      this.tempTables.delete(lower);
      this.memDirty = true;
      this.loadSchema(); // un-shadow a main table of the same name
      return none;
    }
    if (stmt.objectType === 'table') {
      // Not a temp table (handled above): the main table, also when a TEMP table shadows it.
      const table = stmt.schema?.toLowerCase() === 'temp' ? undefined : this.getTable(lower, 'main');
      if (!table) {
        if (stmt.ifExists) return none;
        throw new SmaltError('SMALT_ERROR', `no such table: ${stmt.name}`);
      }
      // Like SQLite, dropping a parent table first deletes its rows (applying foreign-key actions).
      if (this.fk.enabled && this.tables.size > 1 && [...this.tables.values()].some((t) => t !== table && t.foreignKeys.some((f) => f.table.toLowerCase() === lower))) {
        this.fk.sync(this.schemaVersion);
        this.internal(`DELETE FROM main."${table.name.replace(/"/g, '""')}"`, []);
      }
      this.dirtySchema = true;
      this.objectChanged(table.name);
      for (const idx of table.indexes) {
        this.freshTree(idx.rootPage).destroy();
        this.removeCatalogRow(idx.name);
        if (this.indexes.get(idx.name.toLowerCase()) === idx) this.indexes.delete(idx.name.toLowerCase());
      }
      this.freshTree(table.rootPage).destroy();
      if (table.columnar) {
        this.freshTree(table.columnar.segRoot).destroy();
        this.freshTree(table.columnar.delRoot).destroy();
        this.writeColumnarMeta(table.name, null);
      }
      this.removeCatalogRow(table.name);
      if (this.tables.get(lower) === table) this.tables.delete(lower);
      else this.shadowedMain.delete(lower); // a TEMP table of the same name stays
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
      const owner = this.tables.get(idx.table.toLowerCase())!;
      if (owner.temp) {
        this.freshTree(idx.rootPage).destroy();
        owner.indexes = owner.indexes.filter((i) => i !== idx);
        this.indexes.delete(lower);
        this.memDirty = true;
        this.schemaVersion++;
        return none;
      }
      this.memViews.get(owner.name.toLowerCase())?.indexRoots.delete(lower);
      this.dirtySchema = true;
      this.freshTree(idx.rootPage).destroy();
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
    if (stmt.schema && !['main', 'temp'].includes(stmt.schema.toLowerCase())) throw new SmaltError('SMALT_ERROR', `unknown database ${stmt.schema}`);
    const lower = stmt.table.toLowerCase();
    if (CATALOG_NAMES.has(lower) || lower.startsWith('smalt_') || lower.startsWith('sqlite_')) {
      throw new SmaltError('SMALT_ERROR', `table ${CATALOG_NAMES.has(lower) ? 'sqlite_master' : stmt.table} may not be altered`);
    }
    if (this.views.has(lower)) {
      throw new SmaltError('SMALT_ERROR', stmt.action.kind === 'addColumn' ? 'Cannot add a column to a view' : `view ${stmt.table} may not be altered`);
    }
    const table = this.getTable(lower, stmt.schema);
    if (!table && stmt.schema?.toLowerCase() !== 'temp' && this.externals.has(lower)) throw new SmaltError('SMALT_ERROR', `table ${stmt.table} may not be altered`);
    if (!table) throw new SmaltError('SMALT_ERROR', `no such table: ${stmt.schema ? `${stmt.schema}.` : ''}${stmt.table}`);
    // TEMP tables have no catalog rows for ALTER to rewrite (main.t reaches a shadowed main table).
    if (table.temp) throw new SmaltError('SMALT_UNSUPPORTED', `ALTER TABLE is not supported for TEMP table ${table.name}`);
    if (table.matview) throw new SmaltError('SMALT_ERROR', `materialized view ${table.name} may not be altered`);
    if (table.columnar) throw new SmaltError('SMALT_UNSUPPORTED', `ALTER TABLE is not supported for columnar table ${table.name} yet`);
    this.objectChanged(table.name);
    if (stmt.action.kind === 'renameTable') this.objectChanged(stmt.action.newName);
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

  private hasRows(table: TableSchema): boolean {
    const c = this.tree(table.rootPage).cursor();
    try {
      return c.first();
    } finally {
      c.close();
    }
  }

  private addColumn(table: TableSchema, def: ColumnDef, alterSql: string): void {
    if (findColumn(table, def.name) >= 0) throw new SmaltError('SMALT_ERROR', `duplicate column name: ${def.name}`);
    const cons = def.constraints;
    if (cons.some((c) => c.kind === 'primaryKey')) throw new SmaltError('SMALT_ERROR', 'Cannot add a PRIMARY KEY column');
    if (cons.some((c) => c.kind === 'unique')) throw new SmaltError('SMALT_ERROR', 'Cannot add a UNIQUE column');
    if (cons.some((c) => c.kind === 'generated')) throw new SmaltError('SMALT_UNSUPPORTED', 'generated columns are not supported yet');
    checkConstraintExprs([def], [], `error in table ${table.name} after add column: `);
    const dflt = cons.find((c) => c.kind === 'default') as { expr: Expr } | undefined;
    // As in SQLite: with foreign keys on, existing rows would get a default that may reference nothing.
    const nonNullDefault = dflt !== undefined && !(dflt.expr.kind === 'literal' && dflt.expr.value === null);
    if (this.fk.enabled && nonNullDefault && cons.some((c) => c.kind === 'references') && this.hasRows(table)) {
      throw new SmaltError('SMALT_ERROR', 'Cannot add a REFERENCES column with non-NULL default value');
    }
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
    if (schema && !['main', 'temp'].includes(schema.toLowerCase())) throw new SmaltError('SMALT_ERROR', `unknown database ${schema}`);
    const lower = name.toLowerCase();
    if (CATALOG_NAMES.has(lower) || lower === 'smalt_stat' || lower === 'smalt_matview' || lower === 'smalt_columnar' || lower === 'smalt_extcache') throw new SmaltError('SMALT_ERROR', `table ${name} may not be modified`);
    const t = this.getTable(lower, schema);
    if (!t) {
      if (this.views.has(lower)) throw new SmaltError('SMALT_ERROR', `cannot modify ${name} because it is a view`);
      // External tables are read-only (SQLite's wording for tables that cannot be written).
      if (schema?.toLowerCase() !== 'temp' && this.externals.has(lower)) throw new SmaltError('SMALT_ERROR', `table ${name} may not be modified`);
      throw new SmaltError('SMALT_ERROR', `no such table: ${name}`);
    }
    if (t.matview) throw new SmaltError('SMALT_ERROR', `cannot change materialized view "${t.name}" (use REFRESH MATERIALIZED VIEW)`);
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
    if (stmt.source.kind === 'default' && stmt.columns) {
      throw new SmaltError('SMALT_ERROR', `0 values for ${stmt.columns.length} columns`);
    }
    // DEFAULT VALUES supplies no values: every column takes its default.
    const targets: number[] = stmt.source.kind === 'default'
      ? []
      : stmt.columns
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
          try {
            root.open(r);
            while (root.next()) buf.push(plan.outRegs.map((g) => r[g]));
          } finally {
            root.close();
          }
          for (const v of buf) emit(v, reals);
        } else {
          try {
            root.open(r);
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
      w.updateRow(old, other, next, newRowid);
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
    // The resolved target's own schema: a TEMP table and a main table may share the name.
    const target: FromItem = { kind: 'table', schema: table.temp ? 'temp' : 'main', name: table.name, alias, pos: 0, end: 0 };
    // UPDATE ... FROM: the target joined with the FROM sources (the WHERE holds the join conditions).
    const item: FromItem = from ? { kind: 'join', joinType: 'INNER', natural: false, left: target, right: from, pos: 0, end: 0 } : target;
    const root = planner.planFrom(item, where, scope);
    const cs = planner.compileScope(scope);
    const q = alias ?? table.name;
    // Rows are re-read by rowid before they change, so the scan only decodes what WHERE (and, with
    // FROM, the SET expressions evaluated during the join) reference.
    const colRegs = planner.untracked(() => table.columns.map((c) => cs.resolveColumn({ kind: 'column', table: q, name: c.name, pos: 0, end: 0 }).reg));
    const rowidReg = cs.resolveColumn({ kind: 'column', table: q, name: 'rowid', pos: 0, end: 0 }).reg;
    return { root, colRegs, rowidReg, scope: cs };
  }

  private compileUpdate(stmt: UpdateStmt, planner: Planner): { exec: (r: SqlValue[], out?: SqlValue[][]) => RunResult; returning?: { columns: string[]; types: StaticType[] } } {
    if (stmt.orderBy.length || stmt.limit) throw new SmaltError('SMALT_UNSUPPORTED', 'UPDATE ... ORDER BY/LIMIT is not supported');
    const table = this.targetTable(stmt.table, stmt.schema);
    const { root, colRegs, rowidReg, scope } = this.planTarget(table, stmt.alias, stmt.where, planner, stmt.from, stmt.with);
    // Target rowids are collected and sorted before any change: scan order is not observable.
    if (!stmt.from) markUnordered(root);
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
      try {
        root.open(r);
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
        writer.updateRow(old, rowid, next, newRowid);
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
        this.touchTable(table);
        const n = table.columnar ? this.rewriteColumnar(table, false) : new TableWriter(table, this.pager, (root) => this.tree(root)).truncate();
        this.lastChanges = n;
        this.total += n;
        return { changes: n, lastInsertRowid: this.lastRowid };
      }
      const pending: (number | bigint)[] = [];
      try {
        root.open(r);
        while (root.next()) pending.push(r[rowidReg] as number | bigint);
      } finally {
        root.close();
      }
      const writer = this.writerFor(table);
      let changes = 0;
      for (const rowid of pending) {
        const row = writer.readRow(rowid);
        if (row === null || !writer.deleteRow(rowid, row)) continue;
        changes++;
        if (ret && out) {
          for (let i = 0; i < ncols; i++) r[oldBase + i] = row[i];
          r[oldRowid] = rowid;
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
    /** An external table named by the argument (it has columns, but no indexes or foreign keys). */
    const externalArg = (): ExternalTableDef | undefined => {
      const n = arg();
      return n && !this.getTable(n) ? this.externals.get(n.toLowerCase()) : undefined;
    };
    switch (name) {
      case 'table_info':
      case 'table_xinfo': {
        // table_xinfo adds `hidden`: always 0 (normal column), as smaltdb has no hidden or generated columns.
        const xinfo = name === 'table_xinfo';
        return ro(['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk', ...(xinfo ? ['hidden'] : [])], () => {
          const ext = externalArg();
          if (ext) return ext.columns.map((c, i) => [i, c.name, c.declType, 0, null, 0, ...(xinfo ? [0] : [])]);
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
            ...(xinfo ? [0] : []),
          ]);
        });
      }
      case 'index_list':
        return ro(['seq', 'name', 'unique', 'origin', 'partial'], () => {
          if (externalArg()) return [];
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
          if (externalArg()) return [];
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
    /** A boolean setting's value, SQLite's spellings: 1 / on / true / yes (anything else is off). */
    const pragmaBool = (): boolean => ['1', 'on', 'true', 'yes'].includes(arg()?.toLowerCase() ?? '');
    /** A setting change: runs `apply` when executed, returns no rows. */
    const setter = (apply: () => void): Omit<Program, 'regCount'> => ({
      readonly: true,
      columns: [],
      columnTypes: [],
      exec: () => {
        apply();
        return { changes: 0, lastInsertRowid: this.lastRowid };
      },
    });
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
          const on = pragmaBool();
          return setter(() => {
            // Like SQLite, the setting cannot change inside a transaction.
            if (this.autocommit && on !== this.fk.enabled) {
              this.fk.enabled = on;
              this.schemaVersion++; // re-plan statements compiled under the other setting
            }
          });
        }
        return ro(['foreign_keys'], () => [[this.fk.enabled ? 1 : 0]]);
      }
      case 'work_mem': {
        if (stmt.value) {
          const v = Number(arg());
          if (!Number.isInteger(v) || v < 0) throw new SmaltError('SMALT_ERROR', 'work_mem must be a non-negative number of bytes');
          return setter(() => void (this.spill.workMem = v));
        }
        return ro(['work_mem'], () => [[this.spill.workMem]]);
      }
      case 'matview_rewrite': {
        if (stmt.value) {
          const on = pragmaBool();
          return setter(() => this.setMatviewRewrite(on));
        }
        return ro(['matview_rewrite'], () => [[this.matviewRewriteOn ? 1 : 0]]);
      }
      case 'parallel_aggregates': {
        if (stmt.value) {
          const on = pragmaBool();
          return setter(() => void (this.parallelAggregates = on));
        }
        return ro(['parallel_aggregates'], () => [[this.parallelAggregates ? 1 : 0]]);
      }
      case 'spill_bytes':
        // Bytes written to the scratch file since the database was opened.
        return ro(['spill_bytes'], () => [[this.spill.bytesWritten]]);
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
              const pages = this.freshTree(root).checkIntegrity().pages;
              // Memory-store trees are checked, but their pages are not the file's.
              return root >= MEM_BASE ? 0 : pages;
            } catch (e) {
              errors.push(`${what}: ${(e as Error).message}`);
              return 0;
            }
          };
          let pages = 1 + check(this.pager.catalogRoot, 'smalt_schema');
          // Main tables shadowed by a TEMP table of the same name still own their pages.
          for (const t of [...this.tables.values(), ...this.shadowedMain.values()]) {
            pages += check(t.rootPage, `table ${t.name}`);
            if (t.columnar) {
              pages += check(t.columnar.segRoot, `segments of ${t.name}`);
              pages += check(t.columnar.delRoot, `deletions of ${t.name}`);
            }
            const n = this.freshTree(t.rootPage).count();
            for (const i of t.indexes) {
              pages += check(i.rootPage, `index ${i.name}`);
              const m = this.freshTree(i.rootPage).count();
              if (m !== n && !i.where) errors.push(`index ${i.name} has ${m} entries, table ${t.name} has ${n} rows`);
            }
          }
          if (pages + this.pager.freelistCount !== this.pager.pageCount) {
            errors.push(`page accounting: ${pages} in use + ${this.pager.freelistCount} free != ${this.pager.pageCount} total`);
          }
          return errors.length ? errors.map((e) => [e]) : [['ok']];
        });
      case 'compact': {
        // Columnar table: rewrite its segments with every live row (delta included), dropping deletions.
        const name = arg();
        const t = name ? this.tables.get(name.toLowerCase()) : undefined;
        if (!t?.columnar) throw new SmaltError('SMALT_ERROR', `PRAGMA compact needs a columnar table${name ? `, not ${name}` : ''}`);
        return { readonly: false, columns: [], columnTypes: [], exec: () => (this.rewriteColumnar(t, true), { changes: 0, lastInsertRowid: this.lastRowid }) };
      }
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
      default:
        throw new SmaltError('SMALT_UNSUPPORTED', `PRAGMA ${stmt.name} is not supported yet`);
    }
  }
}

/**
 * Order of packed keys (key i = keys[offs[i] .. offs[i + 1])). Radix-sorts by each key's first 4
 * bytes, then fixes runs that share the 4-byte prefix with a byte comparison (entries arrive in
 * rowid order, so runs are often sorted already).
 */
function sortPackedKeys(keys: Uint8Array, offs: Int32Array, count: number): Int32Array {
  const order = new Int32Array(count);
  const cmp = (x: number, y: number): number => compareRanges(keys, offs[x], offs[x + 1] - offs[x], keys, offs[y], offs[y + 1] - offs[y]);
  const prefix = new Uint32Array(count);
  for (let i = 0; i < count; i++) {
    const o = offs[i];
    const n = offs[i + 1] - o;
    prefix[i] = ((n > 0 ? keys[o] << 24 : 0) | (n > 1 ? keys[o + 1] << 16 : 0) | (n > 2 ? keys[o + 2] << 8 : 0) | (n > 3 ? keys[o + 3] : 0)) >>> 0;
  }
  // Stable LSD radix sort on the prefix, one byte per pass (ties keep insertion order).
  let src = order;
  for (let i = 0; i < count; i++) src[i] = i;
  let dst = new Int32Array(count);
  const counts = new Int32Array(256);
  for (let shift = 0; shift < 32; shift += 8) {
    counts.fill(0);
    for (let i = 0; i < count; i++) counts[(prefix[i] >>> shift) & 255]++;
    if (counts[(prefix[0] >>> shift) & 255] === count) continue; // all in one bucket
    let sum = 0;
    for (let k = 0; k < 256; k++) {
      const c = counts[k];
      counts[k] = sum;
      sum += c;
    }
    for (let i = 0; i < count; i++) {
      const e = src[i];
      dst[counts[(prefix[e] >>> shift) & 255]++] = e;
    }
    const t = src;
    src = dst;
    dst = t;
  }
  if (src !== order) order.set(src);
  // Runs with an equal prefix: check, and sort them by full key when needed.
  let a = 0;
  while (a < count) {
    let b = a + 1;
    while (b < count && prefix[order[b]] === prefix[order[a]]) b++;
    if (b - a > 1) {
      // Inline byte comparison of neighbours (entries usually arrive sorted within a run).
      let sorted = true;
      for (let i = a + 1; i < b && sorted; i++) {
        const x = order[i - 1];
        const y = order[i];
        let px = offs[x] + 4;
        let py = offs[y] + 4;
        const ex = offs[x + 1];
        const ey = offs[y + 1];
        while (px < ex && py < ey && keys[px] === keys[py]) {
          px++;
          py++;
        }
        if (px < ex && (py === ey || keys[px] > keys[py])) sorted = false;
      }
      if (!sorted) order.subarray(a, b).sort(cmp);
    }
    a = b;
  }
  return order;
}

function prefixHasNull(prefix: Uint8Array, cols: readonly KeyColumn[]): boolean {
  try {
    return decodeKey(prefix, cols).some((v) => v === null);
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

  private checkedAt = '';

  private prog(): Program {
    if (this.program === null || this.version !== this.db.schemaVersion || this.statsDrifted(this.program)) {
      this.program = this.db.compile(this.parsed);
      this.version = this.db.schemaVersion;
      this.checkedAt = this.db.changeStamp();
    }
    return this.program;
  }

  /**
   * After data changes (checked at most once per commit), re-plan if any table the plan costed has
   * grown or shrunk 4x or more: a plan made for an empty table should not survive it filling up.
   */
  private statsDrifted(p: Program): boolean {
    const cc = this.db.changeStamp();
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

  /**
   * External sources this statement reads (M8). Throws SMALT_ASYNC_REQUIRED when planning itself
   * needs external data (a `read_csv` call, whose columns come from the file).
   */
  get externalSources(): ExternalSource[] {
    return this.prog().externals ?? [];
  }

  /** Static result types ('int', 'real', 'text', ... or 'any' when unknown). */
  get columnTypes(): StaticType[] {
    return this.prog().columnTypes;
  }

  get readonly(): boolean {
    return this.prog().readonly;
  }

  /** Reads TEMP tables or memory-resident views (parallel readers cannot see them). */
  get usesMemoryObjects(): boolean {
    // Memory objects come and go with DDL, which bumps the schema version.
    if (this.memoryUse?.version !== this.db.schemaVersion) this.memoryUse = { version: this.db.schemaVersion, value: this.db.usesMemoryObjects(this.parsed) };
    return this.memoryUse.value;
  }
  private memoryUse: { version: number; value: boolean } | null = null;

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
      try {
        root.open(regs);
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
      try {
        plan.root.open(regs);
      } catch (e) {
        // Operators that work in open() (sorts, hash builds) may hold pages: release them.
        plan.root.close();
        throw e;
      }
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

/** A value can be stored in a column of this type without conversion (materialized views keep query results exact). */
function fitsStorage(v: SqlValue, t: string): boolean {
  if (v === null) return true;
  switch (t) {
    case 'INTEGER':
      return typeof v === 'bigint' || (typeof v === 'number' && Number.isInteger(v));
    case 'REAL':
      return typeof v === 'number';
    case 'TEXT':
      return typeof v === 'string';
    case 'BLOB':
      return v instanceof Uint8Array;
    default:
      return true;
  }
}

function describeValue(v: SqlValue): string {
  if (typeof v === 'string') return 'TEXT';
  if (v instanceof Uint8Array) return 'BLOB';
  return typeof v === 'number' && !Number.isInteger(v) ? 'REAL' : 'INTEGER';
}

/** Runtime state of a memory-resident materialized view. */
interface MemView {
  root: number;
  /** Index name (lower case) -> root. */
  indexRoots: Map<string, number>;
  populated: boolean;
  refreshedAt: string | null;
  fresh: boolean;
}

/** Memory-object state at a transaction / savepoint / statement boundary. */
interface MemSnapshot {
  temps: [string, TableSchema, IndexSchema[]][];
  views: [string, MemView][];
}

/** `CREATE TABLE … WITH (storage = 'row' | 'columnar')` (validates the options). */
function tableStorage(stmt: CreateTableStmt): 'row' | 'columnar' {
  const opts = stmt.with ?? {};
  for (const k of Object.keys(opts)) if (k !== 'storage') throw new SmaltError('SMALT_ERROR', `unknown table option: ${k}`);
  const storage = String(opts.storage ?? 'row').toLowerCase();
  if (storage !== 'row' && storage !== 'columnar') throw new SmaltError('SMALT_ERROR', `storage must be 'row' or 'columnar'`);
  return storage;
}

/** Snapshot of no memory objects (shared: restoring it creates fresh maps). */
const EMPTY_MEM_SNAPSHOT: MemSnapshot = { temps: [], views: [] };

/** A query analyzed for morsel execution, with its compiled merge statement (per schema version). */
interface MorselEntry {
  version: number;
  parsed: ParsedStatement;
  q: MorselQuery;
  types?: StaticType[];
  final?: Statement;
}
