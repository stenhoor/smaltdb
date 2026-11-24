/**
 * ORDER BY with a LIMIT over a join, read in order (planner.ts `orderedJoin`): a source whose rows come in the order
 * wanted first, through an access path that gives them so (a table scan by rowid, an index seek by the column after
 * its equalities), every other source by an index lookup per row, and no sort; the join stops at the LIMIT. That
 * source is the one the ORDER BY reads, or one with a column the plan's conditions make equal to the ordering column
 * (`equalColumns`): the other side of an equality between two plain columns, compared as they are stored, under the
 * ordering's collation. Used where it costs less than the join and a sort of all its rows.
 *
 * A plan from outside SQL often sorts a projection of its join (`project(sort(project(join)))`): the normalizer
 * composes the two projections (plan-normalize.ts `composed`), so the join is the block's FROM and the planner sees
 * the table the ORDER BY reads.
 *
 * What a test expects of the rows is worked out here, from the join read without an ORDER BY or a LIMIT (which this
 * path never plans) and sorted in the test.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';

const col = (index: number, type = 'int') => ({ k: 'col', input: 0, index, depth: 0, type, collation: 'binary' });
const eq = (a: object, b: object) => ({ k: 'call', fn: 'cmp_eq', args: [a, b], type: 'bool' });
const lit = (value: unknown, type: string) => ({ k: 'lit', value, type });

/** 3,000 nodes, every third labelled B, the rest A. `index`: the index of the labels' table. */
function graph(index = 'lab(label, id)', idType = 'INTEGER'): Database {
  const db = Database.openMemory();
  db.exec(`CREATE TABLE node(id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE lab(id ${idType}, label TEXT); CREATE INDEX lab_label ON ${index}`);
  db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) INSERT INTO node SELECT i, 'n' || i FROM n");
  db.exec("INSERT INTO lab SELECT id, CASE WHEN id % 3 = 0 THEN 'B' ELSE 'A' END FROM node");
  db.exec('ANALYZE');
  return db;
}

/**
 * The first `count` rows of `nodes` labelled `label` in `labels`, by id, as a plan builder writes it: the join
 * projected, sorted, projected. `second`: the type of the nodes' second column.
 */
function firstLabelled(label: string, count: number, nullsFirst = false, nodes = 'node', labels = 'lab', second = 'text'): PlanStatementInput {
  const join = { op: 'join', kind: 'cross', inputs: [{ op: 'scan', table: nodes, columns: [0, 1] }, { op: 'scan', table: labels, columns: [0, 1] }] };
  const filtered = { op: 'filter', input: join, pred: { k: 'and', args: [eq(col(2), col(0)), eq(col(3, 'text'), lit(label, 'text'))] } };
  const projected = { op: 'project', input: filtered, exprs: [col(0), col(1, second), col(0)] };
  const sorted = { op: 'sort', input: projected, keys: [{ expr: col(2), desc: false, nullsFirst, collation: 'binary' }] };
  const plan = { op: 'limit', count: lit(count, 'int'), input: { op: 'project', input: sorted, exprs: [col(0), col(1, second)] } };
  return { kind: 'query', plan, columns: [{ name: 'id', type: 'int' }, { name: 'name', type: second }] } as unknown as PlanStatementInput;
}

const explain = (db: Database, q: PlanStatementInput): string =>
  db.queryPlan({ kind: 'explain', mode: 'plan', query: q } as unknown as PlanStatementInput).rows.map((r) => r.join(' ')).join('\n');
const explainSql = (db: Database, sql: string): string => db.query(`EXPLAIN QUERY PLAN ${sql}`).rows.map((r) => r.join(' ')).join('\n');

/** The first `count` rows of an unordered read, sorted here by their first column: numbers by value, text by its code units. */
function first(db: Database, sql: string, count: number): unknown[][] {
  const rows = db.query(sql).rows as unknown[][];
  return rows.sort((a, b) => (a[0]! < b[0]! ? -1 : a[0]! > b[0]! ? 1 : 0)).slice(0, count);
}
const LABELLED = (label: string): string => `SELECT node.id, name FROM node JOIN lab ON lab.id = node.id WHERE label = '${label}'`;

