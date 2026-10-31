/**
 * smaltdb client API. Runs on the main thread (or any worker) and talks to the engine worker.
 * See docs/API.md.
 */
import type { SqlValue } from '../engine/values.js';
import { type Params, type Request, type RequestBody, type Response, type WireColumn, columnValue } from '../shared/protocol.js';

export type { SqlValue, Params };

export interface OpenOptions {
  /** 'opfs' (default) persists in the Origin Private File System; 'memory' is discarded on close. */
  storage?: 'opfs' | 'memory';
  /** Page size for a new database (default 8192). */
  pageSize?: number;
  /** Page cache budget in MiB (default 16). */
  cacheMB?: number;
  /** Flush to storage on every commit (default true). */
  durable?: boolean;
  /** Override the engine worker: a URL/string to load, or an existing Worker. */
  worker?: URL | string | Worker;
}

export type RowMode = 'object' | 'array' | 'columnar';

export interface QueryOptions {
  rowMode?: RowMode;
  /** Rows per batch sent from the worker (default 4096). */
  batchSize?: number;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** Result of a query in 'array' mode: rows plus column names. */
export interface ArrayResult extends Array<SqlValue[]> {
  columns: string[];
}

/** Result of a query in 'columnar' mode. */
export interface ColumnarResult {
  columns: string[];
  length: number;
  /** One entry per column: a Float64Array (numeric columns without NULLs) or a value array. */
  data: Record<string, Float64Array | SqlValue[]>;
}

export class SmaltdbError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SmaltdbError';
  }
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  columns?: string[];
  batches?: { length: number; cols: WireColumn[] }[];
}

/** Build (and cache) an object factory for a column list: monomorphic objects, no per-row key work. */
const factoryCache = new Map<string, (vals: SqlValue[]) => Record<string, SqlValue>>();
let codegenAllowed: boolean | undefined;

function rowFactory(columns: string[]): (vals: SqlValue[]) => Record<string, SqlValue> {
  const key = columns.join('\u0000');
  let f = factoryCache.get(key);
  if (f) return f;
  if (codegenAllowed === undefined) {
    try {
      codegenAllowed = new Function('return 1')() === 1;
    } catch {
      codegenAllowed = false;
    }
  }
  // Duplicate names: later columns win, as with SQLite's object-style APIs.
  if (codegenAllowed) {
    const body = 'return {' + columns.map((c, i) => `${JSON.stringify(c)}: v[${i}]`).join(', ') + '};';
    f = new Function('v', body) as (vals: SqlValue[]) => Record<string, SqlValue>;
  } else {
    f = (vals) => {
      const o: Record<string, SqlValue> = {};
      for (let i = 0; i < columns.length; i++) o[columns[i]] = vals[i];
      return o;
    };
  }
  factoryCache.set(key, f);
  return f;
}

function defaultWorker(): Worker {
  return new Worker(new URL('./smaltdb-worker.js', import.meta.url), { type: 'module', name: 'smaltdb' });
}

/** Open (or create) a database. */
export async function open(name: string, options: OpenOptions = {}): Promise<Database> {
  let worker: Worker;
  if (options.worker instanceof Worker) worker = options.worker;
  else if (options.worker !== undefined) worker = new Worker(options.worker, { type: 'module', name: 'smaltdb' });
  else worker = defaultWorker();
  const db = new Database(worker);
  await db.request({
    op: 'open',
    name,
    storage: options.storage ?? 'opfs',
    pageSize: options.pageSize,
    cacheSizeBytes: options.cacheMB !== undefined ? options.cacheMB * 1024 * 1024 : undefined,
    syncOnCommit: options.durable,
  });
  return db;
}

type QueryResultFor<M extends RowMode | undefined, T> = M extends 'array' ? ArrayResult : M extends 'columnar' ? ColumnarResult : T[];

/** Operations shared by Database and transaction handles. */
export interface Queryable {
  query<T = Record<string, SqlValue>, M extends RowMode | undefined = undefined>(sql: string, params?: Params, options?: QueryOptions & { rowMode?: M }): Promise<QueryResultFor<M, T>>;
  exec(sql: string, params?: Params): Promise<RunResult>;
}

export class Database implements Queryable {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  /** Serializes transactions against other callers (one connection per worker). */
  private lock: Promise<void> = Promise.resolve();

