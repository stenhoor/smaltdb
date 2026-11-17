/**
 * Property graphs, part 2 (ADR 0033, G4): the rules the engine keeps on writes to a graph's tables, from any language
 * (here SQL and plans): node ids unique across the graph and assigned when missing, relationships whose endpoints are
 * nodes of the graph, and nodes that can't be deleted (or re-keyed) while relationships refer to them.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';

function graph(): Database {
  const db = Database.openMemory();
  db.exec(`
    CREATE TABLE person(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE company(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE works_at(start INTEGER, end INTEGER, since INTEGER);
    CREATE INDEX works_at_start ON works_at(start); CREATE INDEX works_at_end ON works_at(end);
    CREATE TABLE knows(a INTEGER, b INTEGER);
    CREATE TABLE notes(id INTEGER PRIMARY KEY, text TEXT);
  `);
  db.queryPlan({
    kind: 'schema',
    op: {
      op: 'createPropertyGraph',
      ifNotExists: false,
      graph: {
        name: 'social',
        nodes: [
          { label: 'Person', table: 'person', id: 'id' },
          { label: 'Company', table: 'company', id: 'id' },
        ],
        edges: [
          { type: 'WORKS_AT', table: 'works_at', start: 'start', end: 'end' },
          { type: 'KNOWS', table: 'knows', start: 'a', end: 'b' },
        ],
      },
    },
  } as unknown as PlanStatementInput);
  return db;
}
const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

describe('node ids', () => {
  it('a node written without an id gets the next one across the whole graph', () => {
    const db = graph();
    db.exec("INSERT INTO person(name) VALUES ('Ada')");
    db.exec("INSERT INTO company(name) VALUES ('Analytical Engines')");
    db.exec("INSERT INTO person(name) VALUES ('Charles')");
    expect(db.query('SELECT id, name FROM person UNION ALL SELECT id, name FROM company ORDER BY id').rows).toEqual([
      [1, 'Ada'],
      [2, 'Analytical Engines'],
      [3, 'Charles'],
    ]);
  });

  it('a given id is kept, and the next assigned one follows the largest in the graph', () => {
    const db = graph();
    db.exec("INSERT INTO company VALUES (10, 'Acme'); INSERT INTO person(name) VALUES ('Ada')");
    expect(db.query('SELECT id FROM person').rows).toEqual([[11]]);
  });

  it('an id another node table of the graph has is refused, on insert and on update', () => {
    const db = graph();
    db.exec("INSERT INTO person VALUES (1, 'Ada'); INSERT INTO company VALUES (2, 'Acme')");
    expect(code(() => db.exec("INSERT INTO company VALUES (1, 'Dup')"))).toBe('SMALT_CONSTRAINT_PRIMARYKEY');
    expect(() => db.exec("INSERT INTO company VALUES (1, 'Dup')")).toThrow(/node id 1 is already a node of person/);
    expect(code(() => db.exec('UPDATE company SET id = 1 WHERE id = 2'))).toBe('SMALT_CONSTRAINT_PRIMARYKEY');
    // The failed statements changed nothing.
    expect(db.query('SELECT id, name FROM company').rows).toEqual([[2, 'Acme']]);
  });

  it('tables outside the graph are not affected', () => {
    const db = graph();
    db.exec("INSERT INTO person VALUES (1, 'Ada'); INSERT INTO notes VALUES (1, 'a note')");
    expect(db.query('SELECT count(*) FROM notes').rows).toEqual([[1]]);
  });
});

describe('relationships', () => {
  it('connect nodes of the graph, of any label', () => {
    const db = graph();
    db.exec("INSERT INTO person VALUES (1, 'Ada'); INSERT INTO company VALUES (2, 'Acme')");
    db.exec('INSERT INTO works_at VALUES (1, 2, 1843); INSERT INTO knows VALUES (1, 1)');
    expect(db.query('SELECT count(*) FROM works_at').rows).toEqual([[1]]);
  });

  it('refuse a start or end that is not a node of the graph, or NULL', () => {
    const db = graph();
    db.exec("INSERT INTO person VALUES (1, 'Ada'); INSERT INTO notes VALUES (5, 'not a node')");
    expect(code(() => db.exec('INSERT INTO knows VALUES (1, 9)'))).toBe('SMALT_CONSTRAINT_FOREIGNKEY');
    expect(() => db.exec('INSERT INTO knows VALUES (1, 9)')).toThrow(/knows\.b = 9 is not a node of the graph/);
    expect(() => db.exec('INSERT INTO knows VALUES (5, 1)')).toThrow(/knows\.a = 5 is not a node/);
    expect(() => db.exec('INSERT INTO knows VALUES (NULL, 1)')).toThrow(/knows\.a is NULL/);
    db.exec('INSERT INTO knows VALUES (1, 1)');
    expect(code(() => db.exec('UPDATE knows SET b = 9'))).toBe('SMALT_CONSTRAINT_FOREIGNKEY');
    expect(db.query('SELECT a, b FROM knows').rows).toEqual([[1, 1]]);
  });

  it('are checked for writes from plans too', () => {
    const db = graph();
    db.exec("INSERT INTO person VALUES (1, 'Ada')");
    const write = (rows: number[][]) => ({ kind: 'write', plan: p.append('knows', p.values(rows.map((r) => r.map((v) => p.lit(v)))), [0, 1]) }) as unknown as PlanStatementInput;
    db.queryPlan(write([[1, 1]]));
    expect(code(() => db.queryPlan(write([[1, 7]])))).toBe('SMALT_CONSTRAINT_FOREIGNKEY');
  });
});

describe('deleting nodes', () => {
  it('is refused while relationships refer to the node, at either end, and allowed once they are deleted', () => {
    const db = graph();
    db.exec("INSERT INTO person VALUES (1, 'Ada'), (2, 'Charles'); INSERT INTO company VALUES (3, 'Acme')");
    db.exec('INSERT INTO knows VALUES (2, 1); INSERT INTO works_at VALUES (2, 3, 1830)');
    expect(code(() => db.exec('DELETE FROM person WHERE id = 1'))).toBe('SMALT_CONSTRAINT_FOREIGNKEY');
    expect(() => db.exec('DELETE FROM company WHERE id = 3')).toThrow(/can't delete node 3 of company: relationships in works_at\.end refer to it/);
    // DETACH DELETE: the relationships first.
    db.exec('DELETE FROM knows WHERE a = 2 OR b = 2; DELETE FROM works_at WHERE start = 2; DELETE FROM person WHERE id = 2');
    db.exec('DELETE FROM person WHERE id = 1');
    expect(db.query('SELECT count(*) FROM person').rows).toEqual([[0]]);
  });

  it('deleting every row of a node table checks each row (no truncation past the rules)', () => {
    const db = graph();
    db.exec("INSERT INTO person VALUES (1, 'Ada'), (2, 'Charles'); INSERT INTO knows VALUES (1, 2)");
    expect(code(() => db.exec('DELETE FROM person'))).toBe('SMALT_CONSTRAINT_FOREIGNKEY');
    expect(db.query('SELECT count(*) FROM person').rows).toEqual([[2]]);
    db.exec('DELETE FROM knows; DELETE FROM person');
    expect(db.query('SELECT count(*) FROM person').rows).toEqual([[0]]);
  });

  it("changing a connected node's id is refused; an unconnected one's is allowed", () => {
    const db = graph();
    db.exec("INSERT INTO person VALUES (1, 'Ada'), (2, 'Charles'); INSERT INTO knows VALUES (1, 1)");
    expect(code(() => db.exec('UPDATE person SET id = 5 WHERE id = 1'))).toBe('SMALT_CONSTRAINT_FOREIGNKEY');
    db.exec('UPDATE person SET id = 5 WHERE id = 2');
    expect(db.query('SELECT id FROM person ORDER BY id').rows).toEqual([[1], [5]]);
  });

  it('INSERT OR REPLACE of a connected node is refused, as its delete would be', () => {
    const db = graph();
    db.exec("INSERT INTO person VALUES (1, 'Ada'); INSERT INTO knows VALUES (1, 1)");
    expect(code(() => db.exec("INSERT OR REPLACE INTO person VALUES (1, 'Ada Lovelace')"))).toBe('SMALT_CONSTRAINT_FOREIGNKEY');
  });
});

describe('once the graph is dropped', () => {
  it('its tables are ordinary tables again', () => {
    const db = graph();
    db.exec("INSERT INTO person VALUES (1, 'Ada'); INSERT INTO knows VALUES (1, 1)");
    db.queryPlan({ kind: 'schema', op: { op: 'drop', objectType: 'property graph', name: 'social', ifExists: false } } as unknown as PlanStatementInput);
    db.exec('DELETE FROM person; INSERT INTO knows VALUES (7, 8)');
    expect(db.query('SELECT count(*) FROM knows').rows).toEqual([[2]]);
  });
});
