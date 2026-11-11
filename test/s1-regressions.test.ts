/**
 * Regression tests for the S1 findings of the M7 code review (docs/research/m7-code-review.md):
 * defects that corrupted data or silently returned wrong results.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const fileDb = () => Database.open(new MemoryVfs(), 'db');

describe('S1-1: columnar INSERT after compaction', () => {
  it('a re-executed prepared INSERT does not reuse rowids moved into segments', async () => {
    const db = await fileDb();
    db.exec("CREATE TABLE c(a INT) WITH (storage = 'columnar')");
    const ins = db.prepare('INSERT INTO c VALUES (?)');
    for (let i = 0; i < 8200; i++) ins.run([i]);
    expect(db.query('SELECT count(*), count(DISTINCT rowid), max(rowid) FROM c').rows).toEqual([[8200, 8200, 8200]]);
  });

  it('a re-executed INSERT still sees conflicts with rows moved into segments', async () => {
    const db = await fileDb();
    db.exec("CREATE TABLE c(id INTEGER PRIMARY KEY, a INT) WITH (storage = 'columnar')");
    const ins = db.prepare('INSERT INTO c(id, a) VALUES (?, ?)');
    for (let i = 1; i <= 8192; i++) ins.run([i, i]); // the last run compacts all of them
    expect(() => ins.run([5, 0])).toThrow(/UNIQUE|constraint/i);
    expect(db.query('SELECT count(*) FROM c').rows).toEqual([[8192]]);
  });

  it('a cached writer follows the segments after a rolled-back statement', async () => {
    const db = await fileDb();
    db.exec("CREATE TABLE c(id INTEGER PRIMARY KEY, a INT) WITH (storage = 'columnar')");
    const ins = db.prepare('INSERT INTO c(id, a) VALUES (?, ?)');
    db.exec('BEGIN');
    ins.run([1, 1]);
    expect(() => db.exec('INSERT INTO c(id, a) VALUES (1, 1)')).toThrow(/UNIQUE|constraint/i); // statement rollback
    for (let i = 2; i <= 8192; i++) ins.run([i, i]);
    db.exec('COMMIT');
    expect(() => ins.run([100, 0])).toThrow(/UNIQUE|constraint/i);
    expect(db.query('SELECT count(*), count(DISTINCT id) FROM c').rows).toEqual([[8192, 8192]]);
  });
});

describe('S1-2: failed CREATE UNIQUE INDEX on a TEMP table', () => {
  for (const kind of ['file', 'memory'] as const) {
    it(`leaves the table usable (${kind} database)`, async () => {
      const db = kind === 'file' ? await fileDb() : Database.openMemory();
      db.exec("CREATE TEMP TABLE tt(x INT, y TEXT); INSERT INTO tt VALUES (1, 'a'), (1, 'b')");
      expect(() => db.exec('CREATE UNIQUE INDEX ui ON tt(x)')).toThrow(/UNIQUE|constraint/i);
      db.exec("INSERT INTO tt VALUES (2, 'c')");
      expect(db.query('SELECT count(*) FROM tt').rows).toEqual([[3]]);
      expect(db.query("SELECT count(*) FROM pragma_index_list('tt')").rows).toEqual([[0]]);
      expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
      db.exec('CREATE INDEX ui ON tt(y)'); // the name is free again
    });
  }

  it('also inside an explicit transaction', async () => {
    const db = await fileDb();
    db.exec('CREATE TEMP TABLE tt(x INT); INSERT INTO tt VALUES (1), (1); BEGIN');
    expect(() => db.exec('CREATE UNIQUE INDEX ui ON tt(x)')).toThrow(/UNIQUE|constraint/i);
    db.exec('INSERT INTO tt VALUES (2); COMMIT');
    expect(db.query('SELECT count(*) FROM tt').rows).toEqual([[3]]);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });
});

describe('S1-3: morsel / MV merges reject aggregates they cannot merge', () => {
  async function setup() {
    const db = await fileDb();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, a INT)');
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) INSERT INTO t SELECT i, i % 2, i FROM n');
    return db;
  }

  it('group_concat / string_agg over constants or keys is not split', async () => {
    const db = await setup();
    for (const sql of [
      "SELECT g, length(group_concat('x', '')) FROM t GROUP BY g",
      'SELECT g, group_concat(g) FROM t GROUP BY g',
      "SELECT g, string_agg('x', '') FROM t GROUP BY g",
      "SELECT length(group_concat('x', '')), count(*) FROM t",
    ]) {
      expect(db.parallelSplit(sql, 4, 0), sql).toBeNull();
    }
    // Mergeable aggregates around a scalar function still split.
    expect(db.parallelSplit('SELECT g, sum(a), max(length(a)) FROM t GROUP BY g', 4, 0)).not.toBeNull();
  });

  it('an MV roll-up does not answer a non-mergeable aggregate', async () => {
    const db = await setup();
    db.exec('CREATE MATERIALIZED VIEW mv AS SELECT g, count(*) AS n FROM t GROUP BY g; PRAGMA matview_rewrite = 1');
    const sql = 'SELECT g, length(group_concat(g)) FROM t GROUP BY g ORDER BY g';
    expect(db.query(`EXPLAIN QUERY PLAN ${sql}`).rows.map((r) => r[3]).join(' ')).not.toMatch(/\bmv\b/);
    expect(db.query(sql).rows).toEqual([[0, 999], [1, 999]]);
  });
});

describe('S1-4: materialized-view freshness', () => {
  async function setup() {
    const db = await fileDb();
    db.exec('CREATE TABLE t(x INT); INSERT INTO t VALUES (1), (2), (3)');
    db.exec('CREATE MATERIALIZED VIEW mv AS SELECT count(*) AS n FROM t; PRAGMA matview_rewrite = 1');
    return db;
  }
  const fresh = (db: Database, name = 'mv') => db.query(`SELECT is_fresh FROM information_schema.materialized_views WHERE table_name = '${name}'`).rows[0]?.[0];

  it('DROP TABLE + CREATE TABLE makes the view stale', async () => {
    const db = await setup();
    // In one transaction: the view's interface (ADR 0027) holds what it reads, checked at COMMIT.
    db.exec('BEGIN; DROP TABLE t; CREATE TABLE t(x INT); COMMIT');
    expect(fresh(db)).toBe('NO');
    expect(db.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
  });

  it('RENAME onto the base name makes the view stale', async () => {
    const db = await setup();
    db.exec('BEGIN; CREATE TABLE u(x INT); INSERT INTO u VALUES (9); DROP TABLE t; ALTER TABLE u RENAME TO t; COMMIT');
    expect(fresh(db)).toBe('NO');
    expect(db.query('SELECT count(*) FROM t').rows).toEqual([[1]]);
  });

  it('redefining a view the MV reads makes it stale, and later writes are tracked', async () => {
    const db = await fileDb();
    db.exec('CREATE TABLE a(x); INSERT INTO a VALUES (1), (2); CREATE TABLE other(x); INSERT INTO other VALUES (1)');
    db.exec('CREATE VIEW v AS SELECT x FROM a; CREATE MATERIALIZED VIEW mv AS SELECT count(*) AS n FROM v');
    db.exec('INSERT INTO a VALUES (3); REFRESH MATERIALIZED VIEW mv'); // dependencies computed and cached
    db.exec('BEGIN; DROP VIEW v; CREATE VIEW v AS SELECT x FROM other; COMMIT');
    expect(fresh(db)).toBe('NO');
    db.exec('REFRESH MATERIALIZED VIEW mv');
    expect(fresh(db)).toBe('YES');
    db.exec('INSERT INTO other VALUES (5)');
    expect(fresh(db)).toBe('NO');
  });

  it('a CTE named like its base table still depends on the table', async () => {
    const db = await fileDb();
    db.exec('CREATE TABLE t(x INT); INSERT INTO t VALUES (1), (2), (3)');
    // The body names the table as main.t: an unqualified t in a CTE named t is a circular reference, as in SQLite.
    db.exec('CREATE MATERIALIZED VIEW mv AS WITH t AS (SELECT * FROM main.t WHERE x > 0) SELECT count(*) AS n FROM t');
    db.exec('INSERT INTO t VALUES (4)');
    expect(fresh(db)).toBe('NO');
  });

  it('a TEMP table shadowing the base table is not answered from the view', async () => {
    const db = await setup();
    db.exec('CREATE TEMP TABLE t(x INT)');
    expect(db.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
    expect(db.query('SELECT count(*) FROM main.t').rows).toEqual([[3]]);
  });

  it('dropping a materialized view makes views over it stale', async () => {
    const db = await setup();
    db.exec('CREATE MATERIALIZED VIEW over_mv AS SELECT n FROM mv');
    db.exec('BEGIN; DROP MATERIALIZED VIEW mv; CREATE TABLE mv(n INT); COMMIT');
    expect(fresh(db, 'over_mv')).toBe('NO');
  });
});

describe('S1-5: main.-qualified statements with a shadowing TEMP table', () => {
  async function setup() {
    const db = await fileDb();
    db.exec('CREATE TABLE t(x INT); INSERT INTO t VALUES (1), (2); CREATE TEMP TABLE t(y INT); INSERT INTO t VALUES (7)');
    return db;
  }

  it('reads and writes reach the main table', async () => {
    const db = await setup();
    expect(db.query('SELECT * FROM main.t ORDER BY 1').rows).toEqual([[1], [2]]);
    expect(db.query('SELECT * FROM t').rows).toEqual([[7]]);
    db.exec('INSERT INTO main.t VALUES (3); UPDATE main.t SET x = x * 10; DELETE FROM main.t WHERE x = 10');
    expect(db.query('SELECT * FROM main.t ORDER BY 1').rows).toEqual([[20], [30]]);
    expect(db.query('SELECT * FROM temp.t').rows).toEqual([[7]]);
  });

  it('DROP TABLE main.t drops the main table and keeps the temp one', async () => {
    const db = await setup();
    db.exec('DROP TABLE main.t');
    expect(db.query('SELECT * FROM t').rows).toEqual([[7]]);
    expect(() => db.query('SELECT * FROM main.t')).toThrow(/no such table/);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
    db.exec('DROP TABLE t');
    expect(() => db.query('SELECT * FROM t')).toThrow(/no such table/);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });
});
