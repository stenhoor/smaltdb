/**
 * The physical planner (ADR 0014): statements over the shapes it plans (access paths, fusion, joins, subqueries,
 * windows, compounds, CTEs, derived tables, writes with RETURNING and ON CONFLICT), compared with SQLite. Plan shapes
 * are pinned by test/plan-shapes.test.ts.
 */
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

type Sqlite = { exec(sql: string): void; selectArrays(sql: string, bind?: unknown[]): unknown[][] };
let sqlite3: { oo1: { DB: new (name: string) => Sqlite } };
beforeAll(async () => {
  sqlite3 = (await (sqliteInit as unknown as (o: object) => Promise<unknown>)({ print: () => {}, printErr: () => {} })) as never;
});

const ddl = (columnar: boolean): string => `
  CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, s TEXT COLLATE NOCASE, r REAL);
  CREATE INDEX t_a ON t(a);
  CREATE TABLE u(x INT, y TEXT);
  CREATE TABLE c(g INT, v INT)${columnar ? " WITH (storage = 'columnar')" : ''};
  CREATE TABLE k(id INTEGER PRIMARY KEY, n TEXT UNIQUE, cnt INT DEFAULT 0, d TEXT DEFAULT 'dflt', CHECK (cnt >= 0));
`;

function rows(): string {
  const out: string[] = [];
  for (let i = 1; i <= 300; i++) {
    out.push(`INSERT INTO t VALUES (${i}, ${i % 17}, '${String.fromCharCode(65 + (i % 5))}${i % 3}', ${i / 4})`);
    out.push(`INSERT INTO u VALUES (${i % 11}, 'y${i % 7}')`);
    out.push(`INSERT INTO c VALUES (${i % 4}, ${i})`);
  }
  return `BEGIN; ${out.join('; ')}; COMMIT;`;
}

async function setup(): Promise<{ db: Database; lite: Sqlite }> {
  const db = await Database.open(new MemoryVfs(), 'db');
  db.exec(ddl(true));
  db.exec(rows());
  const lite = new sqlite3.oo1.DB(':memory:');
  lite.exec(ddl(false));
  lite.exec(rows());
  return { db, lite };
}

