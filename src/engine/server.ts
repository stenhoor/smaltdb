/**
 * Engine request server (M6, ADR 0009): owns one Database and serves requests from several client
 * sessions (the tab that owns the engine worker plus other tabs over a BroadcastChannel).
 *
 * - **Scheduling.** Requests queue and run one at a time. The server yields to the event loop
 *   between requests and between result batches, so cancellations, credits and short requests
 *   from other sessions get through while long results stream.
 * - **Transactions belong to a session.** While a session's transaction is open, other sessions'
 *   requests wait (one connection: they would otherwise see or join its uncommitted changes).
 * - **Streams.** A query sends its result in batches. With a credit (backpressure), it sends that
 *   many batches and pauses until the client grants more. A paused stream keeps its read cursor
 *   open: writes wait until it finishes or is cancelled (a write from the stream's own session
 *   gets SMALT_BUSY instead, since waiting would deadlock).
 * - **Cancellation.** `cancel` removes a queued request or closes a stream. A statement that is
 *   already running is stopped through the interrupt flag (a SharedArrayBuffer shared with the
 *   local client, checked every few hundred page fetches).
 * - **Sessions that disappear** (a closed tab) lose their queued work and streams; an open
 *   transaction is rolled back.
 */
import { type BindParams, Database, RowCursor, type Statement } from './database.js';
import { SmaltError } from './errors.js';
import { exportCSV, exportJSON, importCSV, importJSON } from './io/import-export.js';
import type { Vfs } from './vfs/types.js';
import { type Request, type Response, encodeColumns } from '../shared/protocol.js';
import type { SqlValue } from './values.js';

/** Sends a response to a session. */
export type Send = (session: string, msg: Response, transfer?: Transferable[]) => void;

interface Job {
  session: string;
  req: Request;
  /** Waiting for open read cursors to close (a write hit SMALT_BUSY). */
  blocked: boolean;
  /** Run on the owner, not as morsels (a morsel run of it already failed). */
  noMorsels?: boolean;
}

interface Stream {
  session: string;
  id: number;
  cursor: RowCursor;
  batchSize: number;
  /** Batches the client still accepts (Infinity without backpressure). */
  credit: number;
  /** Reads the database while it streams (writes must wait); false for precomputed rows (merged morsels). */
  holdsReads: boolean;
}

export interface ServerOptions {
  /** Opens the database for an 'open' request. */
  open(req: Extract<Request, { op: 'open' }>): Promise<Database> | Database;
  /** Capabilities reported to clients on open. */
  capabilities?: () => unknown;
  /** Called when a session starts holding state (transaction or stream), to watch for its disappearance. */
  watchSession?(session: string): void;
  /** Parallel reader workers: may take a read-only query (returns false when none is idle). */
  readers?: ReaderPool;
}

/** Parallel readers as seen by the owner's server. */
export interface ReaderPool {
  /** Hand a read-only query to an idle reader; false when none is idle. */
  dispatch(session: string, req: Extract<Request, { op: 'query' }>): boolean;
  /** Route a credit or cancel for a query a reader is serving; false if none is. */
  forward(session: string, req: Request): boolean;
  /** Readers idle right now (morsel parallelism needs at least two). */
  idle?(): number;
  /**
   * Run the partial aggregates of `task.sql` over rowids [lo, hi) on an idle reader (M7.4);
   * `done` receives its rows, or an error message. False when no reader is idle.
   */
  partial?(task: PartialTask, done: (err: string | null, rows: SqlValue[][] | null) => void): boolean;
}

/** One morsel of a parallel aggregate. */
export interface PartialTask {
  sql: string;
  params?: unknown;
  lo: number;
  hi: number;
}

/** A query whose morsels are out on readers. */
interface MorselJob {
  session: string;
  id: number;
  cancelled: boolean;
}

/** Work done between yields to the event loop, in milliseconds. */
const SLICE_MS = 8;

export class EngineServer {
  db: Database | null = null;
  private readonly queue: Job[] = [];
  private readonly streams: Stream[] = [];
  private readonly statements = new Map<number, Statement>();
  private nextStmt = 1;
  private txOwner: string | null = null;
  private pumping = false;
  private current: Job | null = null;
  private interruptFlag: Int32Array | null = null;
  private readonly watched = new Set<string>();
  /** Queries split into morsels, waiting for their partials (writes wait for them). */
  private readonly morselJobs: MorselJob[] = [];
  /** Queries answered by merging morsels (statistics, tests). */
  morselQueries = 0;

