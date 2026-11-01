import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

async function setup() {
  const db = await Database.open(new MemoryVfs(), 'db');
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, s TEXT, x REAL, n INT, ci TEXT COLLATE NOCASE)');
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000)
    INSERT INTO t SELECT i * 3, i % 17, CASE WHEN i % 13 = 0 THEN NULL ELSE 's' || (i % 9) END, i / 7.0, CASE WHEN i % 5 = 0 THEN NULL ELSE i % 1000 END, CASE i % 2 WHEN 0 THEN 'A' ELSE 'a' END FROM n`);
  db.exec("CREATE TABLE c(id INTEGER PRIMARY KEY, g INT, x REAL) WITH (storage = 'columnar')");
  db.exec('INSERT INTO c SELECT id, g, x FROM t');
  db.exec('DELETE FROM c WHERE id % 11 = 0');
  db.exec("CREATE MATERIALIZED VIEW mv WITH (storage = 'columnar') AS SELECT g, x FROM t");
  return db;
}

const QUERIES: [string, unknown[]?][] = [
  ['SELECT count(*), sum(n), total(x), min(s), max(s), avg(n), count(n) FROM t'],
  ['SELECT g, count(*), sum(x), avg(x), min(n), max(n) FROM t GROUP BY g'],
  ['SELECT g, s, count(*) AS cnt FROM t WHERE x > ? GROUP BY g, s HAVING count(*) > 10 ORDER BY cnt DESC, g, s LIMIT ? OFFSET 3', [100, 20]],
  ['SELECT g % 3 AS k, sum(n) * 2 + 1, avg(n) FILTER (WHERE n > 500) FROM t GROUP BY g % 3 ORDER BY k'],
  ['SELECT s, count(*) FROM t GROUP BY s ORDER BY 2 DESC, 1'],
  ['SELECT count(*) FROM t WHERE x < 0'],
  ['SELECT g, count(*) FROM t WHERE x < 0 GROUP BY g'],
  ['SELECT CASE WHEN g > 8 THEN 1 ELSE 0 END AS big, count(*) FROM t GROUP BY CASE WHEN g > 8 THEN 1 ELSE 0 END ORDER BY 1'],
  ['SELECT g, sum(x) FROM c GROUP BY g ORDER BY g'],
  ['SELECT count(*), avg(x) FROM c WHERE g < 5'],
  ['SELECT g, count(*), max(x) FROM mv GROUP BY g ORDER BY g'],
];

const NOT_ELIGIBLE = [
  'SELECT g, count(DISTINCT s) FROM t GROUP BY g',
  'SELECT ci, count(*) FROM t GROUP BY ci', // NOCASE key: partial groups would not meet
  'SELECT g, group_concat(s) FROM t GROUP BY g',
  'SELECT g, x, max(n) FROM t GROUP BY g', // bare column
  'SELECT * FROM t WHERE g = 1',
  'SELECT DISTINCT g FROM t',
  'SELECT g, count(*) FROM t WHERE n IN (SELECT n FROM t WHERE g = 1) GROUP BY g',
  'SELECT t.g, count(*) FROM t JOIN c ON c.id = t.id GROUP BY t.g',
  'SELECT g, count(*) OVER () FROM t',
  'SELECT min(g, 3) FROM t',
];

describe('morsel parallelism (partial aggregates over rowid ranges)', () => {
  it('merges partials into the same result as a normal run', async () => {
    const db = await setup();
    for (const [sql, params] of QUERIES) {
      const want = db.query(sql, params as never);
      for (const parts of [2, 3, 7]) {
        const got = db.queryMorsels(sql, params as never, parts);
        expect(got, sql).not.toBeNull();
        expect(got!.columns, sql).toEqual(want.columns);
        const ordered = /ORDER BY/i.test(sql);
        const norm = (rows: unknown[][]) => (ordered ? rows : [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)));
        // Float sums may differ in the last bits when added in another order.
        expect(JSON.parse(JSON.stringify(norm(got!.rows), (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v))), sql).toEqual(
          JSON.parse(JSON.stringify(norm(want.rows), (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v))),
        );
      }
    }
  });

  it('declines what does not merge exactly', async () => {
    const db = await setup();
    for (const sql of NOT_ELIGIBLE) expect(db.parallelSplit(sql, 4, 0), sql).toBeNull();
  });

  it('only splits large tables', async () => {
    const db = await setup();
    expect(db.parallelSplit('SELECT count(*) FROM t', 4)).toBeNull(); // 50k rows < default threshold
    const ranges = db.parallelSplit('SELECT count(*) FROM t', 4, 1000)!;
    expect(ranges.length).toBe(4);
    expect(ranges[0].lo).toBe(3);
    expect(ranges[3].hi).toBe(150001);
  });
});