// Single-table shapes: access paths, fusion, aggregates (fused and hashed), bare columns, ORDER BY (rowid order,
// extras, top-N), DISTINCT, LIMIT / OFFSET, the count(*) fast path, no FROM, parameters.
const HANDLED = [
  'SELECT * FROM t',
  'SELECT a, s FROM t WHERE a = 3',
  'SELECT id FROM t WHERE a BETWEEN 2 AND 4 AND s = \'b1\'',
  'SELECT id, r * 2 FROM t WHERE id > 290 ORDER BY id DESC',
  'SELECT rowid, x FROM u WHERE x = 5 ORDER BY 1',
  'SELECT id AS k FROM t ORDER BY k LIMIT 3',
  'SELECT a FROM t ORDER BY r DESC, id LIMIT 5 OFFSET 2',
  'SELECT DISTINCT s FROM t ORDER BY s',
  'SELECT a, count(*), sum(r) FROM t GROUP BY a HAVING count(*) > 17 ORDER BY 2 DESC, a',
  'SELECT s, a, max(id) FROM t GROUP BY s',
  'SELECT count(*), min(a), avg(r) FROM t WHERE s LIKE \'a%\'',
  'SELECT count(DISTINCT a) FROM t',
  'SELECT count(*) FROM t',
  'SELECT g, sum(v) FROM c WHERE v > 10 GROUP BY g ORDER BY g',
  'SELECT 1 + 2, \'x\' WHERE 1',
  'SELECT count(*)',
  'SELECT a FROM t WHERE id = ?',
  // Joins (6c-i): index nested loop, hash, outer joins, USING / NATURAL, table functions, virtual tables.
  'SELECT t.a, u.y FROM t JOIN u ON u.x = t.a WHERE t.id < 5',
  'SELECT t.id, u.y FROM u JOIN t ON t.id = u.x AND t.s BETWEEN \'a\' AND \'c\'',
  'SELECT count(*) FROM t, u WHERE t.a = u.x',
  'SELECT t.id, u2.y FROM t LEFT JOIN u AS u2 ON u2.x = t.id AND u2.y = \'y1\' WHERE t.id < 20 ORDER BY 1, 2',
  'SELECT t.id, u.x FROM t RIGHT JOIN u ON u.x = t.id WHERE u.x > 8',
  'SELECT t.id, u.x FROM t FULL JOIN u ON u.x = t.a + 20',
  'SELECT a.id, b.id FROM t a JOIN t b USING (a) WHERE a.id < 4 AND b.id < 4',
  'SELECT t.id, p.name FROM t, pragma_table_info(\'t\') p WHERE t.id < 3',
  'SELECT u.y, max(t.r) FROM t JOIN u ON u.x = t.a GROUP BY u.y ORDER BY 2 DESC, 1',
  // Subqueries (6c-ii): uncorrelated, correlated, decorrelated, over aggregate rows, nested, in ON and arguments.
  'SELECT a FROM t WHERE id IN (SELECT x FROM u)',
  'SELECT a FROM t WHERE a NOT IN (SELECT x FROM u WHERE x > 3) ORDER BY 1',
  'SELECT id, (SELECT max(y) FROM u WHERE u.x = t.a) FROM t WHERE id < 30',
  'SELECT id FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.x = t.a AND u.y = \'y2\')',
  'SELECT id FROM t WHERE NOT EXISTS (SELECT 1 FROM u WHERE u.x = t.a)',
  'SELECT id FROM t WHERE EXISTS (SELECT count(*) FROM u WHERE u.x = t.a)',
  'SELECT id, (SELECT y FROM u WHERE u.x = t.a ORDER BY y LIMIT 1) FROM t WHERE id < 10',
  'SELECT id FROM t WHERE r > (SELECT avg(r) FROM t)',
  'SELECT a, count(*), (SELECT count(*) FROM u WHERE u.x = t.a) FROM t GROUP BY a',
  'SELECT a FROM t GROUP BY a HAVING count(*) > (SELECT count(*) FROM u WHERE u.x = t.a)',
  'SELECT id FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.x = t.a AND EXISTS (SELECT 1 FROM c WHERE c.g = u.x AND c.v = t.id))',
  'SELECT t.id, u.y FROM t LEFT JOIN u ON u.x = t.a AND u.y IN (SELECT y FROM u WHERE x = 1) WHERE t.id < 8',
  'SELECT (SELECT count(*) FROM u), (SELECT 1 WHERE EXISTS (SELECT 1 FROM t))',
  // Windows, compounds, VALUES, recursive CTEs, derived tables the planner does not flatten (6c-iii).
  'SELECT a, rank() OVER (ORDER BY id), sum(r) OVER (PARTITION BY s ORDER BY id ROWS 2 PRECEDING) FROM t LIMIT 5',
  'SELECT s, count(*), row_number() OVER (ORDER BY count(*) DESC, s) FROM t GROUP BY s',
  'SELECT a FROM t WHERE id < 5 UNION SELECT x FROM u WHERE x > 8 ORDER BY 1 DESC LIMIT 4',
  'SELECT a FROM t INTERSECT SELECT x FROM u EXCEPT SELECT 3',
  'VALUES (1, \'a\'), (3, \'b\'), (2, NULL)',
  'SELECT * FROM (VALUES (1), (2)) v',
  'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20) SELECT count(*), max(i) FROM n',
  'SELECT u.x, w.r FROM u CROSS JOIN (SELECT 1 AS r) w LIMIT 2',
  'SELECT d.a, d.n FROM (SELECT a, count(*) AS n FROM t GROUP BY a) d JOIN u ON u.x = d.a WHERE d.n > 17',
  'SELECT * FROM (SELECT DISTINCT y FROM u) ORDER BY 1',
  'SELECT k FROM (SELECT a AS k FROM t ORDER BY r DESC LIMIT 3) ORDER BY 1',
  // Views and FROM subqueries the front end merges into the query (7a), and one it does not (USING inside).
  'SELECT k FROM (SELECT a AS k FROM t WHERE id < 4) ORDER BY 1',
  'SELECT d.k, u.y FROM (SELECT a AS k, id FROM t WHERE id < 30) d LEFT JOIN u ON u.x = d.k WHERE d.id > 25',
  'SELECT * FROM (SELECT t.id, t2.r FROM t JOIN t AS t2 USING (a)) WHERE id < 3',
];

const params = (sql: string) => (sql.includes('?') ? [7] : undefined);
// Rows in a stable order where the statement does not fix one.
const ordered = (sql: string, r: unknown[][]): unknown[][] => (/ORDER BY [^)]*$/i.test(sql) ? r : [...r].sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)));
const run = (db: Database, sql: string): unknown[][] => ordered(sql, db.prepare(sql).all(params(sql)).map((r) => Object.values(r)));
const runLite = (lite: Sqlite, sql: string): unknown[][] => ordered(sql, lite.selectArrays(sql, params(sql)));

