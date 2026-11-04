/**
 * Generated pipelines in two tiers (codegen.ts `Tier`): a fused loop first reads its literals from K, so statements
 * that differ only in their literals share one compiled function; once its runs have scanned enough rows it is
 * compiled again with the literals written in. Results are the same in both tiers.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { setSpecializeRows, traceGeneratedCode } from '../src/engine/exec/codegen.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};

afterEach(() => {
  setSpecializeRows(null);
  traceGeneratedCode(false);
});

async function setup(): Promise<Database> {
  const db = await Database.open(new MemoryVfs(), 'db');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, x INT, y REAL); CREATE TABLE c(g INT, v INT) WITH (storage = \'columnar\')');
  db.exec('BEGIN');
  for (let i = 1; i <= 100; i++) db.exec(`INSERT INTO t VALUES (${i}, ${i % 10}, ${i / 4}); INSERT INTO c VALUES (${i % 3}, ${i})`);
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
  'SELECT id FROM t WHERE x = 7 AND y < 20.5',
  'SELECT x, count(*) FROM t WHERE y > 2.5 GROUP BY x ORDER BY x',
  'SELECT count(*), sum(v) FROM c WHERE v > 30',
  'SELECT g, sum(v) FROM c WHERE v < 90 GROUP BY g ORDER BY g',
];

describe.skipIf(!!env.SMALT_NO_CODEGEN)('generated pipelines in tiers', () => {
  it('read literals from K, then write them in once their runs have scanned enough rows', async () => {
    const db = await setup();
    setSpecializeRows(250); // the tables hold 100 rows: the third run specializes
    for (const q of QUERIES) {
      const st = db.prepare(q);
      const first = pipelines(() => st.all());
      expect(first.length, q).toBeGreaterThan(0);
      expect(first.every((s) => s.includes('= K[')), q).toBe(true);
      const want = st.all();
      const third = pipelines(() => expect(st.all(), q).toEqual(want));
      expect(third.length, q).toBeGreaterThan(0);
      expect(third.some((s) => s.includes('= K[')), q).toBe(false);
      // Specialized once: later runs reuse it.
      expect(pipelines(() => expect(st.all(), q).toEqual(want)), q).toEqual([]);
    }
  });

  it('share one compiled pipeline between statements that differ only in their literals', async () => {
    const db = await setup();
    const a = pipelines(() => db.prepare('SELECT count(*) FROM t WHERE x > 3 AND y < 10.5').all());
    const b = pipelines(() => db.prepare('SELECT count(*) FROM t WHERE x > 6 AND y < 20.5').all());
    expect(b).toEqual(a);
  });

  it('specialize at once over a table at least as large as the threshold', async () => {
    const db = await setup();
    setSpecializeRows(50);
    const first = pipelines(() => db.prepare('SELECT count(*) FROM t WHERE x > 5').all());
    expect(first.length).toBeGreaterThan(0);
    expect(first.some((s) => s.includes('= K['))).toBe(false);
  });
});
