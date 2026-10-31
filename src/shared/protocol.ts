/**
 * Message protocol between the client library (main thread / other workers) and the engine
 * worker. See docs/WORKER_MODEL.md §5. Results travel as columnar batches; numeric columns use
 * transferable Float64Arrays.
 */
import type { SqlValue } from '../engine/values.js';

export type Params = readonly SqlValue[] | Readonly<Record<string, SqlValue>>;

export interface OpenRequest {
  op: 'open';
  name: string;
  storage: 'opfs' | 'memory';
  pageSize?: number;
  cacheSizeBytes?: number;
  syncOnCommit?: boolean;
}

export type Request = { id: number } & (
  | OpenRequest
  | { op: 'exec'; sql: string; params?: Params }
  | { op: 'query'; sql: string; params?: Params; batchSize?: number }
  | { op: 'prepare'; sql: string }
  | { op: 'stmtRun'; stmt: number; params?: Params }
  | { op: 'stmtQuery'; stmt: number; params?: Params; batchSize?: number }
  | { op: 'finalize'; stmt: number }
  | { op: 'close' }
);

/** A request without its id (distributive over the union). */
export type RequestBody = Request extends infer R ? (R extends { id: number } ? Omit<R, 'id'> : never) : never;

/** One column of a batch. */
export type WireColumn =
  | { t: 'f64'; data: Float64Array; nulls: Uint8Array | null }
  | { t: 'str'; data: (string | null)[] }
  | { t: 'any'; data: SqlValue[] };

export type Response =
  | { id: number; kind: 'ok'; changes?: number; lastInsertRowid?: number | bigint; stmt?: number; columns?: string[]; paramCount?: number; capabilities?: unknown }
  | { id: number; kind: 'columns'; columns: string[] }
  | { id: number; kind: 'batch'; length: number; cols: WireColumn[] }
  | { id: number; kind: 'done' }
  | { id: number; kind: 'error'; code: string; message: string };

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