  constructor(
    private readonly send: Send,
    private readonly options: ServerOptions,
  ) {}

  /** Session of the client that owns the engine worker. */
  static readonly LOCAL = 'local';

  /** A request from `session`. Credits and cancellations act immediately; the rest queue. */
  receive(session: string, req: Request): void {
    if ((req.op === 'credit' || req.op === 'cancel') && this.options.readers?.forward(session, req)) return;
    if (req.op === 'credit') {
      const s = this.streams.find((x) => x.session === session && x.id === req.target);
      if (s) s.credit += req.n;
      this.kick();
      return;
    }
    if (req.op === 'cancel') {
      this.cancel(session, req.target);
      return;
    }
    if (req.op === 'open' && req.interrupt) this.interruptFlag = new Int32Array(req.interrupt);
    this.queue.push({ session, req, blocked: false });
    this.kick();
  }

  /** A session went away: drop its work, close its streams, roll back its transaction. */
  sessionGone(session: string): void {
    this.watched.delete(session);
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i].session === session) this.queue.splice(i, 1);
    for (const m of this.morselJobs) if (m.session === session) m.cancelled = true;
    for (let i = this.streams.length - 1; i >= 0; i--) {
      if (this.streams[i].session === session) {
        this.streams[i].cursor.close();
        this.streams.splice(i, 1);
      }
    }
    if (this.txOwner === session && this.db?.inTransaction) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // already rolled back
      }
    }
    if (this.txOwner === session) this.txOwner = null;
    this.unblock();
    this.kick();
  }

  private cancel(session: string, target: number): void {
    const qi = this.queue.findIndex((j) => j.session === session && j.req.id === target);
    if (qi >= 0) {
      this.queue.splice(qi, 1);
      this.fail(session, target, new SmaltError('SMALT_INTERRUPT', 'interrupted'));
      return;
    }
    const mj = this.morselJobs.find((m) => m.session === session && m.id === target && !m.cancelled);
    if (mj) {
      mj.cancelled = true; // the partials finish on the readers; their rows are dropped
      this.fail(session, target, new SmaltError('SMALT_INTERRUPT', 'interrupted'));
      return;
    }
    const si = this.streams.findIndex((s) => s.session === session && s.id === target);
    if (si >= 0) {
      const [s] = this.streams.splice(si, 1);
      s.cursor.close();
      this.fail(session, target, new SmaltError('SMALT_INTERRUPT', 'interrupted'));
      this.unblock();
      this.kick();
    }
    // A running statement is stopped through the interrupt flag (set by the client).
  }

  private fail(session: string, id: number, err: unknown): void {
    const code = err instanceof SmaltError ? err.code : 'SMALT_INTERNAL';
    // Some engines (WebKit) raise DOMExceptions with an empty message: keep the name then.
    this.send(session, { id, kind: 'error', code, message: err instanceof Error ? err.message || err.name : String(err) });
  }

  private kick(): void {
    if (!this.pumping) {
      this.pumping = true;
      // Start on a fresh task: messages that already arrived (e.g. a batch of concurrent queries)
      // are queued first, so routing sees the real demand.
      nextTask(() => void this.pump());
    }
  }

  private unblock(): void {
    if (this.morselJobs.length === 0 && !this.streams.some((s) => s.holdsReads)) for (const j of this.queue) j.blocked = false;
  }

  /** Whether `session` may run now (no other session's transaction is open). */
  private allowed(session: string): boolean {
    return this.txOwner === null || this.txOwner === session;
  }

  private async pump(): Promise<void> {
    try {
      let sliceStart = Date.now();
      for (;;) {
        let worked = false;
        // Requests first (in arrival order, skipping sessions that must wait).
        const ji = this.queue.findIndex((j) => !j.blocked && this.allowed(j.session));
        if (ji >= 0) {
          const [job] = this.queue.splice(ji, 1);
          await this.run(job);
          worked = true;
        } else {
          // Then one batch of each stream that has credit.
          for (const s of [...this.streams]) {
            if (s.credit > 0 && this.allowed(s.session) && this.streams.includes(s)) {
              this.streamBatch(s);
              worked = true;
            }
          }
        }
        if (!worked) break;
        if (Date.now() - sliceStart >= SLICE_MS) {
          await yieldToEventLoop();
          sliceStart = Date.now();
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async run(job: Job): Promise<void> {
    const { session, req } = job;
    this.current = job;
    try {
      await this.handle(session, req);
    } catch (err) {
      if (err instanceof SmaltError && err.code === 'SMALT_BUSY' && /query cursor is open/.test(err.message)) {
        // A write while reads are held. Morsel queries finish by themselves: wait for them (also when
        // they are this session's own). Streams wait for their clients: wait unless they are this
        // session's own (waiting for itself would deadlock).
        const holders = this.streams.filter((s) => s.holdsReads).map((s) => s.session);
        if (this.morselJobs.length > 0 || (holders.length > 0 && holders.every((s) => s !== session))) {
          job.blocked = true;
          this.queue.unshift(job);
          return;
        }
      }
      this.fail(session, req.id, err);
    } finally {
      this.current = null;
      // A cancel that arrived too late to interrupt anything must not hit the next statement.
      if (this.interruptFlag && session === EngineServer.LOCAL && Atomics.load(this.interruptFlag, 0) === req.id) Atomics.store(this.interruptFlag, 0, 0);
      const db = this.db;
      this.txOwner = db?.inTransaction ? session : null;
      if (this.txOwner !== null) this.watch(this.txOwner);
    }
  }

  private watch(session: string): void {
    if (session === EngineServer.LOCAL || this.watched.has(session)) return;
    this.watched.add(session);
    this.options.watchSession?.(session);
  }

  private requireDb(): Database {
    if (!this.db) throw new SmaltError('SMALT_MISUSE', 'database is not open');
    return this.db;
  }

  private async handle(session: string, req: Request): Promise<void> {
    const { id } = req;
    switch (req.op) {
      case 'open': {
        if (this.db) {
          // Another tab joining an open database (multi-tab): nothing to open.
          this.send(session, { id, kind: 'ok', capabilities: this.options.capabilities?.() });
          return;
        }
        this.db = await this.options.open(req);
        const flag = this.interruptFlag;
        if (flag) {
          this.db.setInterruptCheck(() => {
            const cur = this.current;
            if (cur && cur.session === EngineServer.LOCAL && Atomics.load(flag, 0) === cur.req.id) {
              Atomics.store(flag, 0, 0);
              throw new SmaltError('SMALT_INTERRUPT', 'interrupted');
            }
          });
        }
        this.send(session, { id, kind: 'ok', capabilities: this.options.capabilities?.() });
        return;
      }
      case 'exec': {
        const d = this.requireDb();
        if (req.params !== undefined) {
          const r = d.run(req.sql, req.params as BindParams);
          this.send(session, { id, kind: 'ok', changes: r.changes, lastInsertRowid: r.lastInsertRowid });
        } else {
          d.exec(req.sql);
          this.send(session, { id, kind: 'ok', changes: d.changes(), lastInsertRowid: d.lastInsertRowid() });
        }
        return;
      }
      case 'query': {
        const st = this.requireDb().prepare(req.sql);
        if (this.toMorsels(session, st, req.sql, req)) return;
        if (this.toReader(session, st, req.sql, req)) return;
        this.startStream(session, id, st.cursor(req.params as BindParams | undefined), req.batchSize ?? 4096, req.credit);
        return;
      }
      case 'prepare': {
        const st = this.requireDb().prepare(req.sql);
        const sid = this.nextStmt++;
        this.statements.set(sid, st);
        this.send(session, { id, kind: 'ok', stmt: sid, columns: st.columns, paramCount: st.paramCount });
        return;
      }
      case 'stmtRun': {
        const st = this.statement(req.stmt);
        const r = st.run(req.params as BindParams | undefined);
        this.send(session, { id, kind: 'ok', changes: r.changes, lastInsertRowid: r.lastInsertRowid });
        return;
      }
      case 'stmtQuery': {
        const st = this.statement(req.stmt);
        if (this.toMorsels(session, st, st.sql, req)) return;
        if (this.toReader(session, st, st.sql, req)) return;
        this.startStream(session, id, st.cursor(req.params as BindParams | undefined), req.batchSize ?? 4096, req.credit);
        return;
      }
      case 'finalize':
        this.statements.delete(req.stmt);
        this.send(session, { id, kind: 'ok' });
        return;
      case 'import': {
        const d = this.requireDb();
        const text = new TextDecoder().decode(req.data);
        const r = req.format === 'csv' ? importCSV(d, req.table, text, req.options) : importJSON(d, req.table, text, req.options);
        this.send(session, { id, kind: 'ok', changes: r.rows });
        return;
      }
      case 'export': {
        const d = this.requireDb();
        const params = req.params as SqlValue[] | Record<string, SqlValue> | undefined;
        const text = req.format === 'csv' ? exportCSV(d, req.sql, params, req.options) : exportJSON(d, req.sql, params, req.options);
        this.send(session, { id, kind: 'ok', text });
        return;
      }
      case 'close':
        if (session !== EngineServer.LOCAL) {
          // Another tab detaching: forget its state, keep the database open.
          this.sessionGone(session);
          this.send(session, { id, kind: 'ok' });
          return;
        }
        for (const s of this.streams) s.cursor.close();
        this.streams.length = 0;
        this.statements.clear();
        // Morsel queries still out on readers: they end here (their late results are dropped).
        for (const m of this.morselJobs) {
          if (m.cancelled) continue;
          m.cancelled = true;
          this.fail(m.session, m.id, new SmaltError('SMALT_MISUSE', 'database is closed'));
        }
        this.db?.close();
        this.db = null;
        this.send(session, { id, kind: 'ok' });
        return;
    }
  }

  /**
   * Parallel readers: a read-only query outside any transaction runs on an idle reader worker's
   * snapshot of the latest commit (the reader answers the session directly).
   */
  private toReader(session: string, st: Statement, sql: string, req: { id: number; params?: unknown; batchSize?: number; credit?: number }): boolean {
    const pool = this.options.readers;
    if (!pool || this.txOwner !== null || this.db?.inTransaction || !st.readonly || st.usesMemoryObjects) return false;
    // A reader pays for a snapshot refresh and a hand-off: worth it only when other requests are
    // waiting behind this one (concurrent demand). Alone, the owner answers fastest.
    if (this.queue.length === 0) return false;
    return pool.dispatch(session, { op: 'query', id: req.id, sql, params: req.params as never, batchSize: req.batchSize, credit: req.credit });
  }

  /**
   * Morsel parallelism (M7.4): an aggregate over a large table, with at least two idle readers,
   * runs as partial aggregates over rowid ranges on the readers and is merged here. Writes wait
   * until every partial is back, so all morsels see the same commit.
   */
  private toMorsels(session: string, st: Statement, sql: string, req: { id: number; params?: unknown; batchSize?: number; credit?: number }): boolean {
    const pool = this.options.readers;
    const db = this.db;
    const job0 = this.current;
    if (!pool?.partial || !pool.idle || !db || job0 === null || job0.noMorsels || this.txOwner !== null || db.inTransaction || !st.readonly || st.usesMemoryObjects) return false;
    const idle = pool.idle();
    if (idle < 2) return false;
    const ranges = db.parallelSplit(sql, idle);
    if (!ranges) return false;
    const job: MorselJob = { session, id: req.id, cancelled: false };
    const release = db.holdReads();
    const partials: SqlValue[][][] = new Array(ranges.length);
    let pending = ranges.length;
    let failed: string | null = null;
    const finish = (): void => {
      release();
      this.morselJobs.splice(this.morselJobs.indexOf(job), 1);
      if (!job.cancelled) {
        if (this.db !== db) {
          // The database was closed (or replaced) meanwhile: never answer from a closed handle.
          this.fail(session, req.id, new SmaltError('SMALT_MISUSE', 'database is closed'));
        } else if (failed !== null) {
          // A reader failed: run the query again on the owner, as an ordinary queued request, so it
          // waits its turn (transactions of other sessions, held reads) like any other.
          this.queue.unshift({ session, req: job0.req, blocked: false, noMorsels: true });
        } else {
          try {
            // Precomputed rows: the stream holds no reads, so writes need not wait for its client.
            const result = db.mergePartials(sql, req.params as BindParams | undefined, partials.flat());
            this.morselQueries++;
            this.startStream(session, req.id, new RowCursor(db, null, result.rows, [], result.columns), req.batchSize ?? 4096, req.credit, ranges.length);
          } catch (err) {
            this.fail(session, req.id, err);
          }
        }
      }
      this.unblock();
      this.kick();
    };
    this.morselJobs.push(job);
    this.watch(session);
    ranges.forEach((r, i) => {
      const ok = pool.partial!({ sql, params: req.params, lo: r.lo, hi: r.hi }, (err, rows) => {
        if (err !== null) failed ??= err;
        else partials[i] = rows!;
        if (--pending === 0) finish();
      });
      if (!ok) {
        failed ??= 'no idle reader';
        if (--pending === 0) finish();
      }
    });
    return true;
  }

  private statement(id: number): Statement {
    const st = this.statements.get(id);
    if (!st) throw new SmaltError('SMALT_MISUSE', 'statement is finalized');
    return st;
  }

  private startStream(session: string, id: number, cursor: RowCursor, batchSize: number, credit: number | undefined, morsels?: number): void {
    this.send(session, morsels ? { id, kind: 'columns', columns: cursor.columns, morsels } : { id, kind: 'columns', columns: cursor.columns });
    const s: Stream = { session, id, cursor, batchSize, credit: credit ?? Infinity, holdsReads: cursor.plan !== null };
    this.streams.push(s);
    this.watch(session);
    // Results without backpressure are sent right away (the common case: whole results).
    if (s.credit === Infinity) {
      while (this.streams.includes(s)) this.streamBatch(s);
    }
  }

  /** Send one batch of a stream (or finish it). */
  private streamBatch(s: Stream): void {
    const width = s.cursor.columns.length;
    const cols: SqlValue[][] = Array.from({ length: width }, () => []);
    let n: number;
    try {
      n = s.cursor.nextBatch(s.batchSize, cols);
    } catch (err) {
      this.endStream(s);
      this.fail(s.session, s.id, err);
      return;
    }
    if (n > 0) {
      const { cols: wire, transfer } = encodeColumns(cols, n);
      this.send(s.session, { id: s.id, kind: 'batch', length: n, cols: wire }, transfer);
      s.credit--;
    }
    if (n < s.batchSize) {
      this.endStream(s);
      this.send(s.session, { id: s.id, kind: 'done' });
    }
  }

  private endStream(s: Stream): void {
    s.cursor.close();
    const i = this.streams.indexOf(s);
    if (i >= 0) this.streams.splice(i, 1);
    this.unblock();
    this.kick();
  }
}

/** Let pending messages (credits, cancels, other sessions) be delivered. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((r) => nextTask(r));
}

/**
 * Run `fn` as a new task, after messages already waiting (MessageChannel: no timer clamping, so
 * microseconds rather than setTimeout's milliseconds).
 */
const nextTask: (fn: () => void) => void = (() => {
  if (typeof MessageChannel === 'undefined') return (fn: () => void) => void setTimeout(fn, 0);
  const ch = new MessageChannel();
  const queue: (() => void)[] = [];
  ch.port1.onmessage = () => queue.shift()?.();
  // Node: do not keep the process alive for this channel.
  (ch.port1 as { unref?: () => void }).unref?.();
  (ch.port2 as { unref?: () => void }).unref?.();
  return (fn: () => void) => {
    queue.push(fn);
    ch.port2.postMessage(0);
  };
})();

/** Default opener: OPFS file `<name>.db` (with WAL) or an in-memory database. */
export function defaultOpen(vfs: () => Vfs): ServerOptions['open'] {
  return async (req) => {
    const options = { pageSize: req.pageSize, cacheSizeBytes: req.cacheSizeBytes, syncOnCommit: req.syncOnCommit };
    return req.storage === 'memory' || req.name === ':memory:' ? Database.openMemory(options) : Database.open(vfs(), `${req.name}.db`, options);
  };
}
