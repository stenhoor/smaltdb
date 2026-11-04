/// <reference lib="webworker" />
import type { Adapter } from './adapter.js';
import { DuckdbAdapter } from './adapters/duckdb.js';
import { PgliteAdapter } from './adapters/pglite.js';
import { SmaltdbAdapter } from './adapters/smaltdb.js';
import { SqliteAdapter } from './adapters/sqlite.js';
import { type WorkloadOptions, runWorkloads } from '../shared/workloads.js';

export const factories: Record<string, () => Adapter> = {
  smaltdb: () => new SmaltdbAdapter(),
  'smaltdb-mem': () => new SmaltdbAdapter(true),
  'sqlite-mem': () => new SqliteAdapter('MEMORY-DB'),
  'sqlite-off': () => new SqliteAdapter('OFF'),
  'sqlite-wal': () => new SqliteAdapter('WAL'),
  'sqlite-journal': () => new SqliteAdapter('TRUNCATE'),
  pglite: () => new PgliteAdapter(),
  duckdb: () => new DuckdbAdapter(),
};

self.onmessage = async (e: MessageEvent<{ engine: string } & WorkloadOptions>) => {
  const { engine, ...opts } = e.data;
  try {
    const a = factories[engine]();
    const { openMs, results } = await runWorkloads(a, opts);
    postMessage({ ok: true, engine: a.name, config: a.config, atomicCommits: a.atomicCommits, openMs, results, version: (a as { libVersion?: string }).libVersion });
  } catch (err) {
    postMessage({ ok: false, engine, error: String((err as Error)?.stack ?? err) });
  }
};
