/// <reference lib="webworker" />
/**
 * The engine worker runtime (smaltdb/worker-runtime). `defineWorker({ languages, plugins })` (or `serve`, the same)
 * makes the current dedicated worker an engine worker with those languages registered (ADR 0015) and those plugins
 * installed (ADR 0012). The default worker (smaltdb/worker) is `serve()`; an application that uses plugins or another
 * language writes its own entry:
 *
 *     import { defineWorker } from 'smaltdb/worker-runtime';
 *     import parquet from '@smaltdb/parquet';
 *     defineWorker({ plugins: [parquet] });
 *
 * and opens the database with `open(name, { worker: () => new Worker(new URL('./db-worker.ts',
 * import.meta.url), { type: 'module' }) })`. Parallel readers are started from the same
 * script, so they get the same plugins.
 *
 * A worker serves in one of two roles:
 *
 * - **Owner** (default): owns the database files (OPFS sync access handles are only available in
 *   dedicated workers) and serves the client that created it, plus other tabs over a
 *   BroadcastChannel when it is the multi-tab leader (server.ts, ADR 0009). Where shared
 *   (`readwrite-unsafe`) handles exist, it also starts parallel reader workers and hands them
 *   read-only queries.
 * - **Reader** (started by an owner with an 'init' message): opens the same files read-only and
 *   answers the queries it is given from a snapshot of the latest commit, straight to the client.
 */
import { Database } from './database.js';
import { SmaltError, errorCode } from './errors.js';
import { EngineServer, type PartialTask, type ReaderPool, defaultOpen } from './server.js';
import type { SqlValue } from './values.js';
import { detectCapabilities } from './vfs/capabilities.js';
import { OpfsVfs } from './vfs/opfs.js';
import type { SmaltPlugin } from './plugin.js';
import { registerLanguage, type SmaltLanguage } from './plan/language.js';
import type { BusMessage, ReaderMessage, ReaderSettings, Request, Response } from '../shared/protocol.js';

export interface ServeOptions {
  /** Languages to register in this worker's engine (and its parallel readers), by their names. */
  languages?: readonly SmaltLanguage[];
  /** Plugins to install in this worker's engine (and its parallel readers). */
  plugins?: readonly SmaltPlugin[];
}

let serving = false;

