/**
 * The property maps of a graph's tables in its graph index (ADR 0041, section 2): the `props` of each row that was
 * read by its rowid, as the table stores it, in memory. A relationship's properties, and a node found by its id, are
 * read from the table the first time and from there afterwards, without a descent of the table's B+tree. A row the
 * index knows is followed when its props change, and forgotten when it goes. Every database here runs with the test
 * setting on (test/setup-sql.ts): the maps held are compared with the tables after each write, and a query that
 * reads them is run again without them.
 */
import { describe, expect, it } from 'vitest';
import { Database, type DatabaseOptions } from '../src/engine/database.js';
import { GraphProps, type PropsCheck } from '../src/engine/exec/graph-props.js';
import { MapCompare } from '../src/engine/exec/nested-ops.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import type { PlanType } from '../src/engine/plan/types.js';
import { encodeKey } from '../src/engine/storage/key-codec.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const M = 'map<text, any>' as PlanType;
type Props = Record<string, unknown> | null;

const statement = (db: Database, s: Record<string, unknown>) => db.queryPlan(s as unknown as PlanStatementInput);
const schema = (db: Database, op: Record<string, unknown>): void => void statement(db, { kind: 'schema', op });
const write = (db: Database, plan: PlanOp): void => void statement(db, { kind: 'write', plan });
const column = (name: string, type: string, declaredType = type) => ({ name, declaredType, type, notNull: false, collation: 'binary' });
const KEY = [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], ofColumn: 0 }];
const table = (db: Database, name: string, columns: unknown[], keys: unknown[] = []): void =>
  schema(db, { op: 'createTable', table: { name, columns, keys, checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false });

const GRAPH = {
  name: 'g',
  nodes: [
    { label: 'Person', table: 'person', id: 'id', props: 'props' },
    { label: 'Place', table: 'place', id: 'id', props: 'props' },
    { label: 'Tag', table: 'tag', id: 'id' },
  ],
  edges: [
    { type: 'KNOWS', table: 'knows', start: 'start', end: 'end', props: 'props' },
    { type: 'LIVES', table: 'lives', start: 'start', end: 'end' },
  ],
};
const PEOPLE = 200;
/** A person's properties as they are loaded: every seventh has none. */
const person = (i: number): Props => (i % 7 === 3 ? null : { name: `p${i}`, age: 20 + (i % 50), ...(i % 5 === 0 ? { note: 'x'.repeat(i) } : {}) });
const since = (i: number): Props => ({ since: 2000 + (i % 20) });

const eq = (a: PlanExpr, b: PlanExpr): PlanExpr => p.call('cmp_eq', [a, b], 'bool');
/** Sets the props (a table's column `column`) of its rows with the rowids `ids`: the table joined with the values. */
const setProps = (db: Database, name: 'person' | 'knows', ids: number[], props: Props[]): void => {
  const input = p.filter(p.join('cross', p.scan(name, [-1]), p.fromColumns([ids, props] as never, ['int', M])), eq(p.col(0, 0, 'int'), p.col(0, 1, 'int')));
  write(db, { op: 'update', table: name, db: 'main', input, rowid: 0, sets: [{ column: name === 'knows' ? 2 : 1, value: p.col(0, 2, M) }], from: true } as unknown as PlanOp);
};
const addPeople = (db: Database, ids: number[], props: Props[]): void => write(db, p.append('person', p.fromColumns([ids, props] as never, ['int', M]), [0, 1]));

/**
 * People (id, props), places (id, name, props; ids from 1000) and tags (id; from 2000): a graph's nodes have ids of
 * their own. A person knows the next one (with props) and lives in a place (without).
 */
function social(db: Database): Database {
  table(db, 'person', [column('id', 'INTEGER'), column('props', 'MAP', M)], KEY);
  table(db, 'place', [column('id', 'INTEGER'), column('name', 'TEXT'), column('props', 'MAP', M)], KEY);
  table(db, 'knows', [column('start', 'INTEGER'), column('end', 'INTEGER'), column('props', 'MAP', M)]);
  db.exec(`
    CREATE TABLE tag(id INTEGER PRIMARY KEY);
    CREATE TABLE lives(start INTEGER, end INTEGER);
    CREATE INDEX knows_start ON knows(start, end); CREATE INDEX knows_end ON knows(end, start);
    CREATE INDEX lives_start ON lives(start, end); CREATE INDEX lives_end ON lives(end, start);
  `);
  schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: GRAPH });
  const ids = Array.from({ length: PEOPLE }, (_, i) => i);
  addPeople(db, ids, ids.map(person));
  write(db, p.append('place', p.fromColumns([[1000, 1001, 1002], ['Lisbon', 'Oslo', 'Rome'], [{ pop: 5 }, null, { pop: 7 }]] as never, ['int', 'text', M]), [0, 1, 2]));
  write(db, p.append('knows', p.fromColumns([ids, ids.map((i) => (i + 1) % PEOPLE), ids.map(since)] as never, ['int', 'int', M]), [0, 1, 2]));
  db.exec('INSERT INTO tag VALUES (2001), (2002); INSERT INTO lives SELECT id, 1000 + id % 3 FROM person');
  return db;
}
const open = (options: DatabaseOptions = {}): Database => social(Database.openMemory(options));
const plan = (db: Database, sql: string, params: unknown[] = []): string => db.query(`EXPLAIN QUERY PLAN ${sql}`, params as never).rows.map((r) => String(r[3])).join('\n');
const explain = (db: Database, op: PlanOp): string => (statement(db, { kind: 'explain', mode: 'plan', query: { kind: 'query', plan: op } }).rows as unknown[][]).map((r) => String(r[3])).join('\n');
const state = (db: Database) => db.graphIndexState.state()[0]!;
const NODE = 'SELECT id, props FROM person WHERE id = ?';
/** A person's id and props, by the statement the graph index answers. */
const read = (db: Database, id: unknown): unknown[][] => db.query(NODE, [id as never]).rows;
/** The same from the table's B+tree: the scan lists a rowid range, which the index does not answer. */
const stored = (db: Database, id: number): unknown[][] => db.query('SELECT id, props FROM person WHERE id >= ? AND id <= ?', [id, id]).rows;
/** The relationships at a node (of every type, or those who know), with their props. */
const at = (node: number, direction: 'out' | 'in' | 'both' = 'out', types?: string[]): PlanOp => p.filter(p.relationships('g', direction, types ? { types } : {}), eq(p.col(0, 0, 'int'), p.lit(node, 'int')));
const knows = (node: number): PlanOp => at(node, 'out', ['KNOWS']);
/** A place by its id, reading the columns `columns` of its table. */
const place = (id: number, columns: number[]): PlanOp => p.filter(p.scan('place', columns), eq(p.col(0, 0, 'int'), p.lit(id, 'int')));
const rows = (db: Database, op: PlanOp): unknown[][] => db.queryPlan(op).rows as unknown[][];

