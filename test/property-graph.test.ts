/**
 * Property graphs, part 1 (ADR 0033, G4): the catalog record and its schema operations. A graph names its node tables
 * (one per label: an integer id column and a map<text, …> props column) and edge tables (one per relationship type:
 * integer start and end columns); the engine checks them, stores the record, lists it in the catalog, marks the file
 * as needing property graphs, and keeps a graph's tables and columns from being dropped or renamed under it.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import type { PropertyGraphDef } from '../src/engine/plan/schema.js';
import { FEATURE_PROPERTY_GRAPHS } from '../src/engine/storage/format.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const TABLES = `
  CREATE TABLE person(id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE company(id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE works_at(start INTEGER, end INTEGER, since INTEGER);
  CREATE TABLE knows(a INTEGER, b INTEGER);
`;
const GRAPH: PropertyGraphDef = {
  name: 'social',
  nodes: [
    { label: 'Person', table: 'person', id: 'id' },
    { label: 'Company', table: 'company', id: 'id' },
  ],
  edges: [
    { type: 'WORKS_AT', table: 'works_at', start: 'start', end: 'end' },
    { type: 'KNOWS', table: 'knows', start: 'a', end: 'b' },
  ],
};
const create = (graph: PropertyGraphDef, ifNotExists = false) => ({ kind: 'schema', op: { op: 'createPropertyGraph', graph, ifNotExists } }) as unknown as PlanStatementInput;
const drop = (name: string, ifExists = false) => ({ kind: 'schema', op: { op: 'drop', objectType: 'property graph', name, ifExists } }) as unknown as PlanStatementInput;

function fresh(): Database {
  const db = Database.openMemory();
  db.exec(TABLES);
  return db;
}

describe('creating a property graph', () => {
  it('stores the record and lists it in the catalog', () => {
    const db = fresh();
    db.queryPlan(create(GRAPH));
    expect(db.catalog.graphs().map((g) => g.name)).toEqual(['social']);
    const g = db.catalog.graph('SOCIAL')!;
    expect({ name: g.name, nodes: g.nodes, edges: g.edges }).toEqual(GRAPH);
    expect(g.source).toBeUndefined();
    expect(db.catalog.snapshot().graphs.map((x) => x.name)).toEqual(['social']);
  });

  it('keeps graph names apart from table names, and refuses a second graph of the same name', () => {
    const db = fresh();
    db.queryPlan(create({ ...GRAPH, name: 'person', edges: [], nodes: [GRAPH.nodes[0]!] }));
    expect(db.catalog.graph('person')).toBeDefined();
    expect(db.catalog.table('person')).toBeDefined();
    expect(() => db.queryPlan(create({ ...GRAPH, name: 'Person', nodes: [GRAPH.nodes[1]!], edges: [] }))).toThrow(/property graph Person already exists/);
    db.queryPlan(create({ ...GRAPH, name: 'person', nodes: [GRAPH.nodes[1]!], edges: [] }, true));
    expect(db.catalog.graphs()).toHaveLength(1);
  });

  it('accepts a map<text, …> props column', () => {
    const db = fresh();
    db.queryPlan({
      kind: 'schema',
      op: {
        op: 'createTable',
        table: {
          name: 'thing',
          columns: [
            { name: 'id', declaredType: 'INTEGER', type: 'INTEGER', notNull: false, collation: 'binary' },
            { name: 'props', declaredType: 'map<text, any>', type: 'MAP', notNull: false, collation: 'binary' },
          ],
          keys: [],
          checks: [],
          foreignKeys: [],
          storage: 'row',
        },
        temp: false,
        ifNotExists: false,
      },
    } as unknown as PlanStatementInput);
    db.queryPlan(create({ name: 'g', nodes: [{ label: 'Thing', table: 'thing', id: 'id', props: 'props' }], edges: [] }));
    expect(db.catalog.graph('g')!.nodes[0]!.props).toBe('props');
  });

  it.each([
    [{ ...GRAPH, nodes: [] }, /needs at least one node table/],
    [{ ...GRAPH, nodes: [{ label: 'Person', table: 'nope', id: 'id' }] }, /no such table: nope/],
    [{ ...GRAPH, nodes: [{ label: 'Person', table: 'person', id: 'nope' }] }, /table person has no column nope/],
    [{ ...GRAPH, nodes: [{ label: 'Person', table: 'person', id: 'name' }] }, /id column person\.name is TEXT, not INTEGER/],
    [{ ...GRAPH, nodes: [{ label: 'Person', table: 'person', id: 'id', props: 'name' }] }, /props column person\.name is TEXT, not a MAP/],
    [{ ...GRAPH, nodes: [GRAPH.nodes[0]!, { label: 'person', table: 'company', id: 'id' }] }, /label person is listed twice/],
    [{ ...GRAPH, nodes: [GRAPH.nodes[0]!, { label: 'Other', table: 'person', id: 'id' }] }, /table person is listed twice/],
    [{ ...GRAPH, edges: [{ type: 'KNOWS', table: 'knows', start: 'a', end: 'nope' }] }, /table knows has no column nope/],
  ])('refuses a graph whose tables or columns are wrong (%#)', (graph, message) => {
    expect(() => fresh().queryPlan(create(graph as PropertyGraphDef))).toThrow(message);
  });

  it("refuses a table that is a view, a columnar table or another graph's", () => {
    const db = fresh();
    db.exec("CREATE VIEW v AS SELECT id FROM person; CREATE TABLE col(id INTEGER) WITH (storage = 'columnar')");
    expect(() => db.queryPlan(create({ name: 'g', nodes: [{ label: 'V', table: 'v', id: 'id' }], edges: [] }))).toThrow(/no such table: v/);
    expect(() => db.queryPlan(create({ name: 'g', nodes: [{ label: 'C', table: 'col', id: 'id' }], edges: [] }))).toThrow(/columnar/);
    db.queryPlan(create(GRAPH));
    expect(() => db.queryPlan(create({ name: 'g2', nodes: [GRAPH.nodes[0]!], edges: [] }))).toThrow(/table person is already used by property graph social/);
  });

  it('the validator refuses a malformed operation', () => {
    expect(() => fresh().queryPlan(create({ name: 'g', nodes: [{ label: 'P', table: 'person' }], edges: [] } as never))).toThrow(/id/);
  });
});

describe('the file', () => {
  it('needs the property graph feature once a graph exists, keeps the graph across reopening, and keeps the bit after a drop', () => {
    const vfs = new MemoryVfs();
    const open = () => Database.openFile(vfs.openSync('g.db'), {}, vfs.openSync('g.db-wal'));
    let db = open();
    db.exec(TABLES);
    expect(db.pager.requiredFeatures).toBe(0);
    db.queryPlan(create(GRAPH));
    expect(db.pager.requiredFeatures & FEATURE_PROPERTY_GRAPHS).toBe(FEATURE_PROPERTY_GRAPHS);
    db.close();
    db = open();
    expect(db.catalog.graph('social')!.edges.map((e) => e.type)).toEqual(['WORKS_AT', 'KNOWS']);
    db.queryPlan(drop('social'));
    db.close();
    db = open();
    expect(db.catalog.graphs()).toEqual([]);
    expect(db.pager.requiredFeatures & FEATURE_PROPERTY_GRAPHS).toBe(FEATURE_PROPERTY_GRAPHS);
    db.close();
  });

  it('a graph created and rolled back leaves nothing', () => {
    const db = fresh();
    db.exec('BEGIN');
    db.queryPlan(create(GRAPH));
    db.exec('ROLLBACK');
    expect(db.catalog.graphs()).toEqual([]);
    expect(db.pager.requiredFeatures).toBe(0);
  });
});

describe("a graph's tables", () => {
  it('can be read and written as ordinary tables', () => {
    const db = fresh();
    db.queryPlan(create(GRAPH));
    db.exec("INSERT INTO person VALUES (1, 'Ada'); INSERT INTO knows VALUES (1, 1)");
    expect(db.query('SELECT name FROM person JOIN knows ON knows.a = person.id').rows).toEqual([['Ada']]);
  });

  it("can't be dropped, renamed, or lose or rename their graph columns while the graph exists", () => {
    const db = fresh();
    db.queryPlan(create(GRAPH));
    expect(() => db.exec('DROP TABLE person')).toThrow(/table person is used by property graph social: drop the graph first/);
    expect(() => db.exec('ALTER TABLE person RENAME TO people')).toThrow(/used by property graph social and can't be renamed/);
    expect(() => db.exec('ALTER TABLE knows RENAME COLUMN a TO x')).toThrow(/column a of table knows is used by property graph social/);
    expect(() => db.exec('ALTER TABLE knows DROP COLUMN b')).toThrow(/column b of table knows is used by property graph social/);
    // Other columns are the table's own business.
    db.exec('ALTER TABLE person RENAME COLUMN name TO full_name');
    db.exec('ALTER TABLE works_at DROP COLUMN since');
    db.queryPlan(drop('social'));
    db.exec('DROP TABLE person');
  });

  it('DROP PROPERTY GRAPH IF EXISTS of a missing graph is a no-op; without IF EXISTS an error', () => {
    const db = fresh();
    db.queryPlan(drop('nope', true));
    expect(() => db.queryPlan(drop('nope'))).toThrow(/no such property graph: nope/);
  });
});
