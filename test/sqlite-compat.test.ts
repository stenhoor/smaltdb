import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

describe('SQLite compatibility details', () => {
  it('x IN table / x IN table-valued-function shorthand', () => {
    const d = Database.openFile(new MemoryVfs().openSync('c.db'));
    d.exec('CREATE TABLE t1(x INT); INSERT INTO t1 VALUES (1), (2), (NULL); CREATE TABLE e(x INT)');
    expect(d.query('SELECT 1 IN t1, 3 IN t1, 3 NOT IN t1, 1 IN e, NULL IN e').rows).toEqual([[1, null, null, 0, 0]]);
    expect(() => d.query("SELECT 'x' IN pragma_table_info('t1')")).toThrow(/sub-select returns 6 columns - expected 1/);
    expect(() => d.query('SELECT 1 IN nope')).toThrow(/no such table: nope/);
  });

  it('TEMP views live for the connection, shadow main views and are not stored', () => {
    const vfs = new MemoryVfs();
    let d = Database.openFile(vfs.openSync('t.db'), {}, vfs.openSync('t.db-wal'));
    d.exec('CREATE TABLE t(x INT); INSERT INTO t VALUES (1), (2); CREATE VIEW v AS SELECT x FROM t');
    d.exec('CREATE TEMP VIEW v AS SELECT x * 10 AS x FROM t; CREATE TEMPORARY VIEW w AS SELECT count(*) FROM t');
    expect(d.query('SELECT x FROM v ORDER BY x').rows).toEqual([[10], [20]]);
    expect(d.query('SELECT * FROM w').rows).toEqual([[2]]);
    expect(() => d.exec('CREATE TEMP VIEW w AS SELECT 1')).toThrow(/view w already exists/);
    d.exec('CREATE TEMP VIEW IF NOT EXISTS w AS SELECT 1');
    expect(d.query("SELECT count(*) FROM sqlite_schema WHERE name IN ('v', 'w')").rows).toEqual([[1]]);
    d.exec('DROP VIEW v'); // the temp one
    expect(d.query('SELECT x FROM v ORDER BY x').rows).toEqual([[1], [2]]);
    d.close();
    d = Database.openFile(vfs.openSync('t.db'), {}, vfs.openSync('t.db-wal'));
    expect(() => d.query('SELECT * FROM w')).toThrow(/no such table: w/);
  });
});
