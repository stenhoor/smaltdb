/**
 * A graph's next ids (`GraphWriteHost.ids`, `Database.graphIdsOf`; ADR 0042): the id a new node takes and the rowid a
 * new relationship takes, each one more than the largest the graph has had. They are kept from one statement to the
 * next, and read from the ends of the graph's tables again only when a page was changed since they were read.
 */
import { describe, expect, it } from 'vitest';
import { Database, type DatabaseOptions } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const M = 'map<text, any>';
const schema = (db: Database, op: Record<string, unknown>): void => void db.queryPlan({ kind: 'schema', op } as unknown as PlanStatementInput);
const column = (name: string, type: string, declaredType = type) => ({ name, declaredType, type, notNull: false, collation: 'binary' });

/** An empty graph `g` in `db`: nodes in `node(id, props)`, the label index, the label Person (`l_person`) and the type KNOWS (`knows`). */
function graphIn(db: Database): Database {
  const key = [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], ofColumn: 0 }];
  schema(db, { op: 'createTable', table: { name: 'node', columns: [column('id', 'INTEGER'), column('props', 'MAP', M)], keys: key, checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false });
  schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'g', nodes: [{ label: 'Node', table: 'node', id: 'id', props: 'props' }], edges: [] } });
  schema(db, { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabelIndex' } });
  schema(db, { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabel', label: 'Person', table: 'l_person' } });
  schema(db, { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addType', type: 'KNOWS', table: 'knows' } });
  return db;
}

/** A graph in memory whose writes land in its index and stay ahead of its tables between statements. */
function behind(options: DatabaseOptions = {}): Database {
  const db = graphIn(Database.openMemory(options));
  // With the check on (as in every other test, `test/setup-sql.ts`) each statement that writes ends by writing the tables.
  db.graphChecks = false;
  return db;
}

/** The ways a graph's writes reach its tables: the ids are the same in each. */
const WAYS: [string, () => Database][] = [
  ['its writes land in its index, ahead of its tables', () => behind()],
  ['its tables are written when each statement ends', () => graphIn(Database.openMemory())],
  ['its writes go to its tables', () => graphIn(Database.openMemory({ graphWriteBehind: false }))],
  ['it is in a file', () => graphIn(Database.openFile(new MemoryVfs().openSync('g.db')))],
];

const write = (db: Database, plan: PlanOp): unknown[][] => db.queryPlan({ kind: 'write', plan } as PlanStatementInput).rows;
const one = p.values([[]], []);
/** A new node: its id. */
const node = p.graphCreate('g', one, [{ labels: [] }]);
/** Two new nodes and a relationship from the first to the second: their ids, and the relationship's rowid. */
const pair = p.graphCreate('g', one, [{ labels: [] }, { labels: [] }], [{ type: 'KNOWS', start: { node: 0 }, end: { node: 1 } }]);
const ids = (db: Database, table: string, column = 'id'): unknown[] => db.query(`SELECT ${column} FROM ${table} ORDER BY 1`).rows.map((r) => r[0]);

describe.each(WAYS)("a graph's next ids, where %s", (_way, open) => {
  it('count on from one statement to the next', () => {
    const db = open();
    expect([write(db, node), write(db, node), write(db, pair), write(db, pair), write(db, node)]).toEqual([[[0]], [[1]], [[2, 3, 0]], [[4, 5, 1]], [[6]]]);
    expect([ids(db, 'node'), ids(db, 'knows', 'rowid')]).toEqual([[0, 1, 2, 3, 4, 5, 6], [0, 1]]);
  });

  it('go past a row another statement put in one of its tables', () => {
    const db = open();
    expect(write(db, node)).toEqual([[0]]);
    // The node table, written by a statement that is no write of the graph.
    db.exec('INSERT INTO node (id) VALUES (40)');
    expect(write(db, node)).toEqual([[41]]);
    // A label's table is a node table too: ids are counted across them.
    db.exec('INSERT INTO l_person (id) VALUES (60)');
    expect(write(db, node)).toEqual([[61]]);
    // A type's table: the relationships' rowids are counted on their own.
    expect(write(db, pair)).toEqual([[62, 63, 0]]);
    db.exec('INSERT INTO knows (rowid, start, "end") VALUES (30, 0, 41)');
    expect(write(db, pair)).toEqual([[64, 65, 31]]);
    expect(write(db, node)).toEqual([[66]]);
    expect([ids(db, 'node'), ids(db, 'knows', 'rowid')]).toEqual([[0, 40, 41, 61, 62, 63, 64, 65, 66], [0, 30, 31]]);
  });

  it('are not given again where a transaction that took them is rolled back', () => {
    const db = open();
    expect(write(db, node)).toEqual([[0]]);
    // A row of another statement and a node past it, both undone: the node's id is not given again.
    db.exec('BEGIN');
    db.exec('INSERT INTO node (id) VALUES (100)');
    expect(write(db, pair)).toEqual([[101, 102, 0]]);
    db.exec('ROLLBACK');
    expect(write(db, pair)).toEqual([[103, 104, 1]]);
    // A transaction of nothing but the graph's own writes.
    db.exec('BEGIN');
    expect(write(db, pair)).toEqual([[105, 106, 2]]);
    db.exec('ROLLBACK');
    expect(write(db, pair)).toEqual([[107, 108, 3]]);
    expect([ids(db, 'node'), ids(db, 'knows', 'rowid')]).toEqual([[0, 103, 104, 107, 108], [1, 3]]);
  });

  it('are found in tables that have rows when the graph is first written', () => {
    const db = open();
    db.exec('INSERT INTO node (id) VALUES (7), (8)');
    db.exec('INSERT INTO knows (rowid, start, "end") VALUES (30, 7, 8)');
    // The nodes' ids are asked for first, and the relationships' rowids after them with no page changed in between:
    // each is read from its own tables.
    expect(write(db, node)).toEqual([[9]]);
    expect(write(db, pair)).toEqual([[10, 11, 31]]);
  });
});

describe("a graph's next ids, where its writes land in its index", () => {
  /** The names of the graph's tables a B+tree cursor is opened on from here on, in order. */
  function reads(db: Database): string[] {
    const opened: string[] = [];
    const tables = (db as unknown as { tables: Map<string, { rootPage: number }> }).tables;
    for (const name of ['node', 'l_person', 'knows']) {
      const tree = db.tree(tables.get(name)!.rootPage);
      const cursor = tree.cursor.bind(tree);
      tree.cursor = () => (opened.push(name), cursor());
    }
    return opened;
  }

  it('are read from the ends of its tables once, and again only when a page was changed', () => {
    const db = behind();
    // The first node reads where the node tables end (and the graph's index is made for its writes).
    expect(write(db, node)).toEqual([[0]]);
    const opened = reads(db);
    // The first relationship reads where the types' tables end: the node tables are not read again.
    expect([write(db, pair), [...opened]]).toEqual([[[1, 2, 0]], ['knows']]);
    opened.length = 0;
    // From then on no page is changed (the rows are in the index, ahead of the tables), and no table is read.
    expect([write(db, node), write(db, pair), write(db, pair), write(db, node)]).toEqual([[[3]], [[4, 5, 1]], [[6, 7, 2]], [[8]]]);
    expect([opened, db.graphPendingState.settles]).toEqual([[], 0]);
    // A read of the node table from its B+tree has the tables written: pages changed, so the ends are read again.
    expect(ids(db, 'node').length).toBe(9);
    expect(db.graphPendingState.settles).toBe(1);
    opened.length = 0;
    expect([write(db, node), [...opened]]).toEqual([[[9]], ['node', 'l_person']]);
    opened.length = 0;
    expect([write(db, pair), [...opened]]).toEqual([[[10, 11, 3]], ['knows']]);
    opened.length = 0;
    expect([write(db, pair), write(db, node), opened]).toEqual([[[12, 13, 4]], [[14]], []]);
  });

  it('a statement that makes many nodes reads no more than one that makes one', () => {
    const db = behind();
    write(db, node);
    const opened = reads(db);
    const many = p.graphCreate('g', p.values(Array.from({ length: 50 }, (_, i) => [p.lit(i)]), ['int']), [{ labels: ['Person'] }]);
    expect(write(db, many).map((r) => r[1])).toEqual(Array.from({ length: 50 }, (_, i) => 1 + i));
    expect([write(db, node), opened]).toEqual([[[51]], []]);
  });
});