describe('property maps', () => {
  const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);

  it("hold a row's bytes by rowid, and know a row without props from one never read", () => {
    const m = new GraphProps();
    expect([m.get(0), m.known(0), m.rows, m.bytes()]).toEqual([undefined, false, 0, 0]);
    m.set(0, bytes(1, 2, 3));
    m.set(5, null);
    m.set(4095, bytes());
    m.set(4096, bytes(9));
    m.set(2 ** 31 - 1, bytes(7, 7));
    expect([m.get(0), m.get(5), m.get(4095), m.get(4096), m.get(2 ** 31 - 1)]).toEqual([bytes(1, 2, 3), null, bytes(), bytes(9), bytes(7, 7)]);
    expect([m.get(1), m.get(4097), m.get(2 ** 31 - 2)]).toEqual([undefined, undefined, undefined]);
    expect([m.known(5), m.known(4095), m.known(1), m.rows]).toEqual([true, true, false, 5]);
    // What a reader gets is its own: changing it changes nothing held.
    m.get(0)!.fill(0);
    expect(m.get(0)).toEqual(bytes(1, 2, 3));
    const all: [number, Uint8Array | null][] = [];
    m.forEach((rowid, props) => void all.push([rowid, props && props.slice()]));
    expect(all).toEqual([[0, bytes(1, 2, 3)], [5, null], [4095, bytes()], [4096, bytes(9)], [2 ** 31 - 1, bytes(7, 7)]]);
    // Three pages of rowids (0, 1 and the last), each two arrays of 4,096 numbers, and the first buffer.
    expect(m.bytes()).toBe(4096 + 3 * 4096 * 8);
  });

  it('take a changed row, and forget a row', () => {
    const m = new GraphProps();
    m.set(1, bytes(1));
    m.set(2, bytes(2, 2));
    m.set(1, bytes(3, 3, 3));
    m.set(2, null);
    expect([m.get(1), m.get(2), m.rows]).toEqual([bytes(3, 3, 3), null, 2]);
    m.set(2, bytes(4));
    m.forget(1);
    expect([m.get(1), m.get(2), m.known(1), m.rows]).toEqual([undefined, bytes(4), false, 1]);
    m.set(1, bytes(5));
    expect([m.get(1), m.rows]).toEqual([bytes(5), 2]);
    m.forget(1);
    m.forget(2);
    m.forget(2);
    m.forget(9);
    m.forget(5000);
    expect([m.get(1), m.get(2), m.known(1), m.known(2), m.rows]).toEqual([undefined, undefined, false, false, 0]);
    // Cleared, they know no row and keep their memory for the next ones.
    m.set(1, bytes(6));
    m.set(9000, null);
    const held = m.bytes();
    m.clear();
    expect([m.get(1), m.get(9000), m.known(9000), m.rows, m.bytes()]).toEqual([undefined, undefined, false, 0, held]);
    m.set(1, bytes(7, 7));
    expect([m.get(1), m.rows, m.bytes()]).toEqual([bytes(7, 7), 1, held]);
  });

  it('write a buffer again without the bytes no row points at, so rows changed over and over do not grow it', () => {
    const m = new GraphProps();
    const value = (row: number, round: number): Uint8Array => Uint8Array.from({ length: 40 + (row % 7) }, (_, i) => (row * 31 + round * 7 + i) & 255);
    for (let round = 0; round < 500; round++) for (let row = 0; row < 100; row++) m.set(row, value(row, round));
    for (let row = 0; row < 100; row++) expect(m.get(row), `row ${row}`).toEqual(value(row, 499));
    // About 4.3 KB of maps are live; 2.2 MB were written.
    expect(m.bytes()).toBeLessThan(4096 * 8 + 32 * 1024);
    // Rows forgotten leave room the same way.
    for (let row = 0; row < 100; row += 2) m.forget(row);
    for (let round = 0; round < 500; round++) for (let row = 1; row < 100; row += 2) m.set(row, value(row, round));
    expect(m.rows).toBe(50);
    for (let row = 1; row < 100; row += 2) expect(m.get(row)).toEqual(value(row, 499));
    expect(m.bytes()).toBeLessThan(4096 * 8 + 32 * 1024);
  });

  it('know a row that is gone from the index while its table still has it, and take rows the table has not yet', () => {
    const m = new GraphProps();
    m.set(1, bytes(1, 1));
    m.set(2, null);
    m.setGone(1);
    m.setGone(7);
    // A gone row is known (its table is not read for it), has no props, and passes no condition.
    expect([m.gone(1), m.gone(7), m.gone(2), m.gone(3), m.gone(5000)]).toEqual([true, true, false, false, false]);
    expect([m.known(1), m.known(7), m.get(1), m.get(7), m.rows]).toEqual([true, true, undefined, undefined, 1]);
    expect([m.rulesOut(1, []), m.rulesOut(7, []), m.rulesOut(3, [])]).toEqual([true, true, false]);
    const all: number[] = [];
    m.forEach((rowid) => void all.push(rowid));
    expect(all).toEqual([2]);
    // Forgotten, nothing is known of it; set again, it is a row as any.
    m.forget(7);
    m.put(1, bytes(3));
    expect([m.gone(7), m.known(7), m.gone(1), m.get(1), m.rows]).toEqual([false, false, false, bytes(3), 2]);
    // Full, the maps take no more rows read from the table, follow the rows they know, and take what is put.
    m.full = true;
    m.set(9, bytes(9));
    m.set(1, bytes(4, 4));
    m.put(10, bytes(5));
    expect([m.get(9), m.get(1), m.get(10), m.rows]).toEqual([undefined, bytes(4, 4), bytes(5), 3]);
    m.full = false;
    m.set(9, bytes(9));
    expect(m.get(9)).toEqual(bytes(9));
    m.closed = true;
    expect([m.gone(1), m.known(1)]).toEqual([false, false]);
  });

  it('let a page of rowids go when none of its rows is known, so rows made and deleted with ids that go up take no room', () => {
    const m = new GraphProps();
    m.set(0, bytes(1));
    const base = m.bytes();
    const value = (row: number): Uint8Array => Uint8Array.from({ length: 30 }, (_, i) => (row + i) & 255);
    // 200,000 rows, 1,000 at a time: put, some set gone or set again, all forgotten.
    for (let from = 4096; from < 204096; from += 1000) {
      for (let row = from; row < from + 1000; row++) m.put(row, value(row));
      for (let row = from; row < from + 1000; row += 3) m.setGone(row);
      for (let row = from + 1; row < from + 1000; row += 3) m.put(row, value(row + 1));
      expect(m.get(from + 1)).toEqual(value(from + 2));
      for (let row = from; row < from + 1000; row++) m.forget(row);
    }
    expect([m.rows, m.get(0), m.known(4096), m.known(204095)]).toEqual([1, bytes(1), false, false]);
    // The page of row 0 and a buffer that held 1,000 rows at most: no page for the 49 that came and went.
    expect(m.bytes()).toBeLessThan(base + 256 * 1024);
    expect(m.bytes()).toBeLessThan(2 * 4096 * 8 + 256 * 1024);
  });

  it("check a known row's map where it lies, and rule out no row they do not know", () => {
    const m = new GraphProps();
    const key = (k: string): Uint8Array => encodeKey([k]);
    const is = (k: string, v: number | string): PropsCheck => ({ key: key(k), op: MapCompare.Eq, lit: encodeKey([v]) });
    const has = (k: string): PropsCheck => ({ key: key(k), op: MapCompare.None, lit: null });
    m.set(1, encodeKey(['age', 30, 'name', 'Ada']));
    m.set(2, encodeKey(['age', 31]));
    m.set(3, null);
    m.set(4, new Uint8Array(0));
    m.set(4096, encodeKey(['name', 'Bo']));
    // A row is ruled out when its map fails a check: a key it lacks, or a value of the literal's kind that differs.
    expect([1, 2, 4, 4096].map((row) => m.rulesOut(row, [is('age', 30)]))).toEqual([false, true, true, true]);
    expect([1, 2, 4, 4096].map((row) => m.rulesOut(row, [has('name')]))).toEqual([false, true, true, false]);
    expect([m.rulesOut(1, [is('age', 30), is('name', 'Ada')]), m.rulesOut(1, [is('age', 30), is('name', 'Bo')]), m.rulesOut(1, [is('name', 'Bo'), is('age', 30)])]).toEqual([false, true, true]);
    // A value of another kind than the literal's is left to the conjunct. No check rules nothing out.
    expect([m.rulesOut(1, [is('age', '30')]), m.rulesOut(1, []), m.rulesOut(2, [])]).toEqual([false, false, false]);
    // A row with no props passes no condition on a key; a row not known is never ruled out.
    expect([m.rulesOut(3, [has('age')]), m.rulesOut(3, [])]).toEqual([true, true]);
    expect([0, 5, 4095, 4097, 9000, 2 ** 31 - 1].map((row) => m.rulesOut(row, [is('age', 30)]))).toEqual([false, false, false, false, false, false]);
    // A changed row is checked on its new map, wherever the buffer was written again; a forgotten one is not known.
    for (let round = 0; round < 300; round++) m.set(2, encodeKey(['age', round, 'pad', 'x'.repeat(50)]));
    expect([m.rulesOut(2, [is('age', 299)]), m.rulesOut(2, [is('age', 31)]), m.rulesOut(1, [is('age', 30)]), m.rulesOut(4096, [has('name')])]).toEqual([false, true, false, false]);
    m.forget(1);
    expect(m.rulesOut(1, [is('age', 31)])).toBe(false);
    m.closed = true;
    expect([m.rulesOut(2, [is('age', 31)]), m.rulesOut(3, [has('age')])]).toEqual([false, false]);
  });

  it('say when they take more memory, and know no row once they are let go', () => {
    let grown = 0;
    const m = new GraphProps(() => grown++);
    m.set(0, bytes(1));
    // A page of rowids and a buffer.
    expect(grown).toBe(2);
    m.set(1, bytes(2));
    m.forget(1);
    expect(grown).toBe(2);
    m.set(5000, null);
    expect(grown).toBe(3);
    m.set(3, Uint8Array.from({ length: 5000 }));
    expect(grown).toBe(4);
    m.closed = true;
    expect([m.get(0), m.get(5000), m.known(0)]).toEqual([undefined, undefined, false]);
    m.set(9, bytes(1));
    expect(m.get(9)).toBe(undefined);
  });
});

