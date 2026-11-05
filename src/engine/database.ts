import {
  ConstraintError,
  type IndexEval,
  type IndexSchema,
  type MatViewInfo,
  type TableSchema,
  storageTypeFor,
  autoIndexName,
  indexSchemaFromDef,
  tableSchemaFromDef,
  coerceForColumn,
  findColumn,
  isColumnar,
} from './catalog/schema.js';
import { MisuseError, SmaltError } from './errors.js';
import { type StaticType, staticTypeOfStorage, truthy } from './exec/convert.js';
import type { ConflictAction, PlanOp } from './plan/ops.js';
import { type EncodedPlan, canonicalJSON, decodeData, decodePlan, encodeData, encodePlan, planFromJSON, planToJSON } from './plan/codec.js';
import { type PlanStatementInput, paramCount, toBoundStatement } from './plan/statement.js';
import { normalizePlan, normalizeWrite } from './exec/plan-normalize.js';
import { type ValidateCatalog, validatePlan } from './plan/validate.js';
import { type PlanExpr, forEachCol, typeOf } from './plan/expr.js';
import type { CollationName } from './plan/types.js';
import { type Compiled, type Fn } from './exec/expr.js';
import { type FunctionContext, aggregateFunctions, pureFunctionContext, scalarFunctions } from './exec/functions.js';
import { type ExecState, type Operator, explainAnalyze, explainRows } from './exec/operators.js';
import { type ExternalScan, type PhysicalEnv, Planner, type QueryPlan, Registers, type ResultColumnInfo } from './exec/planner.js';
import { DEFAULT_WORK_MEM, SpillArea, openSpillFile } from './exec/spill.js';
import { COMPACT_ROWS, ColumnarTableWriter, deletedBitmap, loadDeleted } from './exec/columnar-table.js';
import { type PlanMorsels, planMorsels } from './exec/plan-morsel.js';
import { toPlan } from './sql/frontend/select.js';
import { bindStoredTableExprs } from './sql/frontend/ddl.js';
import { bindStatement } from './sql/frontend/bind.js';
import type { BoundQuery, BoundStatement, BoundTransaction, BoundWrite } from './plan/bound.js';
import type { AlterAction, ColumnDef as ColumnDefinition, ExprDef, SchemaOp, Source, SourceEditor, TableDef } from './plan/schema.js';
import { SYSTEM_TABLES, type StoredDef, type StoredText, type SystemTableName, decodeDef, encodeDef, isSystemTable, systemTableSql } from './catalog/stored.js';
import type { BindContext } from './plan/bind-context.js';
import { type PlanMatview, matchMatviews } from './exec/plan-mv-match.js';
import { type ConflictMode, TableWriter, constraintError } from './exec/write.js';
import type { ReaderSettings } from '../shared/protocol.js';
import type { CreateViewStmt, ParsedStatement, SelectStmt, Stmt } from './sql/ast.js';
import { parse, parseOne } from './sql/parser.js';
import {
  AsyncRequiredError,
  type ConnectionInfo,
  type ExternalColumn,
  type ExternalSource,
  ExternalRegistry,
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
import { quoteIdent as quoteIdentIfNeeded } from './sql/frontend/source-edit.js';
import { sqlLanguage } from './sql/language.js';
import type { SmaltLanguage } from './plan/language.js';
import { ForeignKeys } from './exec/fk.js';
import { PluginRegistry, type SmaltPlugin } from './plugin.js';
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
export type BindParams = readonly (SqlValue | boolean | undefined)[] | Readonly<Record<string, SqlValue | boolean>>;

export interface DatabaseOptions extends PagerOptions {
  /** Plugins to install (ADR 0012), e.g. `@smaltdb/parquet`. */
  plugins?: readonly SmaltPlugin[];
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

const CATALOG_NAMES = new Set(['smalt_schema', 'sqlite_schema', 'sqlite_master']);

/** A view: its source in its language, bound where the view is read (the SQL front end merges it into the query). */
export interface ViewSchema {
  name: string;
  source: Source;
  columns?: string[];
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

/** For formats that read only what they need (Parquet), the source of its schema only (the footer): what planning and column inference need. */
const schemaSourceOf = (s: ExternalSource): ExternalSource => (s.pushdown ? { ...s, key: `${s.key}|schema`, schemaOnly: true } : s);

/** An external source a materialized view read at its last refresh (smalt_extcache). */
interface ExternalCacheEntry {
  label: string;
  location: string;
  format: string;
  options: Record<string, SqlValue>;
  connection: string | null;
  validator: string | null;
}

/** Catalog key of a connection (connections have their own namespace). */
const connectionKey = (name: string): string => `\u0000connection:${name.toLowerCase()}`;
const quoteIdent = (name: string): string => '"' + name.replace(/"/g, '""') + '"';
const sqlLiteral = (v: SqlValue): string => (v === null ? 'NULL' : typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v));


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

let roundTrip: boolean | undefined;
/** SMALT_PLAN_ROUNDTRIP=1 (tests): every plan goes through its JSON form before the engine plans it. */
function roundTripOn(): boolean {
  if (roundTrip === undefined) {
    const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
    roundTrip = !!g.process?.env?.SMALT_PLAN_ROUNDTRIP;
  }
  return roundTrip;
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
  /** External data (M8): registered files and credentials, loaded sources, and plugin formats (ADR 0012). */
  readonly external: ExternalRegistry;
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
    this.external = new ExternalRegistry(new PluginRegistry(options.plugins));
    this.pager = file === null ? Pager.openMemory(options) : reader ? Pager.openReader(file, walFile!, options) : Pager.open(file, options, walFile);
    this.spill = new SpillArea(spillFile?.file ?? null, options.workMem ?? DEFAULT_WORK_MEM, spillFile?.release ?? null);
    this.mem = file === null ? null : Pager.openMemory({ pageSize: this.pager.pageSize });
    this.cacheSize = options.statementCacheSize ?? 64;
    if (this.pager.catalogRoot === 0) {
      if (reader) throw new SmaltError('SMALT_CANTOPEN', 'reader: the database has no catalog yet');
      this.pager.catalogRoot = BTree.create(this.pager);
      this.pager.definitionRoot = BTree.create(this.pager);
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
        const ready = pending.filter((t) => ![...this.matviewDeps(t.matview!)].some((d) => d !== t.name.toLowerCase() && waiting.has(d)));
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
          if ([...this.sourceDeps(v.source)].some((d) => this.tempViews.has(d) || (this.tables.get(d)?.rootPage ?? 0) >= MEM_BASE)) return true;
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

  // ---------------------------------------------------------------- plans (ADR 0014 section 4)

  /**
   * Compile a statement given as plan data: a query plan, or a bound statement (plan/statement.ts). Its plans are
   * validated first; its parameters are positional.
   */
  preparePlan(stmt: PlanStatementInput): PlanStatement {
    this.checkOpen();
    const bound = normalizeBound(toBoundStatement(stmt, (plan) => this.receivedPlan(plan)));
    return new PlanStatement(this, bound, paramCount(bound));
  }

  /** Run a query given as plan data and return all rows (statements are cached by the plan's canonical form). */
  queryPlan(stmt: PlanStatementInput, params?: readonly SqlValue[]): QueryResult {
    const st = this.cachedPlan(stmt);
    return { columns: st.columns, rows: st.all(params as BindParams | undefined) };
  }

  /** `queryPlan` for a plan that may read external data: its sources are fetched first. */
  async queryPlanAsync(stmt: PlanStatementInput, params?: readonly SqlValue[], options: { signal?: AbortSignal } = {}): Promise<QueryResult> {
    const st = this.cachedPlan(stmt);
    return this.withExternal(options.signal, st, () => ({ columns: st.columns, rows: st.all(params as BindParams | undefined) }));
  }

  /** A plan from outside the engine, as it is received: validated, giving its output width. */
  private receivedPlan(plan: PlanOp): number {
    const p = roundTripOn() ? planFromJSON(planToJSON(plan)) : plan;
    return validatePlan(p, this.validateCatalog);
  }

  /** @internal A compiled plan statement from the cache (or compiled and cached). */
  cachedPlan(stmt: PlanStatementInput): PlanStatement {
    this.checkOpen();
    const key = canonicalJSON(stmt);
    let st = this.planCache.get(key);
    if (st) {
      this.planCache.delete(key);
      this.planCache.set(key, st);
      return st;
    }
    st = this.preparePlan(stmt);
    this.planCache.set(key, st);
    if (this.planCache.size > this.cacheSize) this.planCache.delete(this.planCache.keys().next().value!);
    return st;
  }

  private readonly planCache = new Map<string, PlanStatement>();

  /** @internal Whether a plan statement reads memory-resident objects (as {@link usesMemoryObjects} for SQL). */
  planUsesMemoryObjects(bound: BoundStatement): boolean {
    if (bound.kind === 'setting') return true;
    if (this.tempTables.size === 0 && this.memViews.size === 0) return false;
    const walk = (x: unknown): boolean => {
      if (Array.isArray(x)) return x.some(walk);
      if (!x || typeof x !== 'object') return false;
      const o = x as Record<string, unknown>;
      if (o.op === 'scan' && typeof o.table === 'string') {
        const t = this.getTable(o.table, o.db as 'main' | 'temp' | undefined);
        if (t && (t.temp || t.rootPage >= MEM_BASE)) return true;
      }
      for (const k in o) if (walk(o[k])) return true;
      return false;
    };
    return walk(bound);
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
  async withExternal<T>(signal: AbortSignal | undefined, st: PreparedStatement, run: () => T): Promise<T> {
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
      const first = st instanceof Statement ? this.literalExternalSources(st.parsed.stmt) : [];
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
          // Cancelled (or its tab closed, its transaction rolled back) while a source that ignores
          // the signal was fetched: the statement must not run now.
          if (signal?.aborted) throw new SmaltError('SMALT_INTERRUPT', 'interrupted');
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

  /**
   * Call method `method` of plugin `plugin` (ADR 0012), e.g. `@smaltdb/io`'s importCSV. Plugins
   * export helpers that call this (`importCSV(db, …)`); `session` is the calling client session
   * (`'local'` in-process).
   */
  async callPlugin(plugin: string, method: string, args: unknown[], options: { session?: string; signal?: AbortSignal } = {}): Promise<unknown> {
    this.checkOpen();
    const signal = options.signal;
    const query = async (sql: string, params?: BindParams): Promise<{ columns: string[]; rows: SqlValue[][]; columnTypes: StaticType[] }> => {
      const st = this.prepare(sql);
      return this.withExternal(signal, st, () => ({ columns: st.columns, rows: st.all(params), columnTypes: st.columnTypes }));
    };
    const queryPlan = async (stmt: PlanStatementInput, params?: readonly SqlValue[]): Promise<{ columns: string[]; rows: SqlValue[][]; columnTypes: StaticType[] }> => {
      const st = this.preparePlan(stmt);
      return this.withExternal(signal, st, () => ({ columns: st.columns, rows: st.all(params as BindParams | undefined), columnTypes: st.columnTypes }));
    };
    return this.external.plugins.call({ db: this, session: options.session ?? 'local', signal, query, queryPlan }, plugin, method, args);
  }

  /** The plugins installed in this engine (name and version). */
  get plugins(): readonly { name: string; version: string }[] {
    return this.external.plugins.plugins;
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
    // Row tables keep one writer per schema object, reused by later statements (its encoders and buffers cost
    // more to build than a one-row write); one taken by the running statement is busy until it ends.
    const reuse = !c && this.executeDepth > 0;
    if (reuse) {
      const e = this.writers.get(table);
      // CREATE INDEX adds to a table's index list in place: a writer serves only the list it was built for.
      const cached = e !== undefined && e.version === this.schemaVersion && e.indexes === table.indexes && e.count === table.indexes.length ? e.w : undefined;
      if (cached !== undefined && !this.writersBusy.has(cached)) {
        cached.resetStatement();
        this.writersBusy.add(cached);
        return cached;
      }
    }
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
    if (reuse) {
      const e = this.writers.get(table);
      if (e === undefined || this.writersBusy.has(e.w) === false) this.writers.set(table, { w, version: this.schemaVersion, indexes: table.indexes, count: table.indexes.length });
      this.writersBusy.add(w);
    }
    return w;
  }

  /** Reusable row-table writers (see writerFor), by schema object: DDL replaces the object. */
  private readonly writers = new WeakMap<TableSchema, { w: TableWriter; version: number; indexes: TableSchema['indexes']; count: number }>();
  private readonly writersBusy = new Set<TableWriter>();

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
    for (const v of this.tempViews.values()) out.push([seq(v), ['view', v.name, v.name, 0, v.source.text]]);
    return out.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  }

  private catalogSnapshot(): CatalogSnapshot {
    for (const t of this.tables.values()) if (t.matview) this.matviewPolicy(t.matview);
    return {
      tables: [...this.tables.values(), ...this.shadowedMain.values()],
      views: [...this.views.values()].map((v) => ({ name: v.name, sql: v.source.text, definition: this.languageOf(v.source.language).viewDefinition(v.source) })),
      definition: (source) => this.languageOf(source.language).viewDefinition(source),
      viewColumns: (name) => {
        const v = this.views.get(name.toLowerCase());
        if (!v) return null;
        try {
          const { env, catalog } = this.viewCheckEnv();
          const planner = new Planner(env, new Registers(0));
          planner.sqlText = v.source.text;
          const plan = this.planView(v.source, planner, catalog);
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
            fmt = formatOf(String(location), x.options, x.name, this.external.plugins).name;
          } catch {
            fmt = null;
          }
        }
        return { name: x.name, columns: x.columns, location: String(location), format: fmt, connection: connection === undefined || connection === null ? null : String(connection), options: JSON.stringify(rest) };
      }),
      connections: [...this.connections.values()].map((c) => ({
        name: c.name,
        type: this.external.plugins.connectionType(String(c.options.type ?? 'http')),
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
    this.catalogTable = { ...tableSchemaFromDef(SYSTEM_TABLES.smalt_schema, systemTableSql('smalt_schema'), this.pager.catalogRoot).table, system: true };
    // Opening parses nothing: objects are read from their stored definitions (catalog/stored.ts).
    const rows = this.scanCatalog();
    const defs = this.scanDefinitions();
    const def = <K extends StoredDef['kind']>(key: string, kind: K): Extract<StoredDef, { kind: K }> => {
      const d = defs.get(key);
      if (!d) throw new SmaltError('SMALT_CORRUPT', `missing definition of ${key}`);
      const v = decodeDef(d, key);
      if (v.kind !== kind) throw new SmaltError('SMALT_CORRUPT', `definition of ${key} is a ${v.kind}, not a ${kind}`);
      return v as Extract<StoredDef, { kind: K }>;
    };
    const autoRoots = new Map<string, number>();
    for (const r of rows) if (r.type === 'index' && r.sql === null) autoRoots.set(r.name.toLowerCase(), r.rootpage);
    const columnarTables = new Set<string>();
    for (const r of rows) {
      if (r.type === 'connection') {
        const c = def(connectionKey(r.name), 'connection');
        this.catalog.set(connectionKey(r.name), { type: 'connection', name: r.name, rowid: r.rowid });
        this.connections.set(r.name.toLowerCase(), { name: r.name, options: { ...c.options }, sql: r.sql! });
        continue;
      }
      this.catalog.set(r.name.toLowerCase(), { type: r.type as CatalogEntry['type'], name: r.name, rowid: r.rowid });
      if (r.type === 'external') {
        const x = def(r.name.toLowerCase(), 'external');
        this.externals.set(r.name.toLowerCase(), { name: r.name, columns: x.columns.map((c) => ({ name: c.name, declType: c.declaredType })), options: { ...x.options }, sql: r.sql! });
        continue;
      }
      if (r.type === 'view') {
        const v = def(r.name.toLowerCase(), 'view');
        this.views.set(r.name.toLowerCase(), { name: r.name, source: { language: v.language, text: r.sql! }, ...(v.columns ? { columns: [...v.columns] } : {}) });
        continue;
      }
      if (r.type !== 'table') continue;
      const t = isSystemTable(r.name) ? SYSTEM_TABLES[r.name.toLowerCase() as SystemTableName] : def(r.name.toLowerCase(), 'table').table;
      if (t.storage === 'columnar') columnarTables.add(r.name.toLowerCase());
      const { table, implicitIndexes } = tableSchemaFromDef(t, r.sql!, r.rootpage);
      if (isSystemTable(r.name)) table.system = true;
      implicitIndexes.forEach((spec, i) => {
        const name = autoIndexName(table.name, i + 1);
        const root = autoRoots.get(name.toLowerCase());
        if (root === undefined) throw new SmaltError('SMALT_CORRUPT', `missing automatic index ${name}`);
        const idx: IndexSchema = { name, table: table.name, rootPage: root, columns: spec.columns, unique: true, origin: spec.origin, constraintName: spec.constraintName, onConflict: spec.onConflict };
        table.indexes.push(idx);
        this.indexes.set(name.toLowerCase(), idx);
      });
      this.tables.set(table.name.toLowerCase(), table);
    }
    this.loadMatviews(rows.filter((r) => r.type === 'matview'), (key) => def(key, 'matview'));
    this.loadColumnar(columnarTables);
    for (const r of rows) {
      if (r.type !== 'index' || r.sql === null) continue;
      const table = this.tables.get(r.tbl_name.toLowerCase());
      if (!table) throw new SmaltError('SMALT_CORRUPT', `index ${r.name} references missing table ${r.tbl_name}`);
      let root = r.rootpage;
      if (root === MEM_BASE) {
        // Index of a memory-resident view: its runtime root (an empty tree after reopening).
        const mv = this.memViews.get(table.name.toLowerCase());
        root = mv?.indexRoots.get(r.name.toLowerCase()) ?? this.createTree(true);
        mv?.indexRoots.set(r.name.toLowerCase(), root);
      }
      const idx = indexSchemaFromDef(def(r.name.toLowerCase(), 'index').index, r.sql, table, root);
      this.prepareIndex(table, idx, true);
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

  /** Add a catalog row, and the object's definition (`def`; none for system tables and automatic indexes). */
  private addCatalogRow(type: string, name: string, tblName: string, root: number, sql: string | null, key = name.toLowerCase(), def?: StoredDef): void {
    const w = this.catalogWriter();
    const rowid = w.newRowid();
    w.writeRow([type, name, tblName, root, sql], rowid);
    this.catalog.set(key, { type: type as CatalogEntry['type'], name, rowid });
    if (def) this.writeDefinition(key, def);
  }

  private removeCatalogRow(name: string, key = name.toLowerCase()): void {
    const e = this.catalog.get(key);
    if (!e) return;
    this.catalogWriter().deleteRow(e.rowid);
    this.catalog.delete(key);
    this.deleteDefinition(key);
  }

  /** Rows of smalt_definition by key (rebuilt when the schema is read). */
  private definitionRows = new Map<string, number | bigint>();

  /**
   * The stored definitions by key, as text. Their table is not in the catalog (`sqlite_schema` does not list it): its
   * root is in the database header.
   */
  private scanDefinitions(): Map<string, StoredText> {
    this.definitionRows = new Map();
    const out = new Map<string, StoredText>();
    const root = this.pager.definitionRoot;
    if (root === 0) return out;
    const reader = new RecordReader(this.definitionTable().layout);
    const c = new BTree(this.pager, root).cursor();
    try {
      for (let ok = c.first(); ok; ok = c.next()) {
        c.loadValue();
        reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
        c.loadKey();
        const key = String(reader.column(0));
        const exprs = reader.column(2);
        out.set(key, { def: String(reader.column(1)), exprs: exprs === null ? null : String(exprs) });
        this.definitionRows.set(key, readRowidKey(c.keyBytes, c.keyOffset));
      }
    } finally {
      c.close();
    }
    return out;
  }

  /** The definitions table's schema (its tree is created with the database). */
  private definitionTable(): TableSchema {
    const root = this.pager.definitionRoot;
    if (this.defTable?.rootPage !== root) this.defTable = { ...tableSchemaFromDef(SYSTEM_TABLES.smalt_definition, systemTableSql('smalt_definition'), root).table, system: true };
    return this.defTable;
  }

  private defTable: TableSchema | null = null;

  /** Store an object's definition under its catalog key (replacing the one there). */
  private writeDefinition(key: string, def: StoredDef): void {
    const w = this.definitionWriter();
    const old = this.definitionRows.get(key);
    if (old !== undefined) w.deleteRow(old);
    const rowid = w.newRowid();
    const text = encodeDef(def);
    w.writeRow([key, text.def, text.exprs], rowid);
    this.definitionRows.set(key, rowid);
  }

  private deleteDefinition(key: string): void {
    const old = this.definitionRows.get(key);
    if (old === undefined) return;
    this.definitionWriter().deleteRow(old);
    this.definitionRows.delete(key);
  }

  /** A writer for the definitions table (kept: DDL writes a definition per object), its rowid cache cleared. */
  private definitionWriter(): TableWriter {
    const table = this.definitionTable();
    if (this.defWriter?.table !== table) this.defWriter = new TableWriter(table, this.pager, (root) => this.tree(root));
    this.defWriter.resetStatement();
    return this.defWriter;
  }

  private defWriter: TableWriter | null = null;


  private schemaChanged(): void {
    this.pager.schemaCookie = (this.pager.schemaCookie + 1) >>> 0;
    this.schemaVersion++;
  }

  // ---------------------------------------------------------------- compilation

  /**
   * @internal The physical plan of a SELECT, as `compile` makes it, with the plans of subqueries run from
   * inside expressions and the planner's row estimates. For test/plan-shapes.test.ts.
   */
  planOf(sql: string): { root: Operator; columns: { name: string; type: StaticType }[]; subplans: readonly { label: string; root: Operator }[]; estimates: WeakMap<Operator, number> } {
    this.checkOpen();
    const ps = parseOne(sql);
    if (ps.stmt.kind !== 'select') throw new MisuseError('planOf takes a SELECT statement');
    const bound = bindStatement(ps, this.bindContext(), (fe) => this.received(fe)) as BoundQuery;
    const planner = new Planner(this.plannerDeps(this.rewritePolicy(bound)), new Registers(ps.paramCount));
    planner.sqlText = ps.text;
    const plan = this.planQuery(bound, planner);
    return { root: plan.root, columns: plan.columns.map((c) => ({ name: c.name, type: c.type })), subplans: planner.subplans, estimates: planner.estimates };
  }

  /** What the SQL front end (ADR 0014, step 5) reads of the catalog (it reads the database's state when called). */
  /**
   * A plan from a language as the engine receives it: validated (plan/validate.ts) before it is planned. With
   * SMALT_PLAN_ROUNDTRIP=1 (tests) it goes through its JSON form first (plan/codec.ts), so the suites check that a
   * decoded plan plans and runs as the original.
   */
  private received<T extends { plan: PlanOp }>(fe: T): T {
    const r = roundTripOn() ? { ...fe, plan: planFromJSON(planToJSON(fe.plan)) } : fe;
    validatePlan(r.plan, this.validateCatalog);
    return r;
  }

  private readonly validateCatalog: ValidateCatalog = { tableColumns: (name, db) => this.getTable(name, db)?.columns.length };

  /** The logical catalog languages bind against (plan/bind-context.ts): the planner's tables, views and sources. */
  private bindContext(): BindContext {
    return (this.bindCtx ??= {
      getTable: (n, schema) => this.plannedTable(n, schema),
      writeTarget: (n, schema) => this.targetTable(n, schema),
      indexTarget: (n, schema) => this.indexTarget(n, schema),
      getView: (n, schema) => this.getView(n, schema),
      isExternal: (n) => this.externals.has(n.toLowerCase()),
      externalColumns: (n) => this.externalTableScan(n)?.columns,
      externalFunctionColumns: (n, args, named) => this.externalFunctionScan(n, args, named)?.columns,
      isExternalFunction: (n) => this.external.plugins.isExternalFunction(n),
      virtualTable: (schema, n) => this.virtualTable(schema, n),
      funcCtx: this,
    });
  }

  private bindCtx: BindContext | null = null;

  /** The environment that checks a view still plans after a schema change: tables and views only, no sources. */
  private viewCheckEnv(): { env: PhysicalEnv; catalog: BindContext } {
    const getTable = (n: string): TableSchema | undefined => this.getTable(n);
    return {
      env: { getTable, openTree: (root) => this.tree(root), funcCtx: this, state: this.state },
      catalog: { getTable, writeTarget: (n, schema) => this.targetTable(n, schema), indexTarget: (n, schema) => this.indexTarget(n, schema), getView: (n) => this.getView(n), isExternal: (n) => this.externals.has(n.toLowerCase()), funcCtx: this },
    };
  }

  /** A table the planner reads: a materialized view must have been populated. */
  private plannedTable(name: string, schema?: string): TableSchema | undefined {
    const t = this.getTable(name, schema);
    if (t?.matview && !t.matview.populated) {
      throw new SmaltError('SMALT_ERROR', `materialized view "${t.name}" has not been populated (use REFRESH MATERIALIZED VIEW)`);
    }
    return t;
  }

  /**
   * A top-level SELECT through the plan layer (ADR 0014), against `catalog` (the planner's tables), with
   * materialized-view matching on its plan under the statement's policy (exec/plan-mv-match.ts).
   */
  private planView(source: Source, planner: Planner, catalog: BindContext = this.bindContext()): QueryPlan {
    const fe = this.received(this.languageOf(source.language).bindView(source, catalog));
    const rewrite = planner.env.rewritePlan;
    const p = planner.planPlan(rewrite ? rewrite(fe.plan) : fe.plan, fe.columns);
    if (!p) throw new SmaltError('SMALT_INTERNAL', `the physical planner declined a query\n  in: ${source.text}`);
    return p;
  }

  /** A bound query planned: materialized-view matching under the statement's policy, then the physical planner. */
  private planQuery(q: BoundQuery, planner: Planner): QueryPlan {
    const rewrite = planner.env.rewritePlan;
    const p = planner.planPlan(rewrite ? rewrite(q.plan) : q.plan, q.columns);
    if (!p) throw new SmaltError('SMALT_INTERNAL', `the physical planner declined a query\n  in: ${planner.sqlText}`);
    return p;
  }

  /**
   * @internal Compile a statement into a program for the current schema: the language binds it (sql/frontend/bind.ts),
   * and the engine dispatches on the bound statement (plan/bound.ts).
   */
  compile(ps: ParsedStatement): Program {
    return this.compileBound(bindStatement(ps, this.bindContext(), (fe) => this.received(fe)), ps.paramCount, ps.text);
  }

  /**
   * @internal A bound statement's program (its plans already received): the engine dispatches on its kind
   * (plan/bound.ts). `text` names it in errors (its source, where there is one).
   */
  compileBound(bound: BoundStatement, paramCount: number, text: string): Program {
    const regs = new Registers(paramCount);
    const planner = new Planner(this.plannerDeps(this.rewritePolicy(bound)), regs);
    planner.sqlText = text;
    const done = (p: Omit<Program, 'regCount'>): Program => ({ ...p, regCount: regs.count, rowAssumptions: planner.rowAssumptions, externals: planner.finishExternals() });
    switch (bound.kind) {
      case 'query': {
        const plan = this.planQuery(bound, planner);
        return done({ plan, readonly: true, columns: plan.columns.map((c) => c.name), columnTypes: plan.columns.map((c) => c.type) });
      }
      case 'write':
        return done(this.compileWrite(bound, planner));
      case 'explain': {
        const plan = this.planQuery(bound.query, planner);
        if (bound.mode === 'analyze') {
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
      case 'transaction':
        return done({ exec: () => this.transactionControl(bound), readonly: true, columns: [], columnTypes: [] });
      case 'setting':
        return done(this.compilePragma(bound, planner));
      case 'maintenance':
        switch (bound.action) {
          case 'analyze':
            return done({ exec: () => this.analyze(bound.target, bound.schema), readonly: false, columns: [], columnTypes: [] });
          case 'refresh':
            return done({ exec: () => this.refreshMatview(bound), readonly: false, columns: [], columnTypes: [] });
          default:
            throw new SmaltError('SMALT_UNSUPPORTED', 'vacuum statements are not supported yet');
        }
      case 'schema':
        return done(this.compileSchemaOp(bound.op));
    }
  }

  /** A schema operation's program (plan/schema.ts). */
  private compileSchemaOp(op: SchemaOp): Omit<Program, 'regCount'> {
    const run = (f: () => RunResult): Omit<Program, 'regCount'> => ({ exec: f, readonly: false, columns: [], columnTypes: [] });
    switch (op.op) {
      case 'createTable':
        return run(() => this.createTable(op));
      case 'createIndex':
        return run(() => this.createIndex(op));
      case 'createConnection':
        return run(() => this.createConnection(op));
      case 'createExternalTable':
        return run(() => this.createExternalTable(op));
      case 'createView':
        if (op.materialized) return run(() => this.createMatview(op));
        if (op.schema && !['main', 'temp'].includes(op.schema.toLowerCase())) throw new SmaltError('SMALT_ERROR', `unknown database ${op.schema}`);
        return run(() => this.createView(op));
      case 'drop':
        return run(() => this.drop(op));
      case 'alterTable':
        return run(() => this.alterTable(op));
    }
  }

  /**
   * Whether the SELECTs a statement plans (top level, subqueries, CTEs, views) may be answered from
   * materialized views, and which tables' views are excluded. Queries and EXPLAIN: yes. INSERT …
   * SELECT: yes, except views over the table being written (the statement changes it while it
   * reads) and when foreign keys may change other tables. UPDATE, DELETE and the rest: no.
   */
  private rewritePolicy(bound: BoundStatement): { exclude: string | null } | null {
    if (!this.matviewRewriteOn) return null;
    if (bound.kind === 'query' || bound.kind === 'explain') return { exclude: null };
    if (bound.kind === 'write' && bound.plan.op === 'append' && bound.plan.input && bound.plan.input.op !== 'values' && !this.fkInvolvedNow(bound.plan.table)) return { exclude: bound.plan.table.toLowerCase() };
    return null;
  }

  /** What the planner reads from the database. Unpopulated materialized views cannot be read. */
  private plannerDeps(rewrite: { exclude: string | null } | null = null): PhysicalEnv {
    return {
      rewritePlan: rewrite ? (plan) => this.matviewRewritePlan(plan, rewrite.exclude) : undefined,
      externalTable: (n) => this.externalTableScan(n),
      externalFunction: (n, args, named) => (this.external.plugins.isExternalFunction(n) ? this.externalFunctionScan(n, args, named) : undefined),
      getTable: (n, schema) => this.plannedTable(n, schema),
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

  private transactionControl(stmt: BoundTransaction): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    switch (stmt.action) {
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

  /** @internal How the last explicit transaction ended (the server reports it to `db.transaction()`). */
  lastTransactionEnd: 'commit' | 'rollback' | null = null;

  private commitTransaction(): void {
    // Deferred foreign-key violations keep the transaction open, as in SQLite.
    this.fk.checkCommit();
    this.lastTransactionEnd = 'commit';
    if (this.sqlSavepoints.length) this.tx.releaseSavepoint(1);
    this.sqlSavepoints.length = 0;
    this.memSnapshots.length = 0;
    this.txnMem = null;
    this.tx.commit();
    this.autocommit = true;
    this.txnFromSavepoint = false;
  }

  private rollbackTransaction(): void {
    this.lastTransactionEnd = 'rollback';
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
    if (program.readonly && this.executeDepth === 0) return this.executeInner(program, body);
    this.executeDepth++;
    try {
      return this.executeInner(program, body);
    } finally {
      // The outermost statement is done: its row writers can serve the next statement.
      if (--this.executeDepth === 0 && this.writersBusy.size > 0) this.writersBusy.clear();
    }
  }

  /** Nesting depth of `execute` (statements run from inside a statement, e.g. a refresh). */
  private executeDepth = 0;

  private executeInner<T>(program: Program, body: () => T): T {
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
      // A constraint failure under ROLLBACK (INSERT OR ROLLBACK, or ON CONFLICT ROLLBACK) also
      // rolls back the enclosing transaction, as in SQLite.
      if (e instanceof ConstraintError && e.rollback && !this.autocommit) this.rollbackTransaction();
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

  /**
   * CREATE MATERIALIZED VIEW: the result columns become a table (types from the query), filled by
   * running the query unless `WITH NO DATA`.
   */
  private createMatview(stmt: Extract<SchemaOp, { op: 'createView' }>): RunResult {
    const sql = stmt.source.text;
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    if (stmt.temp || stmt.schema?.toLowerCase() === 'temp') throw new SmaltError('SMALT_ERROR', 'materialized views cannot be temporary');
    if (stmt.ifNotExists && this.catalog.get(stmt.name.toLowerCase())?.type === 'matview') return none;
    const tempDep = this.tempDependency(stmt.source);
    if (tempDep) throw new SmaltError('SMALT_ERROR', `materialized view ${stmt.name} cannot reference TEMP object ${tempDep}`);
    const opts = stmt.options ?? {};
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
    const layout = this.matviewLayout(stmt.name, stmt.source, stmt.columns ? [...stmt.columns] : undefined);
    if (!this.tables.has('smalt_matview')) {
      this.createTable(systemTableOp('smalt_matview'), true);
    }
    const root = this.createTree(inMemory);
    const { table } = tableSchemaFromDef(layout, layoutSql(layout), root);
    table.matview = { sql, language: stmt.source.language, storage, options: { ...opts }, populated: false, refreshedAt: null };
    // A memory-resident view's root is assigned at runtime: the catalog records a marker.
    this.addCatalogRow('matview', table.name, table.name, inMemory ? MEM_BASE : root, sql, undefined, { kind: 'matview', language: stmt.source.language, ...(stmt.columns ? { columns: stmt.columns } : {}), options: stmt.options ?? {} });
    if (inMemory) {
      this.memViews.set(table.name.toLowerCase(), { root, indexRoots: new Map(), populated: false, refreshedAt: null, fresh: false });
      this.memDirty = true;
    }
    this.tables.set(table.name.toLowerCase(), table);
    this.writeMatviewMeta(table.name, { layout: encodeDef({ kind: 'table', table: layout }).def, populated: false, refreshedAt: null });
    let changes = 0;
    if (stmt.withData !== false) changes = this.fillMatview(table);
    this.schemaChanged();
    return { changes, lastInsertRowid: this.lastRowid };
  }

  /** REFRESH MATERIALIZED VIEW [CONCURRENTLY] name [WITH [NO] DATA]. */
  private refreshMatview(stmt: Extract<BoundStatement, { action: 'refresh' }>): RunResult {
    if (stmt.schema && stmt.schema.toLowerCase() !== 'main') throw new SmaltError('SMALT_ERROR', `unknown database ${stmt.schema}`);
    const mv = this.tables.get(stmt.view.toLowerCase());
    if (!mv?.matview) throw new SmaltError('SMALT_ERROR', `no such materialized view: ${stmt.view}`);
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
      sources = this.runQuery({ language: info.language, text: info.sql }, (r, outRegs) => {
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
      this.createTable(systemTableOp('smalt_extcache'), true);
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
      const w = info.options ?? {};
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
  /** The table a materialized view's rows are stored in: a column per result column of its query. */
  private matviewLayout(name: string, source: Source, names?: string[]): TableDef {
    const planner = new Planner(this.plannerDeps(), new Registers(0));
    planner.sqlText = source.text;
    const plan = this.planView(source, planner);
    if (names && names.length !== plan.columns.length) {
      throw new SmaltError('SMALT_ERROR', `materialized view ${name} has ${names.length} column names but its query returns ${plan.columns.length} columns`);
    }
    const seen = new Set<string>();
    const columns = plan.columns.map((c, i) => {
      const colName = names?.[i] ?? c.name;
      if (seen.has(colName.toLowerCase())) throw new SmaltError('SMALT_ERROR', `column "${colName}" specified more than once (name it with AS)`);
      seen.add(colName.toLowerCase());
      // A column copied from a table keeps its declared type; computed values get their static type.
      const st = (c.declType ? storageTypeFor(c.declType) : ({ int: 'INTEGER', real: 'REAL', text: 'TEXT', blob: 'BLOB' } as Record<string, string>)[c.type] ?? 'ANY') as ColumnDefinition['type'];
      const collation: CollationName = c.collation === Collation.NoCase ? 'nocase' : c.collation === Collation.RTrim ? 'rtrim' : 'binary';
      return { name: colName, declaredType: st, type: st, notNull: false, collation };
    });
    return { name, columns, keys: [], checks: [], foreignKeys: [], storage: 'row' };
  }



  /** Run a query to completion; `emit` reads each result row from the registers `r[outRegs[i]]`. */
  /** Run a view's query, passing each row to `emit`; returns the external sources it read (M8). */
  private runQuery(source: Source, emit: (r: SqlValue[], outRegs: number[]) => void): ExternalSource[] {
    const regs = new Registers(0);
    const planner = new Planner(this.plannerDeps(), regs);
    planner.sqlText = source.text;
    const plan = this.planView(source, planner);
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

  /**
   * `plan` with the parts that a fresh materialized view answers read from that view (exec/plan-mv-match.ts), under
   * `PRAGMA matview_rewrite`. `exclude`: views over this table are not used (the statement writes it).
   */
  private matviewRewritePlan(plan: PlanOp, exclude: string | null = null): PlanOp {
    if (!this.matviewRewriteOn) return plan;
    const views: PlanMatview[] = [];
    for (const t of this.tables.values()) {
      const m = t.matview;
      if (!m?.populated || !m.fresh) continue;
      // A TEMP table or view shadowing something the view read: the query's names mean the temp object.
      const deps = this.matviewDeps(m);
      if ([...deps].some((d) => this.tempTables.has(d) || this.tempViews.has(d))) continue;
      // A view over the table the statement writes (INSERT … SELECT into its base table).
      if (exclude !== null && deps.has(exclude)) continue;
      // External data changes without the database noticing: such a view is a cache, refreshed explicitly.
      if (this.externals.size > 0 && [...deps].some((d) => this.externals.has(d))) continue;
      // The view's definition as a plan, bound once per schema version.
      if (m.plan?.version !== this.schemaVersion) {
        let bound: PlanOp | null;
        try {
          bound = this.received(this.languageOf(m.language).bindView({ language: m.language, text: m.sql }, this.bindContext())).plan;
        } catch {
          bound = null;
        }
        m.plan = { version: this.schemaVersion, plan: bound };
      }
      if (!m.plan.plan) continue;
      views.push({
        name: t.name,
        plan: m.plan.plan,
        types: t.columns.map((c) => (c.rowidAlias ? 'int' : staticTypeOfStorage(c.type))),
        collations: t.columns.map((c) => MATVIEW_COLLATIONS[c.collation ?? Collation.Binary]),
      });
    }
    return matchMatviews(plan, views);
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
  /** Partial rows being merged: the `smalt_partials()` source of the merge plan. */
  private morsel: { rows: SqlValue[][]; keys: number; width: number; types: StaticType[] } | null = null;

  /** `sql` as partial aggregates over rowid ranges and their merge (exec/plan-morsel.ts), or null. */
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
        const fe = this.received(toPlan(parsed.stmt, parsed.text, this.bindContext()));
        const q = planMorsels(fe.plan, parsed.paramCount, (name, db) => {
          const t = this.getTable(name, db);
          // Readers open the file: memory-resident objects and system tables stay on the owner.
          return !!t && !t.temp && !t.system && t.rootPage < MEM_BASE && !(t.matview && !t.matview.populated);
        });
        if (q) entry = { version: this.schemaVersion, parsed, plan: fe.plan, columns: fe.columns, q, partial: encodePlan(q.partial), key: `${this.schemaVersion}:${sql}` };
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
   * aggregates merge exactly, rowid ranges for `parts` partial plans ({@link partialTask});
   * otherwise null (run it normally).
   */
  parallelSplit(sql: string, parts: number, minRows = 200_000): { lo: number; hi: number }[] | null {
    if (parts < 2 || !this.parallelAggregates) return null;
    const m = this.morselQuery(sql);
    if (!m) return null;
    // A fresh materialized view answers it more cheaply than any split of the base table.
    if (this.matviewRewriteOn && this.matviewRewritePlan(m.plan) !== m.plan) return null;
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

  /**
   * What a reader needs to aggregate rowids [lo, hi) of `sql`: the partial plan (encoded, the same for every range),
   * a key that names it, and its parameters (the query's, then lo and hi).
   */
  partialTask(sql: string, params: BindParams | undefined, lo: number, hi: number): { plan: EncodedPlan; key: string; params: SqlValue[] } {
    const m = this.morselQuery(sql);
    if (!m) throw new SmaltError('SMALT_ERROR', 'statement cannot run as partial aggregates');
    const values: SqlValue[] = new Array(m.parsed.paramCount + 2).fill(null);
    bindParamValues(m.parsed, params, values);
    values[m.parsed.paramCount] = lo;
    values[m.parsed.paramCount + 1] = hi;
    return { plan: m.partial, key: m.key, params: values };
  }

  /**
   * A reader: the partial aggregates a {@link partialTask} describes (one row per group). The plan is decoded,
   * validated and planned once per `key` and schema, then run for each range.
   */
  runPartial(task: { plan: EncodedPlan; key: string; params: SqlValue[] }): SqlValue[][] {
    let hit = this.partialPrograms.get(task.key);
    if (!hit || hit.version !== this.schemaVersion) {
      const plan = decodePlan(task.plan);
      validatePlan(plan, this.validateCatalog);
      const types = plan.op === 'project' ? plan.exprs.map(typeOf) : [];
      hit = { version: this.schemaVersion, program: this.planProgram(plan, types.map((t, i) => ({ name: `c${i}`, type: t, collation: Collation.Binary, affinity: 'NONE' })), task.params.length) };
      if (this.partialPrograms.size >= 16) this.partialPrograms.delete(this.partialPrograms.keys().next().value!);
      this.partialPrograms.set(task.key, hit);
    }
    return this.runProgram(hit.program, task.params);
  }

  private readonly partialPrograms = new Map<string, { version: number; program: Program }>();

  /** Merge partial rows (from {@link runPartial} over every range) into the result of `sql`. */
  mergePartials(sql: string, params: BindParams | undefined, partials: SqlValue[][]): QueryResult {
    const m = this.morselQuery(sql);
    if (!m) throw new SmaltError('SMALT_ERROR', 'statement cannot run as partial aggregates');
    this.morsel = { rows: partials, keys: m.q.keyCount, width: m.q.types.length, types: m.q.types };
    try {
      const values: SqlValue[] = new Array(m.parsed.paramCount).fill(null);
      bindParamValues(m.parsed, params, values);
      const p = (m.merge ??= this.planProgram(m.q.merge, m.columns, m.parsed.paramCount));
      return { columns: p.columns, rows: this.runProgram(p, values) };
    } finally {
      this.morsel = null;
    }
  }

  /** A read-only program for `plan` (validated), with `paramCount` parameters in its first registers. */
  private planProgram(plan: PlanOp, columns: ResultColumnInfo[], paramCount: number): Program {
    const regs = new Registers(paramCount);
    const planner = new Planner(this.plannerDeps(), regs);
    const qp = planner.planPlan(plan, columns);
    if (!qp) throw new SmaltError('SMALT_INTERNAL', 'the physical planner declined a plan');
    return { plan: qp, readonly: true, regCount: regs.count, columns: qp.columns.map((c) => c.name), columnTypes: qp.columns.map((c) => c.type) };
  }

  /** Run read-only program `p` with `params` in its first registers; its rows. */
  private runProgram(p: Program, params: SqlValue[]): SqlValue[][] {
    const regs: SqlValue[] = new Array(Math.max(p.regCount, params.length)).fill(null);
    for (let i = 0; i < params.length; i++) regs[i] = params[i];
    return this.execute(p, () => {
      const root = p.plan!.root;
      const out = p.plan!.outRegs;
      const rows: SqlValue[][] = [];
      try {
        root.open(regs);
        while (root.next()) rows.push(out.map((g) => regs[g]));
      } finally {
        root.close();
      }
      return rows;
    });
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

  /** {@link parallelSplit} + {@link partialTask} + {@link runPartial} + {@link mergePartials} in this thread (tests). */
  queryMorsels(sql: string, params?: BindParams, parts = 4, minRows = 0): QueryResult | null {
    const ranges = this.parallelSplit(sql, parts, minRows);
    if (!ranges) return null;
    const partials: SqlValue[][] = [];
    // Each task as a reader receives it: a structured clone.
    for (const r of ranges) partials.push(...this.runPartial(structuredClone(this.partialTask(sql, params, r.lo, r.hi))));
    return this.mergePartials(sql, params, partials);
  }

  // ---------------------------------------------------------------- columnar tables (M7.3)

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
  private loadColumnar(columnarTables: ReadonlySet<string>): void {
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
      if (!columnarTables.has(t.name.toLowerCase())) continue;
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
  private loadMatviews(rows: { name: string; rootpage: number; sql: string | null }[], defOf: (key: string) => Extract<StoredDef, { kind: 'matview' }>): void {
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
      const def = defOf(r.name.toLowerCase());
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
      const layout = decodeDef({ def: m.layout, exprs: null }, `${r.name} layout`);
      if (layout.kind !== 'table') throw new SmaltError('SMALT_CORRUPT', `layout of materialized view ${r.name} is not a table`);
      const { table } = tableSchemaFromDef(layout.table, layoutSql(layout.table), root);
      const storage = String(def.options.storage ?? 'row').toLowerCase() as MatViewInfo['storage'];
      table.matview = { sql: r.sql!, language: def.language, options: { ...def.options }, storage, populated, refreshedAt, fresh };
      this.tables.set(table.name.toLowerCase(), table);
    }
  }

  /** Tables and views a view's query reads (lower-case names), through views: its language reads them from its source. */
  private sourceDeps(source: Source, seen = new Set<string>()): Set<string> {
    const out = new Set<string>();
    for (const r of this.languageOf(source.language).viewReferences(source)) {
      const n = r.name.toLowerCase();
      out.add(n);
      const view = this.getView(n);
      if (view && !seen.has(n)) {
        seen.add(n);
        for (const d of this.sourceDeps(view.source, seen)) out.add(d);
      }
    }
    return out;
  }

  /** What a materialized view reads (cached until the names it reads change). */
  private matviewDeps(m: MatViewInfo): Set<string> {
    return (m.deps ??= this.sourceDeps({ language: m.language, text: m.sql }));
  }

  /** A registered language, by name (SQL only, until languages register: ADR 0015 step 9). */
  private languageOf(name: string): SmaltLanguage {
    const l = LANGUAGES[name];
    if (!l) throw new SmaltError('SMALT_MISUSE', `this is written in ${name}, which is not registered`);
    return l;
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
      if (!m.fresh || !this.matviewDeps(m).has(lower)) continue;
      m.fresh = false;
      this.writeMatviewMeta(t.name, { populated: m.populated, refreshedAt: m.refreshedAt, fresh: false });
      changed = true;
    }
    if (changed) {
      this.dirtySchema = true;
      this.schemaChanged();
    }
  }


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
      this.createTable(systemTableOp('smalt_stat'), true);
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

  /** A TEMP table or view that a view's query reads (directly or through views), if any. */
  private tempDependency(source: Source): string | undefined {
    if (this.tempTables.size === 0 && this.tempViews.size === 0) return undefined;
    return [...this.sourceDeps(source)].find((d) => this.tempTables.has(d) || this.tempViews.has(d));
  }

  // ---------------------------------------------------------------- connections and external tables (M8)

  private createConnection(stmt: Extract<SchemaOp, { op: 'createConnection' }>): RunResult {
    const sql = stmt.source.text;
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    const lower = stmt.name.toLowerCase();
    if (this.connections.has(lower)) {
      if (stmt.ifNotExists) return none;
      throw new SmaltError('SMALT_ERROR', `connection ${stmt.name} already exists`);
    }
    // Types, their options and checks come from plugins (@smaltdb/external: http, s3, azure).
    this.external.plugins.checkConnection(stmt.name, stmt.options);
    this.dirtySchema = true;
    this.addCatalogRow('connection', stmt.name, stmt.name, 0, sql, connectionKey(stmt.name), { kind: 'connection', options: stmt.options });
    this.connections.set(lower, { name: stmt.name, options: stmt.options, sql });
    this.schemaChanged();
    return none;
  }

  private dropConnection(stmt: Extract<SchemaOp, { op: 'drop' }>): RunResult {
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
    const fmt = formatOf(location, def.options, def.name, this.external.plugins);
    return { key: `table:${def.name.toLowerCase()}`, label: def.name, location, format: fmt.name, pushdown: !!fmt.pushdown, options, connection: this.connectionOf(def.options, def.name), columns };
  }

  private createExternalTable(stmt: Extract<SchemaOp, { op: 'createExternalTable' }>): RunResult {
    const sql = stmt.source.text;
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    const lower = stmt.name.toLowerCase();
    if (stmt.ifNotExists && this.externals.has(lower)) return none;
    this.checkNewName(stmt.name, 'external');
    // A format whose plugin is missing first: the error names the plugin rather than one of its
    // options (other format errors, such as an unknown extension, come after the options check).
    if (typeof stmt.options.location === 'string' && stmt.options.location !== '') {
      try {
        formatOf(stmt.options.location, stmt.options, stmt.name, this.external.plugins);
      } catch (e) {
        if (e instanceof SmaltError && e.code === 'SMALT_PLUGIN_MISSING') throw e;
      }
    }
    checkReaderOptions(stmt.options, new Set(['location', 'connection', ...this.external.plugins.readerOptions()]), stmt.name);
    const seen = new Set<string>();
    for (const c of stmt.columns) {
      if (c.constrained) throw new SmaltError('SMALT_ERROR', `external table ${stmt.name}: columns cannot have constraints`);
      if (seen.has(c.name.toLowerCase())) throw new SmaltError('SMALT_ERROR', `duplicate column name: ${c.name}`);
      seen.add(c.name.toLowerCase());
    }
    let columns: ExternalColumn[] = stmt.columns.map((c) => ({ name: c.name, declType: c.declaredType }));
    const source = this.externalSourceOf({ name: stmt.name, options: stmt.options }, columns.length ? columns : undefined);
    let text = sql;
    if (columns.length === 0) {
      // Columns inferred from the source now (fetched by the async API; Parquet: only its footer), and stored with the table.
      const data = this.external.data(schemaSourceOf(source));
      if (data.columns.length === 0) throw externalError(source, 'no columns found (the source is empty)');
      columns = data.columns.map((c) => ({ name: c.name, declType: c.declType || 'ANY' }));
      const cols = columns.map((c) => `${quoteIdent(c.name)} ${c.declType}`).join(', ');
      const opts = Object.entries(stmt.options).map(([k, v]) => `${quoteIdentIfNeeded(k)} = ${sqlLiteral(v)}`).join(', ');
      text = `CREATE EXTERNAL TABLE ${quoteIdent(stmt.name)} (${cols}) WITH (${opts})`;
    }
    this.dirtySchema = true;
    this.addCatalogRow('external', stmt.name, stmt.name, 0, text, undefined, { kind: 'external', columns: columns.map((c) => ({ name: c.name, declaredType: c.declType })), options: stmt.options });
    this.externals.set(lower, { name: stmt.name, columns, options: stmt.options, sql: text });
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
      if (o.kind === 'function' && this.external.plugins.isExternalFunction(o.name as string)) {
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
    const { connection: _c, ...options } = named;
    if (options.format === undefined || options.format === null) options.format = this.external.plugins.functionFormat(name, location);
    const fmt = formatOf(location, options, label, this.external.plugins);
    checkReaderOptions(named, new Set(['connection', ...this.external.plugins.readerOptions()]), label);
    const key = `fn:${name}:${JSON.stringify([location, Object.entries(named).sort()], (_k, v) => (typeof v === 'bigint' ? `${v}n` : v))}`;
    return { key, label, location, format: fmt.name, pushdown: !!fmt.pushdown, options, connection: this.connectionOf(named, label) };
  }

  private createView(stmt: Extract<SchemaOp, { op: 'createView' }>): RunResult {
    const sql = stmt.source.text;
    const columns = stmt.columns ? [...stmt.columns] : undefined;
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    if (stmt.temp && stmt.schema?.toLowerCase() === 'main') throw new SmaltError('SMALT_ERROR', 'temporary table name must be unqualified');
    // A view over TEMP objects is itself TEMP (as in SQLite); asked for in main, it is an error.
    const tempDep = stmt.temp || stmt.schema?.toLowerCase() === 'temp' ? undefined : this.tempDependency(stmt.source);
    if (tempDep && stmt.schema?.toLowerCase() === 'main') throw new SmaltError('SMALT_ERROR', `view ${stmt.name} cannot reference TEMP object ${tempDep}`);
    if (stmt.temp || stmt.schema?.toLowerCase() === 'temp' || tempDep) {
      const lower = stmt.name.toLowerCase();
      if (this.tempViews.has(lower)) {
        if (stmt.ifNotExists) return none;
        throw new SmaltError('SMALT_ERROR', `view ${stmt.name} already exists`);
      }
      const view: ViewSchema = { name: stmt.name, source: stmt.source, ...(columns ? { columns } : {}) };
      this.tempViews.set(lower, view);
      this.tempSeq.set(view, this.nextTempSeq++);
      this.schemaVersion++; // re-plan statements; nothing is stored
      return none;
    }
    if (stmt.ifNotExists && this.catalog.get(stmt.name.toLowerCase())?.type === 'view') return none;
    this.checkNewName(stmt.name, 'view');
    this.dirtySchema = true;
    // Like SQLite, the body is not resolved until the view is used (it may reference tables created later).
    this.addCatalogRow('view', stmt.name, stmt.name, 0, sql, undefined, { kind: 'view', language: stmt.source.language, ...(columns ? { columns } : {}) });
    this.views.set(stmt.name.toLowerCase(), { name: stmt.name, source: stmt.source, ...(columns ? { columns } : {}) });
    this.objectChanged(stmt.name);
    this.schemaChanged();
    return none;
  }

  private createTable(stmt: Extract<SchemaOp, { op: 'createTable' }>, internal = false): RunResult {
    const sql = stmt.source.text;
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    const columnar = stmt.table.storage === 'columnar';
    const schema = stmt.schema?.toLowerCase();
    if (schema !== undefined && schema !== 'main' && schema !== 'temp') throw new SmaltError('SMALT_ERROR', `unknown database ${stmt.schema}`);
    if (stmt.temp && schema === 'main') throw new SmaltError('SMALT_ERROR', 'temporary table name must be unqualified');
    if (stmt.temp || schema === 'temp') {
      if (columnar) throw new SmaltError('SMALT_UNSUPPORTED', 'TEMP tables cannot be columnar');
      return this.createTempTable(stmt);
    }
    if (stmt.ifNotExists && this.catalog.has(stmt.table.name.toLowerCase())) return none;
    if (!internal) this.checkNewName(stmt.table.name, 'table');
    this.dirtySchema = true;
    const root = BTree.create(this.pager);
    const { table, implicitIndexes, conflictingOnConflict } = tableSchemaFromDef(stmt.table, sql, root);
    if (conflictingOnConflict) throw new SmaltError('SMALT_ERROR', 'conflicting ON CONFLICT clauses specified');
    if (columnar) {
      // Columnar tables are scanned, not probed: no secondary structures to keep in step.
      if (implicitIndexes.length > 0) throw new SmaltError('SMALT_UNSUPPORTED', 'columnar tables support no UNIQUE or PRIMARY KEY constraints other than INTEGER PRIMARY KEY');
      if (table.foreignKeys.length > 0) throw new SmaltError('SMALT_UNSUPPORTED', 'columnar tables cannot have foreign keys');
      if (!this.tables.has('smalt_columnar')) {
        this.createTable(systemTableOp('smalt_columnar'), true);
      }
      table.columnar = { segRoot: BTree.create(this.pager), delRoot: BTree.create(this.pager) };
      this.writeColumnarMeta(table.name, table.columnar);
    }
    for (const fk of table.foreignKeys) {
      if (this.tables.get(fk.table.toLowerCase())?.columnar) throw new SmaltError('SMALT_UNSUPPORTED', `foreign keys cannot reference columnar table ${fk.table}`);
    }
    this.addCatalogRow('table', table.name, table.name, root, sql, undefined, internal ? undefined : { kind: 'table', table: stmt.table, language: stmt.source.language });
    implicitIndexes.forEach((spec, i) => {
      const name = autoIndexName(table.name, i + 1);
      const iroot = BTree.create(this.pager);
      const idx: IndexSchema = { name, table: table.name, rootPage: iroot, columns: spec.columns, unique: true, origin: spec.origin, constraintName: spec.constraintName, onConflict: spec.onConflict };
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
  private createTempTable(stmt: Extract<SchemaOp, { op: 'createTable' }>): RunResult {
    const sql = stmt.source.text;
    const name = stmt.table.name;
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    const lower = name.toLowerCase();
    if (this.tempTables.has(lower)) {
      if (stmt.ifNotExists) return none;
      throw new SmaltError('SMALT_ERROR', `table ${name} already exists`);
    }
    if (lower.startsWith('smalt_') || lower.startsWith('sqlite_')) throw new SmaltError('SMALT_ERROR', `object name reserved for internal use: ${name}`);
    const { table, implicitIndexes, conflictingOnConflict } = tableSchemaFromDef(stmt.table, sql, this.createTree(true));
    if (conflictingOnConflict) throw new SmaltError('SMALT_ERROR', 'conflicting ON CONFLICT clauses specified');
    table.temp = true;
    implicitIndexes.forEach((spec, i) => {
      const name = autoIndexName(table.name, i + 1);
      table.indexes.push({ name, table: table.name, rootPage: this.createTree(true), columns: spec.columns, unique: true, origin: spec.origin, constraintName: spec.constraintName, onConflict: spec.onConflict });
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

  /** The table CREATE INDEX indexes (BindContext.indexTarget): throws why there is none, or why it cannot be indexed. */
  private indexTarget(name: string, schemaName?: string): TableSchema {
    // The qualifier names the index's schema, which must be its table's (as in SQLite).
    const schema = schemaName?.toLowerCase();
    if (schema !== undefined && schema !== 'main' && schema !== 'temp') throw new SmaltError('SMALT_ERROR', `unknown database ${schemaName}`);
    const table = schema === undefined ? this.tables.get(name.toLowerCase()) : this.getTable(name, schema);
    if (!table) {
      if (schema === 'temp' && this.getTable(name, 'main')) throw new SmaltError('SMALT_ERROR', `cannot create a TEMP index on non-TEMP table "${name}"`);
      if (this.views.has(name.toLowerCase())) throw new SmaltError('SMALT_ERROR', 'views may not be indexed');
      if (schema !== 'temp' && this.externals.has(name.toLowerCase())) throw new SmaltError('SMALT_ERROR', `table ${name} may not be indexed`);
      throw new SmaltError('SMALT_ERROR', `no such table: ${schema === 'main' ? 'main.' : ''}${name}`);
    }
    if (table.matview?.storage === 'columnar') throw new SmaltError('SMALT_ERROR', `columnar materialized view ${table.name} cannot be indexed (zone maps prune its scans)`);
    if (table.columnar) throw new SmaltError('SMALT_UNSUPPORTED', `columnar table ${table.name} cannot be indexed (zone maps prune its scans)`);
    return table;
  }

  private createIndex(op: Extract<SchemaOp, { op: 'createIndex' }>): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    const stmt = op.index;
    const sql = op.source.text;
    if (op.ifNotExists && this.catalog.has(stmt.name.toLowerCase())) return none;
    const table = this.indexTarget(stmt.table, op.schema);
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
    const idx = indexSchemaFromDef(stmt, sql, table, root);
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
    this.addCatalogRow('index', idx.name, table.name, memory ? MEM_BASE : root, sql, undefined, { kind: 'index', index: stmt, language: op.source.language });
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
  /**
   * Set up an index's evaluators (expression columns and partial WHERE). Opening a database compiles them where the
   * index is first used (`lazy`); CREATE INDEX and ALTER TABLE compile them at once, so an error is theirs.
   */
  private prepareIndex(table: TableSchema, idx: IndexSchema, lazy = false): void {
    if (!idx.where && !idx.columns.some((c) => c.expr)) {
      idx.eval = undefined;
      return;
    }
    if (!lazy) {
      Object.defineProperty(idx, 'eval', { value: this.indexEval(table, idx), writable: true, enumerable: true, configurable: true });
      return;
    }
    let ev: IndexEval | undefined;
    Object.defineProperty(idx, 'eval', {
      get: () => (ev ??= this.indexEval(table, idx)),
      set: (v: IndexEval | undefined) => Object.defineProperty(idx, 'eval', { value: v, writable: true, enumerable: true, configurable: true }),
      enumerable: true,
      configurable: true,
    });
  }

  private indexEval(table: TableSchema, idx: IndexSchema): IndexEval {
    const n = table.columns.length;
    const planner = new Planner({ getTable: (x) => this.getTable(x), openTree: (root) => this.tree(root), funcCtx: this, state: this.state }, new Registers(n + 1));
    // Bound by the language when the index was defined: plan expressions over the row (column i, the rowid at n).
    const bound = (e: { expr?: PlanExpr }): PlanExpr => {
      if (!e.expr) throw new SmaltError('SMALT_INTERNAL', `index ${idx.name} has an unbound expression`);
      return e.expr;
    };
    const plan = { cols: idx.columns.map((c) => (c.expr ? bound(c.expr) : null)), where: idx.where ? bound(idx.where) : undefined };
    // Date functions may appear, but fail if they read the clock or time zone (as in SQLite).
    const pure = pureFunctionContext(this, 'an index');
    const compile = (e: PlanExpr): Fn => planner.compileAt([e], (i) => i, pure)[0].fn;
    const cols = plan.cols.map((e) => (e ? compile(e) : null));
    const where = plan.where ? compile(plan.where) : undefined;
    const regs: SqlValue[] = new Array(Math.max(planner.regs.count, n + 1)).fill(null);
    const load = (row: readonly SqlValue[], rowid: number | bigint): SqlValue[] => {
      for (let i = 0; i < n; i++) regs[i] = row[i];
      regs[n] = rowid;
      return regs;
    };
    // Columns read by the index (plain columns, expression and WHERE references).
    const deps = new Set<number>();
    for (const c of idx.columns) if (!c.expr) deps.add(c.column);
    for (const e of [...plan.cols, plan.where]) if (e) forEachCol(e, (c) => c.index < n && deps.add(c.index));
    return {
      cols: cols.map((f) => (f ? (row: readonly SqlValue[], rowid: number | bigint) => f(load(row, rowid)) : null)),
      where: where ? (row, rowid) => truthy(where!(load(row, rowid))) === true : undefined,
      deps: [...deps],
      plan,
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

  private drop(stmt: Extract<SchemaOp, { op: 'drop' }>): RunResult {
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

  /**
   * ALTER TABLE (ADR 0015 step 7): the change is made to the stored definitions; the source texts shown beside them
   * (`sqlite_schema.sql`, expression texts) are edited by their language's {@link SourceEditor}, as SQLite edits its
   * stored statements. Views, kept as source, are checked again afterwards.
   */
  private alterTable(op: Extract<SchemaOp, { op: 'alterTable' }>): RunResult {
    const none = { changes: 0, lastInsertRowid: this.lastRowid };
    if (op.schema && !['main', 'temp'].includes(op.schema.toLowerCase())) throw new SmaltError('SMALT_ERROR', `unknown database ${op.schema}`);
    const lower = op.table.toLowerCase();
    const a = op.action;
    if (CATALOG_NAMES.has(lower) || lower.startsWith('smalt_') || lower.startsWith('sqlite_')) {
      throw new SmaltError('SMALT_ERROR', `table ${CATALOG_NAMES.has(lower) ? 'sqlite_master' : op.table} may not be altered`);
    }
    if (this.views.has(lower)) {
      throw new SmaltError('SMALT_ERROR', a.kind === 'addColumn' ? 'Cannot add a column to a view' : `view ${op.table} may not be altered`);
    }
    const table = this.getTable(lower, op.schema);
    if (!table && op.schema?.toLowerCase() !== 'temp' && this.externals.has(lower)) throw new SmaltError('SMALT_ERROR', `table ${op.table} may not be altered`);
    if (!table) throw new SmaltError('SMALT_ERROR', `no such table: ${op.schema ? `${op.schema}.` : ''}${op.table}`);
    // TEMP tables have no stored definitions (main.t reaches a shadowed main table).
    if (table.temp) throw new SmaltError('SMALT_UNSUPPORTED', `ALTER TABLE is not supported for TEMP table ${table.name}`);
    if (table.matview) throw new SmaltError('SMALT_ERROR', `materialized view ${table.name} may not be altered`);
    if (table.columnar) throw new SmaltError('SMALT_UNSUPPORTED', `ALTER TABLE is not supported for columnar table ${table.name} yet`);
    const defs = this.storedDefinitions();
    const own = defs.get(table.name.toLowerCase());
    if (own?.kind !== 'table') throw new SmaltError('SMALT_CORRUPT', `missing definition of table ${table.name}`);
    const change: AlterChange = { defs: new Map(), rows: () => null };
    let viewSuffix = '';
    switch (a.kind) {
      case 'renameTable':
        this.renameTableDefs(table, a.newName, defs, change);
        break;
      case 'renameColumn':
        this.renameColumnDefs(table, own, a.column, a.newName, defs, change);
        break;
      case 'addColumn':
        this.addColumnDefs(table, own, a, defs, change);
        break;
      case 'dropColumn':
        this.dropColumnDefs(table, own, a.column, defs, change);
        viewSuffix = ' after drop column';
        break;
    }
    this.objectChanged(table.name);
    if (a.kind === 'renameTable') this.objectChanged(a.newName);
    this.dirtySchema = true;
    this.noteValidViews();
    this.rewriteCatalog(change.rows);
    for (const [key, d] of change.defs) {
      if (d) this.writeDefinition(key, d);
      else this.deleteDefinition(key);
    }
    if (a.kind !== 'renameColumn') this.deleteStats(table.name);
    const oldTable = table;
    this.loadSchema();
    this.checkViewsAfterAlter(viewSuffix);
    if (a.kind === 'dropColumn') this.rewriteRowsWithout(oldTable, findColumn(oldTable, a.column));
    // ADD COLUMN: existing rows keep their shorter records, and readers fill in the new column's constant default.
    this.schemaChanged();
    return none;
  }

  /** Every stored definition, by catalog key. */
  private storedDefinitions(): Map<string, StoredDef> {
    const out = new Map<string, StoredDef>();
    for (const [key, text] of this.scanDefinitions()) out.set(key, decodeDef(text, key));
    return out;
  }

  /** The editor of an object's source text, by its language. */
  private sourceEditor(def: StoredDef | undefined): SourceEditor {
    const language = def && 'language' in def && def.language !== undefined ? def.language : 'sql';
    const l = LANGUAGES[language];
    if (!l) throw new SmaltError('SMALT_MISUSE', `ALTER TABLE needs the ${language} language to edit its objects' source text`);
    return l.sourceEditor;
  }

  /** Column names per table, for resolving references while editing source text. */
  private columnsOf = (name: string): ReadonlySet<string> | undefined => {
    const t = this.tables.get(name.toLowerCase());
    return t ? new Set(t.columns.map((c) => c.name.toLowerCase())) : undefined;
  };

  /** The catalog key of a catalog row. */
  private static rowKey(row: { type: string; name: string }): string {
    return row.type === 'connection' ? connectionKey(row.name) : row.name.toLowerCase();
  }

  private renameTableDefs(table: TableSchema, newName: string, defs: Map<string, StoredDef>, change: AlterChange): void {
    const lowerNew = newName.toLowerCase();
    if (lowerNew.startsWith('smalt_') || lowerNew.startsWith('sqlite_')) throw new SmaltError('SMALT_ERROR', `object name reserved for internal use: ${newName}`);
    if (this.catalog.has(lowerNew) && lowerNew !== table.name.toLowerCase()) {
      throw new SmaltError('SMALT_ERROR', `there is already another table or index with this name: ${newName}`);
    }
    const old = table.name;
    const isOld = (n: string): boolean => n.toLowerCase() === old.toLowerCase();
    const autoPrefix = `smalt_autoindex_${old}_`.toLowerCase();
    const newKey = (key: string): string => (key === old.toLowerCase() ? lowerNew : key.startsWith(autoPrefix) ? autoIndexName(newName, Number(key.slice(autoPrefix.length))).toLowerCase() : key);
    // Definitions: the table's name, its indexes' table, foreign keys that reference it; automatic indexes move.
    for (const [key, d] of defs) {
      let next: StoredDef | null = null;
      if (d.kind === 'table') {
        const fks = d.table.foreignKeys.map((f) => (isOld(f.table) ? { ...f, table: newName } : f));
        if (key === old.toLowerCase() || fks.some((f, i) => f !== d.table.foreignKeys[i])) next = { ...d, table: { ...d.table, ...(key === old.toLowerCase() ? { name: newName } : {}), foreignKeys: fks } };
      } else if (d.kind === 'index' && isOld(d.index.table)) {
        next = { ...d, index: { ...d.index, table: newName, ...(key.startsWith(autoPrefix) ? { name: autoIndexName(newName, Number(key.slice(autoPrefix.length))) } : {}) } };
      }
      const k = newKey(key);
      if (k !== key) change.defs.set(key, null);
      if (next || k !== key) change.defs.set(k, next ?? d);
    }
    change.rows = (row) => {
      const ownRow = isOld(row.tbl_name);
      const sql = row.sql === null ? null : this.sourceEditor(defs.get(Database.rowKey(row))).renameTable(row.sql, old, newName, this.columnsOf);
      const name = row.type === 'table' && ownRow ? newName : row.type === 'index' && row.name.toLowerCase().startsWith(autoPrefix) ? autoIndexName(newName, Number(row.name.slice(autoPrefix.length))) : undefined;
      if (sql === row.sql && !ownRow) return null;
      return { name, tbl_name: ownRow ? newName : undefined, sql };
    };
  }

  private renameColumnDefs(table: TableSchema, own: TableDefOf, column: string, newName: string, defs: Map<string, StoredDef>, change: AlterChange): void {
    const ci = findColumn(table, column);
    if (ci < 0) throw new SmaltError('SMALT_ERROR', `no such column: "${column}"`);
    const dup = findColumn(table, newName);
    if (dup >= 0 && dup !== ci) throw new SmaltError('SMALT_ERROR', `error in table ${table.name} after rename: duplicate column name: ${newName}`);
    const old = table.columns[ci].name;
    const editor = this.sourceEditor(own);
    const isTable = (n: string): boolean => n.toLowerCase() === table.name.toLowerCase();
    const text = <E extends ExprDef>(e: E): E => withText(e, editor.renameColumnInExpr(e.text, table.name, old, newName));
    for (const [key, d] of defs) {
      if (d.kind === 'table') {
        const t = d.table;
        const mine = key === table.name.toLowerCase();
        const fks = t.foreignKeys.map((f) => (isTable(f.table) && f.refColumns?.some((c) => c.toLowerCase() === old.toLowerCase()) ? { ...f, refColumns: f.refColumns.map((c) => (c.toLowerCase() === old.toLowerCase() ? newName : c)) } : f));
        if (!mine && fks.every((f, i) => f === t.foreignKeys[i])) continue;
        change.defs.set(key, { ...d, table: { ...t, foreignKeys: fks, ...(mine ? { columns: t.columns.map((c, i) => (i === ci ? { ...c, name: newName } : c)), checks: t.checks.map(text) } : {}) } });
      } else if (d.kind === 'index' && isTable(d.index.table)) {
        const i = d.index;
        if (!i.where && !i.columns.some((c) => c.expr)) continue;
        change.defs.set(key, { ...d, index: { ...i, columns: i.columns.map((c) => (c.expr ? { ...c, expr: text(c.expr) } : c)), ...(i.where ? { where: text(i.where) } : {}) } });
      }
    }
    change.rows = (row) => (row.sql === null ? null : { sql: this.sourceEditor(defs.get(Database.rowKey(row))).renameColumn(row.sql, table.name, old, newName, this.columnsOf) });
  }

  private hasRows(table: TableSchema): boolean {
    const c = this.tree(table.rootPage).cursor();
    try {
      return c.first();
    } finally {
      c.close();
    }
  }

  private addColumnDefs(table: TableSchema, own: TableDefOf, a: Extract<AlterAction, { kind: 'addColumn' }>, defs: Map<string, StoredDef>, change: AlterChange): void {
    if (findColumn(table, a.column.name) >= 0) throw new SmaltError('SMALT_ERROR', `duplicate column name: ${a.column.name}`);
    if (a.invalid) throw new SmaltError(a.invalid.code, a.invalid.message);
    // As in SQLite: with foreign keys on, existing rows would get a default that may reference nothing.
    if (this.fk.enabled && a.foreignKeys.length > 0 && a.column.default !== undefined && a.column.default.value !== null && this.hasRows(table)) {
      throw new SmaltError('SMALT_ERROR', 'Cannot add a REFERENCES column with non-NULL default value');
    }
    const t = own.table;
    const n = t.columns.length;
    // The rowid follows the columns: expressions that read it move one place.
    const m = (i: number): number => (i === n ? n + 1 : i);
    const key = table.name.toLowerCase();
    change.defs.set(key, { ...own, table: { ...t, columns: [...t.columns, a.column], checks: [...t.checks.map((c) => remapExpr(c, m)), ...a.checks], foreignKeys: [...t.foreignKeys, ...a.foreignKeys] } });
    for (const idx of table.indexes) remapIndexDef(idx.name, m, defs, change);
    const sql = this.sourceEditor(own).addColumn(table.sql, a.text);
    change.rows = (row) => (row.type === 'table' && row.name.toLowerCase() === key ? { sql } : null);
  }

  private dropColumnDefs(table: TableSchema, own: TableDefOf, column: string, defs: Map<string, StoredDef>, change: AlterChange): void {
    const ci = findColumn(table, column);
    if (ci < 0) throw new SmaltError('SMALT_ERROR', `no such column: "${column}"`);
    const t = own.table;
    const col = t.columns[ci];
    if (table.columns[ci].primaryKey) throw new SmaltError('SMALT_ERROR', `cannot drop PRIMARY KEY column: "${col.name}"`);
    if (t.keys.some((k) => k.kind === 'unique' && k.ofColumn === ci)) throw new SmaltError('SMALT_ERROR', `cannot drop UNIQUE column: "${col.name}"`);
    if (t.columns.length === 1) throw new SmaltError('SMALT_ERROR', `cannot drop column "${col.name}": no other columns exist`);
    // What still names the column is an error, as SQLite finds it checking the edited schema: the table's own
    // constraints (those of the column itself go with it), then indexes on the table.
    const inTable = (msg: string): SmaltError => new SmaltError('SMALT_ERROR', `error in table ${table.name} after drop column: ${msg}`);
    if (t.keys.some((k) => k.ofColumn !== ci && k.columns.some((c) => c.column === ci))) throw inTable(`no such column: ${col.name}`);
    if (t.foreignKeys.some((f) => f.ofColumn !== ci && f.columns.includes(ci))) throw inTable(`unknown column "${col.name}" in foreign key definition`);
    if (t.checks.some((c) => c.ofColumn !== ci && c.expr && readsColumn(c.expr, ci))) throw inTable(`no such column: ${col.name}`);
    for (const row of this.scanCatalog()) {
      if (row.type !== 'index' || row.tbl_name.toLowerCase() !== table.name.toLowerCase()) continue;
      const d = defs.get(row.name.toLowerCase());
      if (d?.kind !== 'index') continue;
      const i = d.index;
      if (i.columns.some((c) => c.column === ci || (c.expr?.expr && readsColumn(c.expr.expr, ci))) || (i.where?.expr && readsColumn(i.where.expr, ci))) {
        throw new SmaltError('SMALT_ERROR', `error in index ${i.name} after drop column: no such column: ${col.name}`);
      }
    }
    // The column's own constraints go with it; later columns (and the rowid) move one place.
    const m = (i: number): number => (i > ci ? i - 1 : i);
    const ofColumn = <C extends { ofColumn?: number }>(c: C): C => (c.ofColumn === undefined ? c : { ...c, ofColumn: m(c.ofColumn) });
    const key = table.name.toLowerCase();
    change.defs.set(key, {
      ...own,
      table: {
        ...t,
        columns: t.columns.filter((_, i) => i !== ci),
        keys: t.keys.map((k) => ofColumn({ ...k, columns: k.columns.map((c) => ({ ...c, column: m(c.column) })) })),
        checks: t.checks.filter((c) => c.ofColumn !== ci).map((c) => ofColumn(remapExpr(c, m))),
        foreignKeys: t.foreignKeys.filter((f) => f.ofColumn !== ci).map((f) => ofColumn({ ...f, columns: f.columns.map(m) })),
      },
    });
    for (const idx of table.indexes) remapIndexDef(idx.name, m, defs, change);
    const sql = this.sourceEditor(own).dropColumn(table.sql, ci);
    change.rows = (row) => (row.type === 'table' && row.name.toLowerCase() === key ? { sql } : null);
  }

  /** Rewrite every row of `oldTable` without column `ci`, in the table's new layout (index entries keep their keys). */
  private rewriteRowsWithout(oldTable: TableSchema, ci: number): void {
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

  /** Rewrite catalog rows; `f` returns the new (name, tbl_name, sql) or null to keep a row. */
  private rewriteCatalog(f: AlterChange['rows']): void {
    const w = this.catalogWriter();
    for (const row of this.scanCatalog()) {
      const change = f(row);
      if (!change) continue;
      const next = [row.type, change.name ?? row.name, change.tbl_name ?? row.tbl_name, row.rootpage, change.sql === undefined ? row.sql : change.sql];
      w.deleteRow(row.rowid);
      w.writeRow(next, row.rowid);
    }
  }

  /** Views that plan successfully right now (only those must keep working after an ALTER). */
  private viewWasValid = new Set<string>();
  private noteValidViews(): void {
    this.viewWasValid = new Set();
    for (const v of this.views.values()) {
      try {
        const { env, catalog } = this.viewCheckEnv();
        const planner = new Planner(env, new Registers(0));
        planner.sqlText = v.source.text;
        this.planView(v.source, planner, catalog);
        this.viewWasValid.add(v.name.toLowerCase());
      } catch {
        /* already broken */
      }
    }
  }

  /** Views that planned before the ALTER must still plan, reported the way SQLite does ("error in view v …"). */
  private checkViewsAfterAlter(suffix: string): void {
    for (const v of this.views.values()) {
      try {
        const { env, catalog } = this.viewCheckEnv();
        const planner = new Planner(env, new Registers(0));
        planner.sqlText = v.source.text;
        this.planView(v.source, planner, catalog);
      } catch (e) {
        // A view that was already broken (e.g. dangling) stays as it was, like SQLite.
        if (!this.viewWasValid.has(v.name.toLowerCase())) continue;
        throw new SmaltError('SMALT_ERROR', `error in view ${v.name}${suffix}: ${(e as Error).message}`);
      }
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

  private validateRow(
    table: TableSchema,
    row: SqlValue[],
    real: boolean[],
    checks: { fn: Fn; name: string }[],
    regs: SqlValue[],
    base: number,
    override: ConflictMode | undefined,
    defaults: (Fn | null)[],
  ): boolean {
    for (let i = 0; i < table.columns.length; i++) {
      const col = table.columns[i];
      if (col.rowidAlias) continue;
      let v = coerceForColumn(row[i], col, table.name, real[i]);
      if (v === null && col.notNull) {
        // The statement's OR action, else the column's NOT NULL ON CONFLICT action.
        const mode = override ?? col.notNullConflict ?? 'ABORT';
        if (mode === 'IGNORE') return false;
        if (mode === 'REPLACE' && defaults[i]) v = coerceForColumn(defaults[i]!(regs), col, table.name);
        if (v === null) throw constraintError('SMALT_CONSTRAINT_NOTNULL', `NOT NULL constraint failed: ${table.name}.${col.name}`, mode);
      }
      row[i] = v;
    }
    if (checks.length) {
      // CHECK constraints have no ON CONFLICT action of their own; REPLACE acts as ABORT.
      const mode = override ?? 'ABORT';
      for (let i = 0; i < row.length; i++) regs[base + i] = row[i];
      for (const c of checks) {
        const v = c.fn(regs);
        if (v !== null && truthy(v) === false) {
          if (mode === 'IGNORE') return false;
          throw constraintError('SMALT_CONSTRAINT_CHECK', `CHECK constraint failed: ${c.name}`, mode);
        }
      }
    }
    return true;
  }

  /**
   * The table's CHECK constraints and column DEFAULTs as plan expressions, once per schema version: CHECKs over the table's row (column `i` is `#0.i`, the rowid `#0.n`), DEFAULTs reading no columns.
   */
  private tableExprs(table: TableSchema): { checks: { expr: PlanExpr; name: string }[]; defaults: (PlanExpr | null)[] } {
    const hit = this.tableExprCache.get(table);
    if (hit && hit.version === this.schemaVersion) return hit;
    let checks = table.checks;
    let defaults = table.columns.map((c) => c.default);
    // Stored definitions hold bound expressions; a DEFAULT naming a function that did not exist when the table was
    // made is bound where first used, from the table's source. A failure is the binder's error.
    if (checks.some((c) => !c.expr) || defaults.some((d) => d && !d.expr)) {
      const b = bindStoredTableExprs(table, this.bindContext());
      checks = checks.map((c, i) => (c.expr ? c : { ...c, expr: b.checks[i] }));
      defaults = defaults.map((d, i) => (d && !d.expr ? { ...d, expr: b.defaults[i]! } : d));
    }
    const r = {
      version: this.schemaVersion,
      checks: checks.map((c) => ({ expr: c.expr!, name: c.name ?? c.text })),
      defaults: defaults.map((d) => d?.expr ?? null),
    };
    this.tableExprCache.set(table, r);
    return r;
  }

  private readonly tableExprCache = new WeakMap<TableSchema, { version: number; checks: { expr: PlanExpr; name: string }[]; defaults: (PlanExpr | null)[] }>();

  /** The table's CHECK constraints over a row in registers (`base + i`, the rowid in `rowidReg`). */
  private compileChecks(table: TableSchema, base: number, rowidReg: number, planner: Planner): { fn: Fn; name: string }[] {
    if (!table.checks.length) return [];
    const n = table.columns.length;
    const pure = pureFunctionContext(this, 'a CHECK constraint');
    const regOf = (i: number): number => (i < n ? base + i : rowidReg);
    return this.tableExprs(table).checks.map((c) => ({ fn: planner.compileAt([c.expr], regOf, pure)[0].fn, name: c.name }));
  }

  /** The table's column DEFAULTs (null where none). */
  private compileDefaults(table: TableSchema, planner: Planner): (Compiled | null)[] {
    if (!table.columns.some((c) => c.default)) return table.columns.map(() => null);
    return this.tableExprs(table).defaults.map((e) => (e ? planner.compileAt([e], () => -1)[0] : null));
  }

  /** Whether an INSERT may delete rows to resolve conflicts (OR REPLACE, or a constraint's ON CONFLICT REPLACE). */
  private mayReplace(op: AppendOp, table: TableSchema): boolean {
    if (op.onConflict !== undefined) return op.onConflict === 'replace';
    return table.pkConflict === 'REPLACE' || table.indexes.some((i) => i.onConflict === 'REPLACE') || table.columns.some((c) => c.notNullConflict === 'REPLACE');
  }

  /** A write plan's program (INSERT, UPDATE, DELETE), from the plan alone. */
  private compileWrite(fe: BoundWrite, planner: Planner): Omit<Program, 'regCount'> {
    const op = fe.plan;
    switch (op.op) {
      case 'append': {
        const table = this.targetTable(op.table, op.db);
        // A single row with no conflict handling or foreign keys writes once, after every check: no statement journal.
        const single = op.input?.op === 'values' && op.input.rows.length === 1 && !this.mayReplace(op, table) && op.upserts.length === 0 && !this.fkInvolvedNow(op.table);
        return this.dmlProgram(this.compileInsert(op, fe, table, planner), single);
      }
      case 'update':
        return this.dmlProgram(this.compileUpdate(op, fe, this.targetTable(op.table, op.db), planner));
      case 'delete':
        return this.dmlProgram(this.compileDelete(op, fe, this.targetTable(op.table, op.db), planner));
      default:
        throw new SmaltError('SMALT_INTERNAL', `not a write plan: ${op.op}`);
    }
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

  private compileInsert(op: AppendOp, fe: BoundWrite, table: TableSchema, planner: Planner): { exec: (r: SqlValue[], out?: SqlValue[][]) => RunResult; returning?: { columns: string[]; types: StaticType[] } } {
    const ncols = table.columns.length;
    // Where each value goes: a column, or -2 for the rowid of a table without an alias.
    const targets = op.columns.map((c) => (c === -1 ? -2 : c));
    // The statement's OR action; without one, each constraint's ON CONFLICT action applies.
    const mode = conflictMode(op.onConflict);
    const { defaults, defaultReal, base, rowidReg, checks, ret, upserts, rows } = this.insertParts(op, fe, table, planner);

    // Row source: each produces values for `targets`.
    let rowsFn: (r: SqlValue[], emit: (vals: SqlValue[], real: boolean[]) => void) => void;
    if (rows.kind === 'default') {
      rowsFn = (_r, emit) => emit([], []);
    } else if (rows.kind === 'values') {
      const values = rows.rows;
      rowsFn = (r, emit) => {
        for (const row of values) emit(row.map((c) => c.fn(r)), row.map((c) => c.type === 'real'));
      };
    } else {
      const plan = rows.plan;
      const reals = plan.columns.map((c) => c.type === 'real');
      // The SELECT reads the table it writes (in a subquery or a view, too).
      const selfRef = scansTable(op.input, table.name);
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
      // Kept across runs: busy for this run too, so a nested write to the table takes another writer.
      if (this.executeDepth > 0) this.writersBusy.add(writer);
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

  /**
   * INSERT's parts besides the column mapping, planned through the plan layer (step 8c): what belongs to the table
   * (defaults, CHECK) over the new row's registers, RETURNING, the ON CONFLICT clauses, and the rows (VALUES, or the
   * SELECT through the SELECT pipeline).
   */
  private insertParts(appended: AppendOp, fe: BoundWrite, table: TableSchema, planner: Planner): InsertParts {
    const ncols = table.columns.length;
    const prefix = () => {
      const compiled = this.compileDefaults(table, planner);
      const defaults: (Fn | null)[] = compiled.map((c) => c?.fn ?? null);
      const defaultReal = compiled.map((c) => c?.type === 'real');
      const base = planner.regs.alloc(ncols);
      const rowidReg = planner.regs.alloc();
      const checks = this.compileChecks(table, base, rowidReg, planner);
      return { defaults, defaultReal, base, rowidReg, checks };
    };
    const physical = (): InsertParts | null => {
      const p = prefix();
      // Materialized-view matching may answer the SELECT source (under the statement's policy).
      const rewrite = planner.env.rewritePlan;
      const op = rewrite ? rewrite(appended) : appended;
      if (op.op !== 'append') return null;
      const ret = fe.returning && op.returning ? { columns: fe.returning.map((c) => c.name), types: fe.returning.map((c) => c.type), fns: planner.compileRowExprs(op.returning, ncols, p.base, p.rowidReg) } : undefined;
      const upserts: Upsert[] = op.upserts.map((u) => {
        if (!u.update) return { target: u.target, update: null };
        const oldBase = planner.regs.alloc(ncols);
        const oldRowid = planner.regs.alloc();
        // The existing row's columns and rowid, then the proposed row's (`excluded`).
        const regOf = (i: number): number => (i < ncols ? oldBase + i : i === ncols ? oldRowid : i <= 2 * ncols ? p.base + i - ncols - 1 : p.rowidReg);
        const sets = planner.compileAt(u.update.sets.map((x) => x.value), regOf).map((c, k) => ({ col: u.update!.sets[k].column, c }));
        const where = u.update.where ? planner.compileAt([u.update.where], regOf)[0].fn : null;
        return { target: u.target, update: { sets, where, oldBase, oldRowid } };
      });
      let rows: InsertParts['rows'] = { kind: 'default' };
      if (op.input?.op === 'values') rows = { kind: 'values', rows: op.input.rows.map((row) => planner.compileAt(row, () => -1)) };
      else if (op.input) {
        const plan = planner.planPlan(op.input, fe.source!);
        if (!plan) return null;
        rows = { kind: 'select', plan };
      }
      return { defaults: p.defaults, defaultReal: p.defaultReal, base: p.base, rowidReg: p.rowidReg, checks: p.checks, ret, upserts, rows };
    };
    return this.planWrite(planner, physical);
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

  private compileUpdate(op: UpdateOp, fe: BoundWrite, table: TableSchema, planner: Planner): { exec: (r: SqlValue[], out?: SqlValue[][]) => RunResult; returning?: { columns: string[]; types: StaticType[] } } {
    const { root, colRegs, rowidReg, sets, defaults, base, checkRowid, checks, ret } = this.updateParts(op, fe, table, planner);
    // The statement's OR action; without one, each constraint's ON CONFLICT action applies.
    const mode = conflictMode(op.onConflict);
    const ncols = table.columns.length;
    const withFrom = op.from;

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

  private compileDelete(op: DeleteOp, fe: BoundWrite, table: TableSchema, planner: Planner): { exec: (r: SqlValue[], out?: SqlValue[][]) => RunResult; returning?: { columns: string[]; types: StaticType[] } } {
    const { root, rowidReg, oldBase, oldRowid, ret } = this.deleteParts(op, fe, planner);
    // Deleting every row without RETURNING truncates, unless foreign keys need to see every row.
    const truncate = !op.returning && wholeTable(op.input);
    const ncols = table.columns.length;
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

  /**
   * UPDATE's target rows (the target joined with the FROM sources, with its WHERE, reading the rowid), its SET values,
   * then what belongs to the table (defaults and CHECK over the new row's registers) and RETURNING, planned
   * through the plan layer (step 8b).
   */
  private updateParts(op: UpdateOp, fe: BoundWrite, table: TableSchema, planner: Planner): UpdateParts {
    type Target = Pick<UpdateParts, 'root' | 'colRegs' | 'rowidReg' | 'sets'>;
    type Returning = (base: number, checkRowid: number) => UpdateParts['ret'];
    const finish = (t: Target, returning: Returning): UpdateParts => {
      const defaults: (Fn | null)[] = this.compileDefaults(table, planner).map((c) => c?.fn ?? null);
      const base = planner.regs.alloc(table.columns.length);
      const checkRowid = planner.regs.alloc();
      const checks = this.compileChecks(table, base, checkRowid, planner);
      return { ...t, defaults, base, checkRowid, checks, ret: returning(base, checkRowid) };
    };
    const physical = (): UpdateParts | null => {
      const p = planner.planUpdate(op);
      if (!p) return null;
      // The writer's rowid assignment is column -2.
      const sets = p.sets.map((x) => ({ col: x.column < 0 ? -2 : x.column, c: x.c }));
      return finish({ root: p.root, colRegs: p.colRegs, rowidReg: p.rowidReg, sets }, (base, checkRowid) =>
        fe.returning && op.returning
          ? { columns: fe.returning.map((c) => c.name), types: fe.returning.map((c) => c.type), fns: planner.compileRowExprs(op.returning, table.columns.length, base, checkRowid) }
          : undefined,
      );
    };
    return this.planWrite(planner, physical);
  }

  /** A write's parts from the plan layer (ADR 0014), which plans every write. */
  private planWrite<T>(planner: Planner, physical: () => T | null): T {
    const p = physical();
    if (!p) throw new SmaltError('SMALT_INTERNAL', `the physical planner declined a write\n  in: ${planner.sqlText}`);
    return p;
  }

  /**
   * DELETE's target rows (the scan with its WHERE, reading the rowid) and its RETURNING over registers for the
   * deleted row, planned through the plan layer (step 8a).
   */
  private deleteParts(op: DeleteOp, fe: BoundWrite, planner: Planner): DeleteParts {
    const physical = (): DeleteParts | null => {
      const p = planner.planDelete(op);
      if (!p) return null;
      const ret = fe.returning && { columns: fe.returning.map((c) => c.name), types: fe.returning.map((c) => c.type), fns: p.returning! };
      return { root: p.root, rowidReg: p.rowidReg, oldBase: p.oldBase, oldRowid: p.oldRowid, ret };
    };
    return this.planWrite(planner, physical);
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
            c.default ? c.default.text : null,
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

  private compilePragma(stmt: Extract<BoundStatement, { kind: 'setting' }>, planner: Planner): Omit<Program, 'regCount'> {
    const arg = (): string | undefined => {
      if (!stmt.value) return undefined;
      const v = planner.compileAt([stmt.value], () => -1)[0].fn([]);
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
          let pages = 1 + check(this.pager.catalogRoot, 'smalt_schema') + check(this.pager.definitionRoot, 'smalt_definition');
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
/**
 * A compiled statement: recompiled when the schema changes or the tables it costed change size a lot. {@link Statement}
 * holds SQL; {@link PlanStatement} a statement a language bound, given as plan data (`Database.preparePlan`).
 */
export abstract class PreparedStatement {
  private program: Program | null = null;
  private version = -1;

  constructor(readonly db: Database) {}

  private checkedAt = '';

  /** The program for the current schema. */
  protected abstract compileProgram(): Program;

  /** Parameter values into the first registers. */
  protected abstract bindParams(params: BindParams | undefined, regs: SqlValue[]): void;

  /** Whether it reads memory-resident objects, for the current schema. */
  protected abstract readsMemoryObjects(): boolean;

  abstract get paramCount(): number;

  /** @internal */
  prog(): Program {
    if (this.program === null || this.version !== this.db.schemaVersion || this.statsDrifted(this.program)) {
      this.program = this.compileProgram();
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
    if (this.memoryUse?.version !== this.db.schemaVersion) this.memoryUse = { version: this.db.schemaVersion, value: this.readsMemoryObjects() };
    return this.memoryUse.value;
  }
  private memoryUse: { version: number; value: boolean } | null = null;

  private registers(params: BindParams | undefined): SqlValue[] {
    const regs: SqlValue[] = new Array(this.prog().regCount).fill(null);
    this.bindParams(params, regs);
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

/** A SQL statement. */
export class Statement extends PreparedStatement {
  constructor(
    db: Database,
    readonly parsed: ParsedStatement,
    readonly sql: string,
  ) {
    super(db);
  }

  protected compileProgram(): Program {
    return this.db.compile(this.parsed);
  }

  protected bindParams(params: BindParams | undefined, regs: SqlValue[]): void {
    bindParamValues(this.parsed, params, regs);
  }

  protected readsMemoryObjects(): boolean {
    return this.db.usesMemoryObjects(this.parsed);
  }

  get paramCount(): number {
    return this.parsed.paramCount;
  }
}

/** A statement given as plan data (`Database.preparePlan`): parameters are positional. */
export class PlanStatement extends PreparedStatement {
  /** @internal */
  constructor(
    db: Database,
    /** The statement, validated and in the engine's terms. */
    readonly bound: BoundStatement,
    readonly paramCount: number,
  ) {
    super(db);
  }

  protected compileProgram(): Program {
    return this.db.compileBound(this.bound, this.paramCount, '');
  }

  protected bindParams(params: BindParams | undefined, regs: SqlValue[]): void {
    const n = this.paramCount;
    if (params !== undefined && !Array.isArray(params)) throw new SmaltError('SMALT_RANGE', "a plan's parameters are positional: bind them with an array");
    const values = (params ?? []) as readonly (SqlValue | boolean | undefined)[];
    if (values.length !== n) throw new SmaltError('SMALT_RANGE', `statement expects ${n} parameter(s), got ${values.length}`);
    for (let i = 0; i < n; i++) regs[i] = normalizeParam(values[i], i + 1);
  }

  protected readsMemoryObjects(): boolean {
    return this.db.planUsesMemoryObjects(this.bound);
  }
}

/** Write `params` for `parsed` into `regs[0..paramCount)` (positional, or by name). */
function bindParamValues(parsed: ParsedStatement, params: BindParams | undefined, regs: SqlValue[]): void {
  const n = parsed.paramCount;
  if (params === undefined) {
    if (n > 0) throw new SmaltError('SMALT_RANGE', `statement expects ${n} parameter(s)`);
    return;
  }
  if (Array.isArray(params)) {
    if (params.length !== n) throw new SmaltError('SMALT_RANGE', `statement expects ${n} parameter(s), got ${params.length}`);
    for (let i = 0; i < n; i++) regs[i] = normalizeParam(params[i], i + 1);
    return;
  }
  const names = parsed.paramNames;
  // `?` and `?NNN` slots have no name to look up: an object cannot bind them.
  if (names.size !== n) throw new SmaltError('SMALT_RANGE', 'statement has positional parameters (? or ?NNN): bind them with an array, not an object');
  const named = params as Record<string, SqlValue>;
  for (const [name, slot] of names) {
    const bare = name.slice(1);
    const v = Object.prototype.hasOwnProperty.call(named, name) ? named[name] : named[bare];
    if (v === undefined) throw new SmaltError('SMALT_RANGE', `missing value for parameter ${name}`);
    regs[slot - 1] = normalizeParam(v, name);
  }
}

const INT64_MIN = -(BigInt(2) ** BigInt(63));
const INT64_MAX = BigInt(2) ** BigInt(63) - BigInt(1);

/** A bound value as stored: booleans 1/0, undefined and NaN NULL (as SQLite binds NaN), bigints in 64-bit range. */
function normalizeParam(v: SqlValue | boolean | undefined, slot: number | string): SqlValue {
  if (typeof v === 'number') return v === v ? v : null;
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'bigint') {
    if (v < INT64_MIN || v > INT64_MAX) throw new SmaltError('SMALT_RANGE', `parameter ${typeof slot === 'number' ? '?' + slot : slot}: integer ${v} is out of range (INTEGER values are 64-bit signed)`);
    return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
  }
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

/** Snapshot of no memory objects (shared: restoring it creates fresh maps). */
const EMPTY_MEM_SNAPSHOT: MemSnapshot = { temps: [], views: [] };

/** A query analyzed for morsel execution, with its compiled merge statement (per schema version). */
interface MorselEntry {
  version: number;
  parsed: ParsedStatement;
  /** The query's plan and result columns. */
  plan: PlanOp;
  columns: ResultColumnInfo[];
  q: PlanMorsels;
  /** The partial plan as readers receive it, and the key they cache its program by. */
  partial: EncodedPlan;
  key: string;
  merge?: Program;
}

/** See `Database.insertParts`. */
interface InsertParts {
  defaults: (Fn | null)[];
  defaultReal: boolean[];
  base: number;
  rowidReg: number;
  checks: { fn: Fn; name: string }[];
  ret: { columns: string[]; types: StaticType[]; fns: Fn[] } | undefined;
  upserts: Upsert[];
  rows: { kind: 'default' } | { kind: 'values'; rows: Compiled[][] } | { kind: 'select'; plan: QueryPlan };
}

/** See `Database.updateParts`. */
interface UpdateParts {
  root: Operator;
  colRegs: number[];
  rowidReg: number;
  sets: { col: number; c: Compiled }[];
  defaults: (Fn | null)[];
  base: number;
  checkRowid: number;
  checks: { fn: Fn; name: string }[];
  ret: { columns: string[]; types: StaticType[]; fns: Fn[] } | undefined;
}

/** See `Database.deleteParts`. */
interface DeleteParts {
  root: Operator;
  rowidReg: number;
  oldBase: number;
  oldRowid: number;
  ret: { columns: string[]; types: StaticType[]; fns: Fn[] } | undefined;
}

/** Collation names by `Collation` (materialized-view matching reads a view's columns as plan columns). */
const MATVIEW_COLLATIONS: readonly CollationName[] = ['binary', 'nocase', 'rtrim'];

type AppendOp = Extract<PlanOp, { op: 'append' }>;
type UpdateOp = Extract<PlanOp, { op: 'update' }>;
type DeleteOp = Extract<PlanOp, { op: 'delete' }>;

/** A plan's conflict action as the writer's mode (undefined: each constraint's own). */
function conflictMode(a: ConflictAction | undefined): ConflictMode | undefined {
  return a === undefined ? undefined : (a.toUpperCase() as ConflictMode);
}

/** Whether `plan` (or a subquery or nested plan in it) scans table `name`. */
function scansTable(plan: unknown, name: string): boolean {
  const lower = name.toLowerCase();
  const seen = (x: unknown): boolean => {
    if (Array.isArray(x)) return x.some(seen);
    if (!x || typeof x !== 'object' || x instanceof Uint8Array) return false;
    const o = x as Record<string, unknown>;
    if (o.op === 'scan' && typeof o.table === 'string' && o.table.toLowerCase() === lower) return true;
    return Object.values(o).some(seen);
  };
  return seen(plan);
}

/** Whether a delete's input is every row of its table (a scan, under projections only). */
function wholeTable(op: PlanOp): boolean {
  return op.op === 'scan' || (op.op === 'project' && wholeTable(op.input));
}

/** A system table's CREATE TABLE as the schema operation the engine runs: its definition, in code. */
function systemTableOp(name: SystemTableName): Extract<SchemaOp, { op: 'createTable' }> {
  return { op: 'createTable', table: SYSTEM_TABLES[name], temp: false, ifNotExists: false, source: { language: 'sql', text: systemTableSql(name) } };
}

/** The CREATE TABLE text of a materialized view's storage table (as `sqlite_schema`-style display). */
function layoutSql(def: TableDef): string {
  const q = (x: string): string => `"${x.replace(/"/g, '""')}"`;
  const coll = (c: CollationName): string => (c === 'nocase' ? ' COLLATE NOCASE' : c === 'rtrim' ? ' COLLATE RTRIM' : '');
  return `CREATE TABLE ${q(def.name)}(${def.columns.map((c) => `${q(c.name)} ${c.declaredType}${coll(c.collation)}`).join(', ')})`;
}

/** What an ALTER TABLE changes: definitions by catalog key (null: removed), and catalog rows. */
interface AlterChange {
  defs: Map<string, StoredDef | null>;
  rows: (row: { type: string; name: string; tbl_name: string; rootpage: number; sql: string | null }) => { name?: string; tbl_name?: string; sql?: string | null } | null;
}

type TableDefOf = Extract<StoredDef, { kind: 'table' }>;

/** The languages the engine reads: SQL's, until languages register with the engine (ADR 0015 step 9). */
const LANGUAGES: Readonly<Record<string, SmaltLanguage>> = { sql: sqlLanguage };

/** Whether a row expression (column `i` is `#0.i`) reads column `ci`. */
function readsColumn(e: PlanExpr, ci: number): boolean {
  let found = false;
  forEachCol(e, (c) => {
    if (c.input === 0 && c.depth === 0 && c.index === ci) found = true;
  });
  return found;
}

/** `e` with its row's columns renumbered by `m` (expressions over a table's row: CHECK, index keys and WHERE). */
function remapExpr<E extends ExprDef>(e: E, m: (i: number) => number): E {
  if (!e.expr) return e;
  const walk = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(walk);
    if (!x || typeof x !== 'object' || x instanceof Uint8Array) return x;
    const o = x as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k in o) out[k] = walk(o[k]);
    if (o.k === 'col' && o.input === 0 && o.depth === 0) out.index = m(o.index as number);
    return out;
  };
  return { ...e, expr: decodeData(walk(encodeData(e.expr))) as PlanExpr };
}

function withText<E extends ExprDef>(e: E, text: string): E {
  return text === e.text ? e : { ...e, text };
}

/** An index's definition with its table's columns renumbered by `m`. */
function remapIndexDef(name: string, m: (i: number) => number, defs: Map<string, StoredDef>, change: AlterChange): void {
  const key = name.toLowerCase();
  const d = defs.get(key);
  if (d?.kind !== 'index') return;
  const i = d.index;
  change.defs.set(key, { ...d, index: { ...i, columns: i.columns.map((c) => ({ ...c, column: c.column < 0 ? c.column : m(c.column), ...(c.expr ? { expr: remapExpr(c.expr, m) } : {}) })), ...(i.where ? { where: remapExpr(i.where, m) } : {}) } });
}

/** A plan statement's plans in the layering the physical planner reads (exec/plan-normalize.ts). */
function normalizeBound(b: BoundStatement): BoundStatement {
  switch (b.kind) {
    case 'query':
      return { ...b, plan: normalizePlan(b.plan) };
    case 'explain':
      return { ...b, query: { ...b.query, plan: normalizePlan(b.query.plan) } };
    case 'write':
      return { ...b, plan: normalizeWrite(b.plan) };
    default:
      return b;
  }
}
