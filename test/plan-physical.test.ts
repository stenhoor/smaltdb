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
];

const JOINS = ['SELECT t.a, u.y FROM t JOIN u ON u.x = t.a WHERE t.id < 5', 'SELECT a FROM t WHERE id IN (SELECT x FROM u)'];

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

  it('leaves joins and subqueries to the planner', async () => {
    const db = await setup();
    setPlanMode('legacy');
    const want = JOINS.map((q) => run(db, q));
    setPlanMode('shadow');
    const before = shadowStats.physical;
    JOINS.forEach((q, i) => expect(run(db, q), q).toEqual(want[i]));
    expect(shadowStats.physical).toBe(before);
  });
});
