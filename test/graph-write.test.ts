/**
 * Plans that write a property graph (ADR 0042, section 1): `graphCreate`, `graphSet`, `graphDelete`, `graphMerge` and
 * `eager`, run in stages by the engine (exec/graph-write.ts). The graph is laid out as a language for graphs lays one
 * out: one node table (id, props), a label index, a table for each label and each relationship type.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { GraphWriteCounts, PlanOp } from '../src/engine/plan/ops.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';

const M = 'map<text, any>';
const schema = (db: Database, op: Record<string, unknown>): void => void db.queryPlan({ kind: 'schema', op } as unknown as PlanStatementInput);
const column = (name: string, type: string, declaredType = type) => ({ name, declaredType, type, notNull: false, collation: 'binary' });

/** An empty graph `g`: nodes in `node(id, props)`, their labels in `g_labels`, and the label `Person`. */
function graph(options: { history?: 'versions' | 'log' } = {}): Database {
  const db = Database.openMemory();
  const key = [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], ofColumn: 0 }];
  schema(db, { op: 'createTable', table: { name: 'node', columns: [column('id', 'INTEGER'), column('props', 'MAP', M)], keys: key, checks: [], foreignKeys: [], storage: 'row', ...options }, temp: false, ifNotExists: false });
  schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'g', nodes: [{ label: 'Node', table: 'node', id: 'id', props: 'props' }], edges: [], ...options } });
  schema(db, { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabelIndex' } });
  schema(db, { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabel', label: 'Person', table: 'l_person' } });
  return db;
}

const write = (db: Database, plan: PlanOp, params: unknown[] = []) => db.queryPlan({ kind: 'write', plan } as PlanStatementInput, params as never);
const counts = (c: Partial<GraphWriteCounts>): GraphWriteCounts => ({ nodesCreated: 0, nodesDeleted: 0, relationshipsCreated: 0, relationshipsDeleted: 0, propertiesSet: 0, labelsAdded: 0, labelsRemoved: 0, ...c });
const one = p.values([[]], []);
const map = (...entries: (string | PlanExpr)[]): PlanExpr => p.call('map_of', entries.map((e) => (typeof e === 'string' ? p.lit(e) : e)), M);
/** A value of any kind in a map of properties (the map's declared type says so). */
const any = (e: PlanExpr): PlanExpr => e;
const nodes = (db: Database): unknown[][] => db.query('SELECT id, props FROM node ORDER BY id').rows;
const labels = (db: Database): unknown[][] => db.query('SELECT node, label FROM g_labels ORDER BY node, label').rows;
const rels = (db: Database, type: string): unknown[][] => db.query(`SELECT rowid, start, "end", props FROM "${type}" ORDER BY rowid`).rows;
const numbers = (n: number): PlanOp => p.values(Array.from({ length: n }, (_, i) => [p.lit(i)]), ['int']);

describe('graphCreate', () => {
  it('makes a node for each row, with its labels and properties, and gives its id', () => {
    const db = graph();
    const r = write(db, p.graphCreate('g', numbers(3), [{ labels: ['Person'], props: map('i', any(p.col(0, 0, 'int')), 'none', p.lit(null)) }]));
    expect(r.rows).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(r.graph).toEqual(counts({ nodesCreated: 3, labelsAdded: 3, propertiesSet: 3 }));
    expect(nodes(db)).toEqual([[0, { i: 0 }], [1, { i: 1 }], [2, { i: 2 }]]);
    expect(labels(db)).toEqual([[0, 'Person'], [1, 'Person'], [2, 'Person']]);
    // Ids go on from the largest: with a parameter for a property, and no label.
    const more = write(db, p.graphCreate('g', one, [{ labels: [], props: map('name', any(p.param(0, 'text'))) }]), ['Ada']);
    expect([more.rows, more.graph]).toEqual([[[3]], counts({ nodesCreated: 1, propertiesSet: 1 })]);
    expect(nodes(db)[3]).toEqual([3, { name: 'Ada' }]);
  });

  it('adds the labels and relationship types the graph has not, and makes relationships between new nodes and given ones', () => {
    const db = graph();
    write(db, p.graphCreate('g', one, [{ labels: ['Person'] }, { labels: ['Person'] }]));
    // Two nodes of a new label, a relationship of a new type between them, and one from a node the row names.
    const input = p.project(numbers(2), [p.col(0, 0, 'int')]);
    const r = write(
      db,
      p.graphCreate(
        'g',
        input,
        [{ labels: ['City', 'Place'] }, { labels: ['City'] }],
        [
          { type: 'NEAR', start: { node: 0 }, end: { node: 1 }, props: map('km', any(p.lit(3))) },
          { type: 'IN', start: { id: p.col(0, 0, 'int') }, end: { node: 1 } },
        ],
      ),
    );
    // Each row: its column, the two new nodes' ids, the two new relationships' rowids.
    expect(r.rows).toEqual([[0, 2, 3, 0, 1], [1, 4, 5, 2, 3]]);
    expect(r.graph).toEqual(counts({ nodesCreated: 4, labelsAdded: 6, relationshipsCreated: 4, propertiesSet: 2 }));
    expect(rels(db, 'NEAR')).toEqual([[0, 2, 3, { km: 3 }], [2, 4, 5, { km: 3 }]]);
    expect(rels(db, 'IN')).toEqual([[1, 0, 3, {}], [3, 1, 5, {}]]);
    expect(labels(db).filter((l) => l[0] === 2)).toEqual([[2, 'City'], [2, 'Place']]);
    // A relationship to a node that is not there is refused by the graph's rules, and the statement leaves nothing.
    expect(() => write(db, p.graphCreate('g', one, [{ labels: [] }], [{ type: 'NEAR', start: { node: 0 }, end: { id: p.lit(99) } }]))).toThrow(/is not a node of the graph/);
    expect(nodes(db).length).toBe(6);
  });

  it('reads the row as far as it is made', () => {
    const db = graph();
    // The second node's property is the first node's id.
    const r = write(db, p.graphCreate('g', numbers(2), [{ labels: [] }, { labels: [], props: map('first', any(p.col(0, 1, 'int'))) }]));
    expect(r.rows).toEqual([[0, 0, 1], [1, 2, 3]]);
    expect(nodes(db)).toEqual([[0, {}], [1, { first: 0 }], [2, {}], [3, { first: 2 }]]);
  });
});

describe('graphSet', () => {
  const people = (db: Database): void => void write(db, p.graphCreate('g', numbers(3), [{ labels: ['Person'], props: map('i', any(p.col(0, 0, 'int'))) }]));
  const ids = p.scan('node', [0]);

  it('sets and removes properties, counting each one named', () => {
    const db = graph();
    people(db);
    const id = p.col(0, 0, 'int');
    const r = write(db, p.graphSet('g', ids, [
      { node: id, kind: 'property', key: 'age', value: any(p.call('mul', [id, p.lit(10)], 'int')) },
      { node: id, kind: 'property', key: 'i', value: p.lit(null) },
    ]));
    expect(r.graph).toEqual(counts({ propertiesSet: 6 }));
    expect(nodes(db)).toEqual([[0, { age: 0 }], [1, { age: 10 }], [2, { age: 20 }]]);
    // A map replaces the properties, or is merged into them: a NULL in a merged map removes its key.
    write(db, p.graphSet('g', p.filter(ids, p.call('cmp_eq', [id, p.lit(1)], 'bool')), [{ node: id, kind: 'properties', value: map('a', any(p.lit(1)), 'b', any(p.lit('x'))), merge: false }]));
    const merged = write(db, p.graphSet('g', p.filter(ids, p.call('cmp_eq', [id, p.lit(1)], 'bool')), [{ node: id, kind: 'properties', value: map('b', p.lit(null), 'c', p.lit(1)), merge: true }]));
    expect(nodes(db)[1]).toEqual([1, { a: 1, c: 1 }]);
    expect(merged.graph).toEqual(counts({ propertiesSet: 2 }));
    // A NULL node, and a node that is not there, are passed over.
    const none = write(db, p.graphSet('g', p.values([[p.lit(null, 'int')], [p.lit(77)]], ['int']), [{ node: id, kind: 'property', key: 'x', value: any(p.lit(1)) }]));
    expect(none.graph).toEqual(counts({}));
  });

  it('adds and removes labels', () => {
    const db = graph();
    people(db);
    const id = p.col(0, 0, 'int');
    const r = write(db, p.graphSet('g', ids, [{ node: id, kind: 'labels', add: ['Admin', 'Person'], remove: [] }]));
    expect(r.graph).toEqual(counts({ labelsAdded: 3 }));
    const gone = write(db, p.graphSet('g', p.filter(ids, p.call('cmp_lt', [id, p.lit(2)], 'bool')), [{ node: id, kind: 'labels', add: [], remove: ['Person', 'Nothing'] }]));
    expect(gone.graph).toEqual(counts({ labelsRemoved: 2 }));
    expect(labels(db)).toEqual([[0, 'Admin'], [1, 'Admin'], [2, 'Admin'], [2, 'Person']]);
  });

  it('an item reads what the items before it wrote, row by row', () => {
    const db = graph();
    people(db);
    // Every row names node 0: its counter goes up once for each row.
    const count = p.scalar(p.project(p.filter(p.scan('node', [0, 1]), p.call('cmp_eq', [p.col(0, 0, 'int'), p.lit(0)], 'bool')), [p.call('map_get', [p.col(0, 1, M), p.lit('n')], 'any')]), 'any');
    const next = p.call('add', [p.call('coalesce', [count, p.lit(0)], 'any'), p.lit(1)], 'any');
    write(db, p.graphSet('g', numbers(4), [{ node: p.lit(0), kind: 'property', key: 'n', value: next }]));
    expect(nodes(db)[0]).toEqual([0, { i: 0, n: 4 }]);
  });
});

describe('graphDelete', () => {
  it('deletes relationships and nodes in the order given, and a node with relationships only detached', () => {
    const db = graph();
    write(db, p.graphCreate('g', one, [{ labels: ['Person'] }, { labels: ['Person'] }, { labels: [] }], [
      { type: 'KNOWS', start: { node: 0 }, end: { node: 1 } },
      { type: 'KNOWS', start: { node: 1 }, end: { node: 1 } },
    ]));
    const id = p.col(0, 0, 'int');
    const of = (n: number): PlanOp => p.values([[p.lit(n)]], ['int']);
    expect(() => write(db, p.graphDelete('g', of(0), [{ node: id }]))).toThrow(/relationships in KNOWS.start refer to it/);
    // The relationship first, then its start: both go.
    const r = write(db, p.graphDelete('g', of(0), [{ relationship: { type: p.lit('KNOWS'), id: p.lit(0) } }, { node: id }]));
    expect(r.graph).toEqual(counts({ relationshipsDeleted: 1, nodesDeleted: 1 }));
    // Detached: the node's relationship to itself is deleted once. Its label entry goes with it.
    const d = write(db, p.graphDelete('g', of(1), [{ node: id }], { detach: true }));
    expect(d.graph).toEqual(counts({ relationshipsDeleted: 1, nodesDeleted: 1 }));
    expect([nodes(db), labels(db), rels(db, 'KNOWS')]).toEqual([[[2, {}]], [], []]);
    // What is gone already, a NULL, and a type the graph has not, are passed over.
    const again = write(db, p.graphDelete('g', of(1), [{ node: id }, { node: p.lit(null, 'int') }, { relationship: { type: p.lit('NONE'), id: p.lit(0) } }, { relationship: { type: p.lit('KNOWS'), id: p.lit(5) } }]));
    expect(again.graph).toEqual(counts({}));
  });
});

describe('graphMerge', () => {
  /** For each name: the nodes that have it (their ids), or a new node with it. */
  const byName = (names: PlanOp, more: { onCreate?: boolean; key?: boolean } = {}): PlanOp => {
    // The row (its name, then its number), then a node: its id and its properties.
    const row = p.working(7, ['text', 'int']);
    const match = p.project(
      p.filter(p.join('cross', row, p.scan('node', [0, 1])), p.call('cmp_eq', [p.call('map_get', [p.col(0, 3, M), p.lit('name')], 'any'), any(p.col(0, 0, 'text'))], 'bool')),
      [p.col(0, 1, 'int'), p.col(0, 2, 'int')],
    );
    return p.graphMerge('g', 7, names, match, {
      nodes: [{ labels: ['Person'], props: map('name', any(p.col(0, 0, 'text'))) }],
      created: [p.col(0, 1, 'int')],
      ...(more.onCreate
        ? {
            onCreate: [{ node: p.col(0, 1, 'int'), kind: 'property', key: 'made', value: p.lit(1) }],
            onMatch: [{ node: p.col(0, 1, 'int'), kind: 'property', key: 'seen', value: p.lit(1) }],
          }
        : {}),
      ...(more.key ? { key: [p.col(0, 0, 'text')] } : {}),
    });
  };
  const named = (...names: (string | null)[]): PlanOp => p.values(names.map((n) => [p.lit(n, 'text')]), ['text']);

  it('passes on what matches, or makes it, and a row sees what earlier rows made', () => {
    const db = graph();
    const r = write(db, byName(named('Ada', 'Bo', 'Ada'), { onCreate: true }));
    // The third row finds the node the first made.
    expect(r.rows).toEqual([['Ada', 0], ['Bo', 1], ['Ada', 0]]);
    expect(r.graph).toEqual(counts({ nodesCreated: 2, labelsAdded: 2, propertiesSet: 5 }));
    expect(nodes(db)).toEqual([[0, { made: 1, name: 'Ada', seen: 1 }], [1, { made: 1, name: 'Bo' }]]);
  });

  it('gives the same with a key, all its rows matched at once, as without', () => {
    const run = (key: boolean): unknown[] => {
      const db = graph();
      write(db, p.graphCreate('g', one, [{ labels: [], props: map('name', p.lit('Cy')) }, { labels: [], props: map('name', p.lit('Cy')) }]));
      // Two nodes are named Cy already: a row with that name is passed on once for each.
      const r = write(db, byName(named('Ada', 'Cy', 'Bo', 'Ada', 'Bo', 'Di'), { key }));
      return [r.rows, r.graph, nodes(db), labels(db)];
    };
    const rows = [['Ada', 2], ['Cy', 0], ['Cy', 1], ['Bo', 3], ['Ada', 2], ['Bo', 3], ['Di', 4]];
    const made = [[0, { name: 'Cy' }], [1, { name: 'Cy' }], [2, { name: 'Ada' }], [3, { name: 'Bo' }], [4, { name: 'Di' }]];
    const expected = [rows, counts({ nodesCreated: 3, labelsAdded: 3, propertiesSet: 3 }), made, [[2, 'Person'], [3, 'Person'], [4, 'Person']]];
    expect(run(false)).toEqual(expected);
    expect(run(true)).toEqual(expected);
  });

  it('with a NULL in a key, matches each row when its turn comes', () => {
    const db = graph();
    // A name that is NULL equals none: each such row makes a node, as it does without a key.
    const r = write(db, byName(named('Ada', null, null, 'Ada'), { key: true }));
    expect(r.rows).toEqual([['Ada', 0], [null, 1], [null, 2], ['Ada', 0]]);
    expect(nodes(db)).toEqual([[0, { name: 'Ada' }], [1, {}], [2, {}]]);
  });

  it('refuses a match that gives no column for its row, and a created list of another width', () => {
    const db = graph();
    const row = p.working(7, ['text', 'int']);
    const none = p.project(row, []);
    expect(() => write(db, p.graphMerge('g', 7, named('Ada'), none, { created: [] }))).toThrow(/gives no column for its row's number/);
    const number = p.project(row, [p.col(0, 1, 'int')]);
    expect(() => write(db, p.graphMerge('g', 7, named('Ada'), number, { created: [p.lit(1)] }))).toThrow(/gives 1 columns for the 0 the match adds/);
    // The row a `working` gives has the input's columns and its number.
    expect(() => write(db, p.graphMerge('g', 7, named('Ada'), p.working(7, ['text']), { created: [] }))).toThrow(/expected 2 columns/);
  });
});

describe('what is above a write', () => {
  it('reads the graph as it is after each row, until an eager', () => {
    const db = graph();
    const total = p.scalar(p.aggregate(p.scan('node', [0]), [], [{ fn: 'count', args: [], star: true, distinct: false, collation: 'binary', type: 'int' }]), 'int');
    const created = p.graphCreate('g', numbers(3), [{ labels: [] }]);
    // Row by row: each row counts the nodes made so far.
    expect(write(db, p.project(created, [p.col(0, 1, 'int'), total])).rows).toEqual([[0, 1], [1, 2], [2, 3]]);
    // After an eager: every row counts them all.
    expect(write(db, p.project(p.eager(created), [p.col(0, 1, 'int'), total])).rows).toEqual([[3, 6], [4, 6], [5, 6]]);
    // An operation that needs all its rows reads them all first.
    expect(write(db, p.aggregate(created, [], [{ fn: 'count', args: [], star: true, distinct: false, collation: 'binary', type: 'int' }, { fn: 'max', args: [total], star: false, distinct: false, collation: 'binary', type: 'int' }])).rows).toEqual([[3, 9]]);
    expect(nodes(db).length).toBe(9);
  });

  it('a limit stops the write below it', () => {
    const db = graph();
    const r = write(db, p.limit(p.graphCreate('g', numbers(5), [{ labels: [] }]), 2));
    expect(r.rows).toEqual([[0, 0], [1, 1]]);
    expect(r.graph).toEqual(counts({ nodesCreated: 2 }));
    expect(nodes(db).length).toBe(2);
  });

  it('a write after a write handles each row before the next is read', () => {
    const db = graph();
    // Create a node, then set on it how many nodes there are: 1, then 2.
    const total = p.scalar(p.aggregate(p.scan('node', [0]), [], [{ fn: 'count', args: [], star: true, distinct: false, collation: 'binary', type: 'int' }]), 'int');
    write(db, p.graphSet('g', p.graphCreate('g', numbers(2), [{ labels: [] }]), [{ node: p.col(0, 1, 'int'), kind: 'property', key: 'n', value: any(total) }]));
    expect(nodes(db)).toEqual([[0, { n: 1 }], [1, { n: 2 }]]);
  });
});

describe('the statement', () => {
  it('fails as a whole, runs in a transaction, and is refused where a graph cannot be written this way', () => {
    const db = graph();
    db.exec('BEGIN');
    write(db, p.graphCreate('g', one, [{ labels: ['New'] }]));
    db.exec('ROLLBACK');
    expect([nodes(db), db.query("SELECT count(*) FROM sqlite_schema WHERE name = 'New'").rows]).toEqual([[], [[0]]]);
    // A plan that writes a graph is a write statement's.
    expect(() => db.queryPlan({ kind: 'query', plan: p.graphCreate('g', one, [{ labels: [] }]) } as PlanStatementInput)).toThrow();
    expect(() => write(db, p.graphCreate('nope', one, [{ labels: [] }]))).toThrow(/no such property graph/);
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY)');
    schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'plain', nodes: [{ label: 'T', table: 't', id: 'id' }], edges: [] } });
    expect(() => write(db, p.graphCreate('plain', one, [{ labels: [] }]))).toThrow(/can't be written by a plan/);
  });

  it('gives ids past those a version holds, where the graph keeps history', () => {
    const db = graph({ history: 'versions' });
    write(db, p.graphCreate('g', numbers(2), [{ labels: [] }]));
    write(db, p.graphDelete('g', p.values([[p.lit(1)]], ['int']), [{ node: p.col(0, 0, 'int') }]));
    expect(write(db, p.graphCreate('g', one, [{ labels: [] }])).rows).toEqual([[2]]);
  });
});
