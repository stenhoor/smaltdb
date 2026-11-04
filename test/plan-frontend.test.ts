/** The SQL front end (ADR 0014, step 5a): SELECT statements to positional plans. */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { parseOne } from '../src/engine/sql/parser.js';
import type { SelectStmt } from '../src/engine/sql/ast.js';
import type { BindContext } from '../src/engine/plan/bind-context.js';
import { toPlan } from '../src/engine/sql/frontend/select.js';
import { printPlan } from '../src/engine/plan/print.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

async function setup(): Promise<{ db: Database; catalog: BindContext }> {
  const db = await Database.open(new MemoryVfs(), 'db');
  db.exec(`
    CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, s TEXT COLLATE NOCASE);
    CREATE TABLE u(x INT, y REAL);
    CREATE VIEW v AS SELECT a AS va, s FROM t WHERE a > 0;
    CREATE TABLE w(a INT, z TEXT);
  `);
  const catalog = (db as unknown as { bindContext(): BindContext }).bindContext();
  return { db, catalog };
}

const plan = (catalog: BindContext, sql: string) => {
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

  it('plans USING, NATURAL, RIGHT and FULL joins', async () => {
    const { catalog } = await setup();
    // USING hides the right side's copy of the column from * and from unqualified names.
    const p = plan(catalog, 'SELECT * FROM t JOIN w USING (a)');
    expect(p!.columns).toEqual(['id int INTEGER', 'a int INT', 's text TEXT nocase', 'z text TEXT']);
    expect(p!.text).toBe(['project #0.0, #0.1, #0.2, #0.4', '  join inner on sql.eq(#0.1, #1.0)', '    scan t [0, 1, 2]', '    scan w [0, 1, -1]'].join('\n'));
    expect(plan(catalog, 'SELECT z FROM t NATURAL JOIN w')!.text.split('\n')[1]).toBe('  join inner on sql.eq(#0.1, #1.0)');
    expect(plan(catalog, 'SELECT t.a, w.z FROM t FULL JOIN w ON w.a = t.a')!.text.split('\n')[1]).toBe('  join full on sql.eq(#1.0, #0.1)');
    expect(() => plan(catalog, 'SELECT * FROM t JOIN u USING (a)')).toThrow('cannot join using column a - column not present in both tables');
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

  it('plans windows, recursive CTEs, table functions and virtual tables', async () => {
    const { catalog } = await setup();
    // A window outputs its input's columns, then its calls.
    expect(plan(catalog, 'SELECT a, sum(a) OVER (PARTITION BY s ORDER BY id) FROM t')!.text).toBe(
      ['project #0.1, #0.3', '  window [sum(#0.1)] partition [#0.2] order [#0.0] RANGE unboundedPreceding..currentRow', '    scan t [0, 1, 2]'].join('\n'),
    );
    expect(plan(catalog, 'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3) SELECT i FROM n')!.text).toBe(
      ['project #0.0', '  iterate #0', '    project 1', '      values ()', '    project sql.add(#0.0, 1)', '      filter sql.lt(#0.0, 3)', '        working #0'].join('\n'),
    );
    // A table function's arguments may read the join's left input (a lateral source).
    expect(plan(catalog, 'SELECT t.id, p.name FROM t, pragma_table_info(t.s) p')!.text).toBe(
      ['project #0.0, #0.4', '  join cross', '    scan t [0, 1, 2]', '    function pragma_table_info(#0.2)'].join('\n'),
    );
    expect(plan(catalog, 'SELECT table_name FROM information_schema.tables')!.columns).toEqual(['table_name text']);
  });
});

// Plans are the contract between languages and the engine (ADR 0015 section 9): plain data, with no closures and no
// planner-internal nodes, so they can be sent to workers and built by other languages.
describe('plans are plain data', () => {
  const QUERIES = [
    'SELECT CURRENT_DATE, CURRENT_TIME, CURRENT_TIMESTAMP',
    "SELECT a, CURRENT_TIMESTAMP > '2000' FROM t WHERE s = 'x'",
    'SELECT t.a, u.y FROM t JOIN u ON u.x = t.a WHERE t.id < 5 ORDER BY 1',
    'SELECT a, count(*), sum(id) FROM t GROUP BY a HAVING count(*) > 1',
    'SELECT id, (SELECT max(y) FROM u WHERE u.x = t.a) FROM t',
    'SELECT id FROM t WHERE EXISTS (SELECT 1 FROM u WHERE u.x = t.a) AND a IN (SELECT x FROM u)',
    'SELECT a, rank() OVER (PARTITION BY s ORDER BY id) FROM t',
    'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5) SELECT i FROM n',
    'SELECT va FROM v UNION SELECT x FROM u',
  ];
  const offending = (o: unknown, seen = new Set<unknown>()): string[] => {
    if (typeof o === 'function') return ['function'];
    if (!o || typeof o !== 'object' || seen.has(o)) return [];
    seen.add(o);
    const k = (o as { k?: unknown }).k;
    if (k === 'slot' || k === 'native') return [String(k)];
    return Object.values(o).flatMap((v) => offending(v, seen));
  };
  it('carry no closures, registers or compiled parts', async () => {
    const { catalog } = await setup();
    for (const q of QUERIES) {
      const r = toPlan(parseOne(q).stmt as SelectStmt, q, catalog);
      expect(offending(r.plan), q).toEqual([]);
      expect(() => JSON.stringify(r.plan), q).not.toThrow();
    }
  });
  it('read the clock with a call', async () => {
    const { catalog } = await setup();
    expect(plan(catalog, 'SELECT CURRENT_DATE, CURRENT_TIMESTAMP')!.text).toBe('project sql.current_date(), sql.current_timestamp()\n  values ()');
  });
});
