/**
 * Graph indexes (ADR 0040): a property graph's relationships kept in memory by the engine, and edge tables read
 * through them. Every database here runs with the test setting on (test/setup-sql.ts): the index is compared with its
 * tables after each write, and a query that reads it is run again without it.
 */
import { describe, expect, it } from 'vitest';
import type { TableSchema } from '../src/engine/catalog/schema.js';
import { Database, type DatabaseOptions } from '../src/engine/database.js';
import type { GraphIndexes } from '../src/engine/exec/graph-index.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import type { PlanType } from '../src/engine/plan/types.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const schema = (db: Database, op: Record<string, unknown>): void => void db.queryPlan({ kind: 'schema', op } as unknown as PlanStatementInput);

/** People who know and like each other: two edge tables with both endpoint indexes, as the tables the engine makes. */
function social(db: Database): Database {
  db.exec(`
    CREATE TABLE person(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE knows(start INTEGER, end INTEGER, since INTEGER);
    CREATE INDEX knows_start ON knows(start, end); CREATE INDEX knows_end ON knows(end, start);
    CREATE TABLE likes(start INTEGER, end INTEGER);
    CREATE INDEX likes_start ON likes(start, end); CREATE INDEX likes_end ON likes(end, start);
  `);
  schema(db, {
    op: 'createPropertyGraph',
    ifNotExists: false,
    graph: {
      name: 'social',
      nodes: [{ label: 'Person', table: 'person', id: 'id' }],
      edges: [
        { type: 'KNOWS', table: 'knows', start: 'start', end: 'end' },
        { type: 'LIKES', table: 'likes', start: 'start', end: 'end' },
      ],
    },
  });
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 49) INSERT INTO person SELECT i, 'p' || i FROM n`);
  // Everyone knows the next three people round the ring, and likes the one before.
  db.exec(`INSERT INTO knows SELECT p.id, (p.id + d.k) % 50, 2000 + d.k FROM person p, (SELECT 1 AS k UNION ALL SELECT 2 UNION ALL SELECT 3) d`);
  db.exec(`INSERT INTO likes SELECT id, (id + 49) % 50 FROM person`);
  return db;
}
const open = (options: DatabaseOptions = {}): Database => social(Database.openMemory(options));
const plan = (db: Database, sql: string): string => db.query(`EXPLAIN QUERY PLAN ${sql}`).rows.map((r) => String(r[3])).join('\n');
const state = (db: Database) => db.graphIndexState.state()[0]!;
const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

describe('reading an edge table', () => {
  it('reads a node\'s relationships from the index, in the endpoint index\'s order', () => {
    const db = open();
    expect(plan(db, 'SELECT end FROM knows WHERE start = 7')).toContain('SEARCH knows USING GRAPH INDEX (start=?)');
    expect(plan(db, 'SELECT start FROM knows WHERE end = 7')).toContain('SEARCH knows USING GRAPH INDEX (end=?)');
    expect(db.query('SELECT end, rowid FROM knows WHERE start = 7').rows).toEqual(db.query('SELECT end, rowid FROM knows NOT INDEXED WHERE start = 7 ORDER BY end, rowid').rows);
    expect(db.query('SELECT end FROM knows WHERE start = 7').rows).toEqual([[8], [9], [10]]);
    expect(db.query('SELECT start FROM knows WHERE end = 1').rows).toEqual([[0], [48], [49]]);
    expect(db.query('SELECT start FROM likes WHERE end = 0').rows).toEqual([[1]]);
    expect(db.query('SELECT end FROM knows WHERE start = 99').rows).toEqual([]);
    expect(db.query('SELECT end FROM knows WHERE start = ?', [48]).rows).toEqual([[0], [1], [49]]);
  });

  it('fetches the row for columns the index does not hold', () => {
    const db = open();
    expect(plan(db, 'SELECT end, since FROM knows WHERE start = 7')).toContain('USING GRAPH INDEX');
    expect(db.query('SELECT end, since FROM knows WHERE start = 7').rows).toEqual([
      [8, 2001],
      [9, 2002],
      [10, 2003],
    ]);
  });

  it('answers a join of hops', () => {
    const db = open();
    // A table of endpoints only: the planner knows each hop reads nothing but the index.
    const sql = 'SELECT c.end FROM likes a JOIN likes b ON b.start = a.end JOIN likes c ON c.start = b.end WHERE a.start = 0';
    expect(plan(db, sql).match(/USING GRAPH INDEX/g)?.length).toBe(3);
    expect(db.query(sql).rows).toEqual([[47]]);
    // Whatever the planner picks for a wider table, the rows are the same.
    const rows = db.query('SELECT c.end FROM knows a JOIN knows b ON b.start = a.end JOIN knows c ON c.start = b.end WHERE a.start = 0 ORDER BY 1').rows.map((r) => r[0]);
    expect(rows.length).toBe(27);
    expect(rows[0]).toBe(3);
    expect(rows[26]).toBe(9);
  });

  it('compares as the column does: a text number matches, other text and NULL do not', () => {
    const db = open();
    expect(db.query("SELECT end FROM knows WHERE start = '7'").rows).toEqual([[8], [9], [10]]);
    expect(db.query("SELECT end FROM knows WHERE start = 'x'").rows).toEqual([]);
    expect(db.query('SELECT end FROM knows WHERE start = NULL').rows).toEqual([]);
    expect(db.query('SELECT end FROM knows WHERE start = 7.5').rows).toEqual([]);
    expect(db.query('SELECT end FROM knows WHERE start = -1').rows).toEqual([]);
  });

  it('is built on first use, once', () => {
    const db = open();
    expect(state(db)).toMatchObject({ built: false, off: null, builds: 0 });
    db.query('SELECT end FROM knows WHERE start = 7');
    expect(state(db)).toMatchObject({ built: true, entries: 200, builds: 1 });
    db.query('SELECT start FROM likes WHERE end = 7');
    expect(state(db).builds).toBe(1);
  });

  it('gives lists the same with and without it (the test setting compares them by their parts)', () => {
    const db = open();
    const hop = p.filter(p.scan('knows', [0, 1]), p.call('cmp_eq', [p.col(0, 0, 'int'), p.lit(7)], 'bool'));
    const pairs = p.project(hop, [p.call('list_of', [p.col(0, 0, 'int'), p.col(0, 1, 'int')], 'list<int>' as PlanType)]);
    expect(db.queryPlan({ kind: 'explain', mode: 'plan', query: { kind: 'query', plan: pairs } } as unknown as PlanStatementInput).rows.flat().join(' ')).toContain('GRAPH INDEX');
    expect(db.queryPlan(pairs).rows).toEqual([[[7, 8]], [[7, 9]], [[7, 10]]]);
  });

  it('leaves other tables and other conditions to the B+trees', () => {
    const db = open();
    expect(plan(db, 'SELECT name FROM person WHERE id = 3')).not.toContain('GRAPH INDEX');
    expect(plan(db, 'SELECT end FROM knows WHERE start > 40')).not.toContain('GRAPH INDEX');
    expect(plan(db, 'SELECT end FROM knows NOT INDEXED WHERE start = 7')).not.toContain('GRAPH INDEX');
    expect(plan(db, 'SELECT end FROM knows INDEXED BY knows_start WHERE start = 7')).toContain('GRAPH INDEX');
  });
});

describe('writes keep the index', () => {
  it('inserts, deletes and updates', () => {
    const db = open();
    const out = (n: number) => db.query('SELECT end FROM knows WHERE start = ?', [n]).rows.map((r) => r[0]);
    const into = (n: number) => db.query('SELECT start FROM knows WHERE end = ?', [n]).rows.map((r) => r[0]);
    expect(out(7)).toEqual([8, 9, 10]);
    db.exec('INSERT INTO knows VALUES (7, 30, 2020), (7, 2, 2021)');
    expect(out(7)).toEqual([2, 8, 9, 10, 30]);
    expect(into(30)).toEqual([7, 27, 28, 29]);
    db.exec('DELETE FROM knows WHERE start = 7 AND end = 9');
    expect(out(7)).toEqual([2, 8, 10, 30]);
    expect(into(9)).toEqual([6, 8]);
    db.exec('UPDATE knows SET end = 40 WHERE start = 7 AND end = 8');
    expect(out(7)).toEqual([2, 10, 30, 40]);
    expect(into(8)).toEqual([5, 6]);
    expect(into(40)).toEqual([7, 37, 38, 39]);
    db.exec('UPDATE knows SET start = 8 WHERE start = 7');
    expect(out(7)).toEqual([]);
    expect(out(8)).toEqual([2, 9, 10, 10, 11, 30, 40]);
    db.exec('UPDATE knows SET since = 1999 WHERE start = 8');
    expect(db.query('SELECT end, since FROM knows WHERE start = 8 AND end = 30').rows).toEqual([[30, 1999]]);
    db.exec('UPDATE knows SET rowid = rowid + 1000 WHERE start = 8 AND end = 30');
    expect(db.query('SELECT rowid > 1000 FROM knows WHERE start = 8 AND end = 30').rows).toEqual([[1]]);
    db.exec('DELETE FROM knows');
    expect(out(8)).toEqual([]);
    // Entries are counted once, by start: the 50 likes are left.
    expect(state(db)).toMatchObject({ built: true, entries: 50, builds: 1 });
  });

  it('holds a node with thousands of relationships', () => {
    const db = open();
    db.query('SELECT end FROM knows WHERE start = 0');
    db.exec('WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 4999) INSERT INTO likes SELECT 0, i % 50 FROM n');
    expect(db.query('SELECT count(*), min(end), max(end) FROM likes WHERE start = 0').rows).toEqual([[5001, 0, 49]]);
    expect(db.query('SELECT count(*) FROM likes WHERE end = 3').rows).toEqual([[101]]);
    db.exec('DELETE FROM likes WHERE start = 0 AND end % 2 = 0');
    expect(db.query('SELECT count(*) FROM likes WHERE start = 0').rows).toEqual([[2501]]);
    expect(state(db).builds).toBe(1);
  });

  it('gives a statement its own writes, and a scan what is written under it', () => {
    const db = open();
    db.query('SELECT end FROM knows WHERE start = 0');
    // The source is read from the index while the same graph's other table is written, node by node.
    db.exec('INSERT INTO likes SELECT k.start, k.end FROM knows k WHERE k.start = 7');
    expect(db.query('SELECT end FROM likes WHERE start = 7').rows).toEqual([[6], [8], [9], [10]]);
    db.exec('BEGIN');
    db.exec('INSERT INTO knows VALUES (7, 44, 0)');
    expect(db.query('SELECT end FROM knows WHERE start = 7').rows).toEqual([[8], [9], [10], [44]]);
    db.exec('COMMIT');
    expect(db.query('SELECT end FROM knows WHERE start = 7').rows).toEqual([[8], [9], [10], [44]]);
    expect(state(db).builds).toBe(1);
  });
});

describe("the graph's rules read the index", () => {
  /** People with no relationship, or one: 101 knows someone, 102 is known, 103 likes, 104 is liked, 105 likes itself, 106 knows and is liked. */
  const more = (db: Database): Database => {
    db.exec("INSERT INTO person SELECT 100 + value, 'q' FROM (SELECT 0 AS value UNION ALL SELECT 1 UNION ALL SELECT 2 UNION ALL SELECT 3 UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6)");
    db.exec('INSERT INTO knows VALUES (101, 0, 1), (0, 102, 1), (106, 0, 1); INSERT INTO likes VALUES (103, 0), (0, 104), (105, 105), (0, 106)');
    return db;
  };
  const refusal = (db: Database, sql: string): string => {
    try {
      db.exec(sql);
    } catch (e) {
      return /relationships in (\S+) refer to it/.exec((e as Error).message)?.[1] ?? (e as Error).message;
    }
    return 'done';
  };
  /** What deleting each of those people gives: the table and end that refuses it, or done. */
  const deletes = (db: Database): string[] => [101, 102, 103, 104, 105, 106, 100].map((id) => refusal(db, `DELETE FROM person WHERE id = ${id}`));
  const WANT = ['knows.start', 'knows.end', 'likes.start', 'likes.end', 'likes.start', 'knows.start', 'done'];

  it('a node with a relationship is refused as the tables refuse it: the first table and end, in the graph\'s order', () => {
    const built = more(open());
    built.query('SELECT end FROM knows WHERE start = 7');
    expect(state(built).built).toBe(true);
    expect(deletes(built)).toEqual(WANT);
    expect(state(built)).toMatchObject({ built: true, builds: 1 });
    // Changing a node's id is refused the same way.
    expect([101, 104, 105].map((id) => refusal(built, `UPDATE person SET id = id + 1000 WHERE id = ${id}`))).toEqual(['knows.start', 'likes.end', 'likes.start']);
    // With graph indexes off the tables are asked; with none built yet, the first node asked about builds it.
    expect(deletes(more(open({ graphIndexMem: 0 })))).toEqual(WANT);
    const fresh = more(open());
    expect(state(fresh).built).toBe(false);
    expect(deletes(fresh)).toEqual(WANT);
    expect(state(fresh)).toMatchObject({ built: true, builds: 1 });
  });

  it('follows what the statement and the transaction wrote, and what a rollback undid', () => {
    const db = more(open());
    db.query('SELECT end FROM knows WHERE start = 7');
    // Its relationships deleted, a node goes; a relationship given to a free node holds it.
    db.exec('DELETE FROM knows WHERE start = 101');
    expect(refusal(db, 'DELETE FROM person WHERE id = 101')).toBe('done');
    db.exec('INSERT INTO likes VALUES (0, 100)');
    expect(refusal(db, 'DELETE FROM person WHERE id = 100')).toBe('likes.end');
    // In a transaction, and after it is undone: the index is dropped, and the tables refuse until it is built again.
    db.exec('BEGIN; DELETE FROM likes WHERE end = 100; DELETE FROM knows WHERE end = 102');
    expect([refusal(db, 'DELETE FROM person WHERE id = 100'), refusal(db, 'DELETE FROM person WHERE id = 102')]).toEqual(['done', 'done']);
    db.exec('ROLLBACK');
    expect(state(db).built).toBe(false);
    expect([refusal(db, 'DELETE FROM person WHERE id = 100'), refusal(db, 'DELETE FROM person WHERE id = 102')]).toEqual(['likes.end', 'knows.end']);
    db.query('SELECT end FROM knows WHERE start = 7');
    expect([refusal(db, 'DELETE FROM person WHERE id = 100'), refusal(db, 'DELETE FROM person WHERE id = 102')]).toEqual(['likes.end', 'knows.end']);
    // One statement that deletes a node's relationships and then the node, row by row.
    db.exec('DELETE FROM likes WHERE start = 105; DELETE FROM person WHERE id = 105');
    expect(db.query('SELECT count(*) FROM person WHERE id >= 100').rows).toEqual([[5]]);
    expect(state(db)).toMatchObject({ built: true, off: null });
  });

  it('asks the tables about an id the index holds no node for, and in a graph it cannot hold', () => {
    const db = more(open());
    db.query('SELECT end FROM knows WHERE start = 7');
    db.query('INSERT INTO person VALUES (?, ?), (?, ?)', [2 ** 31, 'far', 2n ** 60n, 'further']);
    expect([refusal(db, `DELETE FROM person WHERE id = ${2 ** 31}`), refusal(db, `DELETE FROM person WHERE id = ${2n ** 60n}`)]).toEqual(['done', 'done']);
    expect(state(db)).toMatchObject({ built: true, off: null, builds: 1 });
    // A relationship of a node past 2^31 - 1: the index holds the graph no more, and the tables refuse as before.
    db.query('INSERT INTO person VALUES (?, ?)', [2 ** 31 + 5, 'far']);
    db.query('INSERT INTO likes VALUES (?, 0)', [2 ** 31 + 5]);
    expect(state(db).off).not.toBe(null);
    expect(deletes(db)).toEqual(WANT);
    expect(refusal(db, `DELETE FROM person WHERE id = ${2 ** 31 + 5}`)).toBe('likes.start');
  });

  it("finds a relationship that starts a block of the node's list", () => {
    // Node 0 starts 1,024 KNOWS and one LIKES: built from the tables, its list is a full block and a block of one.
    const db = Database.openMemory();
    db.exec('CREATE TABLE person(id INTEGER PRIMARY KEY); CREATE TABLE knows(start INTEGER, end INTEGER); CREATE TABLE likes(start INTEGER, end INTEGER)');
    db.exec('CREATE INDEX knows_start ON knows(start, end); CREATE INDEX knows_end ON knows(end, start); CREATE INDEX likes_start ON likes(start, end); CREATE INDEX likes_end ON likes(end, start)');
    const edges = [
      { type: 'KNOWS', table: 'knows', start: 'start', end: 'end' },
      { type: 'LIKES', table: 'likes', start: 'start', end: 'end' },
    ];
    schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'big', nodes: [{ label: 'Person', table: 'person', id: 'id' }], edges } });
    db.exec('WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 1024) INSERT INTO person SELECT i FROM n');
    db.exec('INSERT INTO knows SELECT 0, id FROM person WHERE id > 0; INSERT INTO likes VALUES (0, 7)');
    const inside = db as unknown as { graphIndexes: GraphIndexes; tables: Map<string, TableSchema> };
    const likes = inside.graphIndexes.rolesOf(inside.tables.get('likes')!)![0]!;
    expect(inside.graphIndexes.connected(likes, true, 0)).toBe(true);
    expect(state(db)).toMatchObject({ built: true, entries: 1025, builds: 1 });
    expect([inside.graphIndexes.connected(likes, false, 7), inside.graphIndexes.connected(likes, false, 0), inside.graphIndexes.connected(likes, true, 7)]).toEqual([true, false, false]);
  });
});

describe('rollbacks', () => {
  it('a rollback that undid a relationship drops the index, and it is built again', () => {
    const db = open();
    const out = () => db.query('SELECT end FROM knows WHERE start = 7').rows.map((r) => r[0]);
    out();
    db.exec('BEGIN');
    db.exec('INSERT INTO knows VALUES (7, 44, 0)');
    expect(out()).toEqual([8, 9, 10, 44]);
    db.exec('ROLLBACK');
    expect(state(db).built).toBe(false);
    expect(out()).toEqual([8, 9, 10]);
    expect(state(db)).toMatchObject({ built: true, builds: 2 });
  });

  it('a rollback that undid nothing of the graph keeps it', () => {
    const db = open();
    db.query('SELECT end FROM knows WHERE start = 7');
    db.exec("BEGIN; INSERT INTO person VALUES (100, 'x'); ROLLBACK");
    expect(code(() => db.exec('INSERT INTO person VALUES (1, 1)'))).toBe('SMALT_CONSTRAINT_PRIMARYKEY');
    expect(state(db)).toMatchObject({ built: true, builds: 1 });
  });

  it('a savepoint and a failed statement', () => {
    const db = open();
    const out = () => db.query('SELECT end FROM knows WHERE start = 7').rows.map((r) => r[0]);
    out();
    db.exec('BEGIN; INSERT INTO knows VALUES (7, 40, 0); SAVEPOINT s; INSERT INTO knows VALUES (7, 41, 0)');
    expect(out()).toEqual([8, 9, 10, 40, 41]);
    db.exec('ROLLBACK TO s');
    expect(out()).toEqual([8, 9, 10, 40]);
    // The second row's end is no node: the statement fails after writing its first row.
    expect(code(() => db.exec('INSERT INTO knows VALUES (7, 42, 0), (7, 4242, 0)'))).toBe('SMALT_CONSTRAINT_FOREIGNKEY');
    expect(out()).toEqual([8, 9, 10, 40]);
    db.exec('COMMIT');
    expect(out()).toEqual([8, 9, 10, 40]);
  });

  it('an index built inside a transaction that wrote goes with its rollback', () => {
    const db = open();
    db.exec('BEGIN; INSERT INTO knows VALUES (7, 44, 0)');
    expect(db.query('SELECT end FROM knows WHERE start = 7').rows).toEqual([[8], [9], [10], [44]]);
    db.exec('ROLLBACK');
    expect(db.query('SELECT end FROM knows WHERE start = 7').rows).toEqual([[8], [9], [10]]);
  });
});

describe('changes to the graph', () => {
  it('a relationship type added later is read into the index that is there', () => {
    const db = open();
    db.query('SELECT end FROM knows WHERE start = 7');
    schema(db, { op: 'alterPropertyGraph', name: 'social', action: { kind: 'addType', type: 'FOLLOWS', table: 'follows' } });
    db.exec('INSERT INTO follows(start, end) SELECT id, (id + 5) % 50 FROM person');
    db.exec('INSERT INTO follows(start, end) VALUES (1, 2), (1, 3), (4, 1)');
    expect(plan(db, 'SELECT end FROM follows WHERE start = 1')).toContain('USING GRAPH INDEX');
    expect(db.query('SELECT end FROM follows WHERE start = 1').rows).toEqual([[2], [3], [6]]);
    expect(db.query('SELECT start FROM follows WHERE end = 1').rows).toEqual([[4], [46]]);
    expect(db.query('SELECT end FROM knows WHERE start = 7').rows).toEqual([[8], [9], [10]]);
    expect(state(db)).toMatchObject({ built: true, entries: 253, builds: 1 });
  });

  it('an index made on an edge table changes nothing; a graph dropped takes its index with it', () => {
    const db = open();
    db.query('SELECT end FROM knows WHERE start = 7');
    db.exec('CREATE INDEX knows_since ON knows(since)');
    expect(db.query('SELECT end FROM knows WHERE start = 7').rows).toEqual([[8], [9], [10]]);
    expect(state(db).builds).toBe(1);
    schema(db, { op: 'drop', objectType: 'property graph', name: 'social', ifExists: false });
    expect(db.graphIndexState.state()).toEqual([]);
    expect(plan(db, 'SELECT end FROM knows WHERE start = 7')).not.toContain('GRAPH INDEX');
    expect(db.query('SELECT end FROM knows WHERE start = 7').rows).toEqual([[8], [9], [10]]);
  });
});

describe('graphs the index does not hold', () => {
  it('ids past 2^31 - 1: the graph is read from the B+trees', () => {
    const db = open();
    db.query('SELECT end FROM knows WHERE start = 7');
    db.exec('INSERT INTO knows(rowid, start, end) VALUES (3000000000, 7, 11)');
    expect(state(db)).toMatchObject({ built: false });
    expect(state(db).off).toContain('not an integer from 0 to 2147483647');
    expect(db.query('SELECT end FROM knows WHERE start = 7').rows).toEqual([[8], [9], [10], [11]]);
    expect(state(db).builds).toBe(1);
  });

  it('found when it is built, too', () => {
    const db = open();
    db.exec('INSERT INTO knows(rowid, start, end) VALUES (3000000000, 7, 11)');
    expect(db.query('SELECT end FROM knows WHERE start = 7').rows).toEqual([[8], [9], [10], [11]]);
    expect(state(db)).toMatchObject({ built: false });
    expect(state(db).off).toContain('knows');
  });

  it('a memory limit', () => {
    const small = open({ graphIndexMem: 4096 });
    expect(small.query('SELECT end FROM knows WHERE start = 7').rows).toEqual([[8], [9], [10]]);
    expect(state(small)).toMatchObject({ built: false });
    expect(state(small).off).toContain('more than 4096 bytes');
    const none = open({ graphIndexMem: 0 });
    expect(plan(none, 'SELECT end FROM knows WHERE start = 7')).not.toContain('GRAPH INDEX');
    expect(none.query('SELECT end FROM knows WHERE start = 7').rows).toEqual([[8], [9], [10]]);
  });

  it('an edge table without endpoint indexes is indexed from its rows, and read by a scan', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE n(id INTEGER PRIMARY KEY); CREATE TABLE e(a INTEGER, b INTEGER); INSERT INTO n VALUES (1), (2), (3)');
    schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'g', nodes: [{ label: 'N', table: 'n', id: 'id' }], edges: [{ type: 'E', table: 'e', start: 'a', end: 'b' }] } });
    db.exec('INSERT INTO e VALUES (1, 2), (1, 3), (3, 1)');
    expect(plan(db, 'SELECT b FROM e WHERE a = 1')).not.toContain('GRAPH INDEX');
    expect(db.query('SELECT b FROM e WHERE a = 1').rows).toEqual([[2], [3]]);
  });

  it('a reader holds none', async () => {
    const vfs = new MemoryVfs();
    const owner = social(await Database.open(vfs, 'db', { sharedHandles: true }));
    const reader = await Database.openReader(vfs, 'db');
    expect(plan(owner, 'SELECT end FROM knows WHERE start = 7')).toContain('GRAPH INDEX');
    expect(plan(reader, 'SELECT end FROM knows WHERE start = 7')).not.toContain('GRAPH INDEX');
    expect(reader.query('SELECT end FROM knows WHERE start = 7').rows).toEqual([[8], [9], [10]]);
    expect(owner.prepare('SELECT end FROM knows WHERE start = 7').usesGraphIndex).toBe(true);
    expect(owner.prepare('SELECT name FROM person WHERE id = 7').usesGraphIndex).toBe(false);
  });
});

describe('a random run of writes and transactions', () => {
  it('reads the same from the index as from the tables throughout', () => {
    const db = open();
    let seed = 20261120;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed % n;
    };
    const table = () => (rnd(3) === 0 ? 'likes' : 'knows');
    const read = (t: string, by: 'start' | 'end', node: number) => {
      const other = by === 'start' ? 'end' : 'start';
      // The test setting runs it again without the index; NOT INDEXED reads the table itself.
      const got = db.query(`SELECT ${other}, rowid FROM ${t} WHERE ${by} = ?`, [node]).rows;
      expect(got, `${t} ${by} = ${node}`).toEqual(db.query(`SELECT ${other}, rowid FROM ${t} NOT INDEXED WHERE ${by} = ? ORDER BY 1, 2`, [node]).rows);
    };
    let depth = 0; // 0: autocommit, 1: in a transaction, 2: in a savepoint
    let failures = 0;
    for (let step = 0; step < 600; step++) {
      const t = table();
      const a = rnd(50);
      const b = rnd(50);
      switch (rnd(12)) {
        case 0:
        case 1:
        case 2:
          db.exec(t === 'knows' ? `INSERT INTO knows VALUES (${a}, ${b}, ${step})` : `INSERT INTO likes VALUES (${a}, ${b})`);
          break;
        case 3:
          db.exec(`DELETE FROM ${t} WHERE start = ${a} AND end % 3 = ${rnd(3)}`);
          break;
        case 4:
          db.exec(`UPDATE ${t} SET end = ${b} WHERE start = ${a} AND end % 2 = ${rnd(2)}`);
          break;
        case 5:
          db.exec(`UPDATE ${t} SET start = ${b} WHERE end = ${a} AND start % 2 = ${rnd(2)}`);
          break;
        case 6:
          // Fails on its second row, after writing its first.
          if (code(() => db.exec(`INSERT INTO likes VALUES (${a}, ${b}), (${a}, 9999)`)) === 'SMALT_CONSTRAINT_FOREIGNKEY') failures++;
          break;
        case 7:
          if (depth === 0) {
            db.exec('BEGIN');
            depth = 1;
          } else if (depth === 1) {
            db.exec('SAVEPOINT s');
            depth = 2;
          }
          break;
        case 8:
          if (depth === 2) {
            db.exec(rnd(2) ? 'ROLLBACK TO s; RELEASE s' : 'RELEASE s');
            depth = 1;
          } else if (depth === 1) {
            db.exec(rnd(2) ? 'ROLLBACK' : 'COMMIT');
            depth = 0;
          }
          break;
        default:
          read(t, rnd(2) ? 'start' : 'end', a);
      }
      if (step % 7 === 0) read(t, 'start', a);
    }
    if (depth > 0) db.exec('COMMIT');
    for (let node = 0; node < 50; node++) {
      read('knows', 'start', node);
      read('likes', 'end', node);
    }
    expect(failures).toBeGreaterThan(10);
    expect(state(db).builds).toBeGreaterThan(5);
    db.graphIndexState.check();
  });
});