describe('a node found by its id', () => {
  it('is read from the graph index: its id and its properties', () => {
    const db = open();
    expect(plan(db, NODE, [5])).toBe('SEARCH person USING GRAPH INDEX (rowid=?)');
    expect(db.prepare(NODE).usesGraphIndex).toBe(true);
    expect(state(db).props).toBe(0);
    // Each row is read from the table once, and is known from then on.
    const ids = [0, 1, 3, 5, 100, PEOPLE - 1];
    ids.forEach((id, i) => {
      expect(read(db, id), `person ${id}`).toEqual([[id, person(id)]]);
      expect(state(db).props).toBe(i + 1);
      expect(read(db, id), `person ${id}, again`).toEqual([[id, person(id)]]);
    });
    expect(read(db, 3)).toEqual([[3, null]]);
    // The key as a rowid lookup takes it: a whole number of any kind, or text that is one; anything else is no row.
    expect([read(db, 5.0), read(db, 5n), read(db, '5')]).toEqual([[[5, person(5)]], [[5, person(5)]], [[5, person(5)]]]);
    for (const id of [PEOPLE, -1, null, 5.5, 'x', 1000, 2 ** 31, 2 ** 40, -(2 ** 40)]) {
      expect(read(db, id), String(id)).toEqual([]);
      expect(read(db, id), `${String(id)}, again`).toEqual([]);
    }
    // The six rows read are known, and the relationships' lists were built once.
    expect(state(db)).toMatchObject({ built: true, off: null, props: ids.length, builds: 1 });
  });

  it("is each row's node in a join, and its properties are read as a row's are", () => {
    const db = open();
    const sql = 'SELECT k.start, p.props FROM knows k JOIN person p ON p.id = k.end WHERE k.start < 50 ORDER BY k.start';
    expect(plan(db, sql)).toContain('SEARCH person USING GRAPH INDEX (rowid=?)');
    expect(db.query(sql).rows).toEqual(Array.from({ length: 50 }, (_, i) => [i, person(i + 1)]));
    // By a plan: a comparison within a kind on a property, and the property itself.
    const node = p.scan('person', [0, 1]);
    const age = p.call('map_get', [p.col(0, 2, M), p.lit('age')], 'any');
    const found = p.filter(p.join('cross', p.fromColumns([[4, 3, 60, 999, 61]], ['int']), node), p.and(eq(p.col(0, 1, 'int'), p.col(0, 0, 'int')), p.call('cmp_gt_kind', [age, p.lit(25)], 'bool')));
    expect(explain(db, found)).toContain('SEARCH person USING GRAPH INDEX (rowid=?)');
    expect(rows(db, p.project(found, [p.col(0, 0, 'int'), age]))).toEqual([[60, 30], [61, 31]]);
    // An outer join: a row for each id, with no node where there is none.
    const left = p.join('left', p.fromColumns([[5, 999, 3]], ['int']), node, eq(p.col(1, 0, 'int'), p.col(0, 0, 'int')));
    expect(explain(db, left)).toContain('SEARCH person USING GRAPH INDEX (rowid=?)');
    expect(rows(db, left)).toEqual([[5, 5, person(5)], [999, null, null], [3, 3, null]]);
  });

  it('is found in memory where nothing reads its props, once its row was looked up', () => {
    const db = open();
    addPeople(db, [500], [{ name: 'p500' }]);
    const props = (id: number): Props => (id === 500 ? { name: 'p500' } : person(id));
    // A nested plan gives each node's id and props. The plan around it counts its rows: the props have no reader.
    const nested = (ids: number[]): PlanOp => {
      const found = p.join('inner', p.fromColumns([ids], ['int']), p.scan('person', [0, 1]), eq(p.col(1, 0, 'int'), p.col(0, 0, 'int')));
      return p.join('cross', p.project(found, [p.col(0, 1, 'int'), p.col(0, 2, M)]), p.fromColumns([[1]], ['int']));
    };
    const counted = (ids: number[]) => ({ op: 'aggregate', input: nested(ids), keys: [], aggs: [{ fn: 'count', args: [], star: true, distinct: false, collation: 'binary', type: 'int' }], carry: [] }) as unknown as PlanOp;
    const ids = [4, 3, 60, 999, 61, 500];
    expect(explain(db, counted(ids))).toContain('SEARCH person USING GRAPH INDEX (rowid=?)');
    expect(state(db).props).toBe(0);
    for (let again = 0; again < 3; again++) expect(rows(db, counted(ids))).toEqual([[5]]);
    // The rows it found are known from then on, with their props as the table has them (person 3 has none).
    expect(state(db).props).toBe(5);
    for (const id of [3, 4, 60, 61, 500]) expect(read(db, id)).toEqual([[id, props(id)]]);
    expect(state(db).props).toBe(5);
    // A row that goes is found no more, and one that comes is.
    db.exec('DELETE FROM person WHERE id = 500');
    expect(rows(db, counted(ids))).toEqual([[4]]);
    expect(state(db).props).toBe(4);
    addPeople(db, [999], [null]);
    expect(rows(db, counted(ids))).toEqual([[5]]);
    // With the props read around the nested plan: from the index, as a row's are.
    expect(rows(db, p.project(nested(ids), [p.col(0, 0, 'int'), p.col(0, 1, M)]))).toEqual([4, 3, 60, 999, 61].map((id) => [id, id === 999 ? null : person(id)]));
  });

  it('is read from the table by a plan whose scan names another of its columns', () => {
    const db = open();
    // A scan's columns are all a plan may read of the table: its props, with its id or its rowid or neither.
    for (const columns of [[0, 2], [0, 2, 0], [0, -1, 2], [-1, 2]]) expect(explain(db, place(1002, columns)), String(columns)).toBe('SEARCH place USING GRAPH INDEX (rowid=?)');
    for (let again = 0; again < 2; again++) {
      expect(rows(db, place(1002, [0, 2]))).toEqual([[1002, { pop: 7 }]]);
      expect(rows(db, place(1001, [0, 2, -1]))).toEqual([[1001, null, 1001]]);
      expect(rows(db, place(1003, [0, 2]))).toEqual([]);
    }
    // Without the props among them there is nothing to remember: the row is looked up.
    expect(explain(db, place(1002, [0]))).toBe('SEARCH place USING INTEGER PRIMARY KEY (rowid=?)');
    // With the name among them, the row is read.
    expect(explain(db, place(1002, [0, 1, 2]))).toBe('SEARCH place USING INTEGER PRIMARY KEY (rowid=?)');
    expect(rows(db, place(1002, [0, 1, 2]))).toEqual([[1002, 'Rome', { pop: 7 }]]);
    expect(explain(db, place(1002, [0, 1]))).toBe('SEARCH place USING INTEGER PRIMARY KEY (rowid=?)');
    // SQL's scans name every column of a table, so it reads a place's row, and a person's from the index.
    expect(plan(db, 'SELECT id, props FROM place WHERE id = 1002')).toBe('SEARCH place USING INTEGER PRIMARY KEY (rowid=?)');
    expect(db.query('SELECT id, props FROM place WHERE id = 1002').rows).toEqual([[1002, { pop: 7 }]]);
  });

  it('is read from the table where it is not found by one id, and in a table without props', () => {
    const db = open();
    for (const sql of ['SELECT id, props FROM person', 'SELECT id, props FROM person WHERE id > 5', 'SELECT id, props FROM person WHERE id IN (1, 2)', 'SELECT id FROM tag WHERE id = 2001']) {
      expect(plan(db, sql), sql).not.toContain('GRAPH INDEX');
    }
    expect(db.query('SELECT id, props FROM person WHERE id IN (1, 2)').rows).toEqual([[1, person(1)], [2, person(2)]]);
    // No statement read a property by id: none are known.
    expect(state(db).props).toBe(0);
  });
});