describe('ORDER BY with a LIMIT over a join', () => {
  it('reads the ordering table in order, looks up the other per row, and sorts nothing', () => {
    // The labels' index has no order to give for one label: the nodes are scanned by id.
    const db = graph('lab(id, label)');
    const q = firstLabelled('B', 10);
    const plan = explain(db, q);
    expect(plan).not.toContain('ORDER BY');
    expect(plan).toContain('SCAN node');
    expect(plan).toContain('SEARCH lab USING COVERING INDEX lab_label');
    expect(db.queryPlan(q).rows).toEqual(first(db, LABELLED('B'), 10));
  });

  it('gives the same rows as a sort, at any LIMIT, for NULLS FIRST and LAST on the rowid', () => {
    for (const index of ['lab(id, label)', 'lab(label, id)']) {
      const db = graph(index);
      for (const [label, count] of [['A', 1], ['A', 500], ['B', 999], ['B', 1000], ['B', 5000], ['C', 10]] as const) {
        const rows = first(db, LABELLED(label), count);
        expect(db.queryPlan(firstLabelled(label, count)).rows, `${index} ${label} ${count}`).toEqual(rows);
        expect(db.queryPlan(firstLabelled(label, count, true)).rows, `${index} ${label} ${count} nulls first`).toEqual(rows);
        expect(db.query(`${LABELLED(label)} ORDER BY node.id LIMIT ${count}`).rows, `${index} ${label} ${count} SQL`).toEqual(rows);
      }
    }
  });

  it('sorts as before when the LIMIT reads most of the join', () => {
    for (const index of ['lab(id, label)', 'lab(label, id)']) expect(explain(graph(index), firstLabelled('A', 100000)), index).toContain('ORDER BY');
  });
});

