import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';

/** Index scans under order-insensitive aggregates fetch rows in rowid-sorted batches. */
describe('sorted rowid fetch for unordered index scans', () => {
  const setup = (): Database => {
    const db = Database.openMemory({ pageSize: 1024 });
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, v INT, s TEXT); CREATE INDEX t_g ON t(g)');
    const ins = db.prepare('INSERT INTO t VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    // g cycles, so one g value's rowids are spread over the whole table; some huge rowids too.
    for (let i = 1; i <= 20000; i++) ins.run([i, i % 7, i * 3, 's' + (i % 13)]);
    for (const big of [2n ** 60n, 2n ** 62n + 5n, 9007199254740993n]) ins.run([big, 3, 1, 'big']);
    db.exec('COMMIT');
    return db;
  };

  it('aggregates agree with a full scan, across several batches', () => {
    const db = setup();
    for (const where of ['g = 3', 'g >= 2 AND g < 6', 'g > 0', 'g < 100']) {
      const q = (hint: string) => db.query(`SELECT count(*), sum(v), min(s), max(id), avg(v) FROM t ${hint} WHERE ${where}`).rows;
      expect(q('INDEXED BY t_g')).toEqual(q('NOT INDEXED'));
    }
    expect(db.query('EXPLAIN QUERY PLAN SELECT count(*), sum(v) FROM t WHERE g = 3').rows.flat().join(' ')).toMatch(/USING INDEX t_g/);
  });

  it('rescans correctly as the inner side of a join', () => {
    const db = setup();
    db.exec('CREATE TABLE k(g INT); INSERT INTO k VALUES (1), (3), (3), (6)');
    const q = (hint: string) => db.query(`SELECT count(*), sum(t.v) FROM k JOIN t ${hint} ON t.g = k.g`).rows;
    expect(q('INDEXED BY t_g')).toEqual(q('NOT INDEXED'));
  });

  it('keeps index order where order is observable', () => {
    const db = setup();
    // group_concat depends on input order; a plain SELECT returns index order.
    const gc = db.query("SELECT group_concat(id) FROM (SELECT id FROM t INDEXED BY t_g WHERE g = 5 AND id < 60)").rows[0][0];
    expect(gc).toBe('5,12,19,26,33,40,47,54');
    const ids = db.query('SELECT id FROM t INDEXED BY t_g WHERE g = 5 AND id < 40').rows.map((r) => r[0]);
    expect(ids).toEqual([5, 12, 19, 26, 33]);
  });

  it('UPDATE through an index scan updates every target row', () => {
    const db = setup();
    db.exec('UPDATE t SET v = -1 WHERE g = 4');
    expect(db.query('SELECT count(*) FROM t NOT INDEXED WHERE v = -1').rows).toEqual(db.query('SELECT count(*) FROM t NOT INDEXED WHERE g = 4').rows);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });
});
