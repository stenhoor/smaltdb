/**
 * Message protocol between the client library (main thread / other workers) and the engine
 * worker. See docs/WORKER_MODEL.md §5. Results travel as columnar batches; numeric columns use
 * transferable Float64Arrays.
 */
import type { ErrorDetails } from '../engine/errors.js';
import type { PlanType } from '../engine/plan/types.js';
import type { SqlValue } from '../engine/values.js';

/**
 * Statement parameters: an array for `?` / `?NNN` slots or an object for named ones. Besides SQL
 * values, `true` / `false` bind as 1 / 0 and `undefined` (in an array) as NULL; they cross the
 * worker boundary unchanged (structured clone) and the engine converts them.
 */
export type Params = readonly (SqlValue | boolean | undefined)[] | Readonly<Record<string, SqlValue | boolean>>;

export interface OpenRequest {
  op: 'open';
  name: string;
  storage: 'opfs' | 'memory';
  pageSize?: number;
  cacheSizeBytes?: number;
  syncOnCommit?: boolean;
  /**
   * Interrupt flag (cross-origin isolated pages): Int32 slot 0 holds the id of a request to stop.
   * The engine checks it while statements run (every few hundred page fetches).
   */
  interrupt?: SharedArrayBuffer;
  /** Multi-tab: BroadcastChannel name on which the engine also serves other tabs. */
  bus?: string;
}

export type Request = { id: number } & (
  | OpenRequest
  | { op: 'exec'; sql: string; params?: Params }
  /** `credit`: batches to send before waiting for a 'credit' request (backpressure); omitted = all. */
  | { op: 'query'; sql: string; params?: Params; batchSize?: number; credit?: number }
  | { op: 'prepare'; sql: string }
  /**
   * A statement given as plan data (ADR 0014 section 4): `plan` is its JSON text (engine/plan/codec.ts
   * `encodeDataJSON`), in plan format `planVersion`. Parameters are positional.
   */
  /** `data`: the plan's typed arrays (values given as columns), which its JSON refers to as `{$data: i}`; `transfer`: their buffers were handed over. */
  | { op: 'queryPlan'; plan: string; planVersion: number; data?: unknown[]; transfer?: true; params?: readonly (SqlValue | boolean | undefined)[]; batchSize?: number; credit?: number }
  | { op: 'preparePlan'; plan: string; planVersion: number; data?: unknown[]; transfer?: true }
  | { op: 'stmtRun'; stmt: number; params?: Params }
  | { op: 'stmtQuery'; stmt: number; params?: Params; batchSize?: number; credit?: number }
  | { op: 'finalize'; stmt: number }
  /** The logical catalog as plain data (engine/plan/catalog.ts `CatalogData`), in the reply's `value`. */
  | { op: 'catalog' }
  /**
   * End this session's transaction (db.transaction()): COMMIT (`commit`) or ROLLBACK. If a request of
   * the session already ended it, the reply's `ended` says how instead.
   */
  | { op: 'endTransaction'; commit: boolean }
  | { op: 'close' }
  /** Call a plugin's method (ADR 0012); the reply's `value` is its result. */
  | { op: 'pluginCall'; plugin: string; method: string; args: unknown[] }
  /** Answer to a 'pluginAsk' message: the client handler's value, or why it failed. */
  | { op: 'pluginReply'; target: number; value?: unknown; error?: string }
  /** Grant `n` more batches to the stream of request `target`. */
  | { op: 'credit'; target: number; n: number }
  /** Stop request `target`: dequeue it or close its stream (running statements: interrupt flag). */
  | { op: 'cancel'; target: number }
);

/**
 * Connection settings that change how a parallel reader answers a query (set on the owner with
 * PRAGMA). Sent with every query and morsel handed to a reader, which applies them first.
 */
export interface ReaderSettings {
  /** `PRAGMA work_mem`: bytes sorts and hash aggregates use before spilling. */
  workMem: number;
  /** `PRAGMA matview_rewrite`: answer queries from fresh materialized views. */
  matviewRewrite: boolean;
}

