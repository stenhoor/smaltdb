/**
 * Regression tests for the S3 findings of the M7 code review (docs/research/m7-code-review.md):
 * lifecycle, robustness and edge cases.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

interface Internals {
  pager: { inTransaction: boolean; checkpoint(): void };
  mem: { closed: boolean } | null;
  spill: { users: number; workMem: number };
}
const internals = (db: Database) => db as unknown as Internals;

describe('S3-20: rebuilding memory views at open', () => {
  it('leaves the main file untouched and dependent file views fresh', async () => {
    const vfs = new MemoryVfs();
    const db = await Database.open(vfs, 'db');
    db.exec('CREATE TABLE t(g INT, x INT); INSERT INTO t VALUES (1, 10), (2, 20)');
    db.exec("CREATE MATERIALIZED VIEW a WITH (location = 'memory') AS SELECT g, sum(x) AS s FROM t GROUP BY g");
    db.exec('CREATE MATERIALIZED VIEW b AS SELECT count(*) AS n FROM a');
    db.close();
    const again = await Database.open(vfs, 'db');
    expect(internals(again).pager.inTransaction).toBe(false);
    expect(again.query("SELECT table_name, is_fresh FROM information_schema.materialized_views ORDER BY 1").rows).toEqual([['a', 'YES'], ['b', 'YES']]);
    expect(again.query('SELECT * FROM a ORDER BY g').rows).toEqual([[1, 10], [2, 20]]);
    again.checkpoint();
  });

  it('rebuilds memory views over memory views in dependency order', async () => {
    const vfs = new MemoryVfs();
    const db = await Database.open(vfs, 'db');
    db.exec('CREATE TABLE t(x INT); INSERT INTO t VALUES (1), (2)');
    db.exec("CREATE MATERIALIZED VIEW m1 WITH (location = 'memory') AS SELECT x FROM t");
    db.exec("CREATE MATERIALIZED VIEW m2 WITH (location = 'memory') AS SELECT count(*) AS n FROM m1");
    // Re-created m1 comes after m2 in the catalog.
    db.exec("DROP MATERIALIZED VIEW m1; CREATE MATERIALIZED VIEW m1 WITH (location = 'memory') AS SELECT x FROM t");
    db.close();
    const again = await Database.open(vfs, 'db');
    expect(again.query('SELECT n FROM m2').rows).toEqual([[2]]);
  });
});

describe('S3-21: a re-opened fused GROUP BY releases its spill', () => {
  it('leaves no spill hold behind (correlated derived table re-opened per row)', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec('CREATE TABLE o(k INT); INSERT INTO o VALUES (1), (2), (3), (4), (5), (6), (7), (8)');
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, k INT, g INT)');
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO t SELECT i, 1, i FROM n');
    db.exec('PRAGMA work_mem = 32768');
    // Random filtering makes some re-opens outgrow work_mem (and delegate to the spilling
    // aggregate) while others do not: every statement must still end with no spill users.
    const sql = `SELECT o.k, (SELECT max(d.c) FROM o o2 LEFT JOIN
      (SELECT g, count(*) c FROM t WHERE t.k = o.k AND abs(random()) % 1000 < 8 GROUP BY g) d ON 1) FROM o WHERE o.k = 1`;
    for (let i = 0; i < 12; i++) {
      db.query(sql);
      expect(internals(db).spill.users).toBe(0);
    }
  }, 60_000);
});

describe('S3-22: external sort with merge passes', () => {
  it('is stable like the in-memory sort', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, k INT)');
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO t SELECT i, i % 3 FROM n');
    const sql = 'SELECT id, k FROM t ORDER BY k';
    db.exec('PRAGMA work_mem = 0');
    const want = db.query(sql).rows;
    db.exec('PRAGMA work_mem = 2048'); // more than 64 runs: merge passes
    expect(db.query(sql).rows).toEqual(want);
  });
});

describe('S3-23: two handles on one VFS', () => {
  it('do not share (and truncate) one scratch file', async () => {
    const vfs = new MemoryVfs();
    const a = await Database.open(vfs, 'db');
    a.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, x REAL, s TEXT)');
    a.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO t SELECT i, (i * 7919) % 10007, printf('%040d', i) FROM n");
    // Runs of several 64 KiB blocks, read lazily while the merge proceeds.
    a.exec('PRAGMA work_mem = 1000000');
    const c = a.prepare('SELECT id, s FROM t ORDER BY x, id').cursor();
    const first = [c.next(), c.next()];
    const b = await Database.open(vfs, 'db'); // a second handle on the same path
    b.exec('PRAGMA work_mem = 1000000');
    expect(b.query('SELECT count(*) FROM (SELECT id, s FROM t ORDER BY x DESC, id)').rows).toEqual([[20000]]);
    let n = first.length;
    while (c.next() !== null) n++;
    expect(n).toBe(20000);
  });
});

describe('S3-24: close', () => {
  it('closes the memory store too', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec('CREATE TEMP TABLE tt(a); BEGIN; INSERT INTO tt VALUES (1)');
    db.close();
    expect(internals(db).mem?.closed).toBe(true);
  });
});

describe('S3-25: a failing automatic checkpoint after a commit', () => {
  it('does not split the commit between the file and the memory store', async () => {
    const db = await Database.open(new MemoryVfs(), 'db', { walAutoCheckpointBytes: 1 });
    db.exec('CREATE TABLE t(a INT); CREATE TEMP TABLE tt(a INT)');
    const pager = internals(db).pager;
    const real = pager.checkpoint.bind(pager);
    let fail = true;
    pager.checkpoint = () => {
      if (fail) throw new Error('disk I/O error during checkpoint');
      real();
    };
    db.exec('BEGIN; INSERT INTO t VALUES (1); INSERT INTO tt VALUES (2)');
    db.exec('COMMIT'); // the commit is durable in the WAL; the checkpoint is retried later
    expect(db.inTransaction).toBe(false);
    expect(db.query('SELECT (SELECT count(*) FROM t), (SELECT count(*) FROM tt)').rows).toEqual([[1, 1]]);
    db.exec('INSERT INTO tt VALUES (3)');
    expect(db.query('SELECT count(*) FROM tt').rows).toEqual([[2]]);
    fail = false;
    db.checkpoint();
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });
});
