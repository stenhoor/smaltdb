/// <reference lib="webworker" />
import type { Adapter } from './adapter.js';
import { DuckdbAdapter } from './adapters/duckdb.js';
import { PgliteAdapter } from './adapters/pglite.js';
import { SmaltdbAdapter } from './adapters/smaltdb.js';
import { SqliteAdapter } from './adapters/sqlite.js';

const factories: Record<string, () => Adapter> = {
  smaltdb: () => new SmaltdbAdapter(),
  sqlite: () => new SqliteAdapter(),
  pglite: () => new PgliteAdapter(),
  duckdb: () => new DuckdbAdapter(),
};

interface Row {
  workload: string;
  ops: number;
  ms: number;
  opsPerSec: number;
  usPerOp: number;
}

async function timed(rows: Row[], workload: string, ops: number, fn: () => Promise<unknown>, expect?: unknown): Promise<void> {
  const t0 = performance.now();
  const r = await fn();
  const ms = performance.now() - t0;
  if (expect !== undefined && r !== expect) throw new Error(`${workload}: expected ${String(expect)}, got ${String(r)}`);
  rows.push({ workload, ops, ms, opsPerSec: (ops / ms) * 1000, usPerOp: (ms * 1000) / ops });
}

self.onmessage = async (e: MessageEvent<{ engine: string; rows: number; lookups: number; smallTxns: number }>) => {
  const { engine, rows: N, lookups, smallTxns } = e.data;
  try {
    const a = factories[engine]();
    const results: Row[] = [];
    const t0 = performance.now();
    await a.open();
    const openMs = performance.now() - t0;
    let s = 42;
    const keys = new Int32Array(lookups);
    for (let i = 0; i < lookups; i++) {
      s = (Math.imul(s, 1103515245) + 12345) >>> 0;
      keys[i] = s % N;
    }
    await timed(results, `bulk insert ${N} rows (1 txn)`, N, () => a.bulkInsert(N));
    await timed(results, `point lookup x${lookups} (random)`, lookups, () => a.pointLookups(keys), lookups);
    await timed(results, 'full scan count', N, () => a.scanCount(), N);
    await timed(results, 'full scan read values', N, () => a.scanValues(), N * 32);
    await timed(results, `${smallTxns} single-row durable txns`, smallTxns, () => a.smallTxns(N, smallTxns));
    await a.close();
    postMessage({ ok: true, engine: a.name, config: a.config, openMs, results, version: (a as { libVersion?: string }).libVersion });
  } catch (err) {
    postMessage({ ok: false, engine, error: String((err as Error)?.stack ?? err) });
  }
};
