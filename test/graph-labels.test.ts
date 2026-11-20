/**
 * A graph's label index in its graph index (ADR 0040, section 5): which nodes have which labels, kept in memory, so a
 * plan that asks whether one node has one label is answered without a probe of the label index's B+tree. Every
 * database here runs with the test setting on (test/setup-sql.ts): the sets are compared with the table after each
 * write, and a query that reads them is run again without them.
 */
import { describe, expect, it } from 'vitest';
import { Database, type DatabaseOptions } from '../src/engine/database.js';
import { GraphLabels } from '../src/engine/exec/graph-labels.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const schema = (db: Database, op: Record<string, unknown>): void => void db.queryPlan({ kind: 'schema', op } as unknown as PlanStatementInput);

/** People, some of them admins and owners by the label index; they know the next person. */
function social(db: Database, extra: Record<string, unknown> = {}): Database {
  db.exec(`
    CREATE TABLE person(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE admin(id INTEGER PRIMARY KEY);
    CREATE TABLE owner(id INTEGER PRIMARY KEY);
    CREATE TABLE knows(start INTEGER, end INTEGER);
    CREATE INDEX knows_start ON knows(start, end); CREATE INDEX knows_end ON knows(end, start);
  `);
  schema(db, {
    op: 'createPropertyGraph',
    ifNotExists: false,
    graph: {
      name: 'g',
      nodes: [
        { label: 'Person', table: 'person', id: 'id' },
        { label: 'Admin', table: 'admin', id: 'id' },
        { label: 'Owner', table: 'owner', id: 'id' },
      ],
      edges: [{ type: 'KNOWS', table: 'knows', start: 'start', end: 'end' }],
      ...extra,
    },
  });
  schema(db, { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabelIndex' } });
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 199) INSERT INTO person SELECT i, 'p' || i FROM n`);
  db.exec('INSERT INTO knows SELECT id, (id + 1) % 200 FROM person');
  // Every third person is an admin, every tenth an owner.
  db.exec("INSERT INTO g_labels SELECT id, 'Admin' FROM person WHERE id % 3 = 0");
  db.exec("INSERT INTO g_labels SELECT id, 'Owner' FROM person WHERE id % 10 = 0");
  return db;
}
const open = (options: DatabaseOptions = {}): Database => social(Database.openMemory(options));
const plan = (db: Database, sql: string): string => db.query(`EXPLAIN QUERY PLAN ${sql}`).rows.map((r) => String(r[3])).join('\n');
const state = (db: Database) => db.graphIndexState.state()[0]!;
const has = (db: Database, node: number, label: string): boolean => db.query('SELECT count(*) FROM g_labels WHERE node = ? AND label = ?', [node, label]).rows[0]![0] === 1;
const HAS = 'SELECT count(*) FROM g_labels WHERE node = 3 AND label = \'Admin\'';

describe('label sets', () => {
  it('hold the nodes of each label, at any id', () => {
    const l = new GraphLabels();
    expect(l.has('A', 0)).toBe(false);
    expect(l.add('A', 0)).toBe(true);
    expect(l.add('A', 0)).toBe(false);
    expect(l.add('A', 31)).toBe(true);
    expect(l.add('A', 32)).toBe(true);
    expect(l.add('B', 31)).toBe(true);
    expect(l.add('A', 2 ** 31 - 1)).toBe(true);
    expect(l.add('A', 1_000_000)).toBe(true);
    expect([l.has('A', 0), l.has('A', 31), l.has('A', 32), l.has('A', 33), l.has('B', 31), l.has('B', 0), l.has('A', 2 ** 31 - 1), l.has('C', 0)]).toEqual([true, true, true, false, true, false, true, false]);
    expect(l.entries).toBe(6);
    const all: string[] = [];
    l.forEach((label, node) => void all.push(`${label}${node}`));
    expect(all).toEqual(['A0', 'A31', 'A32', 'A1000000', `A${2 ** 31 - 1}`, 'B31']);
    expect(l.remove('A', 31)).toBe(true);
    expect(l.remove('A', 31)).toBe(false);
    expect(l.remove('C', 5)).toBe(false);
    expect([l.has('A', 31), l.has('B', 31), l.entries]).toEqual([false, true, 5]);
    // Four pages of 4 KiB: A's at 0, at 1,000,000 and at the top, and B's.
    expect(l.bytes()).toBe(4 * 4096);
  });
});

describe('asking whether a node has a label', () => {
  it('is answered from the graph index, with the rows the label index gives', () => {
    const db = open();
    expect(plan(db, HAS)).toContain('SEARCH g_labels USING GRAPH INDEX (label=? AND node=?)');
    for (const [node, label] of [[3, 'Admin'], [4, 'Admin'], [30, 'Owner'], [30, 'Admin'], [31, 'Owner'], [3, 'Person'], [3, 'admin'], [9999, 'Admin']] as const) {
      expect(has(db, node, label), `${node} ${label}`).toBe(db.query('SELECT count(*) FROM g_labels NOT INDEXED WHERE node = ? AND label = ?', [node, label]).rows[0]![0] === 1);
    }
    expect([has(db, 3, 'Admin'), has(db, 4, 'Admin'), has(db, 30, 'Owner'), has(db, 3, 'admin')]).toEqual([true, false, true, false]);
    expect(state(db)).toMatchObject({ built: true, labels: 67 + 20, builds: 1 });
    expect(db.prepare(HAS).usesGraphIndex).toBe(true);
  });

  it('gives the row\'s node and label, and leaves its rowid and other reads to the table', () => {
    const db = open();
    expect(db.query("SELECT node, label FROM g_labels WHERE node = 30 AND label = 'Owner'").rows).toEqual([[30, 'Owner']]);
    expect(db.query("SELECT node, label FROM g_labels WHERE label = 'Owner' AND node = 30.0").rows).toEqual([[30, 'Owner']]);
    expect(db.query("SELECT rowid, node FROM g_labels WHERE node = 30 AND label = 'Owner'").rows).toEqual(db.query("SELECT rowid, node FROM g_labels NOT INDEXED WHERE node = 30 AND label = 'Owner'").rows);
    // A node that is NULL, a fraction or text, and a label that is no text, are in no entry.
    for (const [node, label] of [[null, 'Owner'], [30.5, 'Owner'], ['x', 'Owner'], [30, null], [30, 7]] as const) {
      expect(db.query('SELECT count(*) FROM g_labels WHERE node = ? AND label = ?', [node, label]).rows).toEqual([[0]]);
    }
  });

  it('checks a label for each row of a join', () => {
    const db = open();
    // The admins someone knows: the far end's label, for each relationship.
    const sql = "SELECT count(*) FROM knows k JOIN g_labels l ON l.node = k.end AND l.label = 'Admin' WHERE k.start < 100";
    expect(plan(db, sql)).toContain('GRAPH INDEX (label=? AND node=?)');
    expect(db.query(sql).rows).toEqual(db.query("SELECT count(*) FROM knows k WHERE k.start < 100 AND (k.end % 3) = 0").rows);
    // The label's own nodes are still read from its index.
    expect(db.query("SELECT count(*) FROM g_labels WHERE label = 'Owner'").rows).toEqual([[20]]);
    expect(plan(db, "SELECT node FROM g_labels WHERE label = 'Owner'")).not.toContain('GRAPH INDEX');
  });
});

describe('writes keep the label sets', () => {
  it('a label given, taken and changed is read at once', () => {
    const db = open();
    expect(has(db, 4, 'Admin')).toBe(false);
    db.exec("INSERT INTO g_labels VALUES (4, 'Admin')");
    expect(has(db, 4, 'Admin')).toBe(true);
    db.exec("DELETE FROM g_labels WHERE node = 3 AND label = 'Admin'");
    expect(has(db, 3, 'Admin')).toBe(false);
    db.exec("UPDATE g_labels SET label = 'Owner' WHERE node = 6 AND label = 'Admin'");
    expect([has(db, 6, 'Admin'), has(db, 6, 'Owner')]).toEqual([false, true]);
    // A node deleted takes its labels with it (the graph's rules delete its entries).
    db.exec('DELETE FROM knows WHERE start = 30 OR end = 30');
    db.exec('DELETE FROM person WHERE id = 30');
    expect([has(db, 30, 'Admin'), has(db, 30, 'Owner')]).toEqual([false, false]);
    expect(state(db)).toMatchObject({ built: true, builds: 1 });
  });

  it('a rollback that undid a label drops the index, and it is built again', () => {
    const db = open();
    expect(has(db, 4, 'Admin')).toBe(false);
    db.exec("BEGIN; INSERT INTO g_labels VALUES (4, 'Admin')");
    expect(has(db, 4, 'Admin')).toBe(true);
    db.exec('ROLLBACK');
    expect(state(db).built).toBe(false);
    expect(has(db, 4, 'Admin')).toBe(false);
    expect(state(db)).toMatchObject({ built: true, builds: 2 });
  });

  it('a random run of labels given and taken reads the same as the table', () => {
    const db = open();
    let s = 7;
    const rnd = (n: number): number => {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      return s % n;
    };
    for (let i = 0; i < 300; i++) {
      const node = rnd(200);
      const label = rnd(2) ? 'Admin' : 'Owner';
      if (i % 40 === 0) db.exec('BEGIN');
      if (has(db, node, label)) db.query('DELETE FROM g_labels WHERE node = ? AND label = ?', [node, label]);
      else db.query('INSERT INTO g_labels VALUES (?, ?)', [node, label]);
      if (i % 40 === 25) db.exec(rnd(2) ? 'COMMIT' : 'ROLLBACK');
      expect(has(db, node, label)).toBe(db.query('SELECT count(*) FROM g_labels NOT INDEXED WHERE node = ? AND label = ?', [node, label]).rows[0]![0] === 1);
    }
  });
});

describe('label indexes the graph index does not hold', () => {
  it('a table without a unique index on node and label is read from the table', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE n(id INTEGER PRIMARY KEY); CREATE TABLE extra(id INTEGER PRIMARY KEY); CREATE TABLE labels(node INTEGER NOT NULL, label TEXT NOT NULL); CREATE INDEX labels_node ON labels(node, label)');
    schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'g', nodes: [{ label: 'N', table: 'n', id: 'id' }, { label: 'Extra', table: 'extra', id: 'id' }], edges: [] } });
    schema(db, { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabelIndex', table: 'labels' } });
    db.exec("INSERT INTO n VALUES (1), (2); INSERT INTO labels VALUES (1, 'Extra')");
    expect(plan(db, "SELECT 1 FROM labels WHERE node = 1 AND label = 'Extra'")).not.toContain('GRAPH INDEX');
    expect(db.query("SELECT count(*) FROM labels WHERE node = 1 AND label = 'Extra'").rows).toEqual([[1]]);
    expect(state(db).labels).toBe(0);
  });

  it('with graph indexes off, and on a reader', async () => {
    const off = open({ graphIndexMem: 0 });
    expect(plan(off, HAS)).not.toContain('GRAPH INDEX');
    expect(has(off, 3, 'Admin')).toBe(true);
    const vfs = new MemoryVfs();
    const owner = social(await Database.open(vfs, 'db', { sharedHandles: true }));
    const reader = await Database.openReader(vfs, 'db');
    expect(plan(owner, HAS)).toContain('GRAPH INDEX');
    expect(plan(reader, HAS)).not.toContain('GRAPH INDEX');
    expect(reader.query(HAS).rows).toEqual([[1]]);
  });

  it('a graph that ignores case stores a label as the graph spells it, and is asked for it so', () => {
    const db = social(Database.openMemory(), { caseSensitive: false });
    db.exec("INSERT INTO g_labels VALUES (1, 'admin')");
    expect(db.query('SELECT label FROM g_labels WHERE node = 1').rows).toEqual([['Admin']]);
    expect([has(db, 1, 'Admin'), has(db, 1, 'admin')]).toEqual([true, false]);
  });
});
