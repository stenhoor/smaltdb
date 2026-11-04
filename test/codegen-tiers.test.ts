/**
 * Generated scans in mid-scan tiers (codegen.ts `Adaptive`): a fused loop starts shared (literals read from K), pauses
 * every chunk, and switches to the specialized loop (literals written in) when the rest of the scan would lose more
 * than switching costs. Results are the same whichever tier runs, and wherever the switch happens.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { setSwitchCost, traceGeneratedCode } from '../src/engine/exec/codegen.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

afterEach(() => {
  setSwitchCost(null);
  traceGeneratedCode(false);
});

/** Tables of several chunks: well over 64 leaves (row table) and 4 row groups (columnar). */
async function setup(): Promise<Database> {
  const db = await Database.open(new MemoryVfs(), 'db');
  db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, x INT, y REAL, s TEXT); CREATE TABLE c(g INT, v INT) WITH (storage = 'columnar')");
  db.exec('BEGIN');
  const t = db.prepare('INSERT INTO t VALUES (?, ?, ?, ?)');
  const c = db.prepare('INSERT INTO c VALUES (?, ?)');
  for (let i = 1; i <= 40_000; i++) {
    t.run([i, i % 10, i / 4, `row ${i} padding to fill leaves`]);
    c.run([i % 3, i]);
  }
  db.exec('COMMIT');
  return db;
}

/** The pipelines generated while `f` runs. */
function pipelines(f: () => void): string[] {
  traceGeneratedCode(true);
  f();
  return traceGeneratedCode(false).filter((s) => s.startsWith('pipeline'));
}

const QUERIES = [
  'SELECT count(*), sum(y) FROM t WHERE x > 3',
  'SELECT id FROM t WHERE x = 7 AND y < 9000.5',
  'SELECT x, count(*), sum(y) FROM t WHERE y > 2.5 GROUP BY x ORDER BY x',
  'SELECT count(*), sum(v) FROM c WHERE v > 30',
  'SELECT g, sum(v) FROM c WHERE v < 39000 GROUP BY g ORDER BY g',
];

describe.skipIf(!!env.SMALT_NO_CODEGEN)('generated scans in mid-scan tiers', () => {
  it('stay shared while switching would not pay, and switch mid-scan when it would, with the same results', async () => {
    const db = await setup();
    for (const q of QUERIES) {
      setSwitchCost(1e9); // never pays: the shared loop scans everything
      const shared = db.prepare(q);
      let want: unknown;
      const a = pipelines(() => (want = shared.all()));
      expect(a.length, q).toBeGreaterThan(0);
      expect(a.every((s) => s.includes('= K[')), q).toBe(true);

      setSwitchCost(0); // always pays: a fresh statement switches at its first pause
      const fresh = db.prepare(`${q} -- fresh`);
      let got: unknown;
      const b = pipelines(() => (got = fresh.all()));
      expect(got, q).toEqual(want);
      expect(b.some((s) => s.includes('= K[')), q).toBe(true);
      expect(b.some((s) => !s.includes('= K[')), q).toBe(true);
      // Later runs start specialized and compile nothing.
      expect(pipelines(() => expect(fresh.all(), q).toEqual(want)), q).toEqual([]);
    }
  });

  it('share one compiled loop between statements that differ only in their literals', async () => {
    const db = await setup();
    setSwitchCost(1e9);
    const a = pipelines(() => db.prepare('SELECT count(*) FROM t WHERE x > 3 AND y < 10.5').all());
    const b = pipelines(() => db.prepare('SELECT count(*) FROM t WHERE x > 6 AND y < 20.5').all());
    expect(b).toEqual(a);
  });
});
