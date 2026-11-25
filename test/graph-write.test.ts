/**
 * Plans that write a property graph (ADR 0042, section 1): `graphCreate`, `graphSet`, `graphDelete`, `graphMerge` and
 * `eager`, run in stages by the engine (exec/graph-write.ts). The graph is laid out as a language for graphs lays one
 * out: one node table (id, props), a label index, a table for each label and each relationship type.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as client from '../src/client/index.js';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { GraphWriteCounts, PlanOp } from '../src/engine/plan/ops.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import { EngineServer } from '../src/engine/server.js';
import type { Request, Response } from '../src/shared/protocol.js';

const M = 'map<text, any>';
const schema = (db: Database, op: Record<string, unknown>): void => void db.queryPlan({ kind: 'schema', op } as unknown as PlanStatementInput);
const column = (name: string, type: string, declaredType = type) => ({ name, declaredType, type, notNull: false, collation: 'binary' });

/** What makes an empty graph `g`: nodes in `node(id, props)`, their labels in `g_labels`, and the label `Person`. */
function graphSchema(options: { history?: 'versions' | 'log' } = {}): Record<string, unknown>[] {
  const key = [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], ofColumn: 0 }];
  return [
    { op: 'createTable', table: { name: 'node', columns: [column('id', 'INTEGER'), column('props', 'MAP', M)], keys: key, checks: [], foreignKeys: [], storage: 'row', ...options }, temp: false, ifNotExists: false },
    { op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'g', nodes: [{ label: 'Node', table: 'node', id: 'id', props: 'props' }], edges: [], ...options } },
    { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabelIndex' } },
    { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabel', label: 'Person', table: 'l_person' } },
  ];
}

