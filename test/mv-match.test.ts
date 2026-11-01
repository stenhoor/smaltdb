import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

async function setup(vfs = new MemoryVfs()) {
  const db = await Database.open(vfs, 'db');
  db.exec('CREATE TABLE sales(id INTEGER PRIMARY KEY, region TEXT, product TEXT, amount REAL)');
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5000)
    INSERT INTO sales SELECT i, CASE i % 3 WHEN 0 THEN 'EU' WHEN 1 THEN 'US' ELSE 'APAC' END, 'p' || (i % 7), (i % 50) - 5 FROM n`);
  db.exec(`CREATE MATERIALIZED VIEW by_rp AS
    SELECT region, product, count(*) AS n, sum(amount) AS total, min(amount) AS lo, max(amount) AS hi, count(amount) AS na
    FROM sales WHERE amount > 0 GROUP BY region, product`);
  db.exec("CREATE MATERIALIZED VIEW eu AS SELECT id, product, amount FROM sales WHERE region = 'EU'");
  db.exec('PRAGMA matview_rewrite = 1');
  return { vfs, db };
}

const plan = (db: Database, sql: string): string =>
  db
    .query(`EXPLAIN QUERY PLAN ${sql}`)
    .rows.map((r) => r[3])
    .join(' | ');

/** `sql` reads `view` and returns what the base tables return. */
function answeredBy(db: Database, sql: string, view: string | null): void {
  db.exec('PRAGMA matview_rewrite = 0');
  const want = db.query(sql);
  db.exec('PRAGMA matview_rewrite = 1');
  const p = plan(db, sql);
  if (view) expect(p, sql).toMatch(new RegExp(`\\b${view}\\b`));
  else expect(p, sql).not.toMatch(/\bby_rp\b|\beu\b/);
  const got = db.query(sql);
  expect(got.columns, sql).toEqual(want.columns);
  const sorted = (rows: unknown[][]) => (/ORDER BY/i.test(sql) ? rows : [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)));
  expect(sorted(got.rows), sql).toEqual(sorted(want.rows));
}

describe('materialized view matching', () => {
  it('rolls aggregate queries up from a fresh view', async () => {
    const { db } = await setup();
    answeredBy(db, 'SELECT region, count(*), sum(amount), avg(amount), min(amount), max(amount) FROM sales WHERE amount > 0 GROUP BY region ORDER BY region', 'by_rp');
    answeredBy(db, "SELECT product, sum(amount) AS s FROM sales WHERE amount > 0 AND region = 'EU' GROUP BY product HAVING sum(amount) > 100 ORDER BY s DESC", 'by_rp');
    answeredBy(db, 'SELECT count(*), total(amount) FROM sales WHERE amount > 0', 'by_rp');
    answeredBy(db, 'SELECT Region, Product, count(*) FROM sales WHERE amount > 0 GROUP BY region, product', 'by_rp');
    // Not answerable from by_rp: another filter, a non-key filter, an aggregate it lacks.
    answeredBy(db, 'SELECT region, count(*) FROM sales WHERE amount > 5 GROUP BY region', null);
    answeredBy(db, 'SELECT region, count(*) FROM sales WHERE amount > 0 AND id < 100 GROUP BY region', null);
    answeredBy(db, 'SELECT region, count(DISTINCT product) FROM sales WHERE amount > 0 GROUP BY region', null);
    answeredBy(db, 'SELECT region, sum(id) FROM sales WHERE amount > 0 GROUP BY region', null);
  });

  it('answers selections and projections from a fresh view', async () => {
    const { db } = await setup();
    answeredBy(db, "SELECT amount, product FROM sales WHERE region = 'EU' AND amount > 30 ORDER BY id", 'eu');
    answeredBy(db, "SELECT s.product AS p FROM sales AS s WHERE s.region = 'EU' ORDER BY p, s.id", 'eu');
    answeredBy(db, "SELECT region FROM sales WHERE region = 'EU'", null); // region is not a column of eu
    answeredBy(db, "SELECT id FROM sales WHERE region = 'US'", null);
  });

  it('stops using a view once its base table changes, until refreshed', async () => {
    const { vfs, db } = await setup();
    const q = 'SELECT region, count(*) FROM sales WHERE amount > 0 GROUP BY region ORDER BY region';
    const fresh = () => db.query("SELECT table_name, is_fresh FROM information_schema.materialized_views ORDER BY 1").rows;
    expect(fresh()).toEqual([['by_rp', 'YES'], ['eu', 'YES']]);
    const before = db.query(q).rows[1] as [string, number];
    db.exec('BEGIN; INSERT INTO sales(region, product, amount) VALUES (\'EU\', \'p1\', 10)');
    expect(plan(db, q)).not.toMatch(/by_rp/);
    expect(db.query(q).rows[1]).toEqual(['EU', before[1] + 1]); // the new row counts
    db.exec('ROLLBACK');
    expect(fresh()).toEqual([['by_rp', 'YES'], ['eu', 'YES']]);
    expect(plan(db, q)).toMatch(/by_rp/);
    db.exec("UPDATE sales SET amount = 1 WHERE id = 3");
    expect(fresh()).toEqual([['by_rp', 'NO'], ['eu', 'NO']]);
    answeredBy(db, q, null);
    db.exec('REFRESH MATERIALIZED VIEW by_rp');
    expect(fresh()).toEqual([['by_rp', 'YES'], ['eu', 'NO']]);
    answeredBy(db, q, 'by_rp');
    db.close();
    // Freshness is stored: still fresh after reopening (the setting is per connection).
    const again = await Database.open(vfs, 'db');
    expect(again.query("SELECT table_name, is_fresh FROM information_schema.materialized_views ORDER BY 1").rows).toEqual([['by_rp', 'YES'], ['eu', 'NO']]);
    expect(plan(again, q)).not.toMatch(/by_rp/); // matview_rewrite is off by default
    again.exec('PRAGMA matview_rewrite = 1');
    expect(plan(again, q)).toMatch(/by_rp/);
  });

  it('tracks views over views', async () => {
    const { db } = await setup();
    db.exec('CREATE VIEW positive AS SELECT * FROM sales WHERE amount > 0');
    db.exec('CREATE MATERIALIZED VIEW via_view AS SELECT region, count(*) AS n FROM positive GROUP BY region');
    db.exec('CREATE MATERIALIZED VIEW over_mv AS SELECT sum(n) AS n FROM by_rp');
    const fresh = () => Object.fromEntries(db.query('SELECT table_name, is_fresh FROM information_schema.materialized_views').rows as [string, string][]);
    expect(fresh()).toEqual({ by_rp: 'YES', eu: 'YES', via_view: 'YES', over_mv: 'YES' });
    db.exec('DELETE FROM sales WHERE id = 1');
    expect(fresh()).toEqual({ by_rp: 'NO', eu: 'NO', via_view: 'NO', over_mv: 'YES' });
    db.exec('REFRESH MATERIALIZED VIEW by_rp');
    expect(fresh()).toEqual({ by_rp: 'YES', eu: 'NO', via_view: 'NO', over_mv: 'NO' });
  });
});