describe('ORDER BY with a LIMIT, read through a column the join makes equal', () => {
  it("reads a label's ids in its index's order and looks up each node: no scan of the nodes, no sort", () => {
    const db = graph();
    const q = firstLabelled('B', 10);
    const plan = explain(db, q);
    expect(plan).not.toContain('ORDER BY');
    expect(plan).not.toContain('SCAN');
    expect(plan).toContain('SEARCH lab USING COVERING INDEX lab_label (=?)');
    expect(plan).toContain('SEARCH node USING INTEGER PRIMARY KEY (rowid=?)');
    // The labels come first: theirs is the order.
    expect(plan.indexOf('SEARCH lab')).toBeLessThan(plan.indexOf('SEARCH node'));
    expect(db.queryPlan(q).rows).toEqual(first(db, LABELLED('B'), 10));
    // SQL's ORDER BY node.id with the same join is planned the same way.
    const sql = `${LABELLED('B')} ORDER BY node.id LIMIT 10`;
    expect(explainSql(db, sql)).toContain('SEARCH lab USING COVERING INDEX lab_label (=?)');
    expect(explainSql(db, sql)).not.toContain('ORDER BY');
    expect(db.query(sql).rows).toEqual(first(db, LABELLED('B'), 10));
  });

  it('gives no row for an entry with NULL in the equal column, for NULLS FIRST and LAST', () => {
    const db = graph();
    db.exec("INSERT INTO lab VALUES (NULL, 'B'), (NULL, 'B'), (NULL, 'A')");
    for (const nullsFirst of [false, true]) {
      const q = firstLabelled('B', 7, nullsFirst);
      expect(explain(db, q)).toContain('SEARCH lab USING COVERING INDEX lab_label (=?)');
      expect(db.queryPlan(q).rows).toEqual([3, 6, 9, 12, 15, 18, 21].map((i) => [i, `n${i}`]));
    }
  });

  it('several rows of the ordering table for one entry stay in order', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE item(id INTEGER PRIMARY KEY, grp INTEGER); CREATE INDEX item_grp ON item(grp); CREATE TABLE pick(grp INTEGER, kind TEXT); CREATE INDEX pick_kind ON pick(kind, grp)');
    // 2,000 items in 500 groups of four; every fifth group is picked.
    db.exec('WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 1999) INSERT INTO item SELECT i, (i * 7) % 500 FROM n');
    db.exec("WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 499) INSERT INTO pick SELECT i, CASE WHEN i % 5 = 0 THEN 'k' ELSE 'o' END FROM n");
    db.exec('ANALYZE');
    const sql = "SELECT item.grp, item.id FROM item JOIN pick ON pick.grp = item.grp WHERE kind = 'k'";
    const plan = explainSql(db, `${sql} ORDER BY item.grp LIMIT 10`);
    expect(plan).not.toContain('ORDER BY');
    expect(plan.indexOf('SEARCH pick USING COVERING INDEX pick_kind (=?)')).toBeGreaterThanOrEqual(0);
    expect(plan.indexOf('SEARCH pick')).toBeLessThan(plan.indexOf('SEARCH item'));
    // The groups come in order; which of a group's four items come first is not told.
    const rows = db.query(`${sql} ORDER BY item.grp LIMIT 10`).rows as number[][];
    expect(rows.map((r) => r[0])).toEqual([0, 0, 0, 0, 5, 5, 5, 5, 10, 10]);
    for (const [grp, id] of rows) expect((id! * 7) % 500).toBe(grp);
    expect(new Set(rows.map((r) => r[1])).size).toBe(10);
  });

  it('reads a text column the join makes equal, under one collation', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE a(id INTEGER PRIMARY KEY, name TEXT); CREATE UNIQUE INDEX a_name ON a(name); CREATE TABLE b(name TEXT, kind TEXT); CREATE INDEX b_kind ON b(kind, name)');
    // Names whose order as text is not the order of the numbers in them.
    db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) INSERT INTO a SELECT i, 'n' || i FROM n");
    db.exec("INSERT INTO b SELECT name, CASE WHEN id % 3 = 0 THEN 'k' ELSE 'o' END FROM a");
    db.exec('ANALYZE');
    const sql = "SELECT a.name, a.id FROM a JOIN b ON b.name = a.name WHERE kind = 'k'";
    const plan = explainSql(db, `${sql} ORDER BY a.name LIMIT 8`);
    expect(plan).not.toContain('ORDER BY');
    expect(plan.indexOf('SEARCH b USING COVERING INDEX b_kind (=?)')).toBeGreaterThanOrEqual(0);
    expect(plan.indexOf('SEARCH b')).toBeLessThan(plan.indexOf('SEARCH a'));
    expect(db.query(`${sql} ORDER BY a.name LIMIT 8`).rows).toEqual(first(db, sql, 8));
    expect(first(db, sql, 3).map((r) => r[0])).toEqual(['n1002', 'n1005', 'n1008']);
  });

  it('does not read a column the comparison converts: text is not in the order of the numbers it is compared as', () => {
    const db = graph('lab(label, id)', 'TEXT');
    expect(db.query("SELECT typeof(id) FROM lab LIMIT 1").rows).toEqual([['text']]);
    // With a unary plus the labels' column has no affinity, and the comparison reads a number out of it too.
    for (const on of ['lab.id = node.id', 'node.id = lab.id', '+lab.id = node.id']) {
      const sql = `SELECT node.id, name FROM node JOIN lab ON ${on} WHERE label = 'B'`;
      // By the text of the ids the first would be 1002.
      expect(db.query(`${sql} ORDER BY node.id LIMIT 5`).rows, on).toEqual([3, 6, 9, 12, 15].map((i) => [i, `n${i}`]));
      const plan = explainSql(db, `${sql} ORDER BY node.id LIMIT 5`);
      expect(plan.includes('ORDER BY') || plan.indexOf('node') < plan.indexOf('lab'), `${on}\n${plan}`).toBe(true);
    }
    // A plan that compares the two columns as they are stored (text with a number) gives no row, and reads the nodes
    // in their order to find that out: the labels' index is not its order either.
    expect(explain(db, firstLabelled('B', 5))).toContain('SCAN node');
    expect(db.queryPlan(firstLabelled('B', 5)).rows).toEqual([]);
  });

  it("does not read a column in another collation's order", () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE a(id INTEGER PRIMARY KEY, name TEXT); CREATE UNIQUE INDEX a_name ON a(name); CREATE TABLE b(name TEXT COLLATE NOCASE, kind TEXT); CREATE INDEX b_kind ON b(kind, name)');
    // Every other name starts with a capital: as bytes the capitals come first, without case they alternate.
    db.exec("WITH RECURSIVE n(i) AS (SELECT 1000 UNION ALL SELECT i + 1 FROM n WHERE i < 3999) INSERT INTO a SELECT i, CASE WHEN i % 2 = 0 THEN 'n' ELSE 'N' END || i FROM n");
    db.exec("INSERT INTO b SELECT name, CASE WHEN id % 3 = 0 THEN 'k' ELSE 'o' END FROM a");
    db.exec('ANALYZE');
    // The comparison is a's, by bytes, and so is the ORDER BY: b's index is in another order.
    const bytes = "SELECT a.name, a.id FROM a JOIN b ON a.name = b.name WHERE kind = 'k'";
    expect(db.query(`${bytes} ORDER BY a.name LIMIT 8`).rows).toEqual(first(db, bytes, 8));
    expect(first(db, bytes, 3).map((r) => r[0])).toEqual(['N1005', 'N1011', 'N1017']);
    // The comparison is b's, without case: not the ORDER BY's collation.
    const noCase = "SELECT a.name, a.id FROM a JOIN b ON b.name = a.name WHERE kind = 'k'";
    expect(db.query(`${noCase} ORDER BY a.name LIMIT 8`).rows).toEqual(first(db, noCase, 8));
    for (const sql of [bytes, noCase]) {
      const plan = explainSql(db, `${sql} ORDER BY a.name LIMIT 8`);
      expect(plan.includes('ORDER BY') || plan.indexOf(' a ') < plan.indexOf(' b '), plan).toBe(true);
    }
  });

  it('does not read a column compared under another collation, though its index is in the order wanted', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE a(id INTEGER PRIMARY KEY, name TEXT); CREATE UNIQUE INDEX a_name ON a(name); CREATE TABLE b(name TEXT COLLATE NOCASE, kind TEXT); CREATE INDEX b_kind ON b(kind, name COLLATE BINARY)');
    // b has a's names in the other case: without case each has its one match, and by bytes the two are in different orders.
    db.exec("WITH RECURSIVE n(i) AS (SELECT 1000 UNION ALL SELECT i + 1 FROM n WHERE i < 3999) INSERT INTO a SELECT i, CASE WHEN i % 2 = 0 THEN 'n' ELSE 'N' END || i FROM n");
    db.exec("INSERT INTO b SELECT CASE WHEN id % 2 = 0 THEN 'N' ELSE 'n' END || id, CASE WHEN id % 3 = 0 THEN 'k' ELSE 'o' END FROM a");
    db.exec('ANALYZE');
    const sql = "SELECT a.name, a.id FROM a JOIN b ON b.name = a.name WHERE kind = 'k'";
    expect(db.query(sql).rows.length).toBe(1000);
    expect(db.query(`${sql} ORDER BY a.name LIMIT 8`).rows).toEqual(first(db, sql, 8));
    // The first of a by bytes are its capitals; b's index starts with b's capitals, which are a's other names.
    expect(first(db, sql, 3).map((r) => r[0])).toEqual(['N1005', 'N1011', 'N1017']);
    const plan = explainSql(db, `${sql} ORDER BY a.name LIMIT 8`);
    expect(plan.includes('ORDER BY') || plan.indexOf(' a ') < plan.indexOf(' b '), plan).toBe(true);
  });

  it("an outer join's conditions make no column equal: its rows are read as before", () => {
    const db = graph();
    const sql = "SELECT node.id, name FROM node LEFT JOIN lab ON lab.id = node.id AND label = 'B' ORDER BY node.id LIMIT 5";
    expect(explainSql(db, sql)).not.toContain('SEARCH lab USING COVERING INDEX lab_label (=?)');
    expect(db.query(sql).rows).toEqual([1, 2, 3, 4, 5].map((i) => [i, `n${i}`]));
  });
});

