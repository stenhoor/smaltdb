/**
 * A graph's writes that land in its index first, its tables written behind (ADR 0042, section 2;
 * exec/graph-pending.ts): in a database in memory, a plan that writes a graph changes the graph's index, and the
 * tables are brought up to date before anything reads one of them from a B+tree.
 *
 * Every test's database has `graphChecks` off where it leaves rows ahead of the tables: with it on (as in every other
 * test, `test/setup-sql.ts`) each statement that writes ends by writing the tables and comparing the index with them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as client from '../src/client/index.js';
import { Database, type DatabaseOptions } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import { EngineServer } from '../src/engine/server.js';
import { PENDING_READ } from '../src/engine/exec/graph-pending.js';
import type { Request, Response } from '../src/shared/protocol.js';

const M = 'map<text, any>';
const schema = (db: Database, op: Record<string, unknown>): void => void db.queryPlan({ kind: 'schema', op } as unknown as PlanStatementInput);
const column = (name: string, type: string, declaredType = type) => ({ name, declaredType, type, notNull: false, collation: 'binary' });

/** What makes an empty graph `g`: nodes in `node(id, props)`, the label index, the labels Person and City, the types KNOWS and LIKES. */
function graphSchema(options: { history?: 'versions' | 'log' } = {}): Record<string, unknown>[] {
  const key = [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], ofColumn: 0 }];
  return [
    { op: 'createTable', table: { name: 'node', columns: [column('id', 'INTEGER'), column('props', 'MAP', M)], keys: key, checks: [], foreignKeys: [], storage: 'row', ...options }, temp: false, ifNotExists: false },
    { op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'g', nodes: [{ label: 'Node', table: 'node', id: 'id', props: 'props' }], edges: [], ...options } },
    { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabelIndex' } },
    { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabel', label: 'Person', table: 'l_person' } },
    { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabel', label: 'City', table: 'l_city' } },
    { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addType', type: 'KNOWS', table: 'knows' } },
    { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addType', type: 'LIKES', table: 'likes' } },
  ];
}

/** A graph whose writes land in its index, left ahead of its tables between statements. */
function graph(options: DatabaseOptions = {}, more: { history?: 'versions' | 'log' } = {}): Database {
  const db = Database.openMemory(options);
  for (const op of graphSchema(more)) schema(db, op);
  db.graphChecks = false;
  return db;
}

const write = (db: Database, plan: PlanOp, params: unknown[] = []) => db.queryPlan({ kind: 'write', plan } as PlanStatementInput, params as never);
const read = (db: Database, plan: PlanOp, params: unknown[] = []) => db.queryPlan({ kind: 'query', plan } as PlanStatementInput, params as never).rows;
const one = p.values([[]], []);
const numbers = (n: number, from = 0): PlanOp => p.values(Array.from({ length: n }, (_, i) => [p.lit(from + i)]), ['int']);
const map = (...entries: (string | PlanExpr)[]): PlanExpr => p.call('map_of', entries.map((e) => (typeof e === 'string' ? p.lit(e) : e)), M);
const eq = (a: PlanExpr, b: PlanExpr): PlanExpr => p.call('cmp_eq', [a, b], 'bool');
const id = p.col(0, 0, 'int');

// Reads of the graph's tables from their B+trees: each brings the tables up to date.
const nodes = (db: Database): unknown[][] => db.query('SELECT id, props FROM node ORDER BY id').rows;
const labels = (db: Database): unknown[][] => db.query('SELECT node, label FROM g_labels ORDER BY node, label').rows;
const rels = (db: Database, table: string): unknown[][] => db.query(`SELECT rowid, start, "end", props FROM ${table} ORDER BY rowid`).rows;
const tables = (db: Database) => ({ nodes: nodes(db), labels: labels(db), knows: rels(db, 'knows'), likes: rels(db, 'likes') });

// Reads through the graph's index: a node's props by its id, and the relationships at a node.
const propsOf = (db: Database, node: number): unknown[][] => read(db, p.project(p.filter(p.scan('node', [0, 1]), eq(id, p.param(0, 'int'))), [p.col(0, 1, M)]), [node]);
const at = (db: Database, node: number): unknown[][] =>
  read(db, p.project(p.filter({ op: 'relationships', graph: 'g', direction: 'both' } as PlanOp, eq(id, p.param(0, 'int'))), [p.col(0, 1, 'int'), p.col(0, 2, 'text'), p.col(0, 3, 'int'), p.col(0, 5, M)]), [node]);

const pending = (db: Database) => db.graphPendingState;

/** An index on a key of the nodes' properties, as a language for graphs makes one. */
const nameOf = p.call('map_get', [p.col(0, 1, M), p.lit('name')], 'any');
const indexOnName = (db: Database, unique: boolean): void =>
  schema(db, { op: 'createIndex', index: { name: 'node_name', table: 'node', unique, columns: [{ column: -1, expr: { text: "map_get(props, 'name')", expr: nameOf }, desc: false, collation: 'binary' }] }, ifNotExists: false });

describe('where the writes land', () => {
  it('in the index: the tables are written when a statement reads one of them from its B+tree', () => {
    const db = graph();
    const made = write(db, p.graphCreate('g', numbers(3), [{ labels: ['Person'], props: map('i', id) }]));
    expect(made.rows).toEqual([[0, 0], [1, 1], [2, 2]]);
    // Three nodes and three label entries, in the index alone.
    expect([pending(db).count, pending(db).settles]).toEqual([6, 0]);
    write(db, p.graphCreate('g', one, [], [{ type: 'KNOWS', start: { id: p.lit(0) }, end: { id: p.lit(1) }, props: map('since', p.lit(2020)) }]));
    expect(pending(db).count).toBe(7);
    // A node's props by its id are read from the index: nothing is written.
    expect(propsOf(db, 1)).toEqual([[{ i: 1 }]]);
    expect([pending(db).count, pending(db).settles]).toEqual([7, 0]);
    // A scan of the node table: every table is brought up to date, once.
    expect(nodes(db)).toEqual([[0, { i: 0 }], [1, { i: 1 }], [2, { i: 2 }]]);
    expect([pending(db).count, pending(db).settles, pending(db).written]).toEqual([0, 1, 7]);
    expect(labels(db)).toEqual([[0, 'Person'], [1, 'Person'], [2, 'Person']]);
    expect(rels(db, 'knows')).toEqual([[0, 0, 1, { since: 2020 }]]);
    expect(pending(db).settles).toBe(1);
    db.graphIndexState.check();
  });

  it('what is read through the index needs no table: a node by its id, the relationships at a node', () => {
    const db = graph();
    // Enough of a graph that a plan reads a node's relationships at the node, where it would scan a few of them all.
    write(db, p.graphCreate('g', numbers(300), [{ labels: ['Person'], props: map('i', id) }, { labels: [] }], [{ type: 'KNOWS', start: { node: 0 }, end: { node: 1 }, props: map('n', id) }]));
    write(db, p.graphCreate('g', one, [], [{ type: 'LIKES', start: { id: p.lit(0) }, end: { id: p.lit(3) } }]));
    expect(pending(db).count).toBe(300 * 4 + 1);
    expect(propsOf(db, 598)).toEqual([[{ i: 299 }]]);
    expect(at(db, 0)).toEqual([[1, 'KNOWS', 0, { n: 0 }], [3, 'LIKES', 300, {}]]);
    expect(at(db, 3)).toEqual([[2, 'KNOWS', 1, { n: 1 }], [0, 'LIKES', 300, {}]]);
    write(db, p.graphDelete('g', one, [{ relationship: { type: p.lit('LIKES'), id: p.lit(300) } }, { node: p.lit(599) }], { detach: true }));
    expect([at(db, 3), at(db, 598), propsOf(db, 599)]).toEqual([[[2, 'KNOWS', 1, { n: 1 }]], [], []]);
    expect(pending(db).settles).toBe(0);
    expect([db.query('SELECT count(*) FROM node').rows, db.query('SELECT count(*) FROM knows').rows, rels(db, 'likes')]).toEqual([[[599]], [[299]], []]);
    expect(pending(db).settles).toBe(1);
    db.graphIndexState.check();
  });

  it('a statement that read a table once has the tables written before it runs the next time', () => {
    const db = graph();
    const scan = db.prepare('SELECT count(*) FROM node');
    write(db, p.graphCreate('g', numbers(2), [{ labels: [] }]));
    expect(scan.all()).toEqual([[2]]);
    write(db, p.graphCreate('g', numbers(2), [{ labels: [] }]));
    expect(pending(db).count).toBe(2);
    expect(scan.all()).toEqual([[4]]);
    expect([pending(db).count, pending(db).settles]).toEqual([0, 2]);
  });

  it('a row made and deleted before a table is read is never written; a row of the table is deleted behind', () => {
    const db = graph();
    write(db, p.graphCreate('g', numbers(2), [{ labels: ['Person'], props: map('i', id) }], [{ type: 'KNOWS', start: { node: 0 }, end: { node: 0 } }]));
    expect(nodes(db).length).toBe(2);
    // Two more, with a relationship between them; then one of the first two and one of the new ones go.
    write(db, p.graphCreate('g', one, [{ labels: ['City'] }, { labels: ['City'] }], [{ type: 'LIKES', start: { node: 0 }, end: { node: 1 } }]));
    const gone = write(db, p.graphDelete('g', p.values([[p.lit(0)], [p.lit(2)]], ['int']), [{ node: id }], { detach: true }));
    expect(gone.graph).toMatchObject({ nodesDeleted: 2, relationshipsDeleted: 2 });
    expect(pending(db).settles).toBe(1);
    // Through the index: the nodes are gone, the others are there.
    expect([propsOf(db, 0), propsOf(db, 2), propsOf(db, 1), propsOf(db, 3)]).toEqual([[], [], [[{ i: 1 }]], [[{}]]]);
    // A relationship from a node to itself is given once.
    expect([at(db, 1), at(db, 3)]).toEqual([[[1, 'KNOWS', 1, {}]], []]);
    expect(tables(db)).toEqual({ nodes: [[1, { i: 1 }], [3, {}]], labels: [[1, 'Person'], [3, 'City']], knows: [[1, 1, 1, {}]], likes: [] });
    db.graphIndexState.check();
    // An id is not given again.
    expect(write(db, p.graphCreate('g', one, [{ labels: [] }])).rows).toEqual([[4]]);
  });

  it('a relationship deleted before its table is written is not read from the table by its rowid', () => {
    const db = graph();
    // Enough relationships that one is read by its rowid where a few would be scanned.
    write(db, p.graphCreate('g', numbers(300), [{ labels: ['Person'] }, { labels: [] }], [{ type: 'KNOWS', start: { node: 0 }, end: { node: 1 }, props: map('n', id) }]));
    expect(rels(db, 'knows').length).toBe(300);
    // A relationship's props by its rowid: from the index, or from the table for the index.
    const byRowid = p.project(p.filter(p.scan('knows', [-1, 2]), eq(id, p.param(0, 'int'))), [p.col(0, 1, M)]);
    const explained = db.queryPlan({ kind: 'explain', mode: 'plan', query: { kind: 'query', plan: byRowid } } as unknown as PlanStatementInput, [7] as never).rows.flat().join(' ');
    expect(explained).toContain('SEARCH knows USING GRAPH INDEX (rowid=?)');
    const propsOfKnows = (rowid: number): unknown[][] => read(db, byRowid, [rowid]);
    const settles = pending(db).settles;
    // One the index has not read from its table yet, one it has, and one it holds: deleted, each is gone.
    expect(propsOfKnows(8)).toEqual([[{ n: 8 }]]);
    write(db, p.graphSet('g', one, [{ relationship: { type: p.lit('KNOWS'), id: p.lit(9) }, kind: 'property', key: 'n', value: p.lit(90) }]));
    for (const rowid of [7, 8, 9]) write(db, p.graphDelete('g', one, [{ relationship: { type: p.lit('KNOWS'), id: p.lit(rowid) } }]));
    // Their table still has their rows: they are not given, and nothing is written to find that out.
    expect([propsOfKnows(7), propsOfKnows(8), propsOfKnows(9), at(db, 14)]).toEqual([[], [], [], []]);
    expect(propsOfKnows(10)).toEqual([[{ n: 10 }]]);
    expect([pending(db).count, pending(db).settles]).toEqual([4, settles]);
    expect(rels(db, 'knows').length).toBe(297);
    expect([propsOfKnows(7), propsOfKnows(10)]).toEqual([[], [[{ n: 10 }]]]);
    db.graphIndexState.check();
  });

  it('rows made and deleted again leave nothing in the log, and their tables are not behind for them', () => {
    const db = graph();
    pending(db).slack = 16;
    write(db, p.graphCreate('g', numbers(3), [{ labels: ['Person'], props: map('i', id) }]));
    expect(nodes(db).length).toBe(3);
    const scan = db.prepare('SELECT count(*) FROM node');
    for (let i = 0; i < 50; i++) {
      // Two nodes with a label and a relationship, a property set twice, and all of it gone again.
      const made = write(db, p.graphCreate('g', one, [{ labels: ['City'] }, { labels: ['City'] }], [{ type: 'LIKES', start: { node: 0 }, end: { node: 1 } }])).rows[0]!;
      write(db, p.graphSet('g', one, [{ node: p.lit(made[0] as number), kind: 'property', key: 'k', value: p.lit(i) }]));
      write(db, p.graphSet('g', one, [{ node: p.lit(made[0] as number), kind: 'property', key: 'k', value: p.lit(-i - 1) }]));
      expect(propsOf(db, made[0] as number)).toEqual([[{ k: -i - 1 }]]);
      // The relationship by its type and rowid, then its two nodes: nothing of it is asked of a table.
      write(db, p.graphDelete('g', one, [{ relationship: { type: p.lit('LIKES'), id: p.lit(made[2] as number) } }, { node: p.lit(made[0] as number) }, { node: p.lit(made[1] as number) }]));
    }
    // 50 times 9 changes were logged; what is left of them is nothing, and no table is behind.
    expect(pending(db).count).toBeLessThan(40);
    write(db, p.graphCreate('g', one, [{ labels: [] }]));
    write(db, p.graphDelete('g', one, [{ node: p.lit(103) }]));
    for (let i = 0; i < 20; i++) write(db, p.graphSet('g', one, [{ node: p.lit(1), kind: 'property', key: 'i', value: p.lit(i) }]));
    // One row is: node 1, whose props the index holds ahead of its table.
    expect(pending(db).count).toBeLessThan(20);
    expect([propsOf(db, 1), propsOf(db, 103), propsOf(db, 50)]).toEqual([[[{ i: 19 }]], [], []]);
    expect(pending(db).settles).toBe(1);
    expect(scan.all()).toEqual([[3]]);
    expect(tables(db)).toEqual({ nodes: [[0, { i: 0 }], [1, { i: 19 }], [2, { i: 2 }]], labels: [[0, 'Person'], [1, 'Person'], [2, 'Person']], knows: [], likes: [] });
    db.graphIndexState.check();
  });

  it('properties and labels set in the index are written behind, a row at a time or all at once', () => {
    const db = graph();
    write(db, p.graphCreate('g', numbers(4), [{ labels: ['Person'], props: map('i', id) }], [{ type: 'KNOWS', start: { node: 0 }, end: { node: 0 }, props: map('w', p.lit(1)) }]));
    expect(nodes(db).length).toBe(4);
    const all = p.scan('node', [0]);
    // One key of every node (all at once), then of one node; a map over a node's properties; a relationship's.
    write(db, p.graphSet('g', all, [{ node: id, kind: 'property', key: 'seen', value: p.lit(1) }]));
    write(db, p.graphSet('g', p.filter(all, eq(id, p.lit(1))), [{ node: id, kind: 'property', key: 'i', value: p.lit(null) }]));
    write(db, p.graphSet('g', p.filter(all, eq(id, p.lit(2))), [{ node: id, kind: 'properties', value: map('only', p.lit('this')), merge: false }]));
    write(db, p.graphSet('g', one, [{ relationship: { type: p.lit('KNOWS'), id: p.lit(0) }, kind: 'property', key: 'w', value: p.lit(2) }]));
    // Labels, all at once and for one node.
    write(db, p.graphSet('g', all, [{ node: id, kind: 'labels', add: ['City'], remove: [] }]));
    write(db, p.graphSet('g', p.filter(all, eq(id, p.lit(3))), [{ node: id, kind: 'labels', add: [], remove: ['Person', 'City'] }]));
    expect([propsOf(db, 0), propsOf(db, 1), propsOf(db, 2)]).toEqual([[[{ i: 0, seen: 1 }]], [[{ seen: 1 }]], [[{ only: 'this' }]]]);
    expect(tables(db)).toEqual({
      nodes: [[0, { i: 0, seen: 1 }], [1, { seen: 1 }], [2, { only: 'this' }], [3, { i: 3, seen: 1 }]],
      labels: [[0, 'City'], [0, 'Person'], [1, 'City'], [1, 'Person'], [2, 'City'], [2, 'Person']],
      knows: [[0, 0, 0, { w: 2 }], [1, 1, 1, { w: 1 }], [2, 2, 2, { w: 1 }], [3, 3, 3, { w: 1 }]],
      likes: [],
    });
    db.graphIndexState.check();
  });
});

describe("the graph's rules, kept against the index", () => {
  it('refuse what the tables refuse, with their errors, and leave nothing of the statement', () => {
    const db = graph();
    write(db, p.graphCreate('g', numbers(2), [{ labels: ['Person'] }], [{ type: 'KNOWS', start: { node: 0 }, end: { node: 0 } }]));
    const before = pending(db).count;
    const refused = (f: () => unknown): { code: string; message: string; table: unknown; columns: unknown; name: unknown } => {
      try {
        f();
      } catch (e) {
        const x = e as { code: string; message: string; table?: string; columns?: string[]; constraintName?: string };
        return { code: x.code, message: x.message, table: x.table, columns: x.columns, name: x.constraintName };
      }
      throw new Error('not refused');
    };
    // An end that is no node, after a node the statement made.
    expect(refused(() => write(db, p.graphCreate('g', one, [{ labels: [] }], [{ type: 'KNOWS', start: { node: 0 }, end: { id: p.lit(99) } }])))).toEqual({
      code: 'SMALT_CONSTRAINT_FOREIGNKEY',
      message: 'property graph g: knows.end = 99 is not a node of the graph',
      table: 'knows',
      columns: ['end'],
      name: 'g',
    });
    // A node with relationships.
    expect(refused(() => write(db, p.graphDelete('g', numbers(1), [{ node: id }])))).toEqual({
      code: 'SMALT_CONSTRAINT_FOREIGNKEY',
      message: "property graph g: can't delete node 0 of node: relationships in knows.start refer to it (delete them first)",
      table: 'knows',
      columns: ['start'],
      name: 'g',
    });
    // A label for a node that is none.
    expect(refused(() => write(db, p.graphSet('g', p.values([[p.lit(70)]], ['int']), [{ node: id, kind: 'labels', add: ['City'], remove: [] }])))).toEqual({
      code: 'SMALT_CONSTRAINT_FOREIGNKEY',
      message: 'property graph g: g_labels.node = 70 is not a node of the graph',
      table: 'g_labels',
      columns: ['node'],
      name: 'g',
    });
    // Each failure wrote what was ahead of the tables (the index is built again from them), and nothing of its own.
    expect(before).toBeGreaterThan(0);
    expect(pending(db).count).toBe(0);
    expect(tables(db)).toEqual({ nodes: [[0, {}], [1, {}]], labels: [[0, 'Person'], [1, 'Person']], knows: [[0, 0, 0, {}], [1, 1, 1, {}]], likes: [] });
    db.graphIndexState.check();
    // The ids the failed statement took are not given again.
    expect(write(db, p.graphCreate('g', one, [{ labels: [] }])).rows).toEqual([[3]]);
  });
});

describe('transactions', () => {
  it('a rollback drops what the transaction wrote, and keeps the rows of earlier commits that were still ahead of the tables', () => {
    const db = graph();
    write(db, p.graphCreate('g', numbers(2), [{ labels: ['Person'], props: map('i', id) }]));
    expect(pending(db).count).toBe(4);
    db.exec('BEGIN');
    write(db, p.graphCreate('g', one, [{ labels: ['City'] }]));
    write(db, p.graphSet('g', one, [{ node: p.lit(0), kind: 'property', key: 'i', value: p.lit(100) }]));
    expect([propsOf(db, 0), propsOf(db, 2)]).toEqual([[[{ i: 100 }]], [[{}]]]);
    db.exec('ROLLBACK');
    expect([propsOf(db, 0), propsOf(db, 2)]).toEqual([[[{ i: 0 }]], []]);
    expect(tables(db)).toEqual({ nodes: [[0, { i: 0 }], [1, { i: 1 }]], labels: [[0, 'Person'], [1, 'Person']], knows: [], likes: [] });
    db.graphIndexState.check();
  });

  it('rows written to the tables inside a transaction are pending again when it is rolled back', () => {
    const db = graph();
    write(db, p.graphCreate('g', numbers(2), [{ labels: ['Person'] }]));
    db.exec('BEGIN');
    // The scan writes the tables, inside the transaction.
    expect(nodes(db).length).toBe(2);
    expect(pending(db).count).toBe(0);
    db.exec('ROLLBACK');
    expect(tables(db)).toEqual({ nodes: [[0, {}], [1, {}]], labels: [[0, 'Person'], [1, 'Person']], knows: [], likes: [] });
    db.graphIndexState.check();
  });

  it('a savepoint is rolled back to, and a commit keeps what was written', () => {
    const db = graph();
    db.exec('BEGIN');
    write(db, p.graphCreate('g', one, [{ labels: ['Person'] }]));
    db.exec('SAVEPOINT s');
    write(db, p.graphCreate('g', one, [{ labels: ['City'] }]));
    expect(nodes(db).length).toBe(2);
    write(db, p.graphCreate('g', one, [{ labels: ['City'] }]));
    db.exec('ROLLBACK TO s');
    expect([propsOf(db, 0), propsOf(db, 1), propsOf(db, 2)]).toEqual([[[{}]], [], []]);
    write(db, p.graphCreate('g', one, [{ labels: [] }]));
    db.exec('COMMIT');
    expect(tables(db)).toEqual({ nodes: [[0, {}], [3, {}]], labels: [[0, 'Person']], knows: [], likes: [] });
    db.graphIndexState.check();
  });

  it('a statement that fails inside a transaction leaves the transaction as it was', () => {
    const db = graph();
    db.exec('BEGIN');
    write(db, p.graphCreate('g', numbers(2), [{ labels: ['Person'] }]));
    expect(() => write(db, p.graphCreate('g', one, [{ labels: [] }], [{ type: 'KNOWS', start: { node: 0 }, end: { id: p.lit(99) } }]))).toThrow(/is not a node of the graph/);
    write(db, p.graphCreate('g', one, [], [{ type: 'KNOWS', start: { id: p.lit(0) }, end: { id: p.lit(1) } }]));
    db.exec('COMMIT');
    expect(tables(db)).toEqual({ nodes: [[0, {}], [1, {}]], labels: [[0, 'Person'], [1, 'Person']], knows: [[1, 0, 1, {}]], likes: [] });
    db.graphIndexState.check();
  });
});

describe('with other statements', () => {
  it('a statement of another language that writes a table has the tables up to date first', () => {
    const db = graph();
    write(db, p.graphCreate('g', numbers(3), [{ labels: ['Person'] }]));
    expect(pending(db).count).toBe(6);
    db.exec(`DELETE FROM g_labels WHERE node = 1`);
    expect(pending(db).count).toBe(0);
    write(db, p.graphSet('g', p.values([[p.lit(1)]], ['int']), [{ node: id, kind: 'labels', add: ['City'], remove: [] }]));
    expect(labels(db)).toEqual([[0, 'Person'], [1, 'City'], [2, 'Person']]);
    // A table is made: the schema is another, and the writes go on landing in the index.
    db.exec('CREATE TABLE other(x)');
    write(db, p.graphCreate('g', one, [{ labels: [] }]));
    expect(pending(db).count).toBe(1);
    db.exec('INSERT INTO other SELECT id FROM node');
    expect(db.query('SELECT count(*) FROM other').rows).toEqual([[4]]);
    db.graphIndexState.check();
  });

  it('a cursor has the tables written before it opens, and nothing is ahead of them while it is open', () => {
    const db = graph();
    write(db, p.graphCreate('g', numbers(3), [{ labels: [] }]));
    const c = db.prepare('SELECT id FROM node ORDER BY id').cursor();
    expect(pending(db).count).toBe(0);
    expect(c.next()).toEqual([0]);
    expect(() => write(db, p.graphCreate('g', one, [{ labels: [] }]))).toThrow(/while a query cursor is open/);
    expect([c.next(), c.next(), c.next()]).toEqual([[1], [2], null]);
    c.close();
  });

  it('a rollback under an open cursor leaves the rows to write until the cursor is closed', () => {
    const db = graph();
    write(db, p.graphCreate('g', numbers(3), [{ labels: ['Person'] }]));
    db.exec('BEGIN');
    // The cursor writes the tables, inside the transaction; the rollback undoes that with the cursor still open.
    const c = db.prepare('SELECT id FROM node ORDER BY id').cursor();
    expect(c.next()).toEqual([0]);
    db.exec('ROLLBACK');
    expect(pending(db).count).toBe(6);
    expect(() => propsOf(db, 1)).toThrow(/waits for the open query cursors/);
    c.close();
    expect([propsOf(db, 1), pending(db).count]).toEqual([[[{}]], 0]);
    expect(tables(db)).toEqual({ nodes: [[0, {}], [1, {}], [2, {}]], labels: [[0, 'Person'], [1, 'Person'], [2, 'Person']], knows: [], likes: [] });
    db.graphIndexState.check();
  });

  it('a table that is behind is not read from its B+tree by mistake', () => {
    const db = graph();
    write(db, p.graphCreate('g', one, [{ labels: [] }]));
    const root = (db as unknown as { tables: Map<string, { rootPage: number }> }).tables.get('node')!.rootPage;
    const tree = db.tree(root);
    expect(() => tree.cursor().first()).toThrow(PENDING_READ as never);
    // A read that knows the row it asks for is the table's passes.
    expect(tree.trusted(() => tree.count())).toBe(0);
    expect(nodes(db)).toEqual([[0, {}]]);
    expect(tree.count()).toBe(1);
  });

  it('the planner counts the rows that are ahead of a table', () => {
    const db = graph();
    write(db, p.graphCreate('g', numbers(500), [{ labels: ['Person'] }]));
    const root = (db as unknown as { tables: Map<string, { rootPage: number }> }).tables.get('node')!.rootPage;
    expect([db.tree(root).estimateCount(), db.rowsNow(root)]).toEqual([0, 500]);
    write(db, p.graphDelete('g', numbers(100), [{ node: id }], { detach: true }));
    expect(db.rowsNow(root)).toBe(400);
    expect(nodes(db).length).toBe(400);
    expect(db.rowsNow(root)).toBe(db.tree(root).estimateCount());
  });
});

describe("an index on a key of the nodes' properties", () => {
  const explain = (db: Database, plan: PlanOp, params: unknown[]): string => db.queryPlan({ kind: 'explain', mode: 'plan', query: { kind: 'query', plan } } as unknown as PlanStatementInput, params as never).rows.flat().join(' ');
  const named = (value: PlanExpr): PlanOp => p.project(p.filter(p.scan('node', [0, 1]), eq(nameOf, value)), [id, p.col(0, 1, M)]);
  const byName = (db: Database, name: string): unknown[][] => read(db, named(p.param(0, 'text')), [name]);
  const node = (n: number): PlanOp => p.values([[p.lit(n)]], ['int']);

  /** 600 nodes with a name, `n0` to `n599`, in the table and in its index on the name. */
  function people(options: DatabaseOptions = {}): Database {
    const db = graph(options);
    indexOnName(db, false);
    write(db, p.graphCreate('g', numbers(600), [{ labels: ['Person'], props: map('name', p.call('concat', [p.lit('n'), id], 'text')) }]));
    expect(nodes(db).length).toBe(600);
    expect(explain(db, named(p.param(0, 'text')), ['n1'])).toContain('USING INDEX node_name');
    return db;
  }

  it('is searched for a value as it is while every node ahead of the table has under the key what its row in the table has', () => {
    const db = people();
    const settles = pending(db).settles;
    // Nodes without a name, a relationship from a node that has one, a label and a key that is not the name's.
    write(db, p.graphCreate('g', numbers(3), [{ labels: ['City'], props: map('i', id) }]));
    write(db, p.graphCreate('g', one, [], [{ type: 'KNOWS', start: { id: p.lit(7) }, end: { id: p.lit(600) } }]));
    write(db, p.graphSet('g', node(601), [{ node: id, kind: 'labels', add: ['Person'], remove: [] }, { node: id, kind: 'property', key: 'i', value: p.lit(9) }]));
    write(db, p.graphSet('g', node(7), [{ node: id, kind: 'labels', add: ['City'], remove: [] }]));
    // Another key of a node that has a name: its name is what the table has, its row in the table is an older one.
    write(db, p.graphSet('g', node(9), [{ node: id, kind: 'property', key: 'age', value: p.lit(40) }]));
    const ahead = pending(db).count;
    expect(ahead).toBeGreaterThan(7);
    expect(byName(db, 'n7')).toEqual([[7, { name: 'n7' }]]);
    // The row is given with the props the graph's index holds for it.
    expect(byName(db, 'n9')).toEqual([[9, { age: 40, name: 'n9' }]]);
    expect(byName(db, 'nobody')).toEqual([]);
    expect(read(db, named(p.lit('n599')))).toEqual([[599, { name: 'n599' }]]);
    // Nothing was written for those searches.
    expect([pending(db).count, pending(db).settles]).toEqual([ahead, settles]);
    // A node with a name, made and deleted before its table had it: nothing of it is in the table's index, or to be.
    write(db, p.graphCreate('g', one, [{ labels: [], props: map('name', p.lit('gone')) }]));
    write(db, p.graphDelete('g', node(603), [{ node: id }]));
    expect([byName(db, 'gone'), byName(db, 'n7')]).toEqual([[], [[7, { name: 'n7' }]]]);
    expect(pending(db).settles).toBe(settles);
    expect(tables(db).nodes.slice(8, 10)).toEqual([[8, { name: 'n8' }], [9, { age: 40, name: 'n9' }]]);
    expect([pending(db).count, pending(db).settles]).toEqual([0, settles + 1]);
    // A node of the table that has no name, deleted: the entry the index has for it is not one for a value.
    write(db, p.graphDelete('g', node(601), [{ node: id }]));
    expect(pending(db).count).toBeGreaterThan(0);
    expect([byName(db, 'n7'), byName(db, 'n9')]).toEqual([[[7, { name: 'n7' }]], [[9, { age: 40, name: 'n9' }]]]);
    expect(pending(db).settles).toBe(settles + 1);
    expect(tables(db).nodes.length).toBe(602);
    db.graphIndexState.check();
  });

  it('has the tables written first when a node ahead of the table got the key, lost it or got another value under it, or is a node of the table that was deleted', () => {
    const db = people();
    let settles = pending(db).settles;
    const written = (): boolean => pending(db).settles === ++settles && pending(db).count === 0;
    // A new node with a name.
    write(db, p.graphCreate('g', one, [{ labels: [], props: map('name', p.lit('new')) }]));
    expect(byName(db, 'new')).toEqual([[600, { name: 'new' }]]);
    expect(written()).toBe(true);
    // A name changed: the node is found by its new name alone.
    write(db, p.graphSet('g', node(7), [{ node: id, kind: 'property', key: 'name', value: p.lit('seven') }]));
    expect([byName(db, 'seven'), byName(db, 'n7')]).toEqual([[[7, { name: 'seven' }]], []]);
    expect(written()).toBe(true);
    // A name taken away: the node is not found by it.
    write(db, p.graphSet('g', node(8), [{ node: id, kind: 'property', key: 'name', value: p.lit(null) }]));
    expect(byName(db, 'n8')).toEqual([]);
    expect(written()).toBe(true);
    // A node of the table deleted.
    write(db, p.graphDelete('g', node(10), [{ node: id }], { detach: true }));
    expect(byName(db, 'n10')).toEqual([]);
    expect(written()).toBe(true);
    // A search that is not for a value reads entries a node without the key has: the names in order, the nodes without one.
    write(db, p.graphCreate('g', one, [{ labels: [], props: map('i', p.lit(1)) }]));
    expect(read(db, p.project(p.filter(p.scan('node', [0, 1]), p.call('cmp_gt', [nameOf, p.lit('new')], 'bool')), [id]))).toEqual([[7]]);
    expect(written()).toBe(true);
    db.graphIndexState.check();
  });

  it('a kept statement stopped at such a search has the tables written before a later run only when the search needs them', () => {
    const db = people();
    const kept = db.preparePlan({ kind: 'query', plan: named(p.param(0, 'text')) } as PlanStatementInput);
    const find = (name: string): unknown[][] => kept.all([name] as never);
    const settles = pending(db).settles;
    // Stopped: a name is ahead of the table.
    write(db, p.graphCreate('g', one, [{ labels: [], props: map('name', p.lit('a')) }]));
    expect(find('a')).toEqual([[600, { name: 'a' }]]);
    expect(pending(db).settles).toBe(settles + 1);
    // Not stopped, and nothing written: no name is.
    write(db, p.graphCreate('g', numbers(2), [{ labels: ['City'] }]));
    expect(find('n1')).toEqual([[1, { name: 'n1' }]]);
    expect([pending(db).count, pending(db).settles]).toEqual([4, settles + 1]);
    // Written before it runs: a name is again.
    write(db, p.graphSet('g', node(601), [{ node: id, kind: 'property', key: 'name', value: p.lit('b') }]));
    expect(find('b')).toEqual([[601, { name: 'b' }]]);
    expect([pending(db).count, pending(db).settles]).toEqual([0, settles + 2]);
    // A write that begins at such a search: its rows land in the index, with nothing written for the search.
    const link = p.graphCreate('g', named(p.param(0, 'text')), [{ labels: ['City'] }], [{ type: 'LIKES', start: { id }, end: { node: 0 } }]);
    for (const name of ['n3', 'n4', 'n5']) write(db, link, [name]);
    expect([pending(db).count, pending(db).settles]).toEqual([9, settles + 2]);
    expect(rels(db, 'likes')).toEqual([[0, 3, 603, {}], [1, 4, 604, {}], [2, 5, 605, {}]]);
    // In a transaction that is rolled back, and with the search inside the transaction.
    db.exec('BEGIN');
    write(db, p.graphCreate('g', one, [{ labels: [], props: map('name', p.lit('c')) }]));
    expect(find('c')).toEqual([[606, { name: 'c' }]]);
    db.exec('ROLLBACK');
    expect([find('c'), find('n2')]).toEqual([[], [[2, { name: 'n2' }]]]);
    db.graphIndexState.check();
  });

  // More seeds to look further, as below: GRAPH_BEHIND_SEEDS=200 npx vitest run test/graph-write-behind.test.ts
  const seeds = Array.from({ length: Number((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.GRAPH_BEHIND_SEEDS ?? 6) }, (_, i) => i + 7);

  it.each(seeds)('gives the rows a database written through its tables gives (seed %i)', (start) => {
    const behind = people();
    const plain = people({ graphWriteBehind: false });
    let seed = start;
    const pick = (n: number): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const steps: ((db: Database) => unknown)[] = [];
    for (let i = 0; i < 300; i++) {
      const kind = pick(10);
      const n = pick(640);
      const name = `n${pick(640)}`;
      if (kind < 3) steps.push((db) => byName(db, name));
      else if (kind < 5) steps.push((db) => write(db, p.graphCreate('g', one, [{ labels: ['City'], props: map('i', p.lit(i)) }])).rows);
      else if (kind < 6) steps.push((db) => write(db, p.graphCreate('g', one, [{ labels: [], props: map('name', p.lit(name)) }])).rows);
      else if (kind < 7) {
        const [key, value] = [pick(2) === 0 ? 'name' : 'i', pick(3) === 0 ? p.lit(null) : p.lit(name)];
        steps.push((db) => write(db, p.graphSet('g', node(n), [{ node: id, kind: 'property', key, value }])).graph);
      }
      else if (kind < 8) steps.push((db) => write(db, p.graphDelete('g', node(n), [{ node: id }], { detach: true })).graph);
      else steps.push((db) => write(db, p.graphCreate('g', named(p.lit(name)), [{ labels: [] }], [{ type: 'KNOWS', start: { id }, end: { node: 0 } }])).rows);
    }
    steps.forEach((run, i) => expect(run(behind), `step ${i}`).toEqual(run(plain)));
    expect(pending(behind).written).toBeGreaterThan(0);
    expect(tables(behind)).toEqual(tables(plain));
    behind.graphIndexState.check();
  });
});

describe('where they do not land in the index', () => {
  it('a database opened without, a graph that keeps history, and one whose tables are more than a graph is made with', () => {
    const plain = graph({ graphWriteBehind: false });
    write(plain, p.graphCreate('g', one, [{ labels: ['Person'] }]));
    expect([pending(plain).count, pending(plain).written]).toEqual([0, 0]);
    const kept = graph({}, { history: 'versions' });
    write(kept, p.graphCreate('g', one, [{ labels: ['Person'] }]));
    expect([pending(kept).count, pending(kept).written]).toEqual([0, 0]);
    // A unique index on a key of the node's properties: what it refuses is refused when the row is written.
    const unique = graph();
    indexOnName(unique, true);
    write(unique, p.graphCreate('g', one, [{ labels: [], props: map('name', p.lit('Ada')) }]));
    expect(pending(unique).count).toBe(0);
    expect(() => write(unique, p.graphCreate('g', one, [{ labels: [], props: map('name', p.lit('Ada')) }]))).toThrow(/duplicate key in index node_name/);
    // An index that is not unique is written behind with its table.
    const indexed = graph();
    indexOnName(indexed, false);
    write(indexed, p.graphCreate('g', numbers(3), [{ labels: [], props: map('name', p.call('concat', [p.lit('n'), id], 'text')) }]));
    expect(pending(indexed).count).toBe(3);
    expect(read(indexed, p.project(p.filter(p.scan('node', [0, 1]), eq(nameOf, p.lit('n1'))), [id]))).toEqual([[1]]);
    expect(pending(indexed).count).toBe(0);
    // A row of another node table of the graph: its nodes are not all in the one the index holds.
    const other = graph();
    write(other, p.graphCreate('g', one, [{ labels: [] }]));
    expect(pending(other).count).toBe(1);
    other.exec('INSERT INTO l_city(id) VALUES (50)');
    write(other, p.graphCreate('g', one, [{ labels: [] }]));
    expect(pending(other).count).toBe(0);
    expect(nodes(other)).toEqual([[0, {}], [51, {}]]);
  });

  it('an index over its limit is let go once its rows are written, and the graph is written through its tables', () => {
    // Room for the index of a few nodes (a page of a label's set, a page of the property maps and their first bytes).
    const db = graph({ graphIndexMem: 64 * 1024 });
    write(db, p.graphCreate('g', numbers(5), [{ labels: ['Person'], props: map('i', id) }]));
    expect(pending(db).count).toBeGreaterThan(0);
    // Past the limit inside one statement: its rows are written, and the index lets go of what it must.
    write(db, p.graphCreate('g', numbers(3000, 5), [{ labels: ['Person'], props: map('text', p.lit('x'.repeat(40))) }]));
    expect(pending(db).count).toBe(0);
    write(db, p.graphCreate('g', one, [{ labels: ['City'] }]));
    expect(pending(db).count).toBe(0);
    expect(db.query('SELECT count(*), min(id), max(id) FROM node').rows).toEqual([[3006, 0, 3005]]);
    expect(db.query(`SELECT count(*) FROM g_labels`).rows).toEqual([[3006]]);
  });
});

describe('against a graph written through its tables', () => {
  /** A small generator: the same numbers for a seed. */
  const random = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  /** What `f` gives, or the error it throws. */
  const outcome = (f: () => unknown): unknown => {
    try {
      return { value: f() };
    } catch (e) {
      const x = e as { code?: string; message?: string };
      return { error: [x.code, x.message] };
    }
  };

  // More seeds to look further: GRAPH_BEHIND_SEEDS=200 npx vitest run test/graph-write-behind.test.ts
  const seeds = Array.from({ length: Number((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.GRAPH_BEHIND_SEEDS ?? 6) }, (_, i) => i + 1);

  it.each(seeds)('the same statements give the same rows, errors and tables (seed %i)', (seed) => {
    const behind = graph();
    const plain = graph({ graphWriteBehind: false });
    // Every other seed makes the log its net effect at nearly every commit.
    if (seed % 2 === 0) pending(behind).slack = 2;
    const next = random(seed);
    const pick = (n: number): number => Math.floor(next() * n);
    const of = <T>(xs: readonly T[]): T => xs[pick(xs.length)]!;
    const labelSets = [[], ['Person'], ['City'], ['Person', 'City']] as const;
    let inTransaction = false;
    /** A node id that is probably there, sometimes one that is not. */
    const node = (): number => pick(40);
    const steps: { name: string; run: (db: Database) => unknown }[] = [];
    const step = (name: string, run: (db: Database) => unknown): void => void steps.push({ name, run });
    for (let i = 0; i < 260; i++) {
      const kind = pick(100);
      if (kind < 18) {
        const n = 1 + pick(4);
        const ls = of(labelSets);
        const from = pick(1000);
        step(`create ${n} nodes ${ls.join('+')} from ${from}`, (db) => write(db, p.graphCreate('g', numbers(n, from), [{ labels: [...ls], props: map('v', id, 'none', p.lit(null)) }])).rows);
      } else if (kind < 34) {
        const [a, b, type] = [node(), node(), of(['KNOWS', 'LIKES'])];
        const weight = pick(9);
        step(`create ${type} ${a}->${b}`, (db) => {
          const r = write(db, p.graphCreate('g', one, [], [{ type, start: { id: p.lit(a) }, end: { id: p.lit(b) }, props: map('w', p.lit(weight)) }]));
          return [r.rows, r.graph];
        });
      } else if (kind < 40) {
        // New nodes with relationships to each other and to a node that may not be there.
        const [n, to] = [1 + pick(3), node()];
        step(`create ${n} pairs liking ${to}`, (db) => write(db, p.graphCreate('g', numbers(n), [{ labels: ['Person'] }, { labels: [] }], [{ type: 'KNOWS', start: { node: 0 }, end: { node: 1 } }, { type: 'LIKES', start: { node: 1 }, end: { id: p.lit(to) } }])).rows);
      } else if (kind < 50) {
        const [lo, value] = [node(), pick(50)];
        const several = pick(2) === 0;
        const rows = p.filter(p.scan('node', [0]), several ? p.call('cmp_ge', [id, p.lit(lo)], 'bool') : eq(id, p.lit(lo)));
        const key = of(['v', 'x']);
        step(`set ${key}=${value % 7 === 0 ? 'null' : value} of ${several ? '>=' : ''}${lo}`, (db) => write(db, p.graphSet('g', rows, [{ node: id, kind: 'property', key, value: value % 7 === 0 ? p.lit(null) : p.lit(value) }])).graph);
      } else if (kind < 55) {
        const [n, merge] = [node(), pick(2) === 0];
        step(`set map of ${n}${merge ? ' merged' : ''}`, (db) => write(db, p.graphSet('g', p.values([[p.lit(n)]], ['int']), [{ node: id, kind: 'properties', value: map('m', p.lit(n), 'v', p.lit(null)), merge }])).graph);
      } else if (kind < 60) {
        const [type, rowid, w] = [of(['KNOWS', 'LIKES']), pick(30), pick(9)];
        step(`set w of ${type} ${rowid}`, (db) => write(db, p.graphSet('g', one, [{ relationship: { type: p.lit(type), id: p.lit(rowid) }, kind: 'property', key: 'w', value: p.lit(w) }])).graph);
      } else if (kind < 68) {
        const [lo, add, remove] = [node(), of(labelSets), of(labelSets)];
        const several = pick(2) === 0;
        const rows = several ? p.filter(p.scan('node', [0]), p.call('cmp_ge', [id, p.lit(lo)], 'bool')) : p.values([[p.lit(lo)]], ['int']);
        step(`labels +${add.join('+')} -${remove.join('-')} of ${several ? '>=' : ''}${lo}`, (db) => write(db, p.graphSet('g', rows, [{ node: id, kind: 'labels', add: [...add], remove: [...remove] }])).graph);
      } else if (kind < 74) {
        const [type, rowid] = [of(['KNOWS', 'LIKES']), pick(30)];
        step(`delete ${type} ${rowid}`, (db) => write(db, p.graphDelete('g', one, [{ relationship: { type: p.lit(type), id: p.lit(rowid) } }])).graph);
      } else if (kind < 82) {
        const [n, count, detach] = [node(), 1 + pick(3), pick(3) > 0];
        step(`delete ${count} nodes from ${n}${detach ? ' detached' : ''}`, (db) => write(db, p.graphDelete('g', numbers(count, n), [{ node: id }], { detach })).graph);
      } else if (kind < 88) {
        const n = node();
        step(`read ${n}`, (db) => [propsOf(db, n), at(db, n)]);
      } else if (kind < 91) {
        step('read Person', (db) => db.query(`SELECT node FROM g_labels WHERE label = 'Person' ORDER BY node`).rows);
      } else if (kind < 93) {
        step('read tables', (db) => tables(db));
      } else if (kind < 95) {
        const n = node();
        step(`sql delete labels of ${n}`, (db) => db.run(`DELETE FROM g_labels WHERE node = ?`, [n]).changes);
      } else if (!inTransaction) {
        inTransaction = true;
        step('BEGIN', (db) => db.exec('BEGIN'));
      } else {
        inTransaction = false;
        const how = of(['COMMIT', 'ROLLBACK', 'ROLLBACK']);
        step(how, (db) => db.exec(how));
      }
    }
    if (inTransaction) step('COMMIT', (db) => db.exec('COMMIT'));
    steps.forEach((s, i) => {
      const [a, b] = [outcome(() => s.run(behind)), outcome(() => s.run(plain))];
      expect(a, `step ${i} (${steps.slice(Math.max(0, i - 12), i + 1).map((x) => x.name).join('; ')})`).toEqual(b);
    });
    // Rows were left ahead of the tables on the way, and the tables end the same.
    expect(pending(behind).written).toBeGreaterThan(0);
    expect(pending(plain).written).toBe(0);
    expect(tables(behind)).toEqual(tables(plain));
    behind.graphIndexState.check();
  });
});

describe('through the client', () => {
  class FakeWorker {
    onmessage: ((e: { data: Response }) => void) | null = null;
    onerror: unknown = null;
    readonly dbs: Database[] = [];
    private readonly server = new EngineServer((_s, msg) => setTimeout(() => this.onmessage?.({ data: structuredClone(msg) })), {
      open: () => {
        const db = Database.openMemory();
        db.graphChecks = false;
        this.dbs.push(db);
        return db;
      },
      refreshTimer: false,
    });
    postMessage(req: Request, transfer: Transferable[] = []): void {
      const r = structuredClone(req, { transfer });
      setTimeout(() => this.server.receive(EngineServer.LOCAL, r));
    }
    terminate(): void {}
  }
  (globalThis as { Worker?: unknown }).Worker ??= FakeWorker;
  const opened: client.Database[] = [];
  afterEach(async () => {
    for (const d of opened.splice(0)) await d.close();
  });

  it('writes land in the index, and a query that reads a table gives what was written', async () => {
    const worker = new FakeWorker();
    const db = await client.open(':memory:', { storage: 'memory', worker: worker as unknown as Worker });
    opened.push(db);
    for (const op of graphSchema()) await db.queryPlan({ kind: 'schema', op } as unknown as PlanStatementInput);
    await db.queryPlan({ kind: 'write', plan: p.graphCreate('g', numbers(3), [{ labels: ['Person'], props: map('i', id) }]) } as PlanStatementInput);
    const engine = worker.dbs[0]!;
    expect(pending(engine).count).toBe(6);
    const rows = await db.queryPlan({ kind: 'query', plan: p.scan('node', [0, 1]) } as PlanStatementInput, [], { rowMode: 'array' });
    expect([...rows]).toEqual([[0, { i: 0 }], [1, { i: 1 }], [2, { i: 2 }]]);
    expect(pending(engine).count).toBe(0);
  });
});
