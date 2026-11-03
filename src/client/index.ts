/**
 * smaltdb client API. Runs on the main thread (or any worker) and talks to the engine worker.
 * See docs/API.md.
 */
import type { SqlValue } from '../engine/values.js';
import { type BusMessage, type Params, type Request, type RequestBody, type Response, type WireColumn, columnValue } from '../shared/protocol.js';

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
  /**
   * Override the engine worker: a function that starts one (called again when this tab takes over
   * a shared database), a URL/string to load, or an existing Worker. For a worker entry with
   * plugins (ADR 0012), use a function, so bundlers see the worker:
   * `worker: () => new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' })`.
   */
  worker?: (() => Worker) | URL | string | Worker;
  /**
   * Share the database with other tabs of this origin (default: on for OPFS when Web Locks and
   * BroadcastChannel exist). One tab's engine worker owns the file; other tabs send it their
   * requests. When that tab closes, another takes over (in-flight requests then fail with
   * SMALT_RETRY and can be retried).
   */
  multiTab?: boolean;
}

export type RowMode = 'object' | 'array' | 'columnar';

export interface QueryOptions {
  rowMode?: RowMode;
  /** Rows per batch sent from the worker (default 4096). */
  batchSize?: number;
  /** Cancel the request: queued requests and streams stop at once; running statements are interrupted when possible. */
  signal?: AbortSignal;
}

export interface StreamOptions extends QueryOptions {
  /** Batches the engine may send ahead of the consumer (default 4). */
  highWaterMark?: number;
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
  /** Streams: called per message instead of collecting batches. */
  onMessage?: (msg: Response) => void;
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

function makeWorker(options: OpenOptions): Worker {
  if (typeof options.worker === 'function') return options.worker();
  if (options.worker instanceof Worker) return options.worker;
  if (options.worker !== undefined) return new Worker(options.worker, { type: 'module', name: 'smaltdb' });
  return defaultWorker();
}

/** Open (or create) a database. */
export async function open(name: string, options: OpenOptions = {}): Promise<Database> {
  const storage = options.storage ?? 'opfs';
  const canShare = typeof navigator !== 'undefined' && !!navigator.locks && typeof BroadcastChannel !== 'undefined';
  const multiTab = (options.multiTab ?? storage === 'opfs') && canShare && storage === 'opfs' && name !== ':memory:';
  const db = new Database();
  const openReq = {
    op: 'open' as const,
    name,
    storage,
    pageSize: options.pageSize,
    cacheSizeBytes: options.cacheMB !== undefined ? options.cacheMB * 1024 * 1024 : undefined,
    syncOnCommit: options.durable,
  };
  if (multiTab) await db.attachShared(name, options, openReq);
  else db.attachWorker(makeWorker(options), openReq, undefined);
  await db.request(openReq);
  return db;
}

type QueryResultFor<M extends RowMode | undefined, T> = M extends 'array' ? ArrayResult : M extends 'columnar' ? ColumnarResult : T[];

/** Operations shared by Database and transaction handles. */
export interface Queryable {
  query<T = Record<string, SqlValue>, M extends RowMode | undefined = undefined>(sql: string, params?: Params, options?: QueryOptions & { rowMode?: M }): Promise<QueryResultFor<M, T>>;
  exec(sql: string, params?: Params, options?: { signal?: AbortSignal }): Promise<RunResult>;
}

/**
 * The `tx` handle of `db.transaction()`: everything it runs is part of the transaction. It works
 * only while the callback runs; afterwards its methods reject with SMALT_MISUSE.
 */
export interface Transaction extends Queryable {
  /** Stream a query's result inside the transaction (see Database.stream). */
  stream<T = Record<string, SqlValue>, M extends RowMode | undefined = undefined>(sql: string, params?: Params, options?: StreamOptions & { rowMode?: M }): AsyncIterableIterator<QueryResultFor<M, T>>;
  /** Run a statement prepared with `db.prepare()` (before the transaction) inside the transaction. */
  statement(stmt: PreparedStatement): TransactionStatement;
}

/** A prepared statement used through a transaction handle: `tx.statement(stmt)`. */
export interface TransactionStatement {
  readonly columns: string[];
  readonly paramCount: number;
  query<T = Record<string, SqlValue>, M extends RowMode | undefined = undefined>(params?: Params, options?: QueryOptions & { rowMode?: M }): Promise<QueryResultFor<M, T>>;
  stream<T = Record<string, SqlValue>, M extends RowMode | undefined = undefined>(params?: Params, options?: StreamOptions & { rowMode?: M }): AsyncIterableIterator<QueryResultFor<M, T>>;
  run(params?: Params, options?: { signal?: AbortSignal }): Promise<RunResult>;
}

/** Where requests go: this tab's engine worker, or another tab's over a BroadcastChannel. */
interface Link {
  send(req: Request): void;
  close(): void;
}

export class Database implements Queryable {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private closed = false;
  /** Serializes transactions against other callers (one connection per worker). */
  private lock: Promise<void> = Promise.resolve();
  private link: Link | null = null;
  /** Interrupt flag shared with this tab's engine worker (cross-origin isolated pages). */
  private interrupt: Int32Array | null = null;
  /** Incremented when the owning tab changes; prepared statements of an older owner are stale. */
  epoch = 0;
  /** Multi-tab: this tab owns the engine worker. */
  isLeader = true;
  /** Queries answered by parallel reader workers / by the owner (diagnostics). */
  readonly stats = { readerQueries: 0, ownerQueries: 0, morselQueries: 0 };
  /** Set while this client's transaction runs: other calls on this Database wait for it. */
  private txRunning: Promise<void> | null = null;
  private onClose: (() => void)[] = [];

