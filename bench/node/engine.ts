/**
 * One engine, one run, in a fresh Node process (bench/node/run.mjs spawns this per engine and repetition, as the
 * browser harness uses a fresh worker): `node engine.mjs <engine> '<options JSON>'`, prints one JSON result line.
 */
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Adapter } from '../browser/adapter.js';
import { SmaltdbAdapter } from '../browser/adapters/smaltdb.js';
import { SqliteAdapter } from '../browser/adapters/sqlite.js';
import { type WorkloadOptions, runWorkloads } from '../shared/workloads.js';
import { SqliteNativeAdapter } from './adapters/sqlite-native.js';
import { NodeFileVfs } from './node-vfs.js';

const dir = join(process.env.BENCH_DIR ?? tmpdir(), `smaltdb-bench-${process.pid}`);

export const factories: Record<string, () => Adapter> = {
  smaltdb: () => new SmaltdbAdapter(false, new NodeFileVfs(dir), 'Node file VFS (fsync on flush)'),
  'smaltdb-mem': () => new SmaltdbAdapter(true),
  'sqlite-wasm-mem': () => new SqliteAdapter('MEMORY-DB', () => import('@sqlite.org/sqlite-wasm')),
  'native-mem': () => new SqliteNativeAdapter('MEMORY', dir),
  'native-wal': () => new SqliteNativeAdapter('WAL-FULL', dir),
  'native-wal-normal': () => new SqliteNativeAdapter('WAL-NORMAL', dir),
};

const [engine, json] = process.argv.slice(2);
try {
  const make = factories[engine];
  if (!make) throw new Error(`unknown engine ${engine} (known: ${Object.keys(factories).join(', ')})`);
  const a = make();
  const { openMs, results } = await runWorkloads(a, JSON.parse(json) as WorkloadOptions);
  const version = (a as { libVersion?: string }).libVersion;
  console.log(JSON.stringify({ ok: true, engine: a.name, config: a.config, atomicCommits: a.atomicCommits, openMs, results, version }));
} catch (err) {
  console.log(JSON.stringify({ ok: false, engine, error: String((err as Error)?.stack ?? err) }));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
