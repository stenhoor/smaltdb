import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { RunReader, RunWriter, SpillArea } from '../src/engine/exec/spill.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { SqlValue } from '../src/engine/values.js';

interface Spill {
  bytesWritten: number;
  workMem: number;
}
const spillOf = (db: Database): Spill => (db as unknown as { spill: Spill }).spill;

async function setup(rows = 20000) {
  const vfs = new MemoryVfs();
  const db = await Database.open(vfs, 'db');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, s TEXT COLLATE NOCASE, x REAL, b BLOB)');
  db.exec('CREATE TABLE u(g INT PRIMARY KEY, label TEXT)');
  // Deterministic pseudo-random data with NULLs, duplicates, mixed case and non-ASCII text.
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows})
    INSERT INTO t SELECT i,
      CASE WHEN i % 97 = 0 THEN NULL ELSE (i * 7919) % 5003 END,
      CASE WHEN i % 13 = 0 THEN NULL WHEN i % 3 = 0 THEN 'Ab' || ((i * 31) % 701) ELSE 'aB' || ((i * 31) % 701) || 'é…' || substr('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', 1, i % 150) END,
      ((i * 104729) % 10007) / 7.0,
      CASE WHEN i % 5 = 0 THEN randomblob(0) ELSE zeroblob(i % 4) END
    FROM n`);
  db.exec('WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 5002) INSERT INTO u SELECT i, \'L\' || i FROM n');
  return { vfs, db };
}

/** Run `sql` without spilling and with a tiny work_mem; the results must match (and it must spill). */
function same(db: Database, sql: string, workMem = 32 * 1024, ordered = true): SqlValue[][] {
  const spill = spillOf(db);
  spill.workMem = 0;
  const expected = db.query(sql).rows;
  spill.workMem = workMem;
  const before = spill.bytesWritten;
  const got = db.query(sql).rows;
  expect(spill.bytesWritten).toBeGreaterThan(before);
  const key = (rows: SqlValue[][]) => (ordered ? rows : [...rows].sort((a, b) => (JSON.stringify(a, rep) < JSON.stringify(b, rep) ? -1 : 1)));
  expect(key(got)).toEqual(key(expected));
  spill.workMem = 256 * 1024 * 1024;
  return got;
}
const rep = (_k: string, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v);

describe('spill format', () => {
  it('round-trips every value type', async () => {
    const vfs = new MemoryVfs();
    const area = new SpillArea(await vfs.open('s'));
    area.acquire();
    const long = 'é'.repeat(100); // 200 bytes from 100 characters: the length prefix grows
    const rows: SqlValue[][] = [
      [null, 0, -0, 1, -1, 2 ** 31 - 1, -(2 ** 31), 2 ** 31, 1.5, Number.MAX_SAFE_INTEGER],
      [2n ** 62n, -(2n ** 63n), '', 'a', long, 'x'.repeat(127), 'x'.repeat(128), '😀'.repeat(40), new Uint8Array(0), new Uint8Array([1, 2, 3])],
      ['big'.repeat(100000), new Uint8Array(200000).fill(7), null, null, null, null, null, null, null, null],
    ];
    const w = new RunWriter(area);
    for (let k = 0; k < 300; k++) w.add(rows[k % 3]);
    const run = w.finish();
    expect(run.rows).toBe(300);
    const r = new RunReader(area, run);
    const out: SqlValue[] = new Array(10);
    for (let k = 0; k < 300; k++) {
      expect(r.next(out, 10)).toBe(true);
      const want = rows[k % 3];
      for (let i = 0; i < 10; i++) {
        const a = out[i];
        const b = want[i];
        const ok = a instanceof Uint8Array && b instanceof Uint8Array ? Buffer.from(a).equals(Buffer.from(b)) : Object.is(a, b);
        if (!ok) expect([k, i, a]).toEqual([k, i, b]);
      }
    }
    expect(r.next(out, 10)).toBe(false);
    area.release();
  });
});

describe('external sort', () => {
  it('matches the in-memory sort (keys with NULLs, DESC, NOCASE, blobs)', async () => {
    const { db } = await setup();
    same(db, 'SELECT id, g, s, x FROM t ORDER BY g DESC NULLS LAST, s, x, id');
    same(db, 'SELECT s, b, id FROM t ORDER BY s COLLATE BINARY DESC, b, id');
    same(db, 'SELECT id FROM t ORDER BY x * -1, id');
  });

  it('merges in several passes when there are many runs', async () => {
    const { db } = await setup();
    const rows = same(db, 'SELECT id, g, x FROM t ORDER BY x, id', 4 * 1024);
    expect(rows.length).toBe(20000);
  });

  it('keeps top-N, OFFSET and DISTINCT right', async () => {
    const { db } = await setup();
    same(db, 'SELECT id, s FROM t ORDER BY s DESC, id LIMIT 5000 OFFSET 17', 8 * 1024);
    same(db, 'SELECT DISTINCT g FROM t ORDER BY g', 2 * 1024);
  });

  it('empties the scratch file afterwards, also for unfinished cursors and errors', async () => {
    const { vfs, db } = await setup();
    const file = await vfs.open('db-spill');
    db.exec('PRAGMA work_mem = 16384');
    expect(db.query('PRAGMA work_mem').rows).toEqual([[16384]]);
    const written = db.query('PRAGMA spill_bytes').rows[0]![0] as number;
    const c = db.prepare('SELECT id FROM t ORDER BY x, id').cursor();
    c.next();
    expect(file.size()).toBeGreaterThan(0);
    c.close();
    expect(file.size()).toBe(0);
    expect(db.query('PRAGMA spill_bytes').rows[0]![0]).toBeGreaterThan(written);
    expect(() => db.query("SELECT id FROM t ORDER BY x, id LIMIT CASE WHEN 1 THEN 'oops' END")).toThrow();
    let n = 0;
    db.setInterruptCheck(() => {
      if (++n === 20) throw new Error('interrupted');
    });
    expect(() => db.query('SELECT id FROM t ORDER BY s, id')).toThrow(/interrupted/);
    db.setInterruptCheck(null);
    expect(file.size()).toBe(0);
    expect(db.query('SELECT count(*) FROM (SELECT id FROM t ORDER BY s)').rows).toEqual([[20000]]);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });
});

describe('spilling hash aggregate', () => {
  const aggs = "count(*), sum(x), avg(id), min(s), max(s), count(DISTINCT s), sum(id) FILTER (WHERE id % 2 = 0), total(length(b))";

  it('matches the in-memory aggregate (fused scan)', async () => {
    const { db } = await setup();
    same(db, `SELECT g, ${aggs} FROM t GROUP BY g ORDER BY g`);
    same(db, 'SELECT g, count(*) FROM t GROUP BY g', 32 * 1024, false);
  });

  it('matches through joins, bare columns, multi-column keys and HAVING', async () => {
    const { db } = await setup();
    same(db, `SELECT u.label, ${aggs} FROM t JOIN u USING (g) GROUP BY u.label ORDER BY 1`);
    same(db, 'SELECT g, max(x), id FROM t GROUP BY g ORDER BY g'); // bare column from the max row
    same(db, 'SELECT g, s, count(*) FROM t GROUP BY g, s HAVING count(*) > 0 ORDER BY g, s');
    same(db, "SELECT g % 50, group_concat(id, ',') FROM t WHERE id < 3000 GROUP BY g % 50 ORDER BY 1", 1024); // input order kept per group
  });

  it('partitions recursively when partitions are still too big', async () => {
    const { db } = await setup(30000);
    same(db, 'SELECT id % 9000, count(*), sum(x) FROM t GROUP BY id % 9000 ORDER BY 1', 2 * 1024);
  });
});