/** Owner worker <-> parallel reader worker. */
export type ReaderMessage =
  /** `proxy`: the reader reads the owner's files through the owner over this channel (vfs/proxy.ts, ADR 0021). */
  | { type: 'init'; name: string; pageSize?: number; cacheSizeBytes?: number; reader: number; port: MessagePort; bus?: string; interrupt?: SharedArrayBuffer; proxy?: SharedArrayBuffer }
  /** A proxied reader is waiting for the owner to answer its channel. */
  | { type: 'io'; reader: number }
  /** `settings`: the owner's, for a query (credits and cancels for a running query carry none). */
  | { type: 'job'; session: string; req: Request; settings?: ReaderSettings }
  /**
   * Morsel parallelism: partial aggregates of a plan over a rowid range, answered with 'partialDone'. `plan` is an
   * encoded plan (engine/plan/codec.ts), the same for every range of a query; `key` names it (readers cache its
   * program); `params` are the query's, then the range's first and last-plus-one rowid.
   */
  | { type: 'partial'; task: number; plan: { version: number; plan: unknown }; key: string; params: SqlValue[]; settings?: ReaderSettings }
  | { type: 'partialDone'; reader: number; task: number; rows?: SqlValue[][]; error?: string }
  | { type: 'ready'; reader: number }
  | { type: 'idle'; reader: number }
  | { type: 'failed'; reader: number; message: string };

/** Messages on a multi-tab BroadcastChannel. */
export type BusMessage =
  | { type: 'hello'; session: string }
  | { type: 'leader'; leader: string }
  | { type: 'req'; session: string; leader: string; req: Request }
  | { type: 'res'; session: string; res: Response };

/** A request without its id (distributive over the union). */
export type RequestBody = Request extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/** One column of a batch. */
export type WireColumn =
  | { t: 'f64'; data: Float64Array; nulls: Uint8Array | null }
  | { t: 'str'; data: (string | null)[] }
  | { t: 'any'; data: SqlValue[] };

export type Response =
  /** A plugin asks this session's handler for plugin `plugin` a question (e.g. fresh credentials); answered with 'pluginReply'. */
  | { id: 0; kind: 'pluginAsk'; request: number; plugin: string; message: unknown }
  | { id: number; kind: 'ok'; changes?: number; lastInsertRowid?: number | bigint; stmt?: number; columns?: string[]; columnTypes?: PlanType[]; paramCount?: number; capabilities?: unknown; value?: unknown; ended?: 'commit' | 'rollback' }
  /** `reader`: which parallel reader worker serves the result (absent: the owner). */
  | { id: number; kind: 'columns'; columns: string[]; /** Each column's plan type. */ types?: PlanType[]; reader?: number; /** Merged from this many morsels (parallel readers). */ morsels?: number }
  | { id: number; kind: 'batch'; length: number; cols: WireColumn[] }
  /** The end of a result; a write's counts, when the statement was a write. */
  | { id: number; kind: 'done'; changes?: number; lastInsertRowid?: number | bigint }
  /** `details`: what the error is about, as fields (engine/errors.ts `ErrorDetails`). */
  | { id: number; kind: 'error'; code: string; message: string; details?: ErrorDetails }
  /** A direct channel from a parallel reader worker to this client (results bypass the owner). */
  | { id: 0; kind: 'port'; port: MessagePort };

/** Encode a batch of column arrays; returns the columns and the buffers to transfer. */
export function encodeColumns(cols: SqlValue[][], length: number): { cols: WireColumn[]; transfer: ArrayBuffer[] } {
  const out: WireColumn[] = [];
  const transfer: ArrayBuffer[] = [];
  for (const col of cols) {
    let numeric = true;
    let text = true;
    let hasNull = false;
    for (let i = 0; i < length; i++) {
      const v = col[i];
      if (v === null) {
        hasNull = true;
        continue;
      }
      if (typeof v !== 'number') numeric = false;
      if (typeof v !== 'string') text = false;
      if (!numeric && !text) break;
    }
    if (numeric) {
      const data = new Float64Array(length);
      let nulls: Uint8Array | null = null;
      if (hasNull) nulls = new Uint8Array((length + 7) >>> 3);
      for (let i = 0; i < length; i++) {
        const v = col[i];
        if (v === null) nulls![i >>> 3] |= 1 << (i & 7);
        else data[i] = v as number;
      }
      out.push({ t: 'f64', data, nulls });
      transfer.push(data.buffer as ArrayBuffer);
      if (nulls) transfer.push(nulls.buffer as ArrayBuffer);
    } else if (text) {
      out.push({ t: 'str', data: col.slice(0, length) as (string | null)[] });
    } else {
      out.push({ t: 'any', data: col.slice(0, length) });
    }
  }
  return { cols: out, transfer };
}

/** Value at row `i` of a wire column. */
export function columnValue(c: WireColumn, i: number): SqlValue {
  if (c.t === 'f64') return c.nulls !== null && c.nulls[i >>> 3] & (1 << (i & 7)) ? null : c.data[i];
  return c.data[i];
}
