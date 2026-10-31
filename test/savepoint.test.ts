import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const open = () => {
  const vfs = new MemoryVfs();
  return Database.openFile(vfs.openSync('s.db'), {}, vfs.openSync('s.db-wal'));
};
const xs = (d: Database) => d.query('SELECT x FROM t ORDER BY x').rows.map((r) => r[0]);

describe('SQL savepoints', () => {
  it('ROLLBACK TO undoes inner work and keeps the savepoint', () => {
    const d = open();
    d.exec('CREATE TABLE t(x INT UNIQUE)');
    d.exec('BEGIN; INSERT INTO t VALUES (1); SAVEPOINT a; INSERT INTO t VALUES (2); SAVEPOINT b; INSERT INTO t VALUES (3)');
    d.exec('ROLLBACK TO b');
    expect(xs(d)).toEqual([1, 2]);
    d.exec('INSERT INTO t VALUES (4); ROLLBACK TO a');
    expect(xs(d)).toEqual([1]);
    d.exec('INSERT INTO t VALUES (5); RELEASE a; COMMIT');
    expect(xs(d)).toEqual([1, 5]);
    expect(d.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('a SAVEPOINT outside BEGIN starts a transaction that RELEASE commits', () => {
    const d = open();
    d.exec('CREATE TABLE t(x INT)');
    d.exec('SAVEPOINT s1; INSERT INTO t VALUES (1); SAVEPOINT s2; INSERT INTO t VALUES (2); RELEASE s2');
    expect(d.inTransaction).toBe(true);
    d.exec('RELEASE s1');
    expect(d.inTransaction).toBe(false);
    expect(xs(d)).toEqual([1, 2]);
    expect(() => d.exec('RELEASE nope')).toThrow(/no such savepoint/);
  });

  it('rolls back DDL to a savepoint, and a failed statement only undoes itself', () => {
    const d = open();
    d.exec('CREATE TABLE t(x INT UNIQUE); BEGIN; INSERT INTO t VALUES (1); SAVEPOINT a; CREATE TABLE u(y INT); INSERT INTO u VALUES (9)');
    expect(() => d.exec('INSERT INTO t VALUES (2), (1)')).toThrow(/UNIQUE/);
    expect(xs(d)).toEqual([1]);
    d.exec('ROLLBACK TO a');
    expect(() => d.query('SELECT * FROM u')).toThrow(/no such table: u/);
    d.exec('COMMIT');
    expect(xs(d)).toEqual([1]);
    expect(d.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });
});
