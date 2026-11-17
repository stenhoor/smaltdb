/**
 * Property graphs, part 5 (ADR 0033, decisions 5 and 18): per-label copies. A label marked `copy` keeps its own row for
 * each node that has it through the label index: the node's id and the columns the two tables share by name. The
 * engine writes, updates and deletes the copy with the node and the entry; nobody else writes it.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const op = (o: Record<string, unknown>) => ({ kind: 'schema', op: o }) as unknown as PlanStatementInput;
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
    CREATE TABLE person(id INTEGER PRIMARY KEY, name TEXT, age INTEGER);
    CREATE TABLE admin(id INTEGER PRIMARY KEY, name TEXT, level INTEGER DEFAULT 1);
    CREATE TABLE robot(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE knows(start INTEGER, end INTEGER);
    CREATE TABLE labels(node INTEGER NOT NULL, label TEXT NOT NULL);
    CREATE UNIQUE INDEX labels_label ON labels(label, node); CREATE INDEX labels_node ON labels(node);
  `);
  db.queryPlan(
    op({
      op: 'createPropertyGraph',
      ifNotExists: false,
      graph: {
        name: 'g',
        nodes: [
          { label: 'Person', table: 'person', id: 'id' },
          { label: 'Admin', table: 'admin', id: 'id', copy: true },
          { label: 'Robot', table: 'robot', id: 'id' },
        ],
        edges: [{ type: 'KNOWS', table: 'knows', start: 'start', end: 'end' }],
        labels: { table: 'labels', node: 'node', label: 'label' },
      },
    }),
  );
  return db;
}

function fresh(): Database {
  const db = setup(Database.openMemory());
  db.exec("INSERT INTO person VALUES (1, 'Ada', 36), (2, 'Charles', 50)");
  return db;
}
const admins = (db: Database) => db.query('SELECT id, name, level FROM admin ORDER BY id').rows;

describe('a copy', () => {
  it('is written when a node gets the label: its id and the shared columns, defaults for the rest', () => {
    const db = fresh();
    db.exec("INSERT INTO labels VALUES (1, 'Admin')");
    expect(admins(db)).toEqual([[1, 'Ada', 1]]);
  });

  it("follows the node's columns when the node changes", () => {
    const db = fresh();
    db.exec("INSERT INTO labels VALUES (1, 'Admin'), (2, 'Admin')");
    db.exec("UPDATE person SET name = name || ' L.', age = age + 1");
    expect(admins(db)).toEqual([
      [1, 'Ada L.', 1],
      [2, 'Charles L.', 1],
    ]);
  });

  it('keeps its own columns: the label table can have columns the node has not', () => {
    const db = fresh();
    db.exec("INSERT INTO labels VALUES (1, 'Admin')");
    // The engine writes copies; the label's own columns are read from it, and are its defaults.
    expect(db.query('SELECT level FROM admin WHERE id = 1').rows).toEqual([[1]]);
  });

  it('is deleted with the entry, and with the node', () => {
    const db = fresh();
    db.exec("INSERT INTO labels VALUES (1, 'Admin'), (2, 'Admin')");
    db.exec("DELETE FROM labels WHERE node = 1");
    expect(admins(db)).toEqual([[2, 'Charles', 1]]);
    db.exec('DELETE FROM person WHERE id = 2');
    expect(admins(db)).toEqual([]);
    expect(db.query('SELECT count(*) FROM labels').rows).toEqual([[0]]);
  });

  it("moves with the node's id, and with an entry that changes", () => {
    const db = fresh();
    db.exec("INSERT INTO labels VALUES (1, 'Admin')");
    db.exec('UPDATE person SET id = 10 WHERE id = 1');
    expect(admins(db)).toEqual([[10, 'Ada', 1]]);
    db.exec('UPDATE labels SET node = 2');
    expect(admins(db)).toEqual([[2, 'Charles', 1]]);
    db.exec("UPDATE labels SET label = 'Robot'");
    expect(admins(db)).toEqual([]);
  });

  it('is only in the copy label: a label without copies keeps no row', () => {
    const db = fresh();
    db.exec("INSERT INTO labels VALUES (1, 'Robot')");
    expect(db.query('SELECT count(*) FROM robot').rows).toEqual([[0]]);
  });

  it("doesn't count as another node: the node keeps its id, relationships and labels", () => {
    const db = fresh();
    db.exec("INSERT INTO labels VALUES (1, 'Admin'); INSERT INTO knows VALUES (1, 2)");
    db.exec("INSERT INTO labels VALUES (1, 'Robot')");
    expect(db.query('SELECT label FROM labels WHERE node = 1 ORDER BY label').rows).toEqual([['Admin'], ['Robot']]);
    // The next id is after the copies too.
    db.exec("INSERT INTO robot(name) VALUES ('R2')");
    expect(db.query('SELECT id FROM robot').rows).toEqual([[3]]);
  });
});

describe('only the engine writes copies', () => {
  it('changing a copy is refused', () => {
    const db = fresh();
    db.exec("INSERT INTO labels VALUES (1, 'Admin')");
    expect(code(() => db.exec('UPDATE admin SET level = 5 WHERE id = 1'))).toBe('SMALT_CONSTRAINT_FOREIGNKEY');
    expect(() => db.exec("UPDATE admin SET name = 'x'")).toThrow(/row 1 of admin is a copy of node 1 of person, kept by the engine, and can't be changed: change node 1 in person/);
  });

  it('deleting a copy is refused: delete the node or its label', () => {
    const db = fresh();
    db.exec("INSERT INTO labels VALUES (1, 'Admin')");
    expect(() => db.exec('DELETE FROM admin')).toThrow(/can't be deleted: delete the node, or its label Admin in labels/);
    expect(admins(db)).toEqual([[1, 'Ada', 1]]);
  });

  it("a copy's id can't be given to a new node", () => {
    const db = fresh();
    db.exec("INSERT INTO labels VALUES (1, 'Admin')");
    expect(code(() => db.exec("INSERT INTO robot VALUES (1, 'dup')"))).toBe('SMALT_CONSTRAINT_PRIMARYKEY');
  });

  it("the label's own nodes are ordinary: written, changed and deleted as usual, and keep copies of their other labels", () => {
    const db = fresh();
    db.exec("INSERT INTO admin VALUES (5, 'Root', 9); UPDATE admin SET level = 10 WHERE id = 5");
    expect(admins(db)).toEqual([[5, 'Root', 10]]);
    db.exec("INSERT INTO labels VALUES (5, 'Robot')");
    db.exec('DELETE FROM admin WHERE id = 5');
    expect(admins(db)).toEqual([]);
  });

  it("a node whose own table is the copy label's can't take it again", () => {
    const db = fresh();
    db.exec("INSERT INTO admin VALUES (5, 'Root', 9)");
    expect(() => db.exec("INSERT INTO labels VALUES (5, 'Admin')")).toThrow(/node 5 has that label already, as a row of admin/);
  });

  it('a failed statement leaves no copy', () => {
    const db = fresh();
    expect(() => db.exec("INSERT INTO labels VALUES (1, 'Admin'), (9, 'Admin')")).toThrow(/not a node of the graph/);
    expect(admins(db)).toEqual([]);
  });
});

describe('the record', () => {
  it('addLabel takes copy, and the flag survives reopening', () => {
    const vfs = new MemoryVfs();
    const open = () => Database.openFile(vfs.openSync('a.db'), {}, vfs.openSync('a.db-wal'));
    let db = open();
    setup(db);
    db.queryPlan(op({ op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabel', label: 'Manager', copy: true } }));
    expect(db.catalog.graph('g')!.nodes.at(-1)).toEqual({ label: 'Manager', table: 'Manager', id: 'id', props: 'props', copy: true });
    db.exec("INSERT INTO person VALUES (1, 'Ada', 36); INSERT INTO labels VALUES (1, 'Manager')");
    db.close();
    db = open();
    expect(db.catalog.graph('g')!.nodes.find((n) => n.label === 'Admin')!.copy).toBe(true);
    expect(db.query('SELECT id FROM Manager').rows).toEqual([[1]]);
    db.exec("INSERT INTO labels VALUES (1, 'Admin')");
    expect(admins(db)).toEqual([[1, 'Ada', 1]]);
    db.close();
  });

  it('the validator refuses a copy flag that is not a boolean', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE p(id INTEGER PRIMARY KEY)');
    expect(() => db.queryPlan(op({ op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'h', nodes: [{ label: 'P', table: 'p', id: 'id', copy: 'yes' }], edges: [] } }))).toThrow(/copy/);
  });
});
