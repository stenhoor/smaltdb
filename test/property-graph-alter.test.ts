/**
 * Property graphs, part 3 (ADR 0033, decision 11: a label or relationship type with no table gets one on first use):
 * `alterPropertyGraph` adds a label or type to a graph, creating its table (and an edge table's endpoint indexes) or
 * adopting an existing one, in one transaction with the graph's new record.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const op = (o: Record<string, unknown>) => ({ kind: 'schema', op: o }) as unknown as PlanStatementInput;
const addLabel = (label: string, extra: Record<string, unknown> = {}) => op({ op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabel', label, ...extra }, ...('ifNotExists' in extra ? { ifNotExists: extra.ifNotExists } : {}) });
const addType = (type: string, table?: string) => op({ op: 'alterPropertyGraph', name: 'g', action: { kind: 'addType', type, ...(table ? { table } : {}) } });

function fresh(): Database {
  const db = Database.openMemory();
  db.exec('CREATE TABLE person(id INTEGER PRIMARY KEY, name TEXT)');
  db.queryPlan(op({ op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'g', nodes: [{ label: 'Person', table: 'person', id: 'id' }], edges: [] } }));
  return db;
}

describe('adding a label', () => {
  it('creates its table, with an id and a props map, and adds it to the graph', () => {
    const db = fresh();
    db.queryPlan(addLabel('Company'));
    const t = db.catalog.table('Company')!;
    expect(t.columns.map((c) => [c.name, c.type, c.storageType, c.rowid])).toEqual([
      ['id', 'int', 'INTEGER', true],
      ['props', 'map<text, any>', 'MAP', false],
    ]);
    expect(db.catalog.graph('g')!.nodes).toEqual([
      { label: 'Person', table: 'person', id: 'id' },
      { label: 'Company', table: 'Company', id: 'id', props: 'props' },
    ]);
  });

  it('the new table follows the graph rules at once: ids across the graph', () => {
    const db = fresh();
    db.queryPlan(addLabel('Company'));
    db.exec("INSERT INTO person VALUES (1, 'Ada'); INSERT INTO Company(props) VALUES (NULL)");
    expect(db.query('SELECT id FROM Company').rows).toEqual([[2]]);
  });

  it('takes a table name, and adopts an existing table that fits', () => {
    const db = fresh();
    db.queryPlan(addLabel('Company', { table: 'companies' }));
    expect(db.catalog.table('companies')).toBeDefined();
    db.exec('CREATE TABLE city(id INTEGER PRIMARY KEY, name TEXT)');
    db.queryPlan(addLabel('City', { table: 'city' }));
    expect(db.catalog.graph('g')!.nodes.at(-1)).toEqual({ label: 'City', table: 'city', id: 'id' });
  });

  it('refuses an existing table that does not fit, and leaves the graph as it was', () => {
    const db = fresh();
    db.exec('CREATE TABLE tag(name TEXT)');
    expect(() => db.queryPlan(addLabel('Tag', { table: 'tag' }))).toThrow(/table tag has no column id/);
    expect(db.catalog.graph('g')!.nodes).toHaveLength(1);
  });

  it('a label the graph has, spelled the same, is an error, or a no-op with ifNotExists (labels are case-sensitive)', () => {
    const db = fresh();
    expect(() => db.queryPlan(addLabel('Person'))).toThrow(/already has label Person/);
    db.queryPlan(addLabel('Person', { ifNotExists: true }));
    expect(db.catalog.graph('g')!.nodes).toHaveLength(1);
    // Another case is another label (test/property-graph-labels.test.ts).
    db.queryPlan(addLabel('PERSON', { ifNotExists: true }));
    expect(db.catalog.graph('g')!.nodes.map((n) => n.label)).toEqual(['Person', 'PERSON']);
  });
});

describe('adding a relationship type', () => {
  it('creates its table with start, end and props, and indexes on start and end', () => {
    const db = fresh();
    db.queryPlan(addType('KNOWS'));
    expect(db.catalog.table('KNOWS')!.columns.map((c) => c.name)).toEqual(['start', 'end', 'props']);
    expect(db.catalog.table('KNOWS')!.indexes.map((i) => i.name).sort()).toEqual(['KNOWS_end', 'KNOWS_start']);
    expect(db.catalog.graph('g')!.edges).toEqual([{ type: 'KNOWS', table: 'KNOWS', start: 'start', end: 'end', props: 'props' }]);
  });

  it('indexes (start, end) and (end, start): a hop from a node to the other end reads the index alone', () => {
    const db = fresh();
    db.queryPlan(addType('KNOWS', 'knows'));
    const cols = (name: string) => db.catalog.table('knows')!.indexes.find((i) => i.name === name)!.columns.map((c) => c.column);
    expect([cols('knows_start'), cols('knows_end')]).toEqual([
      [0, 1],
      [1, 0],
    ]);
    db.exec("INSERT INTO person VALUES (1, 'Ada'), (2, 'Charles'), (3, 'Grace'); INSERT INTO knows(start, end) VALUES (1, 2), (3, 2), (2, 1)");
    expect(db.query('SELECT start, rowid FROM knows WHERE "end" = 2 ORDER BY start').rows).toEqual([
      [1, 1],
      [3, 2],
    ]);
    const plan = (sql: string) => db.query(`EXPLAIN QUERY PLAN ${sql}`).rows.flat().join(' ');
    // Named, as a compiler seeking for each row names it: on three rows the planner would scan.
    expect(plan('SELECT start, rowid FROM knows INDEXED BY knows_end WHERE "end" = 2')).toContain('COVERING INDEX knows_end');
    expect(plan('SELECT "end" FROM knows INDEXED BY knows_start WHERE start = 1')).toContain('COVERING INDEX knows_start');
  });

  it('the new table follows the graph rules: endpoints must be nodes, and a connected node stays', () => {
    const db = fresh();
    db.queryPlan(addType('KNOWS', 'knows'));
    db.exec("INSERT INTO person VALUES (1, 'Ada'), (2, 'Charles'); INSERT INTO knows(start, end) VALUES (1, 2)");
    expect(() => db.exec('INSERT INTO knows(start, end) VALUES (1, 9)')).toThrow(/knows\.end = 9 is not a node/);
    expect(() => db.exec('DELETE FROM person WHERE id = 2')).toThrow(/can't delete node 2/);
  });
});

describe('the record', () => {
  it('is replaced in the same transaction as the table: a rollback undoes both', () => {
    const db = fresh();
    db.exec('BEGIN');
    db.queryPlan(addLabel('Company'));
    db.queryPlan(addType('WORKS_AT'));
    db.exec('ROLLBACK');
    expect(db.catalog.table('Company')).toBeUndefined();
    expect(db.catalog.table('WORKS_AT')).toBeUndefined();
    expect(db.catalog.graph('g')!.nodes).toHaveLength(1);
    expect(db.catalog.graph('g')!.edges).toHaveLength(0);
  });

  it('survives reopening, and the added tables are protected as the graph\'s', () => {
    const vfs = new MemoryVfs();
    const open = () => Database.openFile(vfs.openSync('a.db'), {}, vfs.openSync('a.db-wal'));
    let db = open();
    db.exec('CREATE TABLE person(id INTEGER PRIMARY KEY, name TEXT)');
    db.queryPlan(op({ op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'g', nodes: [{ label: 'Person', table: 'person', id: 'id' }], edges: [] } }));
    db.queryPlan(addLabel('Company'));
    db.queryPlan(addType('WORKS_AT'));
    db.close();
    db = open();
    expect(db.catalog.graph('g')!.nodes.map((n) => n.label)).toEqual(['Person', 'Company']);
    expect(db.catalog.graph('g')!.edges.map((e) => e.type)).toEqual(['WORKS_AT']);
    expect(() => db.exec('DROP TABLE Company')).toThrow(/used by property graph g/);
    db.close();
  });

  it('a graph that does not exist is an error, and a malformed operation is refused', () => {
    const db = fresh();
    expect(() => db.queryPlan(op({ op: 'alterPropertyGraph', name: 'nope', action: { kind: 'addLabel', label: 'X' } }))).toThrow(/no such property graph: nope/);
    expect(() => db.queryPlan(op({ op: 'alterPropertyGraph', name: 'g', action: { kind: 'rename' } }))).toThrow(/unknown action "rename"/);
  });
});