function graph(options: { history?: 'versions' | 'log' } = {}): Database {
  const db = Database.openMemory();
  for (const op of graphSchema(options)) schema(db, op);
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

  it('refuses a relationship to a node a later row makes, though all its rows are made at once', () => {
    const db = graph();
    // Two rows, a node each: the first row's relationship ends at node 1, which the second row makes; the second's at
    // node 0. Row by row the first is refused: node 1 is not there yet.
    const other = p.call('sub', [p.lit(1), p.col(0, 0, 'int')], 'int');
    const made = p.graphCreate('g', numbers(2), [{ labels: [] }], [{ type: 'NEXT', start: { node: 0 }, end: { id: other } }]);
    expect(() => write(db, made)).toThrow(/= 1 is not a node of the graph/);
    expect(() => write(db, p.limit(made, 5))).toThrow(/is not a node of the graph/);
    expect(nodes(db)).toEqual([]);
    // To the row's own node, and to one an earlier row made, it is made: both rows' relationships end at node 0.
    const fresh = graph();
    const back = p.graphCreate('g', numbers(2), [{ labels: [] }], [{ type: 'NEXT', start: { node: 0 }, end: { id: p.lit(0) } }]);
    expect(write(fresh, back).rows).toEqual([[0, 0, 0], [1, 1, 1]]);
    expect(rels(fresh, 'NEXT')).toEqual([[0, 0, 0, {}], [1, 1, 0, {}]]);
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

  it('computes no value for a NULL node or relationship', () => {
    const db = graph();
    people(db);
    // A value that raises: computed only for a row whose node is there to set. Node 1's row has it; the others' node
    // is NULL.
    const target = p.caseWhen([{ when: p.call('cmp_eq', [p.col(0, 0, 'int'), p.lit(1)], 'bool'), then: p.col(0, 0, 'int') }], 'int', p.lit(null, 'int'));
    const loud = p.caseWhen([{ when: p.call('cmp_eq', [p.col(0, 0, 'int'), p.lit(1)], 'bool'), then: any(p.lit('set')) }], 'any', p.call('raise_error', [p.lit('computed for a NULL node')], 'any'));
    const items = [
      { node: target, kind: 'property', key: 'x', value: loud },
      { relationship: { type: p.lit(null, 'text'), id: p.col(0, 0, 'int') }, kind: 'property', key: 'x', value: p.call('raise_error', [p.lit('computed for a NULL relationship')], 'any') },
      // Beside one that is computed for every row.
      { node: p.col(0, 0, 'int'), kind: 'property', key: 'y', value: any(p.col(0, 0, 'int')) },
    ] as const;
    for (const shape of [(w: PlanOp) => w, (w: PlanOp) => p.limit(w, 10)]) {
      const r = write(db, shape(p.graphSet('g', ids, [...items])));
      expect(r.graph).toEqual(counts({ propertiesSet: 4 }));
    }
    expect(nodes(db)).toEqual([[0, { i: 0, y: 0 }], [1, { i: 1, x: 'set', y: 1 }], [2, { i: 2, y: 2 }]]);
    // For a node that is there, it raises.
    expect(() => write(db, p.graphSet('g', ids, [{ node: p.col(0, 0, 'int'), kind: 'property', key: 'x', value: loud }]))).toThrow(/computed for a NULL node/);
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
    // A node that is not in the graph: a label is not removed from it, and one added to it is refused by the graph's
    // rule on the label index, for one row or several.
    for (const missing of [p.values([[p.lit(70)]], ['int']), p.values([[p.lit(70)], [p.lit(71)]], ['int'])]) {
      expect(write(db, p.graphSet('g', missing, [{ node: id, kind: 'labels', add: [], remove: ['Admin'] }])).graph).toEqual(counts({}));
      expect(() => write(db, p.graphSet('g', missing, [{ node: id, kind: 'labels', add: ['Admin'], remove: [] }]))).toThrow(/g_labels.node = 70 is not a node of the graph/);
    }
    expect(labels(db).length).toBe(4);
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
    // The third row finds the node the first made. Its columns are the row's, then the ones the match adds.
    expect(r.rows).toEqual([['Ada', 0], ['Bo', 1], ['Ada', 0]]);
    expect(r.columnTypes).toEqual(['text', 'int']);
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

  it('a write whose row reads the graph reads it as the rows before left it, and an eager above it waits for them all', () => {
    const db = graph();
    const total = p.scalar(p.aggregate(p.scan('node', [0]), [], [{ fn: 'count', args: [], star: true, distinct: false, collation: 'binary', type: 'int' }]), 'int');
    // Each node holds how many there were before it.
    const counted = p.graphCreate('g', numbers(3), [{ labels: [], props: map('before', any(total)) }]);
    write(db, counted);
    expect(nodes(db)).toEqual([[0, { before: 0 }], [1, { before: 1 }], [2, { before: 2 }]]);
    // What is above the eager starts when all three more are made.
    expect(write(db, p.project(p.eager(counted), [p.col(0, 1, 'int'), total])).rows).toEqual([[3, 6], [4, 6], [5, 6]]);
    expect(nodes(db).slice(3)).toEqual([[3, { before: 3 }], [4, { before: 4 }], [5, { before: 5 }]]);
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

describe('labels, types and ids', () => {
  const COUNT = { fn: 'count', args: [], star: true, distinct: false, collation: 'binary', type: 'int' } as const;
  const tablesNamed = (db: Database, ...names: string[]): unknown[] => db.query(`SELECT name FROM sqlite_schema WHERE name IN (${names.map((n) => `'${n}'`).join(', ')}) ORDER BY name`).rows.map((r) => r[0]);

  it('names the tables of the labels and types it adds, and adds them when a row first needs them', () => {
    const db = graph();
    const tables = [{ label: 'City', table: 'l_city' }, { type: 'NEAR', table: 'e_near' }];
    const cities = (input: PlanOp): PlanOp => p.graphCreate('g', input, [{ labels: ['City'] }, { labels: [] }], [{ type: 'NEAR', start: { node: 0 }, end: { node: 1 } }], tables);
    // No row reaches the write: the graph is as it was.
    expect(write(db, cities(numbers(0))).graph).toEqual(counts({}));
    expect(tablesNamed(db, 'l_city', 'e_near')).toEqual([]);
    // The plan reads the table it names for the new type: for each row, the relationships made so far.
    const made = p.scalar(p.aggregate(p.scan('e_near', [-1]), [], [COUNT]), 'int');
    expect(write(db, p.project(cities(numbers(2)), [p.col(0, 3, 'int'), made])).rows).toEqual([[0, 1], [1, 2]]);
    expect(tablesNamed(db, 'l_city', 'e_near')).toEqual(['e_near', 'l_city']);
    // The graph has them now: the same plan adds nothing more.
    expect(write(db, cities(one)).graph).toEqual(counts({ nodesCreated: 2, labelsAdded: 1, relationshipsCreated: 1 }));
    // A table of the name there already is not taken for a label.
    expect(() => write(db, p.graphCreate('g', one, [{ labels: ['Town'] }], [], [{ label: 'Town', table: 'node' }]))).toThrow(/table node exists already/);
    expect(() => write(db, p.graphCreate('g', one, [{ labels: [] }], [], [{ label: 'Town' } as never]))).toThrow(/expected a table name/);
    expect(() => write(db, p.graphCreate('g', one, [{ labels: [] }], [], [{ label: 'Town', type: 'T', table: 't' } as never]))).toThrow(/expected a label or a relationship type/);
  });

  it('a label a graphSet adds, and a type a graphMerge makes, are added the same way', () => {
    const db = graph();
    write(db, p.graphCreate('g', numbers(2), [{ labels: [] }]));
    const id = p.col(0, 0, 'int');
    write(db, p.graphSet('g', p.scan('node', [0]), [{ node: id, kind: 'labels', add: ['Seen'], remove: [] }], [{ label: 'Seen', table: 'l_seen' }]));
    expect([tablesNamed(db, 'l_seen'), labels(db)]).toEqual([['l_seen'], [[0, 'Seen'], [1, 'Seen']]]);
    // A merge that matches nothing makes a relationship of a type the graph has not: from the row's node to itself.
    const row = p.working(3, ['int', 'int']);
    const none = p.project(p.filter(row, p.call('cmp_lt', [p.col(0, 0, 'int'), p.lit(0)], 'bool')), [p.col(0, 1, 'int')]);
    const merge = p.graphMerge('g', 3, p.scan('node', [0]), none, { relationships: [{ type: 'SELF', start: { id }, end: { id } }], created: [], tables: [{ type: 'SELF', table: 'e_self' }] });
    expect(write(db, merge).graph).toEqual(counts({ relationshipsCreated: 2 }));
    expect(rels(db, 'e_self')).toEqual([[0, 0, 0, {}], [1, 1, 1, {}]]);
  });

  it('a statement kept and run again adds its labels once, and runs on the graph they made', () => {
    const db = graph();
    const kept = db.preparePlan({ kind: 'write', plan: p.graphCreate('g', p.values([[p.param(0, 'int')], [p.param(1, 'int')]], ['int']), [{ labels: ['Town'], props: map('n', any(p.col(0, 0, 'int'))) }], [{ type: 'AT', start: { node: 0 }, end: { node: 0 } }]) } as PlanStatementInput);
    // The first run adds the label and the type, which changes the schema under the statement; the second runs on it.
    expect(kept.result([1, 2] as never).rows).toEqual([[1, 0, 0], [2, 1, 1]]);
    expect(kept.result([3, 4] as never).rows).toEqual([[3, 2, 2], [4, 3, 3]]);
    expect([nodes(db).length, labels(db).length, rels(db, 'AT').length]).toEqual([4, 4, 4]);
  });

  it('gives each new node and relationship an id the graph has not had in this connection', () => {
    const db = graph();
    const pair = p.graphCreate('g', one, [{ labels: [] }, { labels: [] }], [{ type: 'KNOWS', start: { node: 0 }, end: { node: 1 } }]);
    expect(write(db, pair).rows).toEqual([[0, 1, 0]]);
    // The last node and the last relationship deleted: their ids are not given again.
    write(db, p.graphDelete('g', one, [{ node: p.lit(1) }], { detach: true }));
    expect(write(db, pair).rows).toEqual([[2, 3, 1]]);
    // A statement that fails has taken its ids: a node and a relationship here, before its second relationship is refused.
    const broken = p.graphCreate('g', one, [{ labels: [] }], [{ type: 'KNOWS', start: { node: 0 }, end: { node: 0 } }, { type: 'KNOWS', start: { node: 0 }, end: { id: p.lit(99) } }]);
    expect(() => write(db, broken)).toThrow(/is not a node of the graph/);
    expect(write(db, pair).rows).toEqual([[5, 6, 4]]);
    expect(nodes(db).map((n) => n[0])).toEqual([0, 2, 3, 5, 6]);
  });
});

describe('a relationship type whose table has no column for properties', () => {
  /** A graph `g` whose type PLAIN is a table of two ends and nothing else. */
  const plain = (): Database => {
    const db = Database.openMemory();
    const key = [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], ofColumn: 0 }];
    schema(db, { op: 'createTable', table: { name: 'node', columns: [column('id', 'INTEGER'), column('props', 'MAP', M)], keys: key, checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false });
    schema(db, { op: 'createTable', table: { name: 'plain', columns: [column('start', 'INTEGER'), column('end', 'INTEGER')], keys: [], checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false });
    schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'g', nodes: [{ label: 'Node', table: 'node', id: 'id', props: 'props' }], edges: [{ type: 'PLAIN', table: 'plain', start: 'start', end: 'end' }] } });
    schema(db, { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabelIndex' } });
    return db;
  };
  const pair = (props?: PlanExpr): PlanOp => p.graphCreate('g', numbers(2), [{ labels: [] }, { labels: [] }], [{ type: 'PLAIN', start: { node: 0 }, end: { node: 1 }, ...(props ? { props } : {}) }]);
  const ends = (db: Database): unknown[][] => db.query('SELECT rowid, start, "end" FROM plain ORDER BY rowid').rows;

  it('takes relationships without properties, all its rows at once or one at a time', () => {
    for (const shape of [(w: PlanOp) => w, (w: PlanOp) => p.limit(w, 10)]) {
      const db = plain();
      expect(write(db, shape(pair())).graph).toEqual(counts({ nodesCreated: 4, relationshipsCreated: 2 }));
      expect(ends(db)).toEqual([[0, 0, 1], [1, 2, 3]]);
      // An empty map, and one whose values are NULL, are no properties.
      write(db, shape(pair(map('none', p.lit(null)))));
      expect(ends(db).length).toBe(4);
      expect(() => write(db, shape(pair(map('w', any(p.lit(1))))))).toThrow(/relationship type PLAIN keeps no properties/);
      const one = { relationship: { type: p.lit('PLAIN'), id: p.col(0, 0, 'int') }, kind: 'property', key: 'w', value: any(p.lit(1)) } as const;
      expect(() => write(db, shape(p.graphSet('g', numbers(2), [one])))).toThrow(/table plain keeps no properties/);
      expect(ends(db).length).toBe(4);
    }
  });
});

describe('property values', () => {
  it('keep their kind: a truth value, a list', () => {
    const db = graph();
    const yes = p.call('cmp_eq', [p.lit(1), p.lit(1)], 'bool');
    // A map of truth values holds them bare: as properties each is a truth value.
    write(db, p.graphCreate('g', one, [{ labels: [], props: p.call('map_of', [p.lit('ok'), yes], 'map<text, bool>') }]));
    const id = p.col(0, 0, 'int');
    write(db, p.graphSet('g', p.scan('node', [0]), [
      { node: id, kind: 'property', key: 'also', value: yes },
      { node: id, kind: 'property', key: 'list', value: p.call('list_of', [p.lit(1), p.lit(2)], 'list<int>') },
      { node: id, kind: 'properties', value: p.call('map_of', [p.lit('more'), yes], 'map<text, bool>'), merge: true },
    ]));
    expect(nodes(db)).toEqual([[0, { also: true, list: [1, 2], more: true, ok: true }]]);
    // Properties are a map: anything else is an error.
    expect(() => write(db, p.graphSet('g', p.scan('node', [0]), [{ node: id, kind: 'properties', value: p.lit(1), merge: false }]))).toThrow(/properties are given as a map/);
    expect(() => write(db, p.graphCreate('g', one, [{ labels: [], props: p.lit('x') }]))).toThrow(/a node's props is a map, not text/);
  });
});

describe('all the rows of a write at once', () => {
  const COUNT = { fn: 'count', args: [], star: true, distinct: false, collation: 'binary', type: 'int' } as const;
  /** Under a limit a write handles a row at a time: it could stop between two. Without, where no row could tell, all at once. */
  const bothWays = <T>(run: (shape: (write: PlanOp) => PlanOp) => T): [T, T] => [run((w) => w), run((w) => p.limit(w, 1000))];
  /** Ten people, each knowing the next (the last knows itself), a second label on every other one. */
  const people = (): Database => {
    const db = graph();
    write(db, p.graphCreate('g', numbers(10), [{ labels: ['Person'], props: map('i', any(p.col(0, 0, 'int'))) }]));
    const next = p.call('min', [p.call('add', [p.col(0, 0, 'int'), p.lit(1)], 'int'), p.lit(9)], 'int');
    write(db, p.graphCreate('g', p.scan('node', [0]), [], [{ type: 'KNOWS', start: { id: p.col(0, 0, 'int') }, end: { id: next }, props: map('w', any(p.col(0, 0, 'int'))) }]));
    return db;
  };
  const state = (db: Database, r: { rows: unknown; graph?: unknown }): unknown[] => [r.rows, r.graph, nodes(db), labels(db), rels(db, 'KNOWS')];
  const id = p.col(0, 0, 'int');

  it('graphCreate gives what it gives row by row', () => {
    const [once, each] = bothWays((shape) => {
      const db = people();
      const made = p.graphCreate('g', p.scan('node', [0]), [{ labels: ['Person', 'Copy'], props: map('of', any(id)) }, { labels: [] }], [
        { type: 'COPIES', start: { node: 0 }, end: { id }, props: map('n', any(id)) },
        { type: 'KNOWS', start: { node: 0 }, end: { node: 1 } },
      ]);
      const r = write(db, shape(made));
      return [...state(db, r), rels(db, 'COPIES')];
    });
    expect(once).toEqual(each);
    expect((once[1] as GraphWriteCounts).nodesCreated).toBe(20);
  });

  it('graphSet gives what it gives row by row: properties of nodes and relationships, and labels', () => {
    const [once, each] = bothWays((shape) => {
      const db = people();
      const r = write(db, shape(p.graphSet('g', p.scan('node', [0]), [
        { node: id, kind: 'property', key: 'double', value: any(p.call('mul', [id, p.lit(2)], 'int')) },
        // Every other one loses `i`: a NULL takes the key away.
        { node: id, kind: 'property', key: 'i', value: p.caseWhen([{ when: p.call('cmp_eq', [p.call('mod_trunc', [id, p.lit(2)], 'int'), p.lit(0)], 'bool'), then: p.lit(null, 'int') }], 'any', any(id)) },
        // The relationship that has the node's id for its rowid; a type the graph has not is passed over.
        { relationship: { type: p.lit('KNOWS'), id }, kind: 'property', key: 'w', value: any(p.lit(0)) },
        { relationship: { type: p.lit('NONE'), id }, kind: 'property', key: 'w', value: any(p.lit(0)) },
        { node: id, kind: 'labels', add: ['Seen'], remove: ['Person'] },
      ])));
      return state(db, r);
    });
    expect(once).toEqual(each);
    expect(once[1]).toEqual(counts({ propertiesSet: 30, labelsAdded: 10, labelsRemoved: 10 }));
    expect((once[2] as unknown[][])[2]).toEqual([2, { double: 4 }]);
  });

  it('graphSet sets a property of a row whose properties are NULL, and takes none away from it', () => {
    const [once, each] = bothWays((shape) => {
      const db = people();
      // Two nodes written to the node table without properties.
      db.exec('INSERT INTO node(id) VALUES (50), (51)');
      write(db, shape(p.graphSet('g', p.filter(p.scan('node', [0]), p.call('cmp_ge', [id, p.lit(8)], 'bool')), [
        { node: id, kind: 'property', key: 'set', value: p.caseWhen([{ when: p.call('cmp_eq', [id, p.lit(51)], 'bool'), then: p.lit(null, 'int') }], 'any', any(id)) },
      ])));
      return nodes(db).slice(8);
    });
    expect(once).toEqual(each);
    expect(once).toEqual([[8, { i: 8, set: 8 }], [9, { i: 9, set: 9 }], [50, { set: 50 }], [51, null]]);
  });

  it('graphSet goes row by row where two rows name one node: the later one is set over the earlier', () => {
    const db = people();
    // Rows 0 to 9, each naming node 0 or 1.
    const r = write(db, p.graphSet('g', numbers(10), [{ node: p.call('mod_trunc', [id, p.lit(2)], 'int'), kind: 'property', key: 'last', value: any(id) }]));
    expect(r.graph).toEqual(counts({ propertiesSet: 10 }));
    expect(nodes(db).slice(0, 2)).toEqual([[0, { i: 0, last: 8 }], [1, { i: 1, last: 9 }]]);
  });

  it('graphSet tells a node named twice whatever order the nodes come in, and passes rows that name none', () => {
    const run = (ids: (number | null)[], shape: (w: PlanOp) => PlanOp): unknown => {
      const db = people();
      const rows = p.values(ids.map((n, i) => [p.lit(n), p.lit(i)]), ['int', 'int']);
      const r = write(db, shape(p.graphSet('g', rows, [
        { node: p.col(0, 0, 'int'), kind: 'property', key: 'at', value: any(p.col(0, 1, 'int')) },
        { node: p.col(0, 0, 'int'), kind: 'labels', add: ['Seen'], remove: [] },
      ])));
      return [r.graph, nodes(db), labels(db)];
    };
    // Rising, falling and scattered ids; the same id twice, next to itself, far apart and after a smaller one; NULLs.
    const orders: (number | null)[][] = [[0, 1, 2, 3], [3, 2, 1, 0], [2, 0, 3, 1], [0, 1, 2, 2], [0, 1, 1, 2], [5, 1, 5], [3, null, 1, null, 3], [null, null], [0, 2, 1, 2, 0], [9, 8, 9], [4]];
    for (const ids of orders) expect(run(ids, (w) => w), JSON.stringify(ids)).toEqual(run(ids, (w) => p.limit(w, 1000)));
    // The later row is over the earlier one, as row by row.
    const [, after] = run([5, 1, 5], (w) => w) as [unknown, unknown[][]];
    expect([after[1], after[5]]).toEqual([[1, { i: 1, at: 1 }], [5, { i: 5, at: 2 }]]);
  });

  it('graphSet goes row by row where two items write one key of one node in different rows', () => {
    const run = (shape: (w: PlanOp) => PlanOp): unknown[][] => {
      const db = people();
      // Two rows of two nodes, each the other's the other way round: the first item sets `x` on the second node, the
      // second item on the first. Row by row, node 0 is last written by the second row's first item.
      const pairs = p.values([[p.lit(0), p.lit(1)], [p.lit(1), p.lit(0)]], ['int', 'int']);
      write(db, shape(p.graphSet('g', pairs, [
        { node: p.col(0, 1, 'int'), kind: 'property', key: 'x', value: any(p.lit('first item')) },
        { node: p.col(0, 0, 'int'), kind: 'property', key: 'x', value: any(p.lit('second item')) },
        { node: p.col(0, 1, 'int'), kind: 'labels', add: ['Seen'], remove: [] },
        { node: p.col(0, 0, 'int'), kind: 'labels', add: [], remove: ['Seen'] },
      ])));
      return [...nodes(db).slice(0, 2), ...labels(db).filter((l) => l[1] === 'Seen')];
    };
    const rowByRow = [[0, { i: 0, x: 'first item' }], [1, { i: 1, x: 'second item' }], [0, 'Seen']];
    expect(run((w) => p.limit(w, 10))).toEqual(rowByRow);
    expect(run((w) => w)).toEqual(rowByRow);
  });

  it('graphDelete gives what it gives row by row: nodes with their relationships, relationships, lists', () => {
    const [once, each] = bothWays((shape) => {
      const db = people();
      // Nodes 0 to 8 with what they are at; node 9's relationship to itself; and a list of nodes gone by then.
      const r = write(db, shape(p.graphDelete('g', p.filter(p.scan('node', [0]), p.call('cmp_lt', [id, p.lit(9)], 'bool')), [
        { relationship: { type: p.lit('KNOWS'), id: p.lit(9) } },
        { node: id },
        { nodes: p.call('list_of', [id, p.lit(null, 'int')], 'list<int>') },
      ], { detach: true })));
      return state(db, r);
    });
    expect(once).toEqual(each);
    // Nine relationships between the nodes deleted, each deleted once though it is at two of them, and node 9's own.
    expect(once.slice(1)).toEqual([counts({ nodesDeleted: 9, relationshipsDeleted: 10 }), [[9, { i: 9 }]], [[9, 'Person']], []]);
  });

  it('graphCreate counts the properties each node gets: NULL ones are none, a map may be NULL, a node may have none', () => {
    const [once, each] = bothWays((shape) => {
      const db = graph();
      const n = p.col(0, 0, 'int');
      const name = p.col(0, 1, 'text');
      const rows = p.values([[p.lit(1), p.lit('a')], [p.lit(null, 'int'), p.lit('b')], [p.lit(3), p.lit(null, 'text')], [p.lit(null, 'int'), p.lit(null, 'text')]], ['int', 'text']);
      const made = p.graphCreate('g', rows, [
        // Two keys, either of them NULL in some rows.
        { labels: ['Person', 'Seen'], props: map('n', any(n), 'name', any(name)) },
        // One key of a map of truth values: true, false or NULL.
        { labels: [], props: p.call('map_of', [p.lit('big'), p.call('cmp_gt', [n, p.lit(2)], 'bool')], 'map<text, bool>') },
        // No properties given; its labels are counted as given: one twice, and the node table's own.
        { labels: ['Person', 'Node', 'Person'] },
        // A map that is NULL where the row has no number.
        { labels: [], props: p.caseWhen([{ when: p.isNull(n), then: p.lit(null, M) }], M, map('only', any(name))) },
      ]);
      const r = write(db, shape(made));
      return [r.rows, r.graph, nodes(db), labels(db)];
    });
    expect(once).toEqual(each);
    // Of the first row's four nodes: 2, 1, 0 and 1 properties; of the second's: 1 (its name); of the third's: 1 and 1.
    expect(once[1]).toEqual(counts({ nodesCreated: 16, labelsAdded: 20, propertiesSet: 7 }));
    expect((once[2] as unknown[]).slice(0, 8)).toEqual([[0, { n: 1, name: 'a' }], [1, { big: false }], [2, {}], [3, { only: 'a' }], [4, { name: 'b' }], [5, {}], [6, {}], [7, {}]]);
    expect((once[2] as unknown[]).slice(8, 12)).toEqual([[8, { n: 3 }], [9, { big: true }], [10, {}], [11, {}]]);
    expect((once[0] as unknown[])[2]).toEqual([3, null, 8, 9, 10, 11]);
  });

  it('graphDelete of nodes named by columns: a NULL, a node named twice, one that is no node, one with relationships', () => {
    const pairs = (): PlanOp => p.values([[p.lit(3), p.lit(4)], [p.lit(null, 'int'), p.lit(3)], [p.lit(7), p.lit(null, 'int')], [p.lit(40), p.lit(7)], [p.lit(4), p.lit(4)]], ['int', 'int']);
    for (const targets of [[{ node: p.col(0, 0, 'int') }], [{ node: p.col(0, 1, 'int') }, { node: p.col(0, 0, 'int') }]]) {
      const [once, each] = bothWays((shape) => {
        const db = people();
        const r = write(db, shape(p.graphDelete('g', pairs(), targets, { detach: true })));
        return state(db, r);
      });
      expect(once, `${targets.length} target(s)`).toEqual(each);
      // Nodes 3, 4 and 7 with both targets (3, 7 and 4 with the first alone), each once, with the relationships at them.
      expect((once[1] as GraphWriteCounts).nodesDeleted).toBe(3);
      expect((once[2] as unknown[][]).map((n) => n[0])).toEqual([0, 1, 2, 5, 6, 8, 9]);
      expect((once[4] as unknown[][]).map((r) => r[0])).toEqual([0, 1, 5, 8, 9]);
    }
  });

  it('graphDelete of many nodes that still have relationships fails as one of one does, and leaves the graph as it was', () => {
    const db = people();
    const before = state(db, { rows: null });
    expect(() => write(db, p.graphDelete('g', p.scan('node', [0]), [{ node: id }]))).toThrow(/relationships in KNOWS/);
    expect(state(db, { rows: null })).toEqual(before);
    // What names no node deletes none: text, a number that is no integer.
    const r = write(db, p.graphDelete('g', numbers(10), [{ node: any(p.lit('x')) }, { node: any(p.lit(1.5)) }], { detach: true }));
    expect(r.graph).toEqual(counts({}));
  });

  it('where the graph keeps history, a property set to what it is makes no version', () => {
    const db = graph({ history: 'versions' });
    write(db, p.graphCreate('g', numbers(10), [{ labels: [], props: map('i', any(id)) }]));
    const versions = (): unknown => db.queryPlan({ kind: 'query', plan: p.aggregate(p.scan('smalt_versions_node', [0]), [], [COUNT]), columns: [{ name: 'n', type: 'int' }] } as PlanStatementInput).rows[0]![0];
    const before = versions();
    const same = write(db, p.graphSet('g', p.scan('node', [0]), [{ node: id, kind: 'property', key: 'i', value: any(id) }]));
    // Each is counted as set, and none is written.
    expect([same.graph, versions()]).toEqual([counts({ propertiesSet: 10 }), before]);
    write(db, p.graphSet('g', p.scan('node', [0]), [{ node: id, kind: 'property', key: 'i', value: any(p.lit(0)) }]));
    // Node 0 had 0 already: nine rows changed.
    expect(versions()).toBe((before as number) + 9);
  });
});

describe('all at once and row by row give the same, on random plans', () => {
  /** A generator of numbers from a seed (mulberry32): the same plans every run. */
  const random = (seed: number) => {
    let a = seed >>> 0;
    const next = (): number => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const int = (n: number): number => Math.floor(next() * n);
    return { next, int, pick: <T>(xs: readonly T[]): T => xs[int(xs.length)]!, chance: (x: number): boolean => next() < x };
  };
  type Random = ReturnType<typeof random>;
  const NODES = 8;
  const a = p.col(0, 0, 'int');
  const b = p.col(0, 1, 'int');
  const eq = (x: PlanExpr, y: PlanExpr): PlanExpr => p.call('cmp_eq', [x, y], 'bool');

  /** Eight nodes (two without properties, one written with NULL ones), some labelled, and relationships of two types. */
  const world = (r: Random): Database => {
    const db = graph();
    write(db, p.graphCreate('g', numbers(NODES - 1), [{ labels: ['Person'], props: p.caseWhen([{ when: p.call('cmp_lt', [a, p.lit(2)], 'bool'), then: p.lit(null, M) }], M, map('i', any(a), 'x', any(p.lit('old')))) }]));
    db.exec(`INSERT INTO node(id) VALUES (${NODES - 1})`);
    write(db, p.graphSet('g', p.filter(p.scan('node', [0]), eq(p.call('mod_trunc', [a, p.lit(3)], 'int'), p.lit(0))), [{ node: a, kind: 'labels', add: ['Seen'], remove: [] }]));
    const pairs = p.values(Array.from({ length: 10 }, () => [p.lit(r.int(NODES)), p.lit(r.int(NODES))]), ['int', 'int']);
    write(db, p.graphCreate('g', pairs, [], [{ type: 'KNOWS', start: { id: a }, end: { id: b }, props: map('w', any(a)) }, { type: 'LIKES', start: { id: b }, end: { id: a } }]));
    return db;
  };
  /** A node id, sometimes of no node, sometimes NULL. */
  const someId = (r: Random): PlanExpr => (r.chance(0.12) ? p.lit(null, 'int') : p.lit(r.int(NODES + 3)));
  const input = (r: Random): PlanOp => p.values(Array.from({ length: 2 + r.int(9) }, () => [someId(r), someId(r)]), ['int', 'int']);
  const value = (r: Random): PlanExpr =>
    r.pick([
      (): PlanExpr => any(a),
      (): PlanExpr => any(p.call('add', [p.call('coalesce', [a, p.lit(0)], 'int'), p.call('coalesce', [b, p.lit(0)], 'int')], 'int')),
      (): PlanExpr => any(p.lit('new')),
      (): PlanExpr => p.lit(null),
      (): PlanExpr => p.call('cmp_lt', [a, b], 'bool'),
      // One that raises for some rows: both ways fail, or neither does.
      (): PlanExpr => p.caseWhen([{ when: eq(a, p.lit(r.int(NODES + 3))), then: p.call('raise_error', [p.lit('a value that raises')], 'any') }], 'any', any(b)),
    ])();
  const item = (r: Random): Record<string, unknown> => {
    const target = r.chance(0.75) ? { node: r.pick([a, b]) } : { relationship: { type: p.lit(r.pick(['KNOWS', 'LIKES', 'NONE'])), id: r.pick([a, b]) } };
    const kind = r.int(10);
    if (kind < 6) return { ...target, kind: 'property', key: r.pick(['x', 'y']), value: value(r) };
    if (kind < 8 || 'relationship' in target) return { ...target, kind: 'properties', value: map('x', value(r), 'z', any(p.lit(1))), merge: r.chance(0.5) };
    return { ...target, kind: 'labels', add: r.chance(0.6) ? [r.pick(['Seen', 'Tag'])] : [], remove: r.chance(0.6) ? [r.pick(['Seen', 'Person', 'Tag'])] : [] };
  };
  /** A write, sometimes under steps that read only its rows. */
  const plan = (r: Random): PlanOp => {
    const w = aWrite(r);
    return r.chance(0.3) ? p.project(p.filter(w, p.isNotNull(a)), [b, a]) : w;
  };
  const aWrite = (r: Random): PlanOp => {
    const rows = input(r);
    switch (r.int(4)) {
      case 0: {
        // Sometimes two items that write one key, each of another column's node, over two rows that hold two nodes
        // the other way round: each node is written by both items, and which write is the later depends on the row.
        if (r.chance(0.3)) {
          const key = r.pick(['x', 'y']);
          const x = r.int(NODES);
          const y = (x + 1 + r.int(NODES - 1)) % NODES;
          const swapped = p.values([[p.lit(x), p.lit(y)], [p.lit(y), p.lit(x)]], ['int', 'int']);
          return p.graphSet('g', swapped, [{ node: b, kind: 'property', key, value: any(p.lit('of b')) }, { node: a, kind: 'property', key, value: any(p.lit('of a')) }]);
        }
        return p.graphSet('g', rows, Array.from({ length: 1 + r.int(3) }, () => item(r)) as never);
      }
      case 1: {
        const target = (): Record<string, unknown> =>
          r.pick([
            (): Record<string, unknown> => ({ node: r.pick([a, b]) }),
            (): Record<string, unknown> => ({ nodes: p.call('list_of', [a, b], 'list<int>') }),
            (): Record<string, unknown> => ({ relationship: { type: p.lit(r.pick(['KNOWS', 'LIKES', 'NONE'])), id: r.pick([a, b]) } }),
          ])();
        return p.graphDelete('g', rows, Array.from({ length: 1 + r.int(2) }, target) as never, { detach: r.chance(0.7) });
      }
      case 2: {
        const node = (): { labels: string[]; props?: PlanExpr } => ({ labels: r.chance(0.5) ? [r.pick(['Person', 'Tag'])] : [], ...(r.chance(0.7) ? { props: map('x', value(r)) } : {}) });
        const nodes = Array.from({ length: r.int(3) }, node);
        const end = (): { node: number } | { id: PlanExpr } => (nodes.length > 0 && r.chance(0.5) ? { node: r.int(nodes.length) } : { id: r.pick([a, b, p.call('add', [a, p.lit(NODES)], 'int')]) });
        const rels = Array.from({ length: r.int(3) }, () => ({ type: r.pick(['KNOWS', 'LIKES', 'NEW']), start: end(), end: end(), ...(r.chance(0.4) ? { props: map('w', value(r)) } : {}) }));
        return p.graphCreate('g', rows, nodes, rels);
      }
      default: {
        // The nodes whose `x` is the row's first column, or a new one with it.
        const row = p.working(9, ['int', 'int', 'int']);
        const found = p.filter(p.join('cross', row, p.scan('node', [0, 1])), p.call('cmp_eq', [p.call('map_get', [p.col(0, 4, M), p.lit('x')], 'any'), any(a)], 'bool'));
        return p.graphMerge('g', 9, rows, p.project(found, [p.col(0, 2, 'int'), p.col(0, 3, 'int')]), {
          nodes: [{ labels: r.chance(0.5) ? ['Tag'] : [], props: map('x', any(a)) }],
          created: [p.col(0, 2, 'int')],
          ...(r.chance(0.7) ? { key: [a] } : {}),
        });
      }
    }
  };
  /** What a plan gives and leaves: its rows and counts, or that it failed, and the graph after. */
  const outcome = (seed: number, shape: (w: PlanOp) => PlanOp): unknown[] => {
    const r = random(seed);
    const db = world(r);
    let result: unknown;
    try {
      const done = write(db, shape(plan(r)));
      result = [done.rows, done.graph];
    } catch (e) {
      // Which of two failures is reported may differ: that it failed may not.
      result = 'failed';
      void e;
    }
    const types = db.query("SELECT name FROM sqlite_schema WHERE name IN ('KNOWS', 'LIKES', 'NEW') ORDER BY name").rows.map((t) => t[0] as string);
    return [result, nodes(db), labels(db), ...types.map((t) => rels(db, t))];
  };

  // SMALT_GRAPH_PLANS: how many plans (150 unless set), from seed SMALT_GRAPH_SEED (1 unless set).
  const PLANS = Number(process.env.SMALT_GRAPH_PLANS ?? 150);
  const FIRST = Number(process.env.SMALT_GRAPH_SEED ?? 1);

  it(`${PLANS} plans`, { timeout: 30_000 + 100 * PLANS }, () => {
    let failed = 0;
    let wrote = 0;
    for (let seed = FIRST; seed < FIRST + PLANS; seed++) {
      const once = outcome(seed, (w) => w);
      const each = outcome(seed, (w) => p.limit(w, 1000));
      expect(once, `seed ${seed}`).toEqual(each);
      if (once[0] === 'failed') failed++;
      else if (Object.values((once[0] as [unknown, GraphWriteCounts])[1]).some((n) => n > 0)) wrote++;
    }
    // The plans are worth running: most write something, and some fail.
    expect(wrote).toBeGreaterThan(PLANS / 2);
    expect(failed).toBeGreaterThan(PLANS / 20);
  });
});

describe('hops and paths', () => {
  const HOP = 'struct<edge int, rowid int, from int, to int>';
  const hop = (edge: number, rowid: number, from: number, to: number): PlanExpr => p.call('struct_of', [p.lit(edge), p.lit(rowid), p.lit(from), p.lit(to)], HOP);
  const hops = (...h: PlanExpr[]): PlanExpr => p.call('list_of', h, `list<${HOP}>`);
  /** Four nodes in a line, 0 to 3: KNOWS from 0 to 1 and from 2 to 3, LIKES from 1 to 2. */
  const line = (): Database => {
    const db = graph();
    write(db, p.graphCreate('g', one, [{ labels: [] }, { labels: [] }, { labels: [] }, { labels: [] }], [
      { type: 'KNOWS', start: { node: 0 }, end: { node: 1 } },
      { type: 'LIKES', start: { node: 1 }, end: { node: 2 } },
      { type: 'KNOWS', start: { node: 2 }, end: { node: 3 } },
    ]));
    return db;
  };

  it('deletes the relationships of a list of hops, each by its type in the graph and its rowid', () => {
    const db = line();
    // KNOWS is the graph's first type and LIKES its second: KNOWS 2 and LIKES 1. A hop of a type the graph has not,
    // and a NULL, are passed over.
    const r = write(db, p.graphDelete('g', one, [{ hops: hops(hop(0, 2, 2, 3), hop(1, 1, 1, 2), hop(7, 0, 0, 0), p.lit(null, HOP)) }, { hops: p.lit(null, `list<${HOP}>`) }]));
    expect(r.graph).toEqual(counts({ relationshipsDeleted: 2 }));
    expect([rels(db, 'KNOWS'), rels(db, 'LIKES'), nodes(db).length]).toEqual([[[0, 0, 1, {}]], [], 4]);
  });

  it('deletes a path: its relationships, then its nodes', () => {
    const db = line();
    // From 0 over the first two relationships to 2: node 2 still has a relationship, so it is refused without detach.
    const path = { path: { start: p.lit(0), hops: hops(hop(0, 0, 0, 1), hop(1, 1, 1, 2)) } };
    expect(() => write(db, p.graphDelete('g', one, [path]))).toThrow(/relationships in KNOWS/);
    const r = write(db, p.graphDelete('g', one, [path, { path: { start: p.lit(null, 'int'), hops: hops() } }], { detach: true }));
    expect(r.graph).toEqual(counts({ relationshipsDeleted: 3, nodesDeleted: 3 }));
    expect([nodes(db), rels(db, 'KNOWS'), rels(db, 'LIKES')]).toEqual([[[3, {}]], [], []]);
    // A path that is all its nodes have needs no detach: its relationships go before its nodes.
    const whole = line();
    const all = write(whole, p.graphDelete('g', one, [{ path: { start: p.lit(0), hops: hops(hop(0, 0, 0, 1), hop(1, 1, 1, 2), hop(0, 2, 2, 3)) } }]));
    expect([all.graph, nodes(whole)]).toEqual([counts({ relationshipsDeleted: 3, nodesDeleted: 4 }), []]);
  });
});

describe('what a write reads', () => {
  const named = (...names: string[]): PlanOp => p.values(names.map((n) => [p.lit(n)]), ['text']);
  /** Whether a node has the row's name: a plan nested in the filter, read for each row. */
  const there = p.exists(p.filter(p.scan('node', [1]), p.call('cmp_eq', [p.call('map_get', [p.col(0, 0, M), p.lit('name')], 'any'), any(p.col(0, 0, 'text', 'binary', 1))], 'bool')));
  const create = (input: PlanOp): PlanOp => p.graphCreate('g', input, [{ labels: [], props: map('name', any(p.col(0, 0, 'text'))) }]);

  it('below it, an operation that reads the graph for each row reads what the rows before it wrote', () => {
    const db = graph();
    // A node for each name that has none: the second Ada finds the first one's.
    const r = write(db, create(p.filter(named('Ada', 'Ada', 'Bo'), p.not(there))));
    expect(r.rows).toEqual([['Ada', 0], ['Bo', 1]]);
    // Under an eager everything below is read first: no node has either name then.
    const all = write(db, create(p.eager(p.filter(named('Cy', 'Cy'), p.not(there)))));
    expect(all.rows).toEqual([['Cy', 2], ['Cy', 3]]);
  });

  it('above it, operations that read only their rows give the same over all the rows as for each', () => {
    const shaped = (input: PlanOp): PlanOp => p.project(p.filter(create(input), p.call('cmp_ne', [p.col(0, 0, 'text'), p.lit('Bo')], 'bool')), [p.call('text_concat', [p.col(0, 0, 'text'), p.lit('!')], 'text'), p.col(0, 1, 'int')]);
    const rows = [['Ada!', 0], ['Cy!', 2]];
    expect(write(graph(), shaped(named('Ada', 'Bo', 'Cy'))).rows).toEqual(rows);
    // Under a limit they run for each row as it is written: the limit stops the write when it has its rows.
    expect(write(graph(), p.limit(shaped(named('Ada', 'Bo', 'Cy')), 5)).rows).toEqual(rows);
    const db = graph();
    expect(write(db, p.limit(shaped(named('Ada', 'Bo', 'Cy')), 1)).rows).toEqual([['Ada!', 0]]);
    expect(nodes(db)).toEqual([[0, { name: 'Ada' }]]);
    // A sort reads all the rows written, then sorts them.
    const sorted = write(graph(), p.sort(create(named('Bo', 'Ada')), [{ expr: p.col(0, 0, 'text'), desc: false, nullsFirst: true, collation: 'binary' }]));
    expect(sorted.rows).toEqual([['Ada', 1], ['Bo', 0]]);
  });

  it('refuses a write where no row order says when it runs', () => {
    const db = graph();
    const made = p.graphCreate('g', one, [{ labels: [] }]);
    // In a plan nested in an expression.
    expect(() => write(db, p.graphSet('g', one, [{ node: p.scalar(made, 'int'), kind: 'labels', add: ['X'], remove: [] }]))).toThrow(/a write in a nested plan of an expression is not supported/);
    // On the right of a join, and on both sides of one.
    expect(() => write(db, p.join('cross', one, made))).toThrow(/a join whose right input writes is not supported/);
    expect(() => write(db, p.join('cross', made, made))).toThrow(/a join whose inputs both write is not supported/);
    // As the rows a table is given, and under a limit counted from the end.
    expect(() => write(db, p.append('node', made, [0]))).toThrow(/append over rows that were written is not supported/);
    expect(() => write(db, p.limit(made, 1, undefined, { fromEnd: true }))).toThrow(/a limit counted from the end over rows that were written is not supported/);
    // In a merge's match.
    expect(() => write(db, p.graphMerge('g', 4, one, p.project(p.graphCreate('g', p.working(4, ['int']), [{ labels: [] }]), [p.col(0, 0, 'int')]), { created: [] }))).toThrow(/a match that writes is not supported/);
    expect(nodes(db)).toEqual([]);
  });
});

describe('values that are only picked', () => {
  // A projection above a write whose columns are columns of its row, parameters or NULL, and a write's own values
  // that are (a node's id from a column, a property's value from a parameter), take no plan: they are read where
  // they lie. Each must give what the same plan gives where the values are computed.
  const num = p.col(0, 0, 'int');
  const name = p.col(0, 1, 'text');
  /** Rows of a number and a name, some of either NULL. */
  const rows = (): PlanOp => p.values([[p.lit(0), p.lit('a')], [p.lit(null, 'int'), p.lit('b')], [p.lit(2), p.lit(null, 'text')], [p.lit(3), p.lit('d')]], ['int', 'text']);
  /** The same value, computed. */
  const same = (e: PlanExpr, type: string): PlanExpr => p.call('coalesce', [e, e], type as never);
  /** A node for each row: its columns are the row's number and name, then the node's id. */
  const made = (): PlanOp => p.graphCreate('g', rows(), [{ labels: ['Person'], props: map('n', any(num)) }]);
  const node = p.col(0, 2, 'int');
  /** What a plan gives and leaves in a new graph: a statement is given as many parameters as its plan reads. */
  const outcome = (plan: PlanOp, params: unknown[] = ['p', 7]): unknown[] => {
    const db = graph();
    const r = write(db, plan, params);
    return [r.rows, r.graph, nodes(db), labels(db)];
  };

  it('a projection above a write: columns in any order and more than once, a parameter, NULL', () => {
    const picks = [node, num, num, p.lit(null, 'text'), p.param(0, 'text'), name, p.param(1, 'int')];
    const types = ['int', 'int', 'int', 'text', 'text', 'text', 'int'];
    const computed = picks.map((e, i) => same(e, types[i]!));
    const [got, , stored] = outcome(p.project(made(), picks));
    expect(got).toEqual([[0, 0, 0, null, 'p', 'a', 7], [1, null, null, null, 'p', 'b', 7], [2, 2, 2, null, 'p', null, 7], [3, 3, 3, null, 'p', 'd', 7]]);
    expect(stored).toEqual([[0, { n: 0 }], [1, {}], [2, { n: 2 }], [3, { n: 3 }]]);
    const shapes: [string, (w: PlanOp, exprs: PlanExpr[]) => PlanOp][] = [
      ['over all the rows', (w, e) => p.project(w, e)],
      ['row by row, under a limit', (w, e) => p.limit(p.project(w, e), 1000)],
      ['under a limit that stops the write', (w, e) => p.limit(p.project(w, e), 2)],
      ['above an eager', (w, e) => p.project(p.eager(w), e)],
      ['above an eager, under a limit', (w, e) => p.limit(p.project(p.eager(w), e), 3)],
      ['above a filter', (w, e) => p.project(p.filter(w, p.isNotNull(num)), e)],
      ['under a filter', (w, e) => p.filter(p.project(w, e), p.isNotNull(p.col(0, 5, 'text')))],
      ['under a sort', (w, e) => p.sort(p.project(w, e), [{ expr: p.col(0, 0, 'int'), desc: true, nullsFirst: true, collation: 'binary' }])],
      ['under another write', (w, e) => p.graphSet('g', p.project(w, e), [{ node: p.col(0, 0, 'int'), kind: 'property', key: 'seen', value: any(p.col(0, 4, 'text')) }])],
      // Its rows asked for all at once: by an eager, and by a write that takes them so.
      ['between two eagers', (w, e) => p.eager(p.project(p.eager(w), e))],
      ['above an eager, under another write', (w, e) => p.graphSet('g', p.project(p.eager(w), e), [{ node: p.col(0, 0, 'int'), kind: 'property', key: 'seen', value: any(p.col(0, 4, 'text')) }])],
    ];
    for (const [what, shape] of shapes) expect(outcome(shape(made(), picks)), what).toEqual(outcome(shape(made(), computed)));
    // A limit that stops the write stops it where it did: two nodes.
    expect((outcome(p.limit(p.project(made(), picks), 2))[2] as unknown[]).length).toBe(2);
  });

  it('a projection of a projection, and one of no columns', () => {
    // The first gives the name, the node and the number; the second picks from those.
    const first = [name, node, num];
    const second = [p.col(0, 2, 'int'), p.col(0, 0, 'text'), p.param(1, 'int'), p.col(0, 1, 'int')];
    const twice = outcome(p.project(p.project(made(), first), second));
    expect(twice[0]).toEqual([[0, 'a', 7, 0], [null, 'b', 7, 1], [2, null, 7, 2], [3, 'd', 7, 3]]);
    expect(twice).toEqual(outcome(p.project(p.project(made(), first.map((e, i) => same(e, ['text', 'int', 'int'][i]!))), second)));
    expect(twice).toEqual(outcome(p.project(p.project(made(), first), second.map((e, i) => same(e, ['int', 'text', 'int', 'int'][i]!)))));
    // No columns: a row of none for each row, and the write has run.
    const none = outcome(p.project(made(), []), []);
    expect(none[0]).toEqual([[], [], [], []]);
    expect((none[2] as unknown[]).length).toBe(4);
    expect(outcome(p.limit(p.project(made(), []), 3), [])[0]).toEqual([[], [], []]);
    expect(outcome(p.project(p.eager(made()), []), [])).toEqual(none);
  });

  /** Five nodes with `i` and `x`, each joined to the next. */
  const world = (): Database => {
    const db = graph();
    write(db, p.graphCreate('g', numbers(5), [{ labels: ['Person'], props: map('i', any(p.col(0, 0, 'int')), 'x', any(p.lit('old'))) }]));
    write(db, p.graphCreate('g', numbers(4), [], [{ type: 'KNOWS', start: { id: p.col(0, 0, 'int') }, end: { id: p.call('add', [p.col(0, 0, 'int'), p.lit(1)], 'int') } }]));
    return db;
  };
  const state = (plan: PlanOp, params: unknown[]): unknown[] => {
    const db = world();
    const r = write(db, plan, params);
    return [r.rows, r.graph, nodes(db), labels(db), rels(db, 'KNOWS')];
  };
  /** A write's plan with values that pick and with the same values computed, all its rows at once and row by row: all four give the same. */
  const fourWays = (plan: (pick: (e: PlanExpr, type: string) => PlanExpr) => PlanOp, params: unknown[] = []): unknown[] => {
    const ways = [state(plan((e) => e), params), state(plan(same), params), state(p.limit(plan((e) => e), 1000), params), state(p.limit(plan(same), 1000), params)];
    for (const w of ways.slice(1)) expect(w).toEqual(ways[0]);
    return ways[0]!;
  };

  it("a write's own values: what graphSet sets and on which node", () => {
    const [, graphCounts, stored] = fourWays((pick) =>
      p.graphSet('g', rows(), [
        { node: pick(num, 'int'), kind: 'property', key: 'x', value: any(pick(p.param(0, 'text'), 'text')) },
        { node: pick(num, 'int'), kind: 'property', key: 'name', value: any(pick(name, 'text')) },
        { node: pick(num, 'int'), kind: 'property', key: 'i', value: pick(p.lit(null), 'any') },
      ]),
      ['p'],
    );
    expect(stored).toEqual([[0, { name: 'a', x: 'p' }], [1, { i: 1, x: 'old' }], [2, { x: 'p' }], [3, { name: 'd', x: 'p' }], [4, { i: 4, x: 'old' }]]);
    // Three rows name a node, and each of the three items counts for each: a key taken away counts as one set.
    expect((graphCounts as GraphWriteCounts).propertiesSet).toBe(9);
  });

  it("a write's own values: the nodes graphDelete deletes, the labels graphSet adds, and the ends of what graphCreate makes", () => {
    // The node is the rows' second column: what is picked is not the row as it is.
    const named = (): PlanOp => p.values([[p.lit('a'), p.lit(0)], [p.lit('b'), p.lit(null, 'int')], [p.lit('c'), p.lit(2)], [p.lit('d'), p.lit(3)]], ['text', 'int']);
    const second = p.col(0, 1, 'int');
    const deleted = fourWays((pick) => p.graphDelete('g', named(), [{ node: pick(second, 'int') }], { detach: true }));
    expect((deleted[2] as unknown[][]).map((n) => n[0])).toEqual([1, 4]);
    expect(deleted[1]).toEqual(counts({ nodesDeleted: 3, relationshipsDeleted: 4 }));
    const tagged = fourWays((pick) => p.graphSet('g', named(), [{ node: pick(second, 'int'), kind: 'labels', add: ['Seen'], remove: ['Person'] }]));
    expect(tagged[3]).toEqual([[0, 'Seen'], [1, 'Person'], [2, 'Seen'], [3, 'Seen'], [4, 'Person']]);
    // A relationship from the second column's node to the first's.
    const pairs = (): PlanOp => p.values([[p.lit(0), p.lit(4)], [p.lit(4), p.lit(1)], [p.lit(2), p.lit(2)]], ['int', 'int']);
    const joined = fourWays((pick) => p.graphCreate('g', pairs(), [], [{ type: 'KNOWS', start: { id: pick(p.col(0, 1, 'int'), 'int') }, end: { id: pick(p.col(0, 0, 'int'), 'int') } }]));
    expect((joined[4] as unknown[][]).slice(4).map((r) => r.slice(0, 3))).toEqual([[4, 4, 0], [5, 1, 4], [6, 2, 2]]);
  });
});

describe('expressions that hold no nested plan', () => {
  // A write's expressions over its row, and a projection's above a write, are compiled as expressions where they hold
  // no nested plan: they are computed for each row with no plan run (`GraphWrite.program`). One that holds a plan is
  // run as a plan. Each must give what a plan gives for it: the same expression as the one branch of a CASE whose
  // condition is a nested plan that is always true.
  const num = p.col(0, 0, 'int');
  const name = p.col(0, 1, 'text');
  /** Rows of a number and a name, some of either NULL. */
  const rows = (): PlanOp => p.values([[p.lit(0), p.lit('a')], [p.lit(null, 'int'), p.lit('b')], [p.lit(2), p.lit(null, 'text')], [p.lit(3), p.lit('d')]], ['int', 'text']);
  /** `e` computed by a plan: it holds one, which finds the one empty row. */
  const planned = (e: PlanExpr, type: string): PlanExpr => p.caseWhen([{ when: p.exists(one), then: e }], type as never, p.lit(null, type as never));
  type Way = (e: PlanExpr, type: string) => PlanExpr;
  const compiled: Way = (e) => e;

  /** Expressions over a number and a name, with their types: arithmetic, text, a CASE, a truth value, a list, a cast, a map. */
  const EXPRS: [string, (n: PlanExpr, t: PlanExpr) => PlanExpr, string][] = [
    ['a sum with a parameter', (n) => p.call('add', [n, p.param(1, 'int')], 'int'), 'int'],
    ['text joined to a parameter', (_n, t) => p.call('concat', [t, p.lit('-'), p.param(0, 'text')], 'text'), 'text'],
    ['a CASE', (n) => p.caseWhen([{ when: p.isNull(n), then: p.lit(-1) }], 'int', p.call('mul', [n, n], 'int')), 'int'],
    ['a truth value', (n) => p.call('cmp_lt', [n, p.lit(2)], 'bool'), 'bool'],
    ['a list', (n) => p.call('list_of', [n, p.lit(9)], 'list<int>'), 'list<int>'],
    ['a number as text', (n) => p.cast('cast_text', n, 'text'), 'text'],
    ['a map of two kinds', (n, t) => p.call('map_of', [p.lit('n'), any(n), p.lit('t'), any(t)], M), M],
  ];

  /** How many parameters a plan reads: a statement is given as many. */
  const paramsOf = (x: unknown): number => {
    if (x === null || typeof x !== 'object' || x instanceof Uint8Array) return 0;
    if (Array.isArray(x)) return x.reduce((m: number, y) => Math.max(m, paramsOf(y)), 0);
    const o = x as Record<string, unknown>;
    return Object.values(o).reduce((m: number, y) => Math.max(m, paramsOf(y)), o.k === 'param' ? (o.index as number) + 1 : 0);
  };
  /** What a plan gives and leaves in a new graph, run with a text and a number for its parameters. */
  const outcome = (plan: PlanOp, params: unknown[] = ['p', 7]): unknown[] => {
    const db = graph();
    const r = write(db, plan, params.slice(0, paramsOf(plan)));
    return [r.rows, r.graph, nodes(db), labels(db)];
  };
  /** A plan with its expressions compiled and with them run as plans, all its rows at once and row by row: all four give the same. */
  const fourWays = (plan: (way: Way) => PlanOp, params?: unknown[]): unknown[] => {
    const ways = [outcome(plan(compiled), params), outcome(plan(planned), params), outcome(p.limit(plan(compiled), 1000), params), outcome(p.limit(plan(planned), 1000), params)];
    ways.slice(1).forEach((w, i) => expect(w, ['run as plans', 'row by row', 'row by row, as plans'][i]).toEqual(ways[0]));
    return ways[0]!;
  };

  it("the properties of what graphCreate makes: each kind of expression gives what its plan gives", () => {
    for (const [what, expr, type] of EXPRS) {
      const made = fourWays((way) => p.graphCreate('g', rows(), [{ labels: ['Person'], props: map('v', any(way(expr(num, name), type))) }]));
      expect((made[2] as unknown[]).length, what).toBe(4);
    }
    // What two of them leave: a NULL is no property, and a truth value and a list keep their kinds.
    const sum = fourWays((way) => p.graphCreate('g', rows(), [{ labels: [], props: map('v', any(way(EXPRS[0]![1](num, name), 'int'))) }]));
    expect(sum[2]).toEqual([[0, { v: 7 }], [1, {}], [2, { v: 9 }], [3, { v: 10 }]]);
    const truth = fourWays((way) => p.graphCreate('g', rows(), [{ labels: [], props: map('v', any(way(EXPRS[3]![1](num, name), 'bool')), 'l', any(way(EXPRS[4]![1](num, name), 'list<int>'))) }]));
    expect(truth[2]).toEqual([[0, { l: [0, 9], v: true }], [1, { l: [null, 9] }], [2, { l: [2, 9], v: false }], [3, { l: [3, 9], v: false }]]);
    // The whole map given by one expression, and a relationship's properties.
    const whole = fourWays((way) => p.graphCreate('g', rows(), [{ labels: [], props: way(EXPRS[6]![1](num, name), M) }]));
    expect(whole[2]).toEqual([[0, { n: 0, t: 'a' }], [1, { t: 'b' }], [2, { n: 2 }], [3, { n: 3, t: 'd' }]]);
    const joined = (way: Way): unknown[] => {
      const db = graph();
      const r = write(db, p.graphCreate('g', rows(), [{ labels: [] }], [{ type: 'KNOWS', start: { node: 0 }, end: { node: 0 }, props: map('w', any(way(EXPRS[2]![1](num, name), 'int'))) }]));
      return [r.rows, r.graph, rels(db, 'KNOWS')];
    };
    expect(joined(compiled)).toEqual(joined(planned));
    expect((joined(compiled)[2] as unknown[][]).map((r) => r[3])).toEqual([{ w: 0 }, { w: -1 }, { w: 4 }, { w: 9 }]);
  });

  it('what graphSet sets, and a projection above a write', () => {
    for (const [what, expr, type] of EXPRS) {
      // On the nodes a first write made: the value reads the row's number and name, the node is the row's third column.
      const set = fourWays((way) => p.graphSet('g', p.graphCreate('g', rows(), [{ labels: [] }]), [{ node: p.col(0, 2, 'int'), kind: 'property', key: 'v', value: any(way(expr(num, name), type)) }]));
      expect((set[2] as unknown[]).length, what).toBe(4);
    }
    const set = fourWays((way) => p.graphSet('g', p.graphCreate('g', rows(), [{ labels: [] }]), [{ node: p.col(0, 2, 'int'), kind: 'property', key: 'v', value: any(way(EXPRS[2]![1](num, name), 'int')) }]));
    expect(set[2]).toEqual([[0, { v: 0 }], [1, { v: -1 }], [2, { v: 4 }], [3, { v: 9 }]]);
    // A projection of every one of them above a write, beside columns it only picks.
    const all = fourWays((way) => p.project(p.graphCreate('g', rows(), [{ labels: [] }]), [p.col(0, 2, 'int'), ...EXPRS.map(([, expr, type]) => way(expr(num, name), type)), name]));
    expect((all[0] as unknown[][])[0]).toEqual([0, 7, 'a-p', 0, true, [0, 9], '0', { n: 0, t: 'a' }, 'a']);
    // A map that is a row's value keeps a NULL entry: it is as properties that a NULL is no property.
    expect((all[0] as unknown[][])[1]).toEqual([1, null, 'b-p', -1, null, [null, 9], null, { n: null, t: 'b' }, 'b']);
    // Under a limit that stops the write: two rows, two nodes.
    const two = outcome(p.limit(p.project(p.graphCreate('g', rows(), [{ labels: [] }]), [EXPRS[0]![1](num, name)]), 2));
    expect([two[0], (two[2] as unknown[]).length]).toEqual([[[7], [null]], 2]);
  });

  it('an expression that raises does so for the row it raises for, and nothing is left written', () => {
    const loud = (n: PlanExpr): PlanExpr => p.caseWhen([{ when: p.call('cmp_eq', [n, p.lit(2)], 'bool'), then: p.call('raise_error', [p.lit('the third row')], 'int') }], 'int', n);
    for (const way of [compiled, planned]) {
      for (const shape of [(w: PlanOp) => w, (w: PlanOp) => p.limit(w, 1000)]) {
        const db = graph();
        expect(() => write(db, shape(p.graphCreate('g', rows(), [{ labels: [], props: map('v', any(way(loud(num), 'int'))) }])))).toThrow(/the third row/);
        expect(() => write(db, shape(p.project(p.graphCreate('g', rows(), [{ labels: [] }]), [way(loud(num), 'int')])))).toThrow(/the third row/);
        expect(nodes(db)).toEqual([]);
        // A limit that stops before the row: it is not computed.
        expect(write(db, p.limit(p.project(p.graphCreate('g', rows(), [{ labels: [] }]), [way(loud(num), 'int')]), 2)).rows).toEqual([[0], [null]]);
      }
    }
  });

  it('a statement kept and run again computes with the values of each run', () => {
    const db = graph();
    const plan = p.project(p.graphCreate('g', p.values([[p.param(0, 'int')]], ['int']), [{ labels: [], props: map('v', any(p.call('add', [num, p.param(1, 'int')], 'int'))) }]), [p.call('mul', [num, p.param(1, 'int')], 'int'), p.col(0, 1, 'int')]);
    const kept = db.preparePlan({ kind: 'write', plan } as PlanStatementInput);
    expect([kept.result([3, 10] as never).rows, kept.result([4, 100] as never).rows, kept.result([null, 5] as never).rows]).toEqual([[[30, 0]], [[400, 1]], [[null, 2]]]);
    expect(nodes(db)).toEqual([[0, { v: 13 }], [1, { v: 104 }], [2, {}]]);
  });

  it('rows given as columns, and rows written out with parameters, are a write\'s input', () => {
    // `values` whose rows are data in columns has no expressions: its rows are read by a plan.
    const columns = outcome(p.graphCreate('g', p.fromColumns([[5, 6, 7]], ['int']), [{ labels: [], props: map('v', any(num)) }]));
    expect(columns[2]).toEqual([[0, { v: 5 }], [1, { v: 6 }], [2, { v: 7 }]]);
    // Rows of parameters and NULLs are made with no plan, under an eager or not; a row that computes is read by one.
    const written = (input: PlanOp): unknown => outcome(p.graphCreate('g', input, [{ labels: [], props: map('v', any(num), 't', any(name)) }]))[2];
    const params = p.values([[p.param(1, 'int'), p.param(0, 'text')], [p.lit(null, 'int'), p.param(0, 'text')], [p.param(1, 'int'), p.lit(null, 'text')]], ['int', 'text']);
    const expected = [[0, { t: 'p', v: 7 }], [1, { t: 'p' }], [2, { v: 7 }]];
    expect([written(params), written(p.eager(params)), written(p.eager(p.eager(params)))]).toEqual([expected, expected, expected]);
    const computed = p.values([[p.call('add', [p.param(1, 'int'), p.lit(0)], 'int'), p.param(0, 'text')], [p.lit(null, 'int'), p.param(0, 'text')], [p.param(1, 'int'), p.lit(null, 'text')]], ['int', 'text']);
    expect(written(computed)).toEqual(expected);
  });

  it('no plan is run for them, and one is for an expression that holds a plan', () => {
    /** How many plans of its own the engine runs while `f` does (`Database.internalPlan`). */
    const plansRun = (db: Database, f: () => void): number => {
      const d = db as unknown as { internalPlan: (...a: unknown[]) => unknown };
      const inner = d.internalPlan;
      let n = 0;
      d.internalPlan = function (this: unknown, ...a: unknown[]): unknown {
        n++;
        return inner.apply(this, a);
      };
      try {
        f();
      } finally {
        delete (d as { internalPlan?: unknown }).internalPlan;
      }
      return n;
    };
    const db = graph();
    // The tables are not written and compared at each statement's end, which runs plans of its own.
    db.graphChecks = false;
    const sum = (way: Way): PlanExpr => way(p.call('add', [p.param(0, 'int'), p.lit(1)], 'int'), 'int');
    const node = (way: Way): PlanOp => p.graphCreate('g', one, [{ labels: ['Person'], props: map('v', any(sum(way))) }]);
    write(db, node(compiled), [1]);
    // One node with a computed property, from the one empty row: nothing is read, and nothing is run to compute.
    expect(plansRun(db, () => write(db, node(compiled), [2]))).toBe(0);
    // The one empty row under an eager, as a language gives it where the write has no input of its own.
    expect(plansRun(db, () => write(db, p.graphCreate('g', p.eager(one), [{ labels: ['Person'], props: map('v', any(sum(compiled))) }]), [2]))).toBe(0);
    expect(plansRun(db, () => write(db, p.project(node(compiled), [p.call('mul', [p.col(0, 0, 'int'), p.lit(2)], 'int')]), [3]))).toBe(0);
    // Many rows: the plan that reads them, and none for what is computed for each.
    const many = p.source('function', 'range', [p.lit(1), p.lit(50)], ['int']);
    expect(plansRun(db, () => write(db, p.project(p.graphCreate('g', many, [{ labels: [], props: map('v', any(p.call('add', [num, p.param(0, 'int')], 'int'))) }]), [p.call('mul', [num, num], 'int')]), [4]))).toBe(1);
    // A SET of a computed value, and of a parameter, on the rows of one read.
    const ids = p.scan('node', [0]);
    expect(plansRun(db, () => write(db, p.graphSet('g', ids, [{ node: num, kind: 'property', key: 'a', value: any(p.call('add', [num, p.param(0, 'int')], 'int')) }]), [5]))).toBe(1);
    expect(plansRun(db, () => write(db, p.graphSet('g', ids, [{ node: num, kind: 'property', key: 'b', value: any(p.param(0, 'int')) }]), [6]))).toBe(1);
    // What is compiled for a statement: its expressions once, when they are first computed, and nothing where they
    // only pick (a SET's node from a column, its value a parameter).
    const compiles = (f: () => void): number => {
      const host = (db as unknown as { graphWriteHost: { compute: (...a: unknown[]) => unknown } }).graphWriteHost;
      const inner = host.compute;
      let n = 0;
      host.compute = (...a: unknown[]): unknown => (n++, inner(...a));
      try {
        f();
      } finally {
        host.compute = inner;
      }
      return n;
    };
    const computed = p.graphSet('g', ids, [{ node: num, kind: 'property', key: 'c', value: any(p.call('mul', [num, p.param(0, 'int')], 'int')) }]);
    expect([compiles(() => write(db, computed, [2])), compiles(() => write(db, computed, [3]))]).toEqual([1, 0]);
    expect(compiles(() => write(db, p.graphSet('g', ids, [{ node: num, kind: 'property', key: 'd', value: any(p.param(0, 'int')) }]), [4]))).toBe(0);
    // A stage no row reaches compiles nothing.
    expect(compiles(() => write(db, p.graphSet('g', p.filter(ids, p.call('cmp_lt', [num, p.lit(0)], 'bool')), [{ node: num, kind: 'property', key: 'e', value: any(p.call('mul', [num, p.param(0, 'int')], 'int')) }]), [5]))).toBe(0);
    // An expression that holds a plan is run as one, for each row.
    expect(plansRun(db, () => write(db, node(planned), [7]))).toBeGreaterThan(0);
    expect(plansRun(db, () => write(db, p.limit(p.project(p.graphCreate('g', many, [{ labels: [] }]), [planned(p.call('mul', [num, num], 'int'), 'int')]), 1000)))).toBeGreaterThanOrEqual(50);
  });
});

describe('through the client', () => {
  class FakeWorker {
    onmessage: ((e: { data: Response }) => void) | null = null;
    onerror: unknown = null;
    private readonly server = new EngineServer((_s, msg) => setTimeout(() => this.onmessage?.({ data: structuredClone(msg) })), { open: () => Database.openMemory(), refreshTimer: false });
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

  it('a write gives what it did with its rows, and a kept one with its counts', async () => {
    const db = await client.open(':memory:', { storage: 'memory', worker: new FakeWorker() as unknown as Worker });
    opened.push(db);
    for (const op of graphSchema()) await db.queryPlan({ kind: 'schema', op } as unknown as PlanStatementInput);
    const made = { kind: 'write', plan: p.graphCreate('g', numbers(2), [{ labels: ['Person'], props: map('i', any(p.col(0, 0, 'int'))) }]) } as PlanStatementInput;
    const r = await db.queryPlan(made, [], { rowMode: 'array' });
    expect([[...r], r.changes, r.graph]).toEqual([[[0, 0], [1, 1]], 6, counts({ nodesCreated: 2, labelsAdded: 2, propertiesSet: 2 })]);
    const kept = await db.preparePlan(made);
    expect((await kept.run()).graph).toEqual(counts({ nodesCreated: 2, labelsAdded: 2, propertiesSet: 2 }));
    // A statement that writes no graph has none.
    const read = await db.queryPlan({ kind: 'query', plan: p.scan('node', [0]) } as PlanStatementInput, [], { rowMode: 'array' });
    expect([read.length, (read as { graph?: unknown }).graph]).toEqual([4, undefined]);
    await kept.finalize();
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