  /** @internal */
  constructor(private readonly worker: Worker) {
    worker.onmessage = (e: MessageEvent<Response>) => this.onMessage(e.data);
    worker.onerror = (e) => {
      const err = new SmaltdbError('SMALT_WORKER', e.message || 'engine worker failed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
  }

  private onMessage(msg: Response): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    switch (msg.kind) {
      case 'ok':
        this.pending.delete(msg.id);
        p.resolve(msg);
        break;
      case 'error':
        this.pending.delete(msg.id);
        p.reject(new SmaltdbError(msg.code, msg.message));
        break;
      case 'columns':
        p.columns = msg.columns;
        p.batches = [];
        break;
      case 'batch':
        p.batches!.push({ length: msg.length, cols: msg.cols });
        break;
      case 'done':
        this.pending.delete(msg.id);
        p.resolve({ columns: p.columns!, batches: p.batches! });
        break;
    }
  }

  /** @internal */
  request(req: RequestBody): Promise<unknown> {
    if (this.closed) return Promise.reject(new SmaltdbError('SMALT_MISUSE', 'database is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...req, id } as Request);
    });
  }

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.lock;
    let release!: () => void;
    this.lock = new Promise((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** @internal Unlocked query (used inside transactions). */
  async rawQuery(sql: string, params: Params | undefined, options: QueryOptions): Promise<unknown> {
    const res = (await this.request({ op: 'query', sql, params, batchSize: options.batchSize })) as { columns: string[]; batches: { length: number; cols: WireColumn[] }[] };
    return materialize(res.columns, res.batches, options.rowMode ?? 'object');
  }

  /** @internal */
  async rawExec(sql: string, params: Params | undefined): Promise<RunResult> {
    const r = (await this.request({ op: 'exec', sql, params })) as { changes: number; lastInsertRowid: number | bigint };
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }

  /**
   * Run a query. Rows are objects by default (`{ id: 1, name: 'a' }`); `rowMode: 'array'` returns
   * value arrays, and `rowMode: 'columnar'` returns typed arrays per column (zero-copy).
   */
  query<T = Record<string, SqlValue>, M extends RowMode | undefined = undefined>(
    sql: string,
    params?: Params,
    options: QueryOptions & { rowMode?: M } = {},
  ): Promise<QueryResultFor<M, T>> {
    return this.withLock(() => this.rawQuery(sql, params, options)) as Promise<QueryResultFor<M, T>>;
  }

  /** Execute one statement (with params) or a script of statements (without). */
  exec(sql: string, params?: Params): Promise<RunResult> {
    return this.withLock(() => this.rawExec(sql, params));
  }

  /** Prepare a statement for repeated execution. */
  async prepare(sql: string): Promise<PreparedStatement> {
    const r = (await this.withLock(() => this.request({ op: 'prepare', sql }))) as { stmt: number; columns: string[]; paramCount: number };
    return new PreparedStatement(this, r.stmt, r.columns, r.paramCount);
  }

  /**
   * Run `fn` in a transaction: COMMIT on success, ROLLBACK if it throws. Other calls on this
   * Database wait until the transaction finishes.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      await this.rawExec('BEGIN', undefined);
      const tx: Queryable = {
        query: (sql, params, options = {}) => this.rawQuery(sql, params, options) as never,
        exec: (sql, params) => this.rawExec(sql, params),
      };
      try {
        const result = await fn(tx);
        await this.rawExec('COMMIT', undefined);
        return result;
      } catch (e) {
        await this.rawExec('ROLLBACK', undefined).catch(() => undefined);
        throw e;
      }
    });
  }

  /** Close the database and terminate the engine worker. */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.withLock(() => this.request({ op: 'close' }));
    this.closed = true;
    this.worker.terminate();
  }
}

export class PreparedStatement {
  /** @internal */
  constructor(
    private readonly db: Database,
    private readonly id: number,
    readonly columns: string[],
    readonly paramCount: number,
  ) {}

  async query<T = Record<string, SqlValue>, M extends RowMode | undefined = undefined>(params?: Params, options: QueryOptions & { rowMode?: M } = {}): Promise<QueryResultFor<M, T>> {
    const res = (await this.db.request({ op: 'stmtQuery', stmt: this.id, params, batchSize: options.batchSize })) as { columns: string[]; batches: { length: number; cols: WireColumn[] }[] };
    return materialize(res.columns, res.batches, options.rowMode ?? 'object') as QueryResultFor<M, T>;
  }

  async run(params?: Params): Promise<RunResult> {
    const r = (await this.db.request({ op: 'stmtRun', stmt: this.id, params })) as { changes: number; lastInsertRowid: number | bigint };
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }

  async finalize(): Promise<void> {
    await this.db.request({ op: 'finalize', stmt: this.id });
  }
}

function materialize(columns: string[], batches: { length: number; cols: WireColumn[] }[], mode: RowMode): unknown {
  const width = columns.length;
  if (mode === 'columnar') {
    let length = 0;
    for (const b of batches) length += b.length;
    const data: Record<string, Float64Array | SqlValue[]> = {};
    for (let c = 0; c < width; c++) {
      const allNumeric = batches.every((b) => b.cols[c].t === 'f64' && (b.cols[c] as { nulls: Uint8Array | null }).nulls === null);
      if (allNumeric) {
        if (batches.length === 1) data[columns[c]] = (batches[0].cols[c] as { data: Float64Array }).data;
        else {
          const out = new Float64Array(length);
          let off = 0;
          for (const b of batches) {
            out.set((b.cols[c] as { data: Float64Array }).data, off);
            off += b.length;
          }
          data[columns[c]] = out;
        }
      } else {
        const out: SqlValue[] = new Array(length);
        let off = 0;
        for (const b of batches) {
          const col = b.cols[c];
          for (let i = 0; i < b.length; i++) out[off + i] = columnValue(col, i);
          off += b.length;
        }
        data[columns[c]] = out;
      }
    }
    return { columns, length, data } satisfies ColumnarResult;
  }
  const rows: unknown[] = [];
  const make = mode === 'object' ? rowFactory(columns) : null;
  const vals: SqlValue[] = new Array(width);
  for (const b of batches) {
    const cols = b.cols;
    for (let i = 0; i < b.length; i++) {
      if (make) {
        for (let c = 0; c < width; c++) vals[c] = columnValue(cols[c], i);
        rows.push(make(vals));
      } else {
        const row: SqlValue[] = new Array(width);
        for (let c = 0; c < width; c++) row[c] = columnValue(cols[c], i);
        rows.push(row);
      }
    }
  }
  if (mode === 'array') (rows as unknown as ArrayResult).columns = columns;
  return rows;
}
