/// <reference lib="webworker" />
import { ANALYTIC_QUERIES, type Adapter } from './adapter.js';
import { DuckdbAdapter } from './adapters/duckdb.js';
import { PgliteAdapter } from './adapters/pglite.js';
import { SmaltdbAdapter } from './adapters/smaltdb.js';
import { SqliteAdapter } from './adapters/sqlite.js';

export const factories: Record<string, () => Adapter> = {
  smaltdb: () => new SmaltdbAdapter(),
  'sqlite-off': () => new SqliteAdapter('OFF'),
  'sqlite-wal': () => new SqliteAdapter('WAL'),
  'sqlite-journal': () => new SqliteAdapter('TRUNCATE'),
  pglite: () => new PgliteAdapter(),
  duckdb: () => new DuckdbAdapter(),
};

export interface WorkloadResult {
  workload: string;
  ops: number;
  ms: number;
  /** Deterministic summary of the result; must agree across engines. */
  check: string;
}

/** Canonical form of query results: numbers to 9 significant digits, bigint as number, rows sorted. */
function canon(rows: unknown[][]): string {
  const norm = (v: unknown): string => {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'bigint') v = Number(v);
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toPrecision(9);
    if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v)) return norm(Number(v)); // Postgres numeric as text
    return JSON.stringify(v);
  };
  return rows.map((r) => r.map(norm).join(',')).sort().join(';');
}

async function timed(out: WorkloadResult[], workload: string, ops: number, fn: () => Promise<unknown>): Promise<void> {
  const t0 = performance.now();
  const r = await fn();
  const ms = performance.now() - t0;
  out.push({ workload, ops, ms, check: Array.isArray(r) ? canon(r as unknown[][]) : String(r) });
}

self.onmessage = async (e: MessageEvent<{ engine: string; rows: number; lookups: number; smallTxns: number; analyticRows: number }>) => {
  const { engine, rows: N, lookups, smallTxns, analyticRows } = e.data;
  try {
    const a = factories[engine]();
    const results: WorkloadResult[] = [];
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
    await timed(results, `point lookup x${lookups} (warm)`, lookups, () => a.pointLookups(keys));
    await timed(results, 'scan read values (warm)', N, () => a.scanValues());
    await timed(results, `${smallTxns} single-row durable txns`, smallTxns, () => a.smallTxns(N, smallTxns));
    await a.reopen();
    await timed(results, `point lookup x${lookups} (cold)`, lookups, () => a.pointLookups(keys));
    await a.reopen();
    await timed(results, 'scan read values (cold)', N, () => a.scanValues());
    await timed(results, `load analytic table (${analyticRows} rows)`, analyticRows, () => a.loadAnalytic(analyticRows));
    for (const [name, sql] of Object.entries(ANALYTIC_QUERIES)) {
      await timed(results, `analytic: ${name}`, analyticRows, () => a.query(sql));
    }
    await a.close();
    postMessage({ ok: true, engine: a.name, config: a.config, atomicCommits: a.atomicCommits, openMs, results, version: (a as { libVersion?: string }).libVersion });
  } catch (err) {
    postMessage({ ok: false, engine, error: String((err as Error)?.stack ?? err) });
  }
};