  /** @internal */
  attachWorker(worker: Worker, openReq: Extract<RequestBody, { op: 'open' }>, bus: string | undefined): void {
    worker.onmessage = (e: MessageEvent<Response>) => {
      const m = e.data;
      // A parallel reader's direct channel: its results arrive there.
      if (m.kind === 'port') m.port.onmessage = (pe: MessageEvent<Response>) => this.onMessage(pe.data);
      else this.onMessage(m);
    };
    worker.onerror = (e) => this.failAll(new SmaltdbError('SMALT_WORKER', e.message || 'engine worker failed'));
    if (typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated) {
      const sab = new SharedArrayBuffer(4);
      this.interrupt = new Int32Array(sab);
      (openReq as { interrupt?: SharedArrayBuffer }).interrupt = sab;
    }
    if (bus) (openReq as { bus?: string }).bus = bus;
    this.link = { send: (req) => worker.postMessage(req), close: () => worker.terminate() };
    this.isLeader = true;
  }

  /**
   * @internal Multi-tab: become the owner (leader) if no tab owns the database, else send requests
   * to the owner and queue to take over when it goes away.
   */
  async attachShared(name: string, options: OpenOptions, openReq: Extract<RequestBody, { op: 'open' }>): Promise<void> {
    const busName = `smaltdb:${name}`;
    const session = crypto.randomUUID();
    const locks = navigator.locks;
    let releaseClient!: () => void;
    let releaseLeader: (() => void) | null = null;
    // Held for this tab's lifetime: the owner learns we are gone when it can take this lock.
    await new Promise<void>((held) => {
      void locks.request(`${busName}:client:${session}`, () => {
        held();
        return new Promise<void>((r) => (releaseClient = r));
      });
    });
    const bus = new BroadcastChannel(busName);
    let leader: string | null = null;
    let queue: Request[] = [];
    const becomeLeader = (): void => {
      // Requests sent to a previous owner are lost with it.
      if (leader !== null || queue.length > 0 || this.pending.size > 0) this.failAll(new SmaltdbError('SMALT_RETRY', 'the tab that owned the database closed; retry'), true);
      queue = [];
      this.epoch++;
      bus.onmessage = null;
      this.attachWorker(makeWorker(options), openReq, busName);
    };
    const follow = (): void => {
      this.isLeader = false;
      bus.onmessage = (e: MessageEvent<BusMessage>) => {
        const m = e.data;
        if (m.type === 'res' && m.session === session) this.onMessage(m.res);
        else if (m.type === 'leader' && m.leader !== leader) {
          if (leader !== null) {
            this.epoch++;
            this.failAll(new SmaltdbError('SMALT_RETRY', 'the tab that owned the database closed; retry'), true);
          }
          const changed = leader !== null;
          leader = m.leader;
          const q = queue;
          queue = [];
          for (const req of q) bus.postMessage({ type: 'req', session, leader, req } satisfies BusMessage);
          if (changed) this.replayRegistrations();
        }
      };
      this.link = {
        send: (req) => {
          if (leader === null) queue.push(req);
          else bus.postMessage({ type: 'req', session, leader, req } satisfies BusMessage);
        },
        close: () => undefined,
      };
      bus.postMessage({ type: 'hello', session } satisfies BusMessage);
    };
    const isLeader = await new Promise<boolean>((resolve) => {
      void locks.request(`${busName}:leader`, { ifAvailable: true }, (lock) => {
        if (!lock) {
          resolve(false);
          return undefined;
        }
        resolve(true);
        return new Promise<void>((r) => (releaseLeader = r));
      });
    });
    if (isLeader) this.attachWorker(makeWorker(options), openReq, busName);
    else {
      follow();
      // Take over when the owner goes away.
      void locks.request(`${busName}:leader`, () => {
        if (this.closed) return undefined;
        becomeLeader();
        // A follower that was already open re-opens the database in its new worker.
        void this.request(openReq).catch(() => undefined);
        this.replayRegistrations();
        return new Promise<void>((r) => (releaseLeader = r));
      });
    }
    this.onClose.push(() => {
      bus.close();
      releaseLeader?.();
      releaseClient();
    });
  }

