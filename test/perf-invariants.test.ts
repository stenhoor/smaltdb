/**
 * Invariants behind the M7 performance fixes (docs/research/m7-code-review.md, "Performance"):
 * caches and running counts must agree with what they replace.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

interface Internals {
  tables: Map<string, { rootPage: number; columnar?: { delRoot: number; counts?: { delta: number; deleted: number } } }>;
  tree(root: number): { count(): number };
}

/** The writer-maintained counts of columnar table `name` equal the trees' actual counts. */
function countsAgree(db: Database, name = 'c'): void {
  const d = db as unknown as Internals;
  const t = d.tables.get(name)!;
  const counts = t.columnar!.counts;
  if (counts) expect(counts).toEqual({ delta: d.tree(t.rootPage).count(), deleted: d.tree(t.columnar!.delRoot).count() });
}

describe('columnar running counts', () => {
  it('stay exact through inserts, updates, deletes, REPLACE, compaction and rollbacks', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec("CREATE TABLE c(id INTEGER PRIMARY KEY, g INT) WITH (storage = 'columnar')");
    const ins = db.prepare('INSERT INTO c(g) VALUES (?)');
    for (let i = 0; i < 9000; i++) {
      ins.run([i % 10]); // crosses a compaction
      if (i % 1000 === 0) countsAgree(db);
    }
    countsAgree(db);
    for (const sql of [
      'UPDATE c SET g = g + 1 WHERE id % 7 = 0', // segment rows move to the delta
      'UPDATE c SET g = 0 WHERE id > 8500', // delta rows in place
      'UPDATE c SET id = id + 100000 WHERE id BETWEEN 8600 AND 8610', // rowid changes in the delta
      'DELETE FROM c WHERE id % 11 = 0',
      'INSERT OR REPLACE INTO c VALUES (5, 99), (8700, 99), (200000, 1)',
    ]) {
      db.exec(sql);
      countsAgree(db);
    }
    expect(() => db.exec('INSERT INTO c VALUES (5, 1)')).toThrow(/UNIQUE|constraint/i);
    countsAgree(db);
    db.exec('BEGIN; DELETE FROM c WHERE id < 100; UPDATE c SET g = 7 WHERE id < 200');
    countsAgree(db);
    db.exec('ROLLBACK');
    countsAgree(db);
    db.exec('BEGIN; SAVEPOINT s; DELETE FROM c WHERE id < 3000; ROLLBACK TO s; INSERT INTO c(g) VALUES (1); COMMIT');
    countsAgree(db);
    db.exec('PRAGMA compact(c)');
    countsAgree(db);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('scans see deletions made since the last scan (cached deletion sets)', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec("CREATE TABLE c(id INTEGER PRIMARY KEY, g INT) WITH (storage = 'columnar')");
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO c SELECT i, i % 10 FROM n');
    const q = db.prepare('SELECT count(*), sum(g) FROM c');
    expect(q.all()).toEqual([[20000, 90000]]);
    db.exec('DELETE FROM c WHERE g = 9');
    expect(q.all()).toEqual([[18000, 72000]]);
    db.exec('BEGIN; DELETE FROM c WHERE g = 8');
    expect(q.all()).toEqual([[16000, 56000]]);
    db.exec('ROLLBACK');
    expect(q.all()).toEqual([[18000, 72000]]);
  });
});

describe('statement re-planning', () => {
  it('re-plans when a TEMP table grows a lot', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v INT)');
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) INSERT INTO t SELECT i, i FROM n');
    db.exec('CREATE TEMP TABLE x(id INT); INSERT INTO x VALUES (1)');
    const st = db.prepare('SELECT count(*) FROM x JOIN t ON t.id = x.id');
    st.all();
    const before = (st as unknown as { program: unknown }).program;
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO x SELECT i FROM n');
    expect(st.all()).toEqual([[2001]]);
    expect((st as unknown as { program: unknown }).program).not.toBe(before);
  });
});

describe('cached morsel merge statements', () => {
  it('merge the rows of each run, not the first run\'s', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, v INT)');
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) INSERT INTO t SELECT i, i % 3, i FROM n');
    const sql = 'SELECT g, count(*), sum(v) FROM t GROUP BY g ORDER BY g';
    expect(db.queryMorsels(sql, undefined, 4)!.rows).toEqual(db.query(sql).rows);
    db.exec('UPDATE t SET v = v * 2');
    expect(db.queryMorsels(sql, undefined, 4)!.rows).toEqual(db.query(sql).rows);
  });
});