const M = 'map<text, any>';
const schema = (db: Database, op: Record<string, unknown>): void => void db.queryPlan({ kind: 'schema', op } as unknown as PlanStatementInput);
const column = (name: string, type: string, declaredType = type) => ({ name, declaredType, type, notNull: false, collation: 'binary' });

/** An empty graph `g` in memory, nodes in `node(id, props)` with a label index, whose writes are left ahead of its tables between statements. */
function propertyGraph(): Database {
  const db = Database.openMemory();
  const key = [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], ofColumn: 0 }];
  schema(db, { op: 'createTable', table: { name: 'node', columns: [column('id', 'INTEGER'), column('props', 'MAP', M)], keys: key, checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false });
  schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'g', nodes: [{ label: 'Node', table: 'node', id: 'id', props: 'props' }], edges: [] } });
  schema(db, { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabelIndex' } });
  for (const label of ['Person', 'City']) schema(db, { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabel', label, table: `l_${label.toLowerCase()}` } });
  db.graphChecks = false;
  return db;
}

describe("the first nodes of a label, in a graph whose tables are behind its index", () => {
  const numbers = (n: number): PlanOp => p.values(Array.from({ length: n }, (_, i) => [p.lit(i)]), ['int']);
  const map = (...entries: (string | PlanExpr)[]): PlanExpr => p.call('map_of', entries.map((e) => (typeof e === 'string' ? p.lit(e) : e)), M);
  const write = (db: Database, plan: PlanOp) => db.queryPlan({ kind: 'write', plan } as PlanStatementInput);
  const firstPeople = (count: number) => firstLabelled('Person', count, false, 'node', 'g_labels', M);

  it('are read from the index in the order of their ids: the node table is not read, and nothing is written to it', () => {
    const db = propertyGraph();
    // 600 nodes: Person, City, Person, City and so on.
    write(db, p.graphCreate('g', numbers(300), [{ labels: ['Person'], props: map('i', p.col(0, 0, 'int')) }, { labels: ['City'] }]));
    const pending = db.graphPendingState;
    expect([pending.count > 0, pending.settles]).toEqual([true, 0]);
    const ahead = pending.count;
    const plan = explain(db, firstPeople(5));
    expect(plan).not.toContain('ORDER BY');
    expect(plan).not.toContain('SCAN');
    expect(plan).toContain('SEARCH g_labels USING GRAPH INDEX (label=?)');
    expect(plan).toContain('SEARCH node USING GRAPH INDEX (rowid=?)');
    expect(db.queryPlan(firstPeople(5)).rows).toEqual([0, 2, 4, 6, 8].map((id) => [id, { i: id / 2 }]));
    expect([pending.count, pending.settles]).toEqual([ahead, 0]);
    // The same statement again, after more writes: still from the index, with what was written.
    write(db, p.graphDelete('g', p.values([[p.lit(2)], [p.lit(4)]], ['int']), [{ node: p.col(0, 0, 'int') }], { detach: true }));
    write(db, p.graphCreate('g', numbers(1), [{ labels: ['Person'], props: map('new', p.lit(1)) }]));
    expect(db.queryPlan(firstPeople(5)).rows).toEqual([[0, { i: 0 }], [6, { i: 3 }], [8, { i: 4 }], [10, { i: 5 }], [12, { i: 6 }]]);
    expect(db.queryPlan(firstPeople(1000)).rows.length).toBe(299);
    expect(db.queryPlan(firstPeople(1000)).rows.at(-1)).toEqual([600, { new: 1 }]);
    expect(pending.settles).toBe(0);
    // With the tables brought up to date the rows are the same.
    expect(db.query('SELECT count(*) FROM node').rows).toEqual([[599]]);
    expect(pending.settles).toBe(1);
    expect(db.queryPlan(firstPeople(5)).rows).toEqual([[0, { i: 0 }], [6, { i: 3 }], [8, { i: 4 }], [10, { i: 5 }], [12, { i: 6 }]]);
    db.graphIndexState.check();
  });
});