  /** @internal Reject every in-flight request (worker failure, change of owner). */
  private failAll(err: SmaltdbError, all = true): void {
    if (!all) return;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private onMessage(msg: Response): void {
    if (msg.kind === 'pluginAsk') {
      void this.answerPlugin(msg);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    if (msg.kind === 'columns') {
      if (msg.reader) this.stats.readerQueries++;
      else if (msg.morsels) this.stats.morselQueries++;
      else this.stats.ownerQueries++;
    }
    if (p.onMessage) {
      if (msg.kind === 'error' || msg.kind === 'done' || msg.kind === 'ok') this.pending.delete(msg.id);
      p.onMessage(msg);
      return;
    }
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

  /** @internal Send a request; `signal` cancels it. `onMessage` receives a stream's messages. */
  request(req: RequestBody, signal?: AbortSignal, onMessage?: (msg: Response) => void): Promise<unknown> & { id: number } {
    if (this.closed) return Object.assign(Promise.reject(new SmaltdbError('SMALT_MISUSE', 'database is closed')), { id: -1 });
    if (signal?.aborted) return Object.assign(Promise.reject(new SmaltdbError('SMALT_INTERRUPT', 'interrupted')), { id: -1 });
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onMessage });
      this.link!.send({ ...req, id } as Request);
    });
    if (signal) {
      const abort = (): void => this.cancel(id);
      signal.addEventListener('abort', abort, { once: true });
      void promise.then(
        () => signal.removeEventListener('abort', abort),
        () => signal.removeEventListener('abort', abort),
      );
    }
    return Object.assign(promise, { id });
  }

  /** @internal Stop request `id`: dequeue it, close its stream, or interrupt it while it runs. */
  cancel(id: number): void {
    if (!this.pending.has(id)) return;
    if (this.interrupt && this.isLeader) Atomics.store(this.interrupt, 0, id);
    this.link!.send({ id: 0, op: 'cancel', target: id });
  }

  /** @internal Run `fn` after earlier writes and transactions of this client, holding back later ones. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
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
    const res = (await this.request({ op: 'query', sql, params, batchSize: options.batchSize }, options.signal)) as { columns: string[]; batches: { length: number; cols: WireColumn[] }[] };
    return materialize(res.columns, res.batches, options.rowMode ?? 'object');
  }

  /** @internal */
  async rawExec(sql: string, params: Params | undefined, signal?: AbortSignal): Promise<RunResult> {
    const r = (await this.request({ op: 'exec', sql, params }, signal)) as { changes: number; lastInsertRowid: number | bigint };
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
    // Reads may run concurrently (on parallel readers); they only wait for this client's transaction.
    return this.afterTransaction(() => this.rawQuery(sql, params, options)) as Promise<QueryResultFor<M, T>>;
  }

  /** @internal Run `fn` once this client's running transaction (if any) has ended. */
  async afterTransaction<T>(fn: () => Promise<T>): Promise<T> {
    while (this.txRunning) await this.txRunning;
    return fn();
  }