describe("a relationship's properties", () => {
  it('are read from the graph index with the relationship, and only where a plan reads them', () => {
    const db = open();
    expect(rows(db, p.project(at(7), [p.col(0, 1, 'int'), p.col(0, 5, M)]))).toEqual([[8, since(7)], [1001, null]]);
    // The one relationship read is known. Living somewhere has no props to know.
    expect(state(db)).toMatchObject({ built: true, props: 1, builds: 1 });
    expect(rows(db, p.project(at(7, 'both'), [p.col(0, 1, 'int'), p.col(0, 2, 'text'), p.col(0, 5, M)]))).toEqual([
      [8, 'KNOWS', since(7)],
      [1001, 'LIVES', null],
      [6, 'KNOWS', since(6)],
    ]);
    expect(state(db).props).toBe(2);
    // Read again, from memory.
    expect(rows(db, p.project(at(7, 'both'), [p.col(0, 1, 'int'), p.col(0, 5, M)]))).toEqual([[8, since(7)], [1001, null], [6, since(6)]]);
    expect(state(db)).toMatchObject({ props: 2, builds: 1 });
    // A plan that reads no props reads none in: a new database holds none after it.
    const other = open();
    expect(rows(other, p.project(at(7), [p.col(0, 1, 'int')]))).toEqual([[8], [1001]]);
    expect(state(other)).toMatchObject({ built: true, props: 0 });
  });

  it('are filtered on as a row\'s are', () => {
    const db = open();
    const hop = p.join('cross', p.fromColumns([[0, 1, 2, 3, 4, 5]], ['int']), p.relationships('g', 'out', { types: ['KNOWS'] }));
    const year = p.call('map_get', [p.col(0, 6, M), p.lit('since')], 'any');
    const found = p.project(p.filter(hop, p.and(eq(p.col(0, 1, 'int'), p.col(0, 0, 'int')), p.call('cmp_ge_kind', [year, p.lit(2003)], 'bool'))), [p.col(0, 0, 'int'), year]);
    expect(rows(db, found)).toEqual([[3, 2003], [4, 2004], [5, 2005]]);
  });
});

