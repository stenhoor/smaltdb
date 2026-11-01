import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

/** A file-backed database (MemoryVfs stands in for OPFS) with a base table. */
async function fileDb(vfs = new MemoryVfs()) {
  const db = await Database.open(vfs, 'db', { walAutoCheckpointBytes: 1 << 30 });
  db.exec(`CREATE TABLE IF NOT EXISTS t(id INTEGER PRIMARY KEY, g INT, v INT);`);
  if (db.query('SELECT count(*) FROM t').rows[0]![0] === 0)
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) INSERT INTO t SELECT i, i % 10, i FROM n');
  return { vfs, db };
}

const walSize = (db: Database): number => (db as unknown as { pager: { walSize: number } }).pager.walSize;

describe('TEMP tables', () => {
  it('create, insert, query, index and drop without touching the file', async () => {
    const { db } = await fileDb();
    db.checkpoint();
    const before = walSize(db);
    db.exec('CREATE TEMP TABLE scratch(k INTEGER PRIMARY KEY, x TEXT)');
    db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500) INSERT INTO scratch SELECT i, 'x' || i FROM n");
    db.exec('CREATE INDEX scratch_x ON scratch(x)');
    expect(db.query("SELECT k FROM scratch WHERE x = 'x42'").rows).toEqual([[42]]);
    expect(db.query('SELECT count(*) FROM scratch JOIN t ON t.id = scratch.k').rows).toEqual([[500]]);
    db.exec('UPDATE scratch SET x = upper(x) WHERE k <= 10; DELETE FROM scratch WHERE k > 400');
    expect(db.query("SELECT count(*), sum(x GLOB 'X*') FROM scratch").rows).toEqual([[400, 10]]);
    expect(walSize(db)).toBe(before); // nothing written to the database files
    expect(db.query("SELECT count(*) FROM sqlite_schema WHERE name LIKE 'scratch%'").rows).toEqual([[0]]);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
    db.exec('DROP INDEX scratch_x; DROP TABLE scratch');
    expect(() => db.query('SELECT * FROM scratch')).toThrow(/no such table/);
  });

  it('shadow a main table of the same name and vanish on reopen', async () => {
    const { vfs, db } = await fileDb();
    db.exec('CREATE TEMP TABLE t(a)');
    db.exec('INSERT INTO t VALUES (1)');
    expect(db.query('SELECT * FROM t').rows).toEqual([[1]]);
    db.exec('DROP TABLE t'); // drops the temp table
    expect(db.query('SELECT count(*) FROM t').rows).toEqual([[2000]]);
    db.exec('CREATE TEMP TABLE keep(a); INSERT INTO keep VALUES (1)');
    db.close();
    const { db: again } = await fileDb(vfs);
    expect(() => again.query('SELECT * FROM keep')).toThrow(/no such table/);
    expect(again.query('SELECT count(*) FROM t').rows).toEqual([[2000]]);
  });

  it('roll back with the transaction', async () => {
    const { db } = await fileDb();
    db.exec('CREATE TEMP TABLE a(x); INSERT INTO a VALUES (1)');
    db.exec('BEGIN; INSERT INTO a VALUES (2); CREATE TEMP TABLE b(y); INSERT INTO b VALUES (1); UPDATE t SET v = 0');
    expect(db.query('SELECT count(*) FROM a').rows).toEqual([[2]]);
    db.exec('ROLLBACK');
    expect(db.query('SELECT x FROM a').rows).toEqual([[1]]);
    expect(() => db.query('SELECT * FROM b')).toThrow(/no such table/);
    expect(db.query('SELECT sum(v) FROM t').rows).toEqual([[2001000]]);

    db.exec('BEGIN; INSERT INTO a VALUES (3); SAVEPOINT s; DROP TABLE a; ROLLBACK TO s; INSERT INTO a VALUES (4); COMMIT');
    expect(db.query('SELECT x FROM a ORDER BY x').rows).toEqual([[1], [3], [4]]);

    // A failing statement undoes its own temp changes.
    db.exec('CREATE TEMP TABLE u(k INTEGER PRIMARY KEY)');
    expect(() => db.exec('INSERT INTO u VALUES (1), (2), (1)')).toThrow(/UNIQUE|constraint/i);
    expect(db.query('SELECT count(*) FROM u').rows).toEqual([[0]]);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('work in an in-memory database too', () => {
    const db = Database.openMemory();
    db.exec('CREATE TEMP TABLE x(a); INSERT INTO x VALUES (1), (2)');
    expect(db.query('SELECT sum(a) FROM x').rows).toEqual([[3]]);
    db.exec('BEGIN; DROP TABLE x; ROLLBACK');
    expect(db.query('SELECT sum(a) FROM x').rows).toEqual([[3]]);
  });
});

describe("materialized views WITH (location = 'memory')", () => {
  const create = "CREATE MATERIALIZED VIEW agg WITH (location = 'memory') AS SELECT g, sum(v) AS s, count(*) AS n FROM t GROUP BY g";

  it('are populated, refreshed and indexed in memory', async () => {
    const { db } = await fileDb();
    db.exec(create);
    db.checkpoint();
    const before = walSize(db);
    expect(db.query('SELECT s FROM agg WHERE g = 3').rows).toEqual([[199600]]);
    db.exec('CREATE INDEX agg_s ON agg(s)');
    db.exec('UPDATE t SET v = v + 10 WHERE g = 3');
    const w = walSize(db);
    expect(w).toBeGreaterThan(before);
    db.exec('REFRESH MATERIALIZED VIEW agg');
    expect(walSize(db)).toBe(w); // refresh writes no database pages
    expect(db.query('SELECT g FROM agg INDEXED BY agg_s WHERE s = 201600').rows).toEqual([[3]]);
    expect(db.query("SELECT storage, location FROM information_schema.materialized_views WHERE table_name = 'agg'").rows).toEqual([['row', 'memory']]);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('are rebuilt when the database is reopened', async () => {
    const { vfs, db } = await fileDb();
    db.exec(create);
    db.exec('CREATE INDEX agg_n ON agg(n)');
    db.close();
    const { db: again } = await fileDb(vfs);
    expect(again.query('SELECT count(*), sum(s) FROM agg').rows).toEqual([[10, 2001000]]);
    expect(again.query('SELECT count(*) FROM agg INDEXED BY agg_n WHERE n = 200').rows).toEqual([[10]]);
    expect(again.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
    again.exec('DROP MATERIALIZED VIEW agg');
    expect(() => again.query('SELECT * FROM agg')).toThrow(/no such table/);
  });

  it('roll back a refresh with the transaction', async () => {
    const { db } = await fileDb();
    db.exec(create);
    db.exec('BEGIN; UPDATE t SET v = 0; REFRESH MATERIALIZED VIEW agg');
    expect(db.query('SELECT sum(s) FROM agg').rows).toEqual([[0]]);
    db.exec('ROLLBACK');
    expect(db.query('SELECT sum(s) FROM agg').rows).toEqual([[2001000]]);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('support columnar storage', async () => {
    const { vfs, db } = await fileDb();
    db.exec("CREATE MATERIALIZED VIEW colv WITH (location = 'memory', storage = 'columnar') AS SELECT id, g, v FROM t");
    expect(db.query('SELECT g, sum(v) FROM colv WHERE g < 2 GROUP BY g ORDER BY g').rows).toEqual([[0, 201000], [1, 199200]]);
    db.close();
    const { db: again } = await fileDb(vfs);
    expect(again.query('SELECT count(*), sum(v) FROM colv').rows).toEqual([[2000, 2001000]]);
  });

  it('are not visible to snapshot readers as stale file data', async () => {
    const vfs = new MemoryVfs();
    const w = await Database.open(vfs, 'db', { sharedHandles: true, walAutoCheckpointBytes: 1 << 30 });
    w.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, v INT); INSERT INTO t VALUES (1, 1, 1)');
    w.exec("CREATE MATERIALIZED VIEW m WITH (location = 'memory') AS SELECT count(*) AS c FROM t");
    const r = await Database.openReader(vfs, 'db');
    expect(r.prepare('SELECT c FROM m').usesMemoryObjects).toBe(true);
    expect(r.prepare('SELECT * FROM t').usesMemoryObjects).toBe(false);
  });
});