  /** Execute one statement (with params) or a script of statements (without). */
  exec(sql: string, params?: Params, options: { signal?: AbortSignal } = {}): Promise<RunResult> {
    return this.withLock(() => this.rawExec(sql, params, options.signal));
  }

  /**
   * Stream a query's result in batches: `for await (const rows of db.stream(sql)) …`. The engine
   * sends at most `highWaterMark` batches ahead and pauses until they are consumed; leaving the
   * loop early closes the result. While a stream is open, this tab's writes fail with SMALT_BUSY
   * (other tabs' writes wait); reads continue. Like `query`, it starts after a running transaction.
   */
  stream<T = Record<string, SqlValue>, M extends RowMode | undefined = undefined>(
    sql: string,
    params?: Params,
    options: StreamOptions & { rowMode?: M } = {},
  ): AsyncIterableIterator<QueryResultFor<M, T>> {
    return this.openStream({ op: 'query', sql, params, batchSize: options.batchSize }, options, true) as AsyncIterableIterator<QueryResultFor<M, T>>;
  }

  /** @internal `waitForTransaction`: send the request only once this client's running transaction has ended. */
  openStream(body: RequestBody, options: StreamOptions, waitForTransaction = false): AsyncIterableIterator<unknown> {
    const hwm = Math.max(1, options.highWaterMark ?? 4);
    const mode = options.rowMode ?? 'object';
    const ready: unknown[] = [];
    let columns: string[] = [];
    let finished = false;
    let failure: unknown = null;
    let wake: (() => void) | null = null;
    const notify = (): void => {
      wake?.();
      wake = null;
    };
    let id = -1;
    const start = (): void => {
      if (finished) return; // closed before it started
      const req = this.request({ ...body, credit: hwm } as RequestBody, options.signal, (msg) => {
        if (msg.kind === 'columns') columns = msg.columns;
        else if (msg.kind === 'batch') ready.push(materialize(columns, [{ length: msg.length, cols: msg.cols }], mode));
        else if (msg.kind === 'done') finished = true;
        else if (msg.kind === 'error') {
          finished = true;
          failure = new SmaltdbError(msg.code, msg.message);
        }
        notify();
      });
      req.catch((e) => {
        finished = true;
        failure = e;
        notify();
      });
      id = req.id;
    };
    if (waitForTransaction && this.txRunning) void this.afterTransaction(async () => start());
    else start();
    const it: AsyncIterableIterator<unknown> = {
      [Symbol.asyncIterator]: () => it,
      next: async () => {
        for (;;) {
          if (ready.length > 0) {
            const value = ready.shift();
            if (!finished) this.link?.send({ id: 0, op: 'credit', target: id, n: 1 });
            return { value, done: false };
          }
          if (failure !== null) throw failure;
          if (finished) return { value: undefined, done: true };
          await new Promise<void>((r) => (wake = r));
        }
      },
      return: async () => {
        if (!finished) {
          finished = true;
          if (id >= 0) this.cancel(id);
        }
        return { value: undefined, done: true };
      },
    };
    return it;
  }

  /**
   * Call method `method` of plugin `plugin` in the engine worker (ADR 0012). Plugins export helpers
   * that call this, e.g. `importCSV(db, …)` from `@smaltdb/io`, so applications rarely call it
   * directly. Options:
   * - `lock`: wait for (and hold off) other requests and transactions of this Database, as `exec` does.
   * - `replay`: a key under which the call is sent again to a new engine worker when this tab takes
   *   over a shared database (state that lives in the worker, such as registered files). A later
   *   call with the same key replaces it; `dropReplay` removes it.
   */
  callPlugin(plugin: string, method: string, args: unknown[], options: { lock?: boolean; replay?: string; dropReplay?: boolean; signal?: AbortSignal } = {}): Promise<unknown> {
    if (options.replay !== undefined) {
      if (options.dropReplay) this.replays.delete(options.replay);
      else this.replays.set(options.replay, { plugin, method, args });
    }
    const call = async (): Promise<unknown> => ((await this.request({ op: 'pluginCall', plugin, method, args }, options.signal)) as { value?: unknown }).value;
    return options.lock ? this.withLock(call) : call();
  }

