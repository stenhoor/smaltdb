/**
 * Materialized-view matching beyond the top-level SELECT (docs/research/m7-code-review.md, follow-up
 * features): subqueries, derived tables, CTE bodies, view bodies, compound branches and
 * INSERT … SELECT. Each query must return what it returns with matching off; a spy on the
 * database's matcher records which views were used.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { SelectStmt } from '../src/engine/sql/ast.js';

async function setup() {
  const db = await Database.open(new MemoryVfs(), 'db');
  db.exec(`
    CREATE TABLE t(id INTEGER PRIMARY KEY, s TEXT COLLATE NOCASE, g INT, x INT);
    CREATE TABLE o(id INTEGER PRIMARY KEY, s TEXT, g INT, w INT);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 400)
      INSERT INTO t SELECT i, char(97 + i % 5), i % 7, i % 13 FROM n;
    INSERT INTO o VALUES (1, 'A', 1, 3), (2, 'b', 2, 0), (3, 'Z', 9, 6), (4, NULL, NULL, NULL);
    CREATE MATERIALIZED VIEW ma AS SELECT g, sum(x) AS sx, count(*) AS n, min(x) AS lo FROM t GROUP BY g;
    CREATE MATERIALIZED VIEW mp AS SELECT id, s, g, x FROM t;
  `);
  // Which views answered the SELECTs planned since the last reset.
  const used: string[] = [];
  const d = db as unknown as { matviewRewrite: (s: SelectStmt, text: string, exclude?: string | null) => SelectStmt | null };
  const real = d.matviewRewrite.bind(db);
  d.matviewRewrite = (s, text, exclude) => {
    const r = real(s, text, exclude);
    if (r) {
      const from = r.core.kind === 'select' ? r.core.from : undefined;
      used.push(from?.kind === 'table' ? from.name : from?.kind === 'subquery' && from.select.core.kind === 'select' && from.select.core.from?.kind === 'table' ? from.select.core.from.name : '?');
    }
    return r;
  };
  return { db, used };
}

const canon = (rows: unknown[][], ordered: boolean) => (ordered ? rows : [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)));

/** Rows of `sql` with matching on (and which views it used), checked against matching off. */
function compare(db: Database, used: string[], sql: string): string[] {
  db.exec('PRAGMA matview_rewrite = 0');
  const want = db.query(sql).rows;
  db.exec('PRAGMA matview_rewrite = 1');
  used.length = 0;
  const got = db.query(sql).rows;
  const ordered = /ORDER BY/i.test(sql);
  expect(canon(got, ordered), sql).toEqual(canon(want, ordered));
  // Each view once.
  return [...new Set(used)];
}

describe('materialized views answer nested SELECTs', () => {
  const REWRITTEN: [string, string][] = [
    ['derived table', 'SELECT o.id, d.sx FROM o JOIN (SELECT g, sum(x) AS sx FROM t GROUP BY g) d ON d.g = o.g ORDER BY o.id'],
    ['derived table, no alias names', 'SELECT * FROM (SELECT g, count(*), min(x) FROM t GROUP BY g) ORDER BY 1'],
    ['two levels of derived tables', 'SELECT * FROM (SELECT * FROM (SELECT g, sum(x) AS sx FROM t WHERE g > 2 GROUP BY g)) ORDER BY g'],
    ['IN subquery (projection view)', 'SELECT id FROM o WHERE g IN (SELECT g FROM t WHERE x > 11)'],
    ['NOT IN subquery', 'SELECT id FROM o WHERE g NOT IN (SELECT g FROM t WHERE x = 12)'],
    ['uncorrelated scalar subquery', 'SELECT id, (SELECT sum(x) FROM t) AS total FROM o'],
    ['scalar subquery in WHERE', 'SELECT id FROM o WHERE w < (SELECT min(x) + 4 FROM t)'],
    ['uncorrelated EXISTS', 'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM t WHERE x = 12)'],
    ['CTE body', 'WITH c AS (SELECT g, sum(x) AS sx FROM t GROUP BY g) SELECT * FROM c WHERE sx > 100 ORDER BY g'],
    ['CTE used twice', 'WITH c AS (SELECT g, count(*) AS n FROM t GROUP BY g) SELECT a.g, b.n FROM c a JOIN c b ON a.g = b.g ORDER BY 1'],
    ['UNION branches', 'SELECT g, sum(x) FROM t GROUP BY g UNION ALL SELECT g, count(*) FROM t GROUP BY g ORDER BY 1, 2'],
    ['subquery in HAVING', 'SELECT g, count(*) FROM o GROUP BY g HAVING count(*) <= (SELECT count(*) FROM t WHERE g = 3)'],
  ];
  for (const [what, sql] of REWRITTEN) {
    it(`${what}`, async () => {
      const { db, used } = await setup();
      expect(compare(db, used, sql).length, sql).toBeGreaterThan(0);
    });
  }

  it('correlated scalar aggregate, decorrelated into a GROUP BY (results only with SMALT_NO_DECORRELATE)', async () => {
    const { db, used } = await setup();
    const views = compare(db, used, 'SELECT id, (SELECT sum(x) FROM t WHERE t.g = o.g) FROM o');
    // Without decorrelation the subquery reads the outer row: it must not use the view.
    if (process.env.SMALT_NO_DECORRELATE) expect(views).toEqual([]);
    else expect(views.length).toBeGreaterThan(0);
  });

  it('view bodies, with result names from the view\'s own text', async () => {
    const { db, used } = await setup();
    db.exec('CREATE VIEW v AS SELECT g, sum(x), count(*) AS n FROM t GROUP BY g');
    expect(compare(db, used, 'SELECT * FROM v ORDER BY g')).toEqual(['ma']);
    expect(db.query('SELECT * FROM v').columns).toEqual(['g', 'sum(x)', 'n']);
    expect(compare(db, used, 'SELECT o.id, v.n FROM o JOIN v ON v.g = o.g ORDER BY o.id')).toEqual(['ma']);
  });

  it('INSERT … SELECT into another table', async () => {
    const { db, used } = await setup();
    db.exec('CREATE TABLE r1(g INT, sx INT); CREATE TABLE r2(g INT, sx INT)');
    db.exec('PRAGMA matview_rewrite = 0; INSERT INTO r1 SELECT g, sum(x) FROM t GROUP BY g');
    db.exec('PRAGMA matview_rewrite = 1');
    used.length = 0;
    db.exec('INSERT INTO r2 SELECT g, sum(x) FROM t GROUP BY g');
    // Shadow mode plans the INSERT with both planners.
    expect([...new Set(used)]).toEqual(['ma']);
    expect(db.query('SELECT * FROM r2 ORDER BY g').rows).toEqual(db.query('SELECT * FROM r1 ORDER BY g').rows);
  });
});

