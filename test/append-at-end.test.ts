/**
 * Rows written past a table's last row (rows in rowid order, as most inserts are) go in at the end of its B+tree
 * without the two searches any other row takes: one to see that no row has its rowid, one to find its place
 * (`TableWriter.resolveRowid` and `writeRow`, `BTree.beyondLast` and `appendIfLast`). What a table holds, and every
 * conflict, must be what they were.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { BTree } from '../src/engine/storage/btree.js';
import { encodeKey } from '../src/engine/storage/key-codec.js';
import { compareBytes } from '../src/engine/util/bytes.js';
import { openMemoryPager } from './helpers.js';

const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};
const rows = (db: Database, sql: string) => db.query(sql).rows;

describe('the tree', () => {
  it('knows a key past its last, and takes it at the end', () => {
    // Small pages, so the keys below make a tree of several levels.
    const { pager } = openMemoryPager({ pageSize: 512 });
    const tree = new BTree(pager, BTree.create(pager));
    const key = (n: number) => encodeKey([n]);
    const value = (n: number) => new Uint8Array([n & 255, 7]);
    expect(tree.beyondLast(key(1))).toBe(true);
    expect(tree.appendIfLast(key(10), value(10))).toBe(true);
    expect(tree.beyondLast(key(10))).toBe(false);
    expect(tree.beyondLast(key(9))).toBe(false);
    expect(tree.beyondLast(key(11))).toBe(true);
    // Not the last: nothing is written.
    expect(tree.appendIfLast(key(10), value(1))).toBe(false);
    expect(tree.appendIfLast(key(5), value(5))).toBe(false);
    expect(tree.has(key(5))).toBe(false);
    expect([...tree.get(key(10))!]).toEqual([...value(10)]);
    // Many, over several levels, mixed with rows put anywhere.
    for (let n = 11; n < 30_000; n++) {
      if (n % 7 === 0) tree.put(key(n), value(n));
      else expect(tree.appendIfLast(key(n), value(n))).toBe(true);
      if (n % 1000 === 0) tree.put(key(-n), value(n));
    }
    expect(tree.beyondLast(key(29_999))).toBe(false);
    expect(tree.beyondLast(key(30_000))).toBe(true);
    expect(tree.count()).toBe(1 + (30_000 - 11) + 29);
    for (const n of [10, 11, 14, 4096, 12_345, 29_999, -1000, -29_000]) expect([...tree.get(key(n))!], String(n)).toEqual([...value(Math.abs(n))]);
    // In key order from end to end, each key once.
    const c = tree.cursor();
    let seen = 0;
    let before: Uint8Array | null = null;
    for (let ok = c.first(); ok; ok = c.next()) {
      c.loadKey();
      const k = c.keyBytes.slice(c.keyOffset, c.keyOffset + c.keyLength);
      if (before) expect(compareBytes(before, k)).toBeLessThan(0);
      before = k;
      seen++;
    }
    c.close();
    expect(seen).toBe(tree.count());
  });
});

describe('a table', () => {
  it('holds rows written in rowid order, with and without their rowids given', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); CREATE TABLE u(v TEXT)');
    db.exec("INSERT INTO t VALUES (1, 'a'), (2, 'b'), (5, 'e')");
    db.exec("INSERT INTO t(v) VALUES ('f'), ('g')");
    db.exec("INSERT INTO u VALUES ('x'), ('y'); INSERT INTO u(rowid, v) VALUES (10, 'z'); INSERT INTO u VALUES ('w')");
    expect(rows(db, 'SELECT id, v FROM t ORDER BY id')).toEqual([
      [1, 'a'],
      [2, 'b'],
      [5, 'e'],
      [6, 'f'],
      [7, 'g'],
    ]);
    expect(rows(db, 'SELECT rowid, v FROM u ORDER BY rowid')).toEqual([
      [1, 'x'],
      [2, 'y'],
      [10, 'z'],
      [11, 'w'],
    ]);
  });

  it('takes rows in any order, before, between and after the others', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v INT)');
    db.exec('INSERT INTO t VALUES (50, 1), (10, 2), (70, 3), (60, 4), (5, 5), (80, 6), (75, 7)');
    expect(rows(db, 'SELECT id FROM t ORDER BY id').flat()).toEqual([5, 10, 50, 60, 70, 75, 80]);
    expect(rows(db, 'SELECT v FROM t WHERE id = 75')).toEqual([[7]]);
  });

  it('refuses a rowid a row has, the last and one given twice', () => {
    const db = Database.openMemory();
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'a'), (2, 'b')");
    expect(code(() => db.exec("INSERT INTO t VALUES (2, 'again')"))).toBe('SMALT_CONSTRAINT_PRIMARYKEY');
    expect(code(() => db.exec("INSERT INTO t VALUES (3, 'c'), (3, 'twice')"))).toBe('SMALT_CONSTRAINT_PRIMARYKEY');
    // The statement that failed wrote nothing.
    expect(rows(db, 'SELECT id, v FROM t ORDER BY id')).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    db.exec("INSERT OR IGNORE INTO t VALUES (3, 'c'), (3, 'ignored'), (2, 'ignored'), (4, 'd')");
    db.exec("INSERT OR REPLACE INTO t VALUES (4, 'D'), (5, 'e'), (5, 'E')");
    expect(rows(db, 'SELECT id, v FROM t ORDER BY id')).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
      [4, 'D'],
      [5, 'E'],
    ]);
  });

  it('a row past the end that another constraint refuses is not written, and its rowid stays free', () => {
    const db = Database.openMemory();
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, u TEXT UNIQUE, n INT NOT NULL); INSERT INTO t VALUES (1, 'a', 1)");
    expect(code(() => db.exec("INSERT INTO t VALUES (2, 'a', 2)"))).toBe('SMALT_CONSTRAINT_UNIQUE');
    db.exec("INSERT OR IGNORE INTO t VALUES (2, 'a', 2)");
    expect(code(() => db.exec("INSERT INTO t VALUES (2, 'b', NULL)"))).toBe('SMALT_CONSTRAINT_NOTNULL');
    expect(rows(db, 'SELECT count(*) FROM t')).toEqual([[1]]);
    db.exec("INSERT INTO t VALUES (2, 'b', 2)");
    // REPLACE on the unique column removes the row that had the value, here the table's last.
    db.exec("INSERT OR REPLACE INTO t VALUES (3, 'b', 3)");
    expect(rows(db, 'SELECT id, u, n FROM t ORDER BY id')).toEqual([
      [1, 'a', 1],
      [3, 'b', 3],
    ]);
    expect(rows(db, "SELECT id FROM t WHERE u = 'b'")).toEqual([[3]]);
  });

  it('keeps its indexes, and passes the integrity check, after many rows at the end and some elsewhere', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, s TEXT); CREATE INDEX t_g ON t(g)');
    db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000) INSERT INTO t SELECT i * 2, i % 100, 'row ' || i FROM n");
    db.exec("INSERT INTO t VALUES (1, 100, 'first'), (60001, 100, 'last'), (30001, 100, 'middle')");
    db.exec('DELETE FROM t WHERE id > 59990 AND id <= 60000');
    db.exec("INSERT INTO t VALUES (59999, 100, 'again'), (60003, 100, 'after')");
    expect(rows(db, 'SELECT count(*), min(id), max(id) FROM t')).toEqual([[30000 - 5 + 5, 1, 60003]]);
    expect(rows(db, 'SELECT id FROM t WHERE g = 100 ORDER BY id').flat()).toEqual([1, 30001, 59999, 60001, 60003]);
    expect(rows(db, 'SELECT count(*) FROM t WHERE g = 7')).toEqual([[300]]);
    expect(rows(db, "SELECT s FROM t WHERE id = 24680")).toEqual([['row 12340']]);
    expect(rows(db, 'PRAGMA integrity_check')).toEqual([['ok']]);
  });

  it('a rollback takes back rows written at the end, and rows go in there again', () => {
    const db = Database.openMemory();
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t VALUES (1, 'a')");
    db.exec("BEGIN; INSERT INTO t VALUES (2, 'b'), (3, 'c'); ROLLBACK");
    db.exec("INSERT INTO t VALUES (2, 'B')");
    db.exec("BEGIN; INSERT INTO t VALUES (3, 'c'); SAVEPOINT s; INSERT INTO t VALUES (4, 'd'); ROLLBACK TO s; INSERT INTO t VALUES (4, 'D'); COMMIT");
    expect(rows(db, 'SELECT id, v FROM t ORDER BY id')).toEqual([
      [1, 'a'],
      [2, 'B'],
      [3, 'c'],
      [4, 'D'],
    ]);
  });

  it('a columnar table still looks in its segments for a rowid', () => {
    const db = Database.openMemory();
    db.exec("CREATE TABLE c(id INTEGER PRIMARY KEY, v INT) WITH (storage = 'columnar')");
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20000) INSERT INTO c SELECT i, i FROM n');
    expect(code(() => db.exec('INSERT INTO c VALUES (20000, 0)'))).toBe('SMALT_CONSTRAINT_PRIMARYKEY');
    expect(code(() => db.exec('INSERT INTO c VALUES (5, 0)'))).toBe('SMALT_CONSTRAINT_PRIMARYKEY');
    db.exec('INSERT INTO c VALUES (20001, 1)');
    expect(rows(db, 'SELECT count(*), max(id) FROM c')).toEqual([[20001, 20001]]);
  });
});