  /**
   * Answer plugin `plugin`'s questions from the engine (e.g. fresh credentials for a request): the
   * handler's value (or promise) is the answer. One handler per plugin; null removes it.
   */
  onPluginMessage(plugin: string, handler: ((message: unknown) => unknown) | null): void {
    if (handler === null) this.pluginHandlers.delete(plugin);
    else this.pluginHandlers.set(plugin, handler);
  }

  /** Calls to send again to a new owner (another tab taking over), by replay key. */
  private readonly replays = new Map<string, { plugin: string; method: string; args: unknown[] }>();
  private readonly pluginHandlers = new Map<string, (message: unknown) => unknown>();

  /** @internal After a change of owner: send this tab's replayable plugin calls (registered files, credentials) to it. */
  replayRegistrations(): void {
    for (const c of this.replays.values()) void this.request({ op: 'pluginCall', plugin: c.plugin, method: c.method, args: c.args }).catch(() => undefined);
  }

  /** A plugin in the engine asks this tab's handler a question. */
  private async answerPlugin(msg: Extract<Response, { kind: 'pluginAsk' }>): Promise<void> {
    const h = this.pluginHandlers.get(msg.plugin);
    let reply: { value?: unknown; error?: string };
    try {
      if (!h) throw new Error(`this tab has no handler for ${msg.plugin} (onPluginMessage)`);
      reply = { value: await h(msg.message) };
    } catch (e) {
      reply = { error: e instanceof Error ? e.message : String(e) };
    }
    const send = (r: { value?: unknown; error?: string }): void => this.link?.send({ id: 0, op: 'pluginReply', target: msg.request, ...r });
    try {
      send(reply);
    } catch (e) {
      // An answer the browser cannot clone (a function, …): fail the question now rather than let
      // the engine wait out its timeout.
      try {
        send({ error: `the answer could not be sent to the engine: ${e instanceof Error ? e.message : String(e)}` });
      } catch {
        // the link is gone: the engine learns that the session closed
      }
    }
  }

  /** Prepare a statement for repeated execution. */
  async prepare(sql: string): Promise<PreparedStatement> {
    const epoch = this.epoch;
    const r = (await this.withLock(() => this.request({ op: 'prepare', sql }))) as { stmt: number; columns: string[]; paramCount: number };
    return new PreparedStatement(this, r.stmt, r.columns, r.paramCount, epoch);
  }