describe('writes keep the property maps', () => {
  it('a row the index knows is followed when its props change, and forgotten when it goes', () => {
    const db = open();
    // Known: read before the write.
    expect([read(db, 5), read(db, 3), read(db, 6), read(db, 9), read(db, 500)]).toEqual([[[5, person(5)]], [[3, null]], [[6, person(6)]], [[9, person(9)]], []]);
    expect(state(db).props).toBe(4);
    setProps(db, 'person', [5, 3], [{ name: 'p5', age: 99, more: [1, 2] }, { name: 'had none' }]);
    expect([read(db, 5), read(db, 3)]).toEqual([[[5, { name: 'p5', age: 99, more: [1, 2] }]], [[3, { name: 'had none' }]]]);
    db.exec('UPDATE person SET props = NULL WHERE id = 5');
    expect(read(db, 5)).toEqual([[5, null]]);
    db.exec('DELETE FROM lives WHERE start = 6; DELETE FROM knows WHERE start = 6 OR end = 6; DELETE FROM person WHERE id = 6');
    expect(read(db, 6)).toEqual([]);
    // A row that was not there when it was asked for.
    addPeople(db, [500], [{ name: 'new' }]);
    expect(read(db, 500)).toEqual([[500, { name: 'new' }]]);
    // A row whose id changes is another row: the old one is forgotten, the new one is read when asked for.
    db.exec('DELETE FROM lives WHERE start = 9; DELETE FROM knows WHERE start = 9 OR end = 9; UPDATE person SET id = 900 WHERE id = 9');
    expect(state(db).props).toBe(3);
    expect([read(db, 9), read(db, 900)]).toEqual([[], [[900, person(9)]]]);
    expect(state(db)).toMatchObject({ built: true, props: 4, builds: 1 });
  });

  it('a row written without a change to its props stays as the index knows it', () => {
    const db = open();
    expect(rows(db, place(1002, [0, 2]))).toEqual([[1002, { pop: 7 }]]);
    expect(state(db).props).toBe(1);
    db.exec("UPDATE place SET name = 'Roma' WHERE id = 1002");
    expect(state(db).props).toBe(1);
    expect(rows(db, place(1002, [0, 2]))).toEqual([[1002, { pop: 7 }]]);
    expect(rows(db, place(1002, [0, 1, 2]))).toEqual([[1002, 'Roma', { pop: 7 }]]);
  });

  it('a row the index does not know is read from the table when it is asked for', () => {
    const db = open();
    expect(read(db, 5)).toEqual([[5, person(5)]]);
    // None of these was read: the writes leave the maps as they are.
    addPeople(db, [500, 501], [{ name: 'new' }, null]);
    setProps(db, 'person', [10, 3, 501], [{ name: 'p10', age: 1 }, { name: 'had none' }, { now: true }]);
    db.exec('DELETE FROM lives WHERE start = 6; DELETE FROM knows WHERE start = 6 OR end = 6; DELETE FROM person WHERE id = 6');
    expect(state(db).props).toBe(1);
    expect([read(db, 500), read(db, 501), read(db, 10), read(db, 3), read(db, 6)]).toEqual([[[500, { name: 'new' }]], [[501, { now: true }]], [[10, { name: 'p10', age: 1 }]], [[3, { name: 'had none' }]], []]);
    expect(state(db)).toMatchObject({ built: true, props: 5, builds: 1 });
  });

  it("a relationship's properties changed, and a relationship added and removed", () => {
    const db = open();
    const props = (node: number): unknown[][] => rows(db, p.project(knows(node), [p.col(0, 1, 'int'), p.col(0, 3, 'int'), p.col(0, 5, M)]));
    expect(props(7)).toEqual([[8, 8, since(7)]]);
    setProps(db, 'knows', [8, 12], [{ since: 1999, by: 'post' }, { since: 1 }]);
    expect([props(7), props(11)]).toEqual([[[8, 8, { since: 1999, by: 'post' }]], [[12, 12, { since: 1 }]]]);
    write(db, p.append('knows', p.fromColumns([[7, 7], [20, 30], [{ since: 2020 }, null]] as never, ['int', 'int', M]), [0, 1, 2]));
    expect(props(7)).toEqual([[8, 8, { since: 1999, by: 'post' }], [20, 201, { since: 2020 }], [30, 202, null]]);
    db.exec('DELETE FROM knows WHERE start = 7 AND end = 8');
    expect(props(7)).toEqual([[20, 201, { since: 2020 }], [30, 202, null]]);
    // Known: the two added and the one at 11. The one deleted is forgotten.
    expect(state(db)).toMatchObject({ built: true, props: 3, builds: 1 });
  });

  it('a rollback that may have undone what the index knows makes it know no row, and they are read again', () => {
    const db = open();
    expect(read(db, 5)).toEqual([[5, person(5)]]);
    // A change to a row the index knows, undone with no read in between.
    db.exec('BEGIN');
    setProps(db, 'person', [5], [{ gone: true }]);
    db.exec('ROLLBACK');
    expect(state(db).props).toBe(0);
    expect(read(db, 5)).toEqual([[5, person(5)]]);
    db.exec('BEGIN');
    setProps(db, 'person', [5, 8], [{ gone: true }, { gone: 'too' }]);
    // 5 was known and is followed; 8 is read as the transaction left it.
    expect([read(db, 5), read(db, 8)]).toEqual([[[5, { gone: true }]], [[8, { gone: 'too' }]]]);
    expect(state(db).props).toBe(2);
    db.exec('ROLLBACK');
    // The lists hold nothing the rollback undid, and stay.
    expect(state(db)).toMatchObject({ built: true, props: 0, builds: 1 });
    expect([read(db, 5), read(db, 8)]).toEqual([[[5, person(5)]], [[8, person(8)]]]);
    expect(state(db)).toMatchObject({ built: true, props: 2, builds: 1 });
    // A savepoint rolled back, inside a transaction that commits.
    db.exec('BEGIN; SAVEPOINT s');
    setProps(db, 'person', [5], [{ gone: true }]);
    expect(read(db, 5)).toEqual([[5, { gone: true }]]);
    db.exec('ROLLBACK TO s');
    expect(read(db, 5)).toEqual([[5, person(5)]]);
    setProps(db, 'person', [6], [{ kept: true }]);
    db.exec('COMMIT');
    expect([read(db, 5), read(db, 6)]).toEqual([[[5, person(5)]], [[6, { kept: true }]]]);
    // A statement that fails after it wrote: its second row's id is taken.
    expect(read(db, 700)).toEqual([]);
    expect(() => addPeople(db, [700, 5], [{ a: 1 }, { b: 2 }])).toThrow(/UNIQUE|PRIMARY KEY|constraint/i);
    expect(state(db).props).toBe(0);
    expect([read(db, 700), read(db, 5)]).toEqual([[], [[5, person(5)]]]);
    // A row remembered inside a transaction, of a table the transaction did not write, goes with it too.
    db.exec('BEGIN; INSERT INTO tag VALUES (2003)');
    expect(read(db, 9)).toEqual([[9, person(9)]]);
    expect(state(db).props).toBe(2);
    db.exec('ROLLBACK');
    expect(state(db)).toMatchObject({ built: true, props: 0, builds: 1 });
  });

  it('a rollback that undid nothing the index knows leaves it', () => {
    const db = open();
    expect([read(db, 5), read(db, 8)]).toEqual([[[5, person(5)]], [[8, person(8)]]]);
    // A statement that fails, and a transaction rolled back, in a table whose rows the index does not remember.
    expect(() => db.exec('INSERT INTO tag VALUES (2001)')).toThrow(/UNIQUE|PRIMARY KEY|constraint/i);
    db.exec('BEGIN; INSERT INTO tag VALUES (2003); ROLLBACK');
    expect(state(db)).toMatchObject({ built: true, props: 2, builds: 1 });
    expect([read(db, 5), read(db, 8)]).toEqual([[[5, person(5)]], [[8, person(8)]]]);
    // A transaction that commits keeps what it wrote and what was remembered in it.
    db.exec('BEGIN');
    setProps(db, 'person', [5], [{ kept: true }]);
    expect(read(db, 9)).toEqual([[9, person(9)]]);
    db.exec('COMMIT');
    expect(() => db.exec('INSERT INTO tag VALUES (2001)')).toThrow(/UNIQUE|PRIMARY KEY|constraint/i);
    expect(state(db)).toMatchObject({ built: true, props: 3, builds: 1 });
    expect([read(db, 5), read(db, 9)]).toEqual([[[5, { kept: true }]], [[9, person(9)]]]);
  });

  it('a row whose id the maps cannot hold is read from the table', () => {
    const db = open();
    expect(read(db, 5)).toEqual([[5, person(5)]]);
    addPeople(db, [2 ** 31], [{ far: true }]);
    for (let again = 0; again < 2; again++) expect([read(db, 2 ** 31), read(db, 5)]).toEqual([[[2 ** 31, { far: true }]], [[5, person(5)]]]);
    setProps(db, 'person', [2 ** 31], [{ far: 'still' }]);
    expect(read(db, 2 ** 31)).toEqual([[2 ** 31, { far: 'still' }]]);
    expect(state(db)).toMatchObject({ built: true, off: null, props: 1, builds: 1 });
  });

  it('a table emptied holds no row', () => {
    const db = open();
    expect(rows(db, p.project(knows(7), [p.col(0, 5, M)]))).toEqual([[since(7)]]);
    expect(state(db).props).toBe(1);
    db.exec('DELETE FROM knows');
    expect(state(db).props).toBe(0);
    expect(rows(db, p.project(knows(7), [p.col(0, 5, M)]))).toEqual([]);
    write(db, p.append('knows', p.fromColumns([[7], [9], [{ since: 1 }]] as never, ['int', 'int', M]), [0, 1, 2]));
    expect(rows(db, p.project(knows(7), [p.col(0, 1, 'int'), p.col(0, 5, M)]))).toEqual([[9, { since: 1 }]]);
  });

  it('a random run of writes reads the same as the table', () => {
    const db = open();
    let s = 11;
    const rnd = (n: number): number => {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      return s % n;
    };
    const value = (): Props => (rnd(6) === 0 ? null : { n: rnd(1000), ...(rnd(3) === 0 ? { text: 'y'.repeat(rnd(300)) } : {}) });
    for (let i = 0; i < 600; i++) {
      const id = 3000 + rnd(120);
      if (i % 50 === 0) db.exec('BEGIN');
      const has = stored(db, id).length === 1;
      if (!has) addPeople(db, [id], [value()]);
      else if (rnd(3) === 0) db.query('DELETE FROM person WHERE id = ?', [id]);
      else setProps(db, 'person', [id], [value()]);
      if (i % 50 === 30) db.exec(rnd(2) ? 'COMMIT' : 'ROLLBACK');
      // Read some of the time, so a write meets rows the index knows and rows it doesn't.
      for (let k = rnd(3); k > 0; k--) {
        const probe = 3000 + rnd(120);
        expect(read(db, probe), `step ${i}, person ${probe}`).toEqual(stored(db, probe));
      }
    }
    expect(state(db).props).toBeGreaterThan(0);
  });
});

