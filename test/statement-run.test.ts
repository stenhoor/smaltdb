/**
 * What a statement does on every run besides its plan (`PreparedStatement.cursor` and `RowCursor` in database.ts):
 * its cursor is among the open ones, which keep writes out; it checks whether its tables changed size; and its rows
 * are given in the form of their columns. Each is kept more cheaply than it was: these say it does what it did.
 */
import { describe, expect, it } from 'vitest';
import { Database, type RowCursor } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { ColumnDef } from '../src/engine/plan/schema.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

/** 'ok', or the code of the error `f` throws. */
const outcome = (f: () => unknown): string => {
  try {
    f();
    return 'ok';
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

const numbers = (): Database => {
  const db = Database.openMemory();
  db.exec('CREATE TABLE t(a INT); INSERT INTO t VALUES (1), (2), (3), (4)');
  db.exec('CREATE TABLE w(a INT)');
  return db;
};
const write = (db: Database): string => outcome(() => db.exec('INSERT INTO w VALUES (1)'));
const open = (db: Database): RowCursor => db.prepare('SELECT a FROM t').cursor();
const rest = (c: RowCursor): unknown[] => {
  const out: unknown[] = [];
  for (let row = c.next(); row !== null; row = c.next()) out.push(row[0]);
  return out;
};

/** Every order of `n` things. */
function orders(n: number): number[][] {
  if (n === 0) return [[]];
  const out: number[][] = [];
  for (const o of orders(n - 1)) for (let at = 0; at < n; at++) out.push([...o.slice(0, at), n - 1, ...o.slice(at)]);
  return out;
}

describe('open cursors keep writes out', () => {
  it('a write fails while a cursor is open, and runs once it is read to its end or closed', () => {
    const db = numbers();
    const c = open(db);
    expect(c.next()).toEqual([1]);
    expect(write(db)).toBe('SMALT_BUSY');
    expect(rest(c)).toEqual([2, 3, 4]);
    expect(write(db)).toBe('ok');
    const d = open(db);
    expect(write(db)).toBe('SMALT_BUSY');
    d.close();
    expect(write(db)).toBe('ok');
    expect(d.next()).toBeNull();
  });

  it('four cursors closed in every order: writes stay out until the last is closed, and the others read on', () => {
    for (const order of orders(4)) {
      const db = numbers();
      db.exec('INSERT INTO t VALUES (5), (6), (7), (8)');
      const cursors = [0, 1, 2, 3].map(() => open(db));
      // Each has read as many rows as its number.
      const read = [0, 1, 2, 3];
      cursors.forEach((c, i) => {
        for (let k = 0; k < i; k++) c.next();
      });
      const left = new Set([0, 1, 2, 3]);
      for (const i of order) {
        expect(db.activeCursors.size, String(order)).toBe(left.size);
        expect(write(db), String(order)).toBe('SMALT_BUSY');
        cursors[i]!.close();
        cursors[i]!.close();
        left.delete(i);
        expect(cursors[i]!.next(), String(order)).toBeNull();
        // The others read their next row, each from where it was.
        for (const j of left) expect(cursors[j]!.next(), String(order)).toEqual([++read[j]!]);
      }
      expect(db.activeCursors.size, String(order)).toBe(0);
      expect(write(db), String(order)).toBe('ok');
    }
  });

  it('cursors closed while others open: each close takes that cursor out, and no other', () => {
    const db = numbers();
    const a = open(db);
    const b = open(db);
    a.close();
    const c = open(db);
    const d = open(db);
    b.close();
    expect(db.activeCursors.size).toBe(2);
    expect(rest(d)).toEqual([1, 2, 3, 4]);
    expect(write(db)).toBe('SMALT_BUSY');
    expect(rest(c)).toEqual([1, 2, 3, 4]);
    expect(db.activeCursors.size).toBe(0);
    expect(write(db)).toBe('ok');
  });

  it('closing the database closes every open cursor', () => {
    const db = numbers();
    const cursors = [open(db), open(db), open(db)];
    cursors[1]!.next();
    db.close();
    for (const c of cursors) expect(c.next()).toBeNull();
    expect(db.activeCursors.size).toBe(0);
  });

  it('a hold on reads keeps writes out until it is released, whatever cursors open and close meanwhile', () => {
    const db = numbers();
    const release = db.holdReads();
    expect(write(db)).toBe('SMALT_BUSY');
    const c = open(db);
    const other = db.holdReads();
    c.close();
    expect(write(db)).toBe('SMALT_BUSY');
    release();
    release();
    expect(write(db)).toBe('SMALT_BUSY');
    other();
    expect(write(db)).toBe('ok');
    expect(db.query('SELECT count(*) FROM w').rows).toEqual([[1]]);
  });

  it('a cursor that is open is in the list once, however often it is added', () => {
    const db = numbers();
    const a = open(db);
    const b = open(db);
    db.activeCursors.add(a);
    db.activeCursors.add(b);
    expect(db.activeCursors.size).toBe(2);
    a.close();
    b.close();
    expect(db.activeCursors.size).toBe(0);
    expect(write(db)).toBe('ok');
  });

  it('a hold released a second time takes no other cursor out', () => {
    const db = numbers();
    const release = db.holdReads();
    const a = open(db);
    const b = open(db);
    release();
    release();
    expect(db.activeCursors.size).toBe(2);
    a.close();
    expect(write(db)).toBe('SMALT_BUSY');
    expect(rest(b)).toEqual([1, 2, 3, 4]);
    expect(write(db)).toBe('ok');
  });
});

describe("a statement checks its tables' sizes when the data changed", () => {
  const program = (st: unknown): unknown => (st as { program: unknown }).program;
  const fill = (db: Database, table: string, n: number): void => {
    db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n}) INSERT INTO ${table} SELECT i, i FROM n`);
  };

  for (const [name, make] of [
    ['in memory', () => Promise.resolve(Database.openMemory())],
    ['in a file', () => Database.open(new MemoryVfs(), 'db')],
  ] as const) {
    it(`re-plans when a table grows a lot, and not for a change that leaves its size (${name})`, async () => {
      const db = await make();
      db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v INT); CREATE TABLE x(id INTEGER PRIMARY KEY, v INT); INSERT INTO x VALUES (1, 1)');
      fill(db, 't', 2000);
      const st = db.prepare('SELECT count(*) FROM x JOIN t ON t.id = x.id');
      expect(st.all()).toEqual([[1]]);
      const first = program(st);
      // Run again with nothing changed, then after a change of one row: the same program.
      expect(st.all()).toEqual([[1]]);
      db.exec('UPDATE t SET v = 0 WHERE id = 7; INSERT INTO x VALUES (2, 2)');
      expect(st.all()).toEqual([[2]]);
      expect(program(st)).toBe(first);
      db.exec('DELETE FROM x');
      fill(db, 'x', 20000);
      expect(st.all()).toEqual([[2000]]);
      expect(program(st)).not.toBe(first);
      // And back: checked again once the data changes.
      const grown = program(st);
      expect(st.all()).toEqual([[2000]]);
      expect(program(st)).toBe(grown);
      db.exec('DELETE FROM x WHERE id > 1');
      expect(st.all()).toEqual([[1]]);
      expect(program(st)).not.toBe(grown);
    });
  }
});

describe('rows are given in the form of their columns', () => {
  it('on every run, and in the new form when the statement is planned again for other types', () => {
    const db = Database.openMemory();
    const col = (name: string, type: ColumnDef['type']): ColumnDef => ({ name, declaredType: type, type, notNull: false, collation: 'binary' });
    const create = (type: ColumnDef['type']): void => {
      db.exec('DROP TABLE IF EXISTS f');
      db.queryPlan({ kind: 'schema', op: { op: 'createTable', table: { name: 'f', columns: [col('v', type)], keys: [], checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false } });
    };
    create('INTEGER');
    db.exec('INSERT INTO f VALUES (1), (0), (NULL)');
    const st = db.prepare('SELECT v FROM f');
    expect(st.columnTypes).toEqual(['int']);
    for (let again = 0; again < 3; again++) expect(st.all()).toEqual([[1], [0], [null]]);
    // The same statement over a BOOLEAN column: planned again, its rows are booleans.
    create('BOOLEAN');
    db.queryPlan({ kind: 'write', plan: p.append('f', p.fromColumns([[true, false, null]], ['bool']), [0]) });
    expect(st.columnTypes).toEqual(['bool']);
    for (let again = 0; again < 3; again++) {
      expect(st.all()).toEqual([[true], [false], [null]]);
      expect(st.result().rows).toEqual([[true], [false], [null]]);
      const c = st.cursor();
      expect(c.next()).toEqual([true]);
      c.close();
    }
    // And back.
    create('INTEGER');
    db.exec('INSERT INTO f VALUES (1)');
    expect(st.all()).toEqual([[1]]);
    expect(st.columnTypes).toEqual(['int']);
  });

  it("a write's result has its counts, and a query's has none", () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v INT)');
    const w = db.prepare('INSERT INTO t(v) VALUES (?), (?)').result([5, 6]);
    expect(w).toMatchObject({ rows: [], changes: 2, lastInsertRowid: 2 });
    const r = db.prepare('INSERT INTO t(v) VALUES (7) RETURNING id').result();
    expect(r).toMatchObject({ rows: [[3]], changes: 1, lastInsertRowid: 3 });
    const q = db.prepare('SELECT v FROM t ORDER BY id').result();
    expect(q.rows).toEqual([[5], [6], [7]]);
    expect(Object.keys(q).sort()).toEqual(['columnTypes', 'columns', 'rows']);
  });
});
