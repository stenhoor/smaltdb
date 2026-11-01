/**
 * Aggregate queries (docs/research/m7-code-review.md, "Found while fixing S2"):
 * - select-list aliases of aggregates in HAVING: `SELECT g, sum(a) AS s ... HAVING s > 100` refers to the aggregate;
 * - correlated subqueries in the result, HAVING and ORDER BY read the group's outer columns (they read NULL before).
 * Compared with SQLite. Run with SMALT_NO_DECORRELATE=1 too (`npm test` runs both modes).
 */
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

type Lite = { exec(s: string): void; selectArrays(s: string): unknown[][] };
let lite: Lite;
const SETUP = `
  CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, a INT, b TEXT);
  CREATE TABLE u(id INTEGER PRIMARY KEY, g INT, w INT);
  INSERT INTO t VALUES (1, 1, 50, 'x'), (2, 1, 60, 'y'), (3, 2, 5, 'x'), (4, 2, 7, NULL), (5, 3, 200, 'z'), (6, NULL, 9, 'x'), (7, 3, NULL, 'y');
  INSERT INTO u VALUES (1, 1, 100), (2, 2, 1), (3, 3, 500);
`;
beforeAll(async () => {
  const s3 = await (sqliteInit as unknown as (o: object) => Promise<{ oo1: { DB: new (n: string) => Lite } }>)({ print() {}, printErr() {} });
  lite = new s3.oo1.DB(':memory:');
  // smaltdb tables are STRICT by default.
  lite.exec(SETUP.replace(/^(\s*CREATE TABLE .*)\);$/gm, '$1) STRICT;'));
});

const QUERIES = [
  'SELECT g, sum(a) AS s FROM t GROUP BY g HAVING s > 100',
  'SELECT g, sum(a) AS s FROM t GROUP BY g HAVING s > 10 ORDER BY s DESC',
  'SELECT g, sum(a) AS s FROM t GROUP BY g HAVING s > 10 ORDER BY s + 0 DESC',
  'SELECT g, count(*) AS n FROM t GROUP BY g HAVING n = 2 AND sum(a) > 20',
  'SELECT g, sum(a) + 1 AS s FROM t GROUP BY g HAVING s > 100',
  'SELECT g, sum(a) AS s, count(a) AS c FROM t GROUP BY g HAVING s / c > 20',
  'SELECT g, sum(a) AS s FROM t GROUP BY g HAVING s IS NULL OR s < 20',
  'SELECT g, max(b) AS m FROM t GROUP BY g HAVING m = \'y\'',
  'SELECT g AS k, sum(a) AS s FROM t GROUP BY k HAVING k > 1 AND s > 0',
  'SELECT g + 1 AS k, sum(a) AS s FROM t GROUP BY g + 1 HAVING k > 2',
  'SELECT sum(a) AS s FROM t HAVING s > 1',
  'SELECT sum(a) AS s FROM t HAVING s > 100000',
  'SELECT g, sum(a) AS s FROM t GROUP BY g HAVING s > (SELECT avg(w) FROM u)',
  'SELECT g, sum(a) AS s FROM t GROUP BY g HAVING EXISTS (SELECT 1 FROM u WHERE u.g = t.g AND u.w > 50)',
  'SELECT t.g, sum(a) AS s, max(w) AS mw FROM t JOIN u ON u.g = t.g GROUP BY t.g HAVING s < mw',
  'SELECT g, sum(a) AS s FROM t WHERE b IS NOT NULL GROUP BY g HAVING s >= 9 ORDER BY g',
  'SELECT * FROM (SELECT g, sum(a) AS s FROM t GROUP BY g HAVING s > 50) ORDER BY g',
  'SELECT b, count(*) AS n FROM t GROUP BY b HAVING n > 1 ORDER BY n, b',
  'SELECT g, total(a) AS s FROM t GROUP BY g HAVING s BETWEEN 10 AND 150',
];

const CORRELATED = [
  'SELECT g, sum(a) FROM t GROUP BY g HAVING EXISTS (SELECT 1 FROM u WHERE u.g = t.g AND u.w > 50)',
  'SELECT g, sum(a) FROM t GROUP BY g HAVING NOT EXISTS (SELECT 1 FROM u WHERE u.g = t.g)',
  'SELECT g, sum(a), (SELECT max(w) FROM u WHERE u.g = t.g) FROM t GROUP BY g',
  'SELECT t.g, sum(a), (SELECT max(w) FROM u WHERE u.g = t.g) FROM t GROUP BY t.g',
  'SELECT g, sum(a) FROM t GROUP BY g HAVING (SELECT max(w) FROM u WHERE u.g = t.g) > 50',
  'SELECT g, sum(a) AS s FROM t GROUP BY g HAVING s < (SELECT max(w) FROM u WHERE u.g = t.g)',
  'SELECT g, sum(a) FROM t GROUP BY g HAVING g IN (SELECT u.g FROM u WHERE u.w >= t.g)',
  'SELECT g, sum(a) FROM t GROUP BY g ORDER BY (SELECT w FROM u WHERE u.g = t.g), g',
  'SELECT g, sum((SELECT max(w) FROM u WHERE u.g = t.g)) FROM t GROUP BY g',
  'SELECT g, sum(a) + (SELECT count(*) FROM u WHERE u.g = t.g) FROM t GROUP BY g',
  'SELECT count(*), (SELECT max(w) FROM u WHERE u.g = t.g) FROM t WHERE g = 3',
  'SELECT g, (SELECT sum(x.a) FROM t x WHERE x.g = t.g AND x.a > (SELECT min(w) FROM u WHERE u.g = t.g)) FROM t GROUP BY g',
];

const sort = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();

describe('aliases of aggregates in HAVING', () => {
  it('match SQLite (normal path, fused and hash aggregates)', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec(SETUP);
    for (const q of QUERIES) {
      const want = lite.selectArrays(q);
      const got = db.query(q).rows as unknown[][];
      if (/ORDER BY/.test(q.replace(/\(.*\)/, ''))) expect(got, q).toEqual(want);
      else expect(sort(got), q).toEqual(sort(want));
    }
  });

  it('correlated subqueries read the group\'s columns (match SQLite)', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec(SETUP);
    for (const q of CORRELATED) {
      const want = lite.selectArrays(q);
      const got = db.query(q).rows as unknown[][];
      if (/ORDER BY/.test(q)) expect(got, q).toEqual(want);
      else expect(sort(got), q).toEqual(sort(want));
    }
  });

  it('match the normal path through morsels', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, a INT)');
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) INSERT INTO t SELECT i, i % 7, i % 100 FROM n');
    for (const q of [
      'SELECT g, sum(a) AS s FROM t GROUP BY g HAVING s > 21210 ORDER BY g',
      'SELECT g, count(*) AS n, sum(a) AS s FROM t GROUP BY g HAVING n > 428 AND s < 21250 ORDER BY g',
      'SELECT sum(a) AS s FROM t HAVING s > 1',
    ]) {
      const want = db.query(q).rows;
      expect(want.length, q).toBeGreaterThan(0);
      expect(want.length, q).toBeLessThan(7);
      const viaMorsels = db.queryMorsels(q, undefined, 4);
      if (viaMorsels) expect(viaMorsels.rows, q).toEqual(want);
    }
  });

  it('still rejects an aggregate alias in WHERE', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec(SETUP);
    expect(() => db.query('SELECT g, sum(a) AS s FROM t WHERE s > 1 GROUP BY g')).toThrow(/misuse of aggregate|no such column/);
  });
});
