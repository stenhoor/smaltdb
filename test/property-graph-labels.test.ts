/**
 * Property graphs, part 4 (ADR 0033, decision 5): the label index. A node's table gives its first label; the label
 * index, a table of (node, label) rows, gives it more. The engine keeps it (decision 12): entries name nodes and labels
 * of the graph, and follow their node when it is deleted or its id changes.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const op = (o: Record<string, unknown>) => ({ kind: 'schema', op: o }) as unknown as PlanStatementInput;
const addLabelIndex = (extra: Record<string, unknown> = {}) => op({ op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabelIndex', ...extra } });
const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

function setup(db: Database): Database {
  db.exec(`
    CREATE TABLE person(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE company(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE knows(start INTEGER, end INTEGER);
  `);
  db.queryPlan(
    op({
      op: 'createPropertyGraph',
      ifNotExists: false,
      graph: {
        name: 'g',
        nodes: [
          { label: 'Person', table: 'person', id: 'id' },
          { label: 'Company', table: 'company', id: 'id' },
          { label: 'Admin', table: 'admin', id: 'id' },
        ],
        edges: [{ type: 'KNOWS', table: 'knows', start: 'start', end: 'end' }],
      },
    }),
  );
  return db;
}

function fresh(): Database {
  const db = Database.openMemory();
  db.exec('CREATE TABLE admin(id INTEGER PRIMARY KEY)');
  setup(db);
  db.queryPlan(addLabelIndex());
  db.exec("INSERT INTO person VALUES (1, 'Ada'), (2, 'Charles'); INSERT INTO company VALUES (3, 'Acme')");
  return db;
}

describe('adding the label index', () => {
  it('creates <graph>_labels with node and label, a unique (label, node) index and a node index', () => {
    const db = fresh();
    const t = db.catalog.table('g_labels')!;
    expect(t.columns.map((c) => [c.name, c.storageType, c.notNull])).toEqual([
      ['node', 'INTEGER', true],
      ['label', 'TEXT', true],
    ]);
    expect(t.indexes.map((i) => [i.name, i.unique]).sort()).toEqual([
      ['g_labels_label', true],
      ['g_labels_node', false],
    ]);
    expect(db.catalog.graph('g')!.labels).toEqual({ table: 'g_labels', node: 'node', label: 'label' });
  });

  it('takes a table name, adopts a table that fits, and refuses one that does not', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE admin(id INTEGER PRIMARY KEY)');
    setup(db);
    expect(() => db.queryPlan(addLabelIndex({ table: 'person' }))).toThrow(/table person is listed twice/);
    db.exec('CREATE TABLE tags(node INTEGER, label INTEGER)');
    expect(() => db.queryPlan(addLabelIndex({ table: 'tags' }))).toThrow(/the label column tags\.label is INTEGER, not TEXT/);
    expect(db.catalog.graph('g')!.labels).toBeUndefined();
    db.exec('CREATE TABLE node_labels(node INTEGER, label TEXT)');
    db.queryPlan(addLabelIndex({ table: 'node_labels' }));
    expect(db.catalog.graph('g')!.labels!.table).toBe('node_labels');
  });

  it('a second one is an error, or a no-op with ifNotExists', () => {
    const db = fresh();
    expect(() => db.queryPlan(addLabelIndex())).toThrow(/already has a label index \(g_labels\)/);
    db.queryPlan(op({ op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabelIndex' }, ifNotExists: true }));
  });

  it('can be given when the graph is created, and its table is then the graph\'s', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE p(id INTEGER PRIMARY KEY); CREATE TABLE l(node INTEGER, label TEXT)');
    db.queryPlan(op({ op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'h', nodes: [{ label: 'P', table: 'p', id: 'id' }], edges: [], labels: { table: 'l', node: 'node', label: 'label' } } }));
    expect(() => db.exec('DROP TABLE l')).toThrow(/used by property graph h/);
    expect(() => db.exec('ALTER TABLE l RENAME COLUMN label TO tag')).toThrow(/column label of table l is used by property graph h/);
  });
});

describe('entries', () => {
  it('give a node more labels: a label finds its nodes through the index', () => {
    const db = fresh();
    db.exec("INSERT INTO g_labels VALUES (1, 'Admin'), (3, 'Person')");
    const admins = db.query("SELECT id FROM admin UNION SELECT node FROM g_labels WHERE label = 'Admin'").rows;
    expect(admins).toEqual([[1]]);
    expect(db.query('SELECT label FROM g_labels WHERE node = 3').rows).toEqual([['Person']]);
  });

  it('name a node of the graph', () => {
    const db = fresh();
    expect(code(() => db.exec("INSERT INTO g_labels VALUES (9, 'Admin')"))).toBe('SMALT_CONSTRAINT_FOREIGNKEY');
    expect(() => db.exec("INSERT INTO g_labels VALUES (9, 'Admin')")).toThrow(/g_labels\.node = 9 is not a node of the graph/);
  });

  it("name a label of the graph, spelled as the graph spells it, other than the node's table's", () => {
    const db = fresh();
    expect(() => db.exec("INSERT INTO g_labels VALUES (1, 'Robot')")).toThrow(/g_labels\.label = "Robot" is not a label of the graph/);
    expect(() => db.exec("INSERT INTO g_labels VALUES (1, 'admin')")).toThrow(/labels are case-sensitive: Admin/);
    expect(() => db.exec("INSERT INTO g_labels VALUES (1, 'Person')")).toThrow(/node 1 has that label already, as a row of person/);
    expect(db.query('SELECT count(*) FROM g_labels').rows).toEqual([[0]]);
  });

  it('are unique per node and label', () => {
    const db = fresh();
    db.exec("INSERT INTO g_labels VALUES (1, 'Admin')");
    expect(code(() => db.exec("INSERT INTO g_labels VALUES (1, 'Admin')"))).toBe('SMALT_CONSTRAINT_UNIQUE');
  });

  it('are checked when they change', () => {
    const db = fresh();
    db.exec("INSERT INTO g_labels VALUES (1, 'Admin')");
    expect(() => db.exec('UPDATE g_labels SET node = 9')).toThrow(/is not a node of the graph/);
    expect(() => db.exec("UPDATE g_labels SET label = 'Person'")).toThrow(/has that label already/);
    db.exec('UPDATE g_labels SET node = 2');
    expect(db.query('SELECT node, label FROM g_labels').rows).toEqual([[2, 'Admin']]);
  });
});

describe('a node with labels', () => {
  it('takes them with it when it is deleted', () => {
    const db = fresh();
    db.exec("INSERT INTO g_labels VALUES (1, 'Admin'), (2, 'Admin'), (3, 'Person')");
    db.exec('DELETE FROM person WHERE id = 1');
    expect(db.query('SELECT node, label FROM g_labels ORDER BY node').rows).toEqual([
      [2, 'Admin'],
      [3, 'Person'],
    ]);
    db.exec('DELETE FROM company');
    expect(db.query('SELECT node FROM g_labels').rows).toEqual([[2]]);
  });

  it('keeps them when the delete is refused (relationships), and takes them when its id changes', () => {
    const db = fresh();
    db.exec("INSERT INTO g_labels VALUES (1, 'Admin'); INSERT INTO knows VALUES (2, 1)");
    expect(code(() => db.exec('DELETE FROM person WHERE id = 1'))).toBe('SMALT_CONSTRAINT_FOREIGNKEY');
    expect(db.query('SELECT node FROM g_labels').rows).toEqual([[1]]);
    db.exec("INSERT INTO g_labels VALUES (2, 'Admin'); DELETE FROM knows");
    db.exec('UPDATE person SET id = 10 WHERE id = 2');
    expect(db.query('SELECT node FROM g_labels ORDER BY node').rows).toEqual([[1], [10]]);
  });

  it('a rolled-back delete keeps its labels', () => {
    const db = fresh();
    db.exec("INSERT INTO g_labels VALUES (1, 'Admin')");
    db.exec('BEGIN; DELETE FROM person WHERE id = 1; ROLLBACK');
    expect(db.query('SELECT node FROM g_labels').rows).toEqual([[1]]);
  });
});

describe('the record', () => {
  it('survives reopening, and a rollback undoes the table and the record', () => {
    const vfs = new MemoryVfs();
    const open = () => Database.openFile(vfs.openSync('a.db'), {}, vfs.openSync('a.db-wal'));
    let db = open();
    db.exec('CREATE TABLE admin(id INTEGER PRIMARY KEY)');
    setup(db);
    db.exec('BEGIN');
    db.queryPlan(addLabelIndex());
    db.exec('ROLLBACK');
    expect(db.catalog.table('g_labels')).toBeUndefined();
    expect(db.catalog.graph('g')!.labels).toBeUndefined();
    db.queryPlan(addLabelIndex());
    db.exec("INSERT INTO person VALUES (1, 'Ada'); INSERT INTO g_labels VALUES (1, 'Admin')");
    db.close();
    db = open();
    expect(db.catalog.graph('g')!.labels!.table).toBe('g_labels');
    expect(() => db.exec("INSERT INTO g_labels VALUES (1, 'Robot')")).toThrow(/not a label of the graph/);
    db.close();
  });
});