describe('… but not where a view could give a different answer', () => {
  const NOT_REWRITTEN: [string, string][] = [
    ['correlated (not decorrelated): outer column qualified', 'SELECT id, (SELECT sum(x) FROM t WHERE t.g < o.g) FROM o'],
    ['correlated: outer column unqualified', 'SELECT id, (SELECT count(*) FROM t WHERE x < w) FROM o'],
    ['correlated EXISTS', 'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM t WHERE t.x > o.w AND t.g = 3)'],
    ['a CTE named like the base table', 'WITH t AS (SELECT 1 AS g, 100 AS x) SELECT id FROM o WHERE g IN (SELECT g FROM t)'],
  ];
  for (const [what, sql] of NOT_REWRITTEN) {
    it(`${what}`, async () => {
      const { db, used } = await setup();
      expect(compare(db, used, sql), sql).toEqual([]);
    });
  }

  it('INSERT … SELECT into a base table of the view', async () => {
    const { db, used } = await setup();
    const want = db.query('SELECT g + 100, sum(x) FROM t GROUP BY g ORDER BY g').rows;
    db.exec('PRAGMA matview_rewrite = 1');
    used.length = 0;
    db.exec("INSERT INTO t(s, g, x) SELECT 'q', g + 100, sum(x) FROM t GROUP BY g");
    expect(used).toEqual([]);
    expect(db.query('SELECT g, x FROM t WHERE g >= 100 ORDER BY g').rows).toEqual(want);
  });

  it('UPDATE and DELETE', async () => {
    const { db, used } = await setup();
    const total = db.query('SELECT sum(x) FROM t').rows[0][0];
    const kept = db.query('SELECT id FROM o WHERE g IS NULL OR g NOT IN (SELECT g FROM t WHERE x = 12) ORDER BY id').rows;
    db.exec('PRAGMA matview_rewrite = 1');
    used.length = 0;
    db.exec('UPDATE o SET w = (SELECT sum(x) FROM t) WHERE id = 3');
    expect(db.query('SELECT w FROM o WHERE id = 3').rows).toEqual([[total]]);
    db.exec('DELETE FROM o WHERE g IN (SELECT g FROM t WHERE x = 12)');
    expect(used).toEqual([]);
    expect(db.query('SELECT id FROM o ORDER BY id').rows).toEqual(kept);
  });

  it('stale views', async () => {
    const { db, used } = await setup();
    db.exec('UPDATE t SET x = x + 1 WHERE id = 1');
    expect(compare(db, used, 'SELECT o.id, d.sx FROM o JOIN (SELECT g, sum(x) AS sx FROM t GROUP BY g) d ON d.g = o.g ORDER BY o.id')).toEqual([]);
    db.exec('REFRESH MATERIALIZED VIEW ma');
    expect(compare(db, used, 'SELECT o.id, d.sx FROM o JOIN (SELECT g, sum(x) AS sx FROM t GROUP BY g) d ON d.g = o.g ORDER BY o.id')).toEqual(['ma']);
  });
});