describe('the memory limit', () => {
  it('property maps that do not fit are not held, and the lists stay', () => {
    const roomy = open();
    read(roomy, 5);
    const lists = open();
    rows(lists, p.project(at(7), [p.col(0, 1, 'int')]));
    const withProps = state(roomy).bytes;
    const without = state(lists).bytes;
    expect(withProps).toBeGreaterThan(without);
    // Room for the lists and not for a page of the people's maps.
    const db = open({ graphIndexMem: without + 1024 });
    expect(plan(db, NODE, [5])).toBe('SEARCH person USING GRAPH INDEX (rowid=?)');
    for (let again = 0; again < 2; again++) {
      expect(read(db, 5)).toEqual([[5, person(5)]]);
      expect(state(db)).toMatchObject({ built: true, off: null, props: 0, bytes: without });
    }
    expect([read(db, 3), read(db, PEOPLE)]).toEqual([[[3, null]], []]);
    expect(rows(db, p.project(knows(7), [p.col(0, 1, 'int'), p.col(0, 5, M)]))).toEqual([[8, since(7)]]);
    expect(state(db)).toMatchObject({ built: true, off: null, props: 0, builds: 1 });
  });

  it('maps that outgrow it are let go, by a read or by a write, and the lists stay', () => {
    const lists = open();
    rows(lists, p.project(at(7), [p.col(0, 1, 'int')]));
    const roomy = open();
    read(roomy, 5);
    // Room for a few rows' maps.
    const limit = state(roomy).bytes + 4096;
    const db = open({ graphIndexMem: limit });
    expect(read(db, 5)).toEqual([[5, person(5)]]);
    expect(state(db).props).toBe(1);
    setProps(db, 'person', [5], [{ big: 'z'.repeat(200_000) }]);
    expect(state(db)).toMatchObject({ built: true, off: null, props: 0, bytes: state(lists).bytes });
    expect(read(db, 5)).toEqual([[5, { big: 'z'.repeat(200_000) }]]);
    expect(state(db)).toMatchObject({ built: true, props: 0, builds: 1 });
    // By reads: each row read adds its map, until they don't fit.
    const other = open({ graphIndexMem: limit });
    setProps(other, 'person', [10, 11, 12], [{ t: 'a'.repeat(3000) }, { t: 'b'.repeat(3000) }, { t: 'c'.repeat(3000) }]);
    expect(read(other, 10)).toEqual([[10, { t: 'a'.repeat(3000) }]]);
    expect(state(other).props).toBe(1);
    expect([read(other, 11), read(other, 12)]).toEqual([[[11, { t: 'b'.repeat(3000) }]], [[12, { t: 'c'.repeat(3000) }]]]);
    expect(state(other)).toMatchObject({ built: true, off: null, props: 0, bytes: state(lists).bytes });
    expect([read(other, 10), read(other, 11)]).toEqual([[[10, { t: 'a'.repeat(3000) }]], [[11, { t: 'b'.repeat(3000) }]]]);
  });

  it('with graph indexes off, and on a reader, the table is read', async () => {
    const off = open({ graphIndexMem: 0 });
    expect(plan(off, NODE, [5])).toBe('SEARCH person USING INTEGER PRIMARY KEY (rowid=?)');
    expect(read(off, 5)).toEqual([[5, person(5)]]);
    const vfs = new MemoryVfs();
    const owner = social(await Database.open(vfs, 'db', { sharedHandles: true }));
    const reader = await Database.openReader(vfs, 'db');
    expect(plan(owner, NODE, [5])).toContain('GRAPH INDEX');
    expect(plan(reader, NODE, [5])).not.toContain('GRAPH INDEX');
    expect(read(reader, 5)).toEqual([[5, person(5)]]);
    expect(read(owner, 5)).toEqual([[5, person(5)]]);
  });
});

