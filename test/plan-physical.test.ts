/** The physical planner (ADR 0014, step 6b): operators for the SQL front end's plans over one table. */
import { afterAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { setPlanMode, shadowStats } from '../src/engine/exec/plan-shadow.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

afterAll(() => setPlanMode(null));

async function setup(): Promise<Database> {
  const db = await Database.open(new MemoryVfs(), 'db');
  db.exec(`
    CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, s TEXT COLLATE NOCASE, r REAL);
    CREATE INDEX t_a ON t(a);
    CREATE TABLE u(x INT, y TEXT);
    CREATE TABLE c(g INT, v INT) WITH (storage = 'columnar');
  `);
  db.exec('BEGIN');
  for (let i = 1; i <= 300; i++) {
    db.exec(`INSERT INTO t VALUES (${i}, ${i % 17}, '${String.fromCharCode(65 + (i % 5))}${i % 3}', ${i / 4})`);
    db.exec(`INSERT INTO u VALUES (${i % 11}, 'y${i % 7}')`);
    db.exec(`INSERT INTO c VALUES (${i % 4}, ${i})`);
  }
  db.exec('COMMIT');
  return db;
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
  'SELECT u.y, max(t.r) FROM t JOIN u ON u.x = t.a GROUP BY u.y ORDER BY 2 DESC',
  'SELECT table_name FROM information_schema.tables ORDER BY 1',
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
  'VALUES (1, \'a\'), (3, \'b\'), (2, NULL) ORDER BY 1',
  'SELECT * FROM (VALUES (1), (2)) v',
  'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20) SELECT count(*), max(i) FROM n',
  'SELECT u.x, w.r FROM u CROSS JOIN (SELECT 1 AS r) w LIMIT 2',
  'SELECT d.a, d.n FROM (SELECT a, count(*) AS n FROM t GROUP BY a) d JOIN u ON u.x = d.a WHERE d.n > 17',
  'SELECT * FROM (SELECT DISTINCT y FROM u) ORDER BY 1',
  'SELECT k FROM (SELECT a AS k FROM t ORDER BY r DESC LIMIT 3) ORDER BY 1',
];

// A derived table the planner may flatten into the query: left to it until flattening reads plans (step 7a).
const FLATTENED = ['SELECT k FROM (SELECT a AS k FROM t WHERE id < 4) ORDER BY 1'];

const params = (sql: string) => (sql.includes('?') ? [7] : undefined);
const run = (db: Database, sql: string) => db.prepare(sql).all(params(sql));
const explain = (db: Database, sql: string) => db.prepare(`EXPLAIN ${sql}`).all(params(sql));

describe('physical planner', () => {
  it('builds the planner\'s operators for single-table plans, with the same results', async () => {
    const db = await setup();
    setPlanMode('legacy');
    const want = HANDLED.map((q) => ({ rows: run(db, q), plan: explain(db, q) }));
    setPlanMode('plan');
    HANDLED.forEach((q, i) => {
      expect(run(db, q), q).toEqual(want[i].rows);
      expect(explain(db, q), q).toEqual(want[i].plan);
    });
    // Shadow mode checks EXPLAIN against the planner and runs the physical planner's operators.
    setPlanMode('shadow');
    const before = shadowStats.physical;
    for (const q of HANDLED) run(db, q);
    expect(shadowStats.physical - before).toBe(HANDLED.length);
  });

  it.skipIf(!!process.env.SMALT_NO_FLATTEN)('leaves derived tables the planner may flatten to the planner', async () => {
    const db = await setup();
    setPlanMode('legacy');
    const want = FLATTENED.map((q) => run(db, q));
    setPlanMode('shadow');
    const before = shadowStats.physical;
    FLATTENED.forEach((q, i) => expect(run(db, q), q).toEqual(want[i]));
    expect(shadowStats.physical).toBe(before);
  });
});