/** Make the current dedicated worker an engine worker. Call it once, at the top level of the worker script. */
export function serve(options: ServeOptions = {}): void {
  if (serving) throw new SmaltError('SMALT_MISUSE', 'serve() was already called in this worker');
  serving = true;
  for (const language of options.languages ?? []) registerLanguage(language);
  const plugins = options.plugins ?? [];
  const installed = plugins.map((p) => ({ name: p.name, version: p.version }));
  const scope = self as unknown as DedicatedWorkerGlobalScope;

  // ------------------------------------------------------------------ reader role

  function startReader(init: Extract<ReaderMessage, { type: 'init' }>): void {
    const port = init.port;
    const bus = init.bus ? new BroadcastChannel(init.bus) : null;
    let job: { session: string; id: number } | null = null;
    const server = new EngineServer(
      (session, msg, transfer = []) => {
        if (msg.kind === 'columns') msg.reader = init.reader;
        if (session === EngineServer.LOCAL) port.postMessage(msg, transfer);
        else bus?.postMessage({ type: 'res', session, res: msg } satisfies BusMessage);
        // The query is over: tell the owner this reader is free (and may checkpoint).
        if (job && session === job.session && msg.id === job.id && (msg.kind === 'done' || msg.kind === 'error' || msg.kind === 'ok')) {
          job = null;
          scope.postMessage({ type: 'idle', reader: init.reader } satisfies ReaderMessage);
        }
      },
      // Readers never refresh materialized views (the owner's scheduler does).
      { open: () => Database.openReader(new OpfsVfs(), `${init.name}.db`, { pageSize: init.pageSize, cacheSizeBytes: init.cacheSizeBytes, spillPath: `${init.name}.db-spill-r${init.reader}`, plugins }), refreshTimer: false },
    );
    // Open (with the shared interrupt flag); the 'ok' goes to id 0, which the client ignores.
    server.receive(EngineServer.LOCAL, { id: 0, op: 'open', name: init.name, storage: 'opfs', interrupt: init.interrupt });
    const waitOpen = (): void => {
      if (server.db) scope.postMessage({ type: 'ready', reader: init.reader } satisfies ReaderMessage);
      else setTimeout(waitOpen, 5);
    };
    waitOpen();
    scope.onmessage = (e: MessageEvent<ReaderMessage>) => {
      const m = e.data;
      if (m.type === 'partial') {
        // A morsel: partial aggregates over a rowid range, back to the owner (which merges them).
        let msg: ReaderMessage;
        try {
          server.db!.refreshSnapshot();
          if (m.settings) server.db!.applyReaderSettings(m.settings);
          msg = { type: 'partialDone', reader: init.reader, task: m.task, rows: server.db!.runPartial(m) };
        } catch (err) {
          msg = { type: 'partialDone', reader: init.reader, task: m.task, error: err instanceof Error ? err.message : String(err) };
        }
        scope.postMessage(msg);
        return;
      }
      if (m.type !== 'job') return;
      if (m.req.op === 'query' || m.req.op === 'queryPlan') {
        // A new query: move to the latest commit and take the owner's settings first.
        try {
          server.db!.refreshSnapshot();
          if (m.settings) server.db!.applyReaderSettings(m.settings);
        } catch (err) {
          scope.postMessage({ type: 'failed', reader: init.reader, message: String(err) } satisfies ReaderMessage);
        }
        job = { session: m.session, id: m.req.id };
      }
      server.receive(m.session, m.req);
    };
  }

  // ------------------------------------------------------------------ owner role

  let bus: BroadcastChannel | null = null;
  const leaderId = crypto.randomUUID();

  /** What a reader worker is busy with: a client's query (streamed to it directly) or a morsel. */
  type ReaderJob = { kind: 'query'; session: string; id: number } | { kind: 'partial'; task: number };

  /** Parallel readers of this owner (empty when shared handles are unavailable). */
  class Readers implements ReaderPool {
    private readonly workers: { w: Worker; ready: boolean; job: ReaderJob | null }[] = [];
    private readonly partials = new Map<number, (err: string | null, rows: SqlValue[][] | null) => void>();
    private nextTask = 1;

    idle(): number {
      return this.workers.filter((r) => r.ready && r.job === null).length;
    }

    partial(task: PartialTask, done: (err: string | null, rows: SqlValue[][] | null) => void): boolean {
      const r = this.workers.find((x) => x.ready && x.job === null);
      if (!r) return false;
      const id = this.nextTask++;
      r.job = { kind: 'partial', task: id }; // busy (and holds checkpoints back) until the partial is done
      this.partials.set(id, done);
      r.w.postMessage({ type: 'partial', task: id, plan: task.plan, key: task.key, params: task.params, settings: task.settings } satisfies ReaderMessage);
      return true;
    }

    /** Queries running on readers: checkpoints wait for zero. */
    get active(): number {
      return this.workers.filter((r) => r.job !== null).length;
    }

    start(count: number, open: Extract<Request, { op: 'open' }>): void {
      for (let i = 0; i < count; i++) {
        const w = new Worker(scope.location.href, { type: 'module', name: `smaltdb-reader-${i + 1}` });
        const entry = { w, ready: false, job: null as ReaderJob | null };
        this.workers.push(entry);
        const ch = new MessageChannel();
        w.onmessage = (e: MessageEvent<ReaderMessage>) => {
          const m = e.data;
          if (m.type === 'ready') entry.ready = true;
          else if (m.type === 'idle') entry.job = null;
          else if (m.type === 'failed') entry.ready = false;
          else if (m.type === 'partialDone') {
            entry.job = null;
            const done = this.partials.get(m.task);
            this.partials.delete(m.task);
            done?.(m.error ?? null, m.rows ?? null);
          }
        };
        w.onerror = () => {
          entry.ready = false;
          // Partials it was running will not come back: fail them (the owner answers the query itself).
          if (entry.job?.kind === 'partial') {
            const done = this.partials.get(entry.job.task);
            this.partials.delete(entry.job.task);
            entry.job = null;
            done?.('reader failed', null);
          }
        };
        // The client's end of the direct result channel.
        scope.postMessage({ id: 0, kind: 'port', port: ch.port1 } satisfies Response, [ch.port1]);
        w.postMessage(
          { type: 'init', name: open.name, pageSize: open.pageSize, cacheSizeBytes: open.cacheSizeBytes, reader: i + 1, port: ch.port2, bus: open.bus, interrupt: open.interrupt } satisfies ReaderMessage,
          [ch.port2],
        );
      }
    }

    dispatch(session: string, req: Extract<Request, { op: 'query' | 'queryPlan' }>, settings: ReaderSettings): boolean {
      const r = this.workers.find((x) => x.ready && x.job === null);
      if (!r) return false;
      r.job = { kind: 'query', session, id: req.id };
      r.w.postMessage({ type: 'job', session, req, settings } satisfies ReaderMessage);
      return true;
    }

    forward(session: string, req: Request): boolean {
      const target = (req as { target?: number }).target;
      const r = this.workers.find((x) => x.job?.kind === 'query' && x.job.session === session && x.job.id === target);
      if (!r) return false;
      r.w.postMessage({ type: 'job', session, req } satisfies ReaderMessage);
      return true;
    }

    stop(): void {
      for (const r of this.workers) r.w.terminate();
      this.workers.length = 0;
    }
  }

  const readers = new Readers();

  const server = new EngineServer(
    (session: string, msg: Response, transfer: Transferable[] = []) => {
      if (session === EngineServer.LOCAL) scope.postMessage(msg, transfer);
      else bus?.postMessage({ type: 'res', session, res: msg } satisfies BusMessage);
    },
    {
      open: async (req) => {
        // Parallel readers need shared handles, which give up the file lock: only under the
        // multi-tab leader lock (one owner per database), for OPFS files, where supported.
        const caps = detectCapabilities();
        const parallel = !!req.bus && req.storage === 'opfs' && caps.readwriteUnsafe && (caps.hardwareConcurrency ?? 1) > 1;
        if (!parallel) return defaultOpen(() => new OpfsVfs(), plugins)(req);
        const db = await Database.open(new OpfsVfs(), `${req.name}.db`, { pageSize: req.pageSize, cacheSizeBytes: req.cacheSizeBytes, syncOnCommit: req.syncOnCommit, sharedHandles: true, plugins });
        db.setCheckpointGate(() => readers.active === 0);
        readers.start(Math.min(3, (caps.hardwareConcurrency ?? 2) - 1), req);
        return db;
      },
      capabilities: () => ({ ...detectCapabilities(), plugins: installed }),
      // Another tab holds a lock named after its session for as long as it lives: when we are
      // granted that lock, the tab is gone.
      watchSession: (session) => {
        if (!bus || !navigator.locks) return;
        void navigator.locks.request(`${bus.name}:client:${session}`, () => server.sessionGone(session));
      },
      readers,
    },
  );

  function startOwner(): void {
    // Materialized views with `refresh_on_reconnect` refresh when the network comes back.
    scope.addEventListener('online', () => server.reconnected());
    scope.onmessage = (e: MessageEvent<Request>) => {
      const req = e.data;
      if (req.op === 'open' && req.bus && !bus) {
        bus = new BroadcastChannel(req.bus);
        bus.onmessage = (ev: MessageEvent<BusMessage>) => {
          const m = ev.data;
          if (m.type === 'hello') bus!.postMessage({ type: 'leader', leader: leaderId } satisfies BusMessage);
          else if (m.type === 'req' && m.leader === leaderId) server.receive(m.session, m.req);
        };
        bus.postMessage({ type: 'leader', leader: leaderId } satisfies BusMessage);
      }
      if (req.op === 'close') readers.stop();
      try {
        server.receive(EngineServer.LOCAL, req);
      } catch (err) {
        const code = errorCode(err);
        scope.postMessage({ id: req.id, kind: 'error', code, message: err instanceof Error ? err.message : String(err) } satisfies Response);
      }
    };
  }

  // The first message decides the role.
  scope.onmessage = (e: MessageEvent<Request | ReaderMessage>) => {
    const m = e.data as { type?: string };
    if (m.type === 'init') startReader(e.data as Extract<ReaderMessage, { type: 'init' }>);
    else {
      startOwner();
      scope.onmessage!(e);
    }
  };
}

/**
 * Makes the current dedicated worker an engine worker with these languages and plugins (ADR 0015): what a language's
 * worker entry calls. The same as `serve`; call one of them once, at the top level of the worker script.
 */
export function defineWorker(options: ServeOptions = {}): void {
  serve(options);
}