describe('a graph whose tables change', () => {
  it('reads a table made again from that table, and a table no longer in a graph from the table', () => {
    const db = open();
    expect(read(db, 5)).toEqual([[5, person(5)]]);
    schema(db, { op: 'drop', objectType: 'property graph', name: 'g', ifExists: false });
    expect(plan(db, NODE, [5])).toBe('SEARCH person USING INTEGER PRIMARY KEY (rowid=?)');
    setProps(db, 'person', [5], [{ outside: 'a graph' }]);
    expect(read(db, 5)).toEqual([[5, { outside: 'a graph' }]]);
    schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: GRAPH });
    expect(plan(db, NODE, [5])).toBe('SEARCH person USING GRAPH INDEX (rowid=?)');
    expect([read(db, 5), read(db, 4)]).toEqual([[[5, { outside: 'a graph' }]], [[4, person(4)]]]);
    // The table dropped and made again, with other rows.
    schema(db, { op: 'drop', objectType: 'property graph', name: 'g', ifExists: false });
    db.exec('DROP TABLE person');
    table(db, 'person', [column('id', 'INTEGER'), column('props', 'MAP', M)], KEY);
    addPeople(db, [5], [{ made: 'again' }]);
    schema(db, { op: 'createPropertyGraph', ifNotExists: false, graph: GRAPH });
    expect([read(db, 5), read(db, 4)]).toEqual([[[5, { made: 'again' }]], []]);
  });
});
