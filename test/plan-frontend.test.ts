/** The SQL front end (ADR 0014, step 5a): SELECT statements to positional plans. */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { parseOne } from '../src/engine/sql/parser.js';
import type { SelectStmt } from '../src/engine/sql/ast.js';
import { type FrontEndCatalog, toPlan } from '../src/engine/sql/frontend/select.js';
import { printPlan } from '../src/engine/plan/print.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

async function setup(): Promise<{ db: Database; catalog: FrontEndCatalog }> {
  const db = await Database.open(new MemoryVfs(), 'db');
  db.exec(`
    CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, s TEXT COLLATE NOCASE);
    CREATE TABLE u(x INT, y REAL);
    CREATE VIEW v AS SELECT a AS va, s FROM t WHERE a > 0;
  `);
  const catalog = (db as unknown as { frontEndCatalog(): FrontEndCatalog }).frontEndCatalog();
  return { db, catalog };
}

const plan = (catalog: FrontEndCatalog, sql: string) => {
  const r = toPlan(parseOne(sql).stmt as SelectStmt, sql, catalog);
  return r && { text: printPlan(r.plan), columns: r.columns.map((c) => `${c.name} ${c.type}${c.declType ? ` ${c.declType}` : ''}${c.collation ? ' nocase' : ''}`) };
};

describe('SQL front end', () => {
  it('references columns by position and makes SQL rules explicit', async () => {
    const { catalog } = await setup();
    const p = plan(catalog, "SELECT s, a + 1 AS b FROM t WHERE s = 'x' ORDER BY b LIMIT 2");
    expect(p!.columns).toEqual(['s text TEXT nocase', 'b int']);
    expect(p!.text).toBe(
      [
        'limit 2',
        '  sort #0.1',
        '    project #0.2, sql.add(#0.1, 1)',
        "      filter sql.eq(#0.2, sql.affinity_text('x'))[nocase]",
        '        scan t [0, 1, 2]',
      ].join('\n'),
    );
  });

  it('plans joins with their inputs, and rowids', async () => {
    const { catalog } = await setup();
    // u has no INTEGER PRIMARY KEY: its rowid is the position after its columns.
    expect(plan(catalog, 'SELECT t.a, u.rowid FROM t LEFT JOIN u ON u.x = t.a')!.text).toBe(
      ['project #0.1, #0.5', '  join left on sql.eq(#1.0, #0.1)', '    scan t [0, 1, 2]', '    scan u [0, 1, -1]'].join('\n'),
    );
  });

  it('carries bare columns through the aggregate', async () => {
    const { catalog } = await setup();
    expect(plan(catalog, 'SELECT a, s, max(id) FROM t GROUP BY a HAVING count(*) > 1')!.text).toBe(
      ['project #0.0, #0.3, #0.1', '  filter sql.gt(#0.2, 1)', '    aggregate keys [#0.1] aggs [max(#0.0), count(*)] carry [#0.2]', '      scan t [0, 1, 2]'].join('\n'),
    );
  });

  it('plans views, derived tables and subqueries as nested plans', async () => {
    const { catalog } = await setup();
    const p = plan(catalog, 'SELECT va, (SELECT max(y) FROM u WHERE u.x = va) AS m FROM v');
    expect(p!.columns).toEqual(['va int INT', 'm real']);
    expect(p!.text).toBe(['project #0.0, scalar(<project>)', '  project #0.1, #0.2', '    filter sql.gt(#0.1, sql.affinity_numeric(0))', '      scan t [0, 1, 2]'].join('\n'));
  });

  it('raises the planner\'s errors', async () => {
    const { catalog } = await setup();
    expect(() => plan(catalog, 'SELECT nope FROM t')).toThrow('no such column: nope');
    expect(() => plan(catalog, 'SELECT a FROM t, t')).toThrow('ambiguous table name: t');
    expect(() => plan(catalog, 'SELECT sum(sum(a)) FROM t')).toThrow('misuse of aggregate function sum()');
    expect(() => plan(catalog, 'SELECT a FROM t UNION SELECT a, s FROM t')).toThrow('do not have the same number of result columns');
  });

  it('returns null for shapes it does not handle yet', async () => {
    const { catalog } = await setup();
    for (const sql of [
      'SELECT a, row_number() OVER (ORDER BY a) FROM t',
      'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT i FROM n',
      "SELECT * FROM pragma_table_info('t')",
      'SELECT * FROM t JOIN u USING (id)',
      'SELECT * FROM t RIGHT JOIN u ON u.x = t.a',
    ]) {
      expect(plan(catalog, sql), sql).toBeNull();
    }
  });
});