  /**
   * Run `fn` in a transaction: COMMIT on success, ROLLBACK if it throws. Every other call on this
   * Database and its prepared statements waits until the transaction finishes: run statements through
   * `tx`. If `fn` ends the transaction itself, a COMMIT stands (the promise resolves) and a ROLLBACK
   * rejects the promise with SMALT_ERROR.
   */
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    return this.withLock(async () => {
      let done!: () => void;
      this.txRunning = new Promise<void>((r) => (done = r));
      try {
        return await this.runTransaction(fn);
      } finally {
        this.txRunning = null;
        done();
      }
    });
  }

  private async runTransaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
    await this.rawExec('BEGIN', undefined);
    let active = true;
    const ended = (): SmaltdbError => new SmaltdbError('SMALT_MISUSE', 'the transaction has ended: use tx only while the transaction callback runs');
    const tx: Transaction = {
      query: (sql, params, options = {}) => (active ? this.rawQuery(sql, params, options) : Promise.reject(ended())) as never,
      exec: (sql, params, options = {}) => (active ? this.rawExec(sql, params, options.signal) : Promise.reject(ended())),
      stream: (sql, params, options = {}) => (active ? this.openStream({ op: 'query', sql, params, batchSize: options.batchSize }, options) : failingIterator(ended())) as never,
      statement: (stmt) => {
        if (stmt.db !== this) throw new SmaltdbError('SMALT_MISUSE', 'the statement was prepared on another Database');
        return {
          columns: stmt.columns,
          paramCount: stmt.paramCount,
          query: (params, options = {}) => (active ? stmt.rawQuery(params, options) : Promise.reject(ended())) as never,
          stream: (params, options = {}) => (active ? stmt.rawStream(params, options) : failingIterator(ended())) as never,
          run: (params, options = {}) => (active ? stmt.rawRun(params, options) : Promise.reject(ended())),
        };
      },
    };
    let result: T;
    try {
      result = await fn(tx);
      active = false;
    } catch (e) {
      active = false;
      await this.request({ op: 'endTransaction', commit: false }).catch(() => undefined);
      throw e;
    }
    let end: { ended?: 'commit' | 'rollback' };
    try {
      end = (await this.request({ op: 'endTransaction', commit: true })) as { ended?: 'commit' | 'rollback' };
    } catch (e) {
      await this.request({ op: 'endTransaction', commit: false }).catch(() => undefined);
      throw e;
    }
    // The callback ran ROLLBACK itself: nothing it did was committed.
    if (end.ended === 'rollback') throw new SmaltdbError('SMALT_ERROR', 'the transaction was rolled back inside the transaction callback');
    return result;
  }

  /**
   * Close the database. The tab that owns the engine worker closes the file and terminates the
   * worker (another tab then takes over); other tabs just detach.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    await this.withLock(() => this.request({ op: 'close' })).catch(() => undefined);
    this.closed = true;
    if (this.isLeader) this.link?.close();
    for (const f of this.onClose) f();
  }
}

export class PreparedStatement {
  /** @internal */
  constructor(
    /** @internal */
    readonly db: Database,
    private readonly id: number,
    readonly columns: string[],
    readonly paramCount: number,
    private readonly epoch: number,
  ) {}

  /** Statement ids belong to the tab that owned the engine when they were prepared. */
  private check(): void {
    if (this.epoch !== this.db.epoch) throw new SmaltdbError('SMALT_RETRY', 'the tab that owned the database changed; prepare the statement again');
  }

  /** Run and return the rows (see Database.query); waits for a running transaction, like it. */
  async query<T = Record<string, SqlValue>, M extends RowMode | undefined = undefined>(params?: Params, options: QueryOptions & { rowMode?: M } = {}): Promise<QueryResultFor<M, T>> {
    this.check();
    return this.db.afterTransaction(() => this.rawQuery(params, options)) as Promise<QueryResultFor<M, T>>;
  }

  /** Stream the statement's result in batches (see Database.stream); starts after a running transaction. */
  stream<T = Record<string, SqlValue>, M extends RowMode | undefined = undefined>(params?: Params, options: StreamOptions & { rowMode?: M } = {}): AsyncIterableIterator<QueryResultFor<M, T>> {
    this.check();
    return this.db.openStream({ op: 'stmtQuery', stmt: this.id, params, batchSize: options.batchSize }, options, true) as AsyncIterableIterator<QueryResultFor<M, T>>;
  }

  /** Run for effect (see Database.exec); runs in call order with exec and waits for a running transaction. */
  async run(params?: Params, options: { signal?: AbortSignal } = {}): Promise<RunResult> {
    this.check();
    return this.db.withLock(() => this.rawRun(params, options));
  }

  /** @internal Unlocked query (inside a transaction). */
  async rawQuery(params: Params | undefined, options: QueryOptions): Promise<unknown> {
    this.check();
    const res = (await this.db.request({ op: 'stmtQuery', stmt: this.id, params, batchSize: options.batchSize }, options.signal)) as { columns: string[]; batches: { length: number; cols: WireColumn[] }[] };
    return materialize(res.columns, res.batches, options.rowMode ?? 'object');
  }

  /** @internal */
  rawStream(params: Params | undefined, options: StreamOptions): AsyncIterableIterator<unknown> {
    this.check();
    return this.db.openStream({ op: 'stmtQuery', stmt: this.id, params, batchSize: options.batchSize }, options);
  }

  /** @internal */
  async rawRun(params: Params | undefined, options: { signal?: AbortSignal }): Promise<RunResult> {
    this.check();
    const r = (await this.db.request({ op: 'stmtRun', stmt: this.id, params }, options.signal)) as { changes: number; lastInsertRowid: number | bigint };
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }

  async finalize(): Promise<void> {
    if (this.epoch !== this.db.epoch) return;
    await this.db.request({ op: 'finalize', stmt: this.id });
  }
}

/** An iterator whose first `next()` rejects with `err`. */
function failingIterator(err: unknown): AsyncIterableIterator<never> {
  const it: AsyncIterableIterator<never> = {
    [Symbol.asyncIterator]: () => it,
    next: () => Promise.reject(err),
    return: async () => ({ value: undefined, done: true }),
  };
  return it;
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