describe('physical planner', () => {
  it('gives the rows SQLite gives', async () => {
    const { db, lite } = await setup();
    for (const q of HANDLED) expect(run(db, q), q).toEqual(runLite(lite, q));
  });
});

// Writes (step 8): the target scan, WHERE and RETURNING go through the physical planner.
const DELETES = [
  'DELETE FROM t WHERE a = 3',
  'DELETE FROM t WHERE id BETWEEN 10 AND 20 RETURNING id, a * 2, s',
  'DELETE FROM u AS x WHERE x.x IN (SELECT a FROM t WHERE id < 5) RETURNING *',
  'DELETE FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.x = t.a AND u.y = \'y3\') RETURNING rowid',
  'WITH k(v) AS (SELECT 7) DELETE FROM c WHERE v IN (SELECT v FROM k) RETURNING g, v',
  'DELETE FROM u RETURNING x',
];

const UPDATES = [
  'UPDATE t SET a = a + 1 WHERE id < 10',
  'UPDATE t AS q SET s = upper(q.s), r = r * 2 WHERE q.a = 4 RETURNING id, s, r',
  'UPDATE u SET y = (SELECT s FROM t WHERE t.id = u.x) WHERE x > 5 RETURNING *',
  'UPDATE t SET a = u.x FROM u WHERE u.x = t.id AND u.y = \'y2\' RETURNING rowid, a',
  'UPDATE t SET rowid = rowid + 1000 WHERE id > 295',
  'WITH k(v) AS (SELECT 3) UPDATE c SET v = v + 1 WHERE g IN (SELECT v FROM k) RETURNING g',
];

const INSERTS = [
  "INSERT INTO k VALUES (1, 'a', 1, 'x'), (2, 'b', 2, 'y')",
  "INSERT INTO k(n) VALUES ('c') RETURNING id, n, cnt, d",
  'INSERT INTO k DEFAULT VALUES RETURNING *',
  'INSERT INTO u(rowid, x) VALUES (1000, 5) RETURNING rowid, x, y',
  "INSERT INTO k(n, cnt) SELECT 'm' || x, x FROM u WHERE x > 8 GROUP BY x ORDER BY x RETURNING n, cnt",
  "INSERT INTO k(n) VALUES ('a') ON CONFLICT DO NOTHING",
  "INSERT INTO k(n, cnt) VALUES ('a', 4), ('z', 7) ON CONFLICT(n) DO UPDATE SET cnt = k.cnt + excluded.cnt, d = excluded.n WHERE excluded.cnt > 1 RETURNING *",
  "INSERT INTO k AS q(n, cnt) VALUES ('b', 9) ON CONFLICT(n) DO UPDATE SET cnt = q.cnt * 10 WHERE q.cnt < excluded.cnt",
  "INSERT OR REPLACE INTO k(id, n) VALUES (1, 'b')",
  "WITH w(v) AS (SELECT a FROM t WHERE id < 4) INSERT INTO k(n, cnt) SELECT 'w' || v, v FROM w",
  'INSERT INTO k(n, cnt) SELECT n || n, cnt + 1 FROM k WHERE cnt < 3',
  'INSERT INTO u SELECT id, s FROM t WHERE a = (SELECT max(a) FROM t) RETURNING x',
  'INSERT INTO c SELECT g + 10, sum(v) FROM c GROUP BY g',
];

describe('physical planner, writes', () => {
  // Each statement's RETURNING rows, then the table it changed.
  const writes = (stmts: string[], after: string) => async () => {
    const { db, lite } = await setup();
    for (const q of stmts) {
      expect(run(db, q), q).toEqual(runLite(lite, q));
      expect(run(db, after), q).toEqual(runLite(lite, after));
    }
  };
  it('inserts the rows SQLite inserts and returns the same RETURNING rows', writes(INSERTS, 'SELECT * FROM k ORDER BY id'));
  it('updates the rows SQLite updates and returns the same RETURNING rows', writes(UPDATES, 'SELECT * FROM t ORDER BY id'));
  it('deletes the rows SQLite deletes and returns the same RETURNING rows', writes(DELETES, 'SELECT (SELECT count(*) FROM t), (SELECT count(*) FROM u), (SELECT count(*) FROM c)'));
});
