/**
 * Regression tests for catalog, DDL and external-table bugs found while writing the user docs.
 * Expected values were checked against SQLite (@sqlite.org/sqlite-wasm) where SQLite has the feature.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const mem = (): Database => Database.openFile(new MemoryVfs().openSync('t.db'));

const errorOf = async (p: Promise<unknown> | (() => unknown)): Promise<{ code: string; message: string }> => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return { code: (e as { code: string }).code, message: (e as Error).message };
  }
  throw new Error('expected an error');
};

describe('INSERT ... DEFAULT VALUES', () => {
  it('stores every column default and assigns the rowid', () => {
    const d = mem();
    d.exec('CREATE TABLE a(x INTEGER DEFAULT 3); INSERT INTO a DEFAULT VALUES');
    expect(d.query('SELECT rowid, x FROM a').rows).toEqual([[1, 3]]);
    expect(d.query('INSERT INTO a DEFAULT VALUES RETURNING *, rowid').rows).toEqual([[3, 2]]);
    d.exec("CREATE TABLE b(id INTEGER PRIMARY KEY, y DEFAULT 'q')");
    expect(d.query('INSERT INTO b DEFAULT VALUES RETURNING *').rows).toEqual([[1, 'q']]);
    expect(d.query('INSERT INTO b DEFAULT VALUES RETURNING *').rows).toEqual([[2, 'q']]);
  });

  it('honours OR conflict clauses and NOT NULL; rejects a column list and upsert like SQLite', async () => {
    const d = mem();
    d.exec('CREATE TABLE c(x UNIQUE DEFAULT 1); INSERT INTO c DEFAULT VALUES; INSERT OR IGNORE INTO c DEFAULT VALUES');
    expect(d.query('INSERT OR REPLACE INTO c DEFAULT VALUES RETURNING rowid').rows).toEqual([[2]]);
    expect(d.query('SELECT rowid, x FROM c').rows).toEqual([[2, 1]]);
    expect(await errorOf(() => d.exec('INSERT INTO c(x) DEFAULT VALUES'))).toEqual({ code: 'SMALT_ERROR', message: '0 values for 1 columns' });
    expect((await errorOf(() => d.exec('INSERT INTO c DEFAULT VALUES ON CONFLICT DO NOTHING'))).message).toMatch(/^near "ON": syntax error/);
    d.exec('CREATE TABLE n(x NOT NULL)');
    expect(await errorOf(() => d.exec('INSERT INTO n DEFAULT VALUES'))).toEqual({ code: 'SMALT_CONSTRAINT_NOTNULL', message: 'NOT NULL constraint failed: n.x' });
  });
});

describe('external table option "null"', () => {
  it('stores re-parseable SQL for inferred columns; keyword keys parse; old stored text still opens', async () => {
    const vfs = new MemoryVfs();
    let db = await Database.open(vfs, 'db');
    db.registerFile('x.csv', 'a,b\n1,NA\n2,z\n');
    await db.execAsync(`CREATE EXTERNAL TABLE p WITH (location='file:x.csv', "null"='NA')`);
    expect(db.query("SELECT sql FROM sqlite_schema WHERE name = 'p'").rows).toEqual([[`CREATE EXTERNAL TABLE "p" ("a" INTEGER, "b" TEXT) WITH (location = 'file:x.csv', "null" = 'NA')`]]);
    await db.execAsync(`CREATE EXTERNAL TABLE p2 WITH (location='file:x.csv', null='NA')`);
    // The text earlier versions stored for p (an unquoted keyword key).
    await db.execAsync(`CREATE EXTERNAL TABLE p3 ("a" INTEGER, "b" TEXT) WITH (location = 'file:x.csv', null = 'NA')`);
    db.exec('CREATE TABLE q(x)');
    db.close();
    db = await Database.open(vfs, 'db');
    db.registerFile('x.csv', 'a,b\n1,NA\n2,z\n');
    for (const t of ['p', 'p2', 'p3']) expect((await db.queryAsync(`SELECT * FROM ${t}`)).rows).toEqual([[1, null], [2, 'z']]);
    db.exec('CREATE TABLE q2(x)');
  });
});

describe('temp. and main. qualifiers on CREATE; the TEMP catalog', () => {
  it('CREATE TABLE / INDEX / VIEW temp.x create TEMP objects; DML and SELECT reach them', () => {
    const d = mem();
    d.exec('CREATE TABLE temp.t7(x); INSERT INTO temp.t7 VALUES (1); CREATE INDEX temp.i7 ON t7(x); CREATE VIEW temp.v AS SELECT x FROM t7');
    expect(d.query('SELECT * FROM temp.t7').rows).toEqual([[1]]);
    expect(d.query('UPDATE temp.t7 SET x = 2 RETURNING *').rows).toEqual([[2]]);
    expect(d.query('SELECT * FROM temp.v').rows).toEqual([[2]]);
    expect(d.query('SELECT count(*) FROM sqlite_schema').rows).toEqual([[0]]);
    d.exec('CREATE TABLE main.t8(x); CREATE VIEW v AS SELECT 9 AS x');
    expect(d.query('SELECT name FROM main.sqlite_schema').rows).toEqual([['t8'], ['v']]);
    expect(d.query('SELECT (SELECT x FROM main.v), (SELECT x FROM temp.v), (SELECT x FROM v)').rows).toEqual([[9, 2, 2]]);
    d.exec('DELETE FROM temp.t7; DROP VIEW temp.v; DROP INDEX temp.i7; DROP TABLE temp.t7');
    expect(d.query('SELECT count(*) FROM temp.sqlite_schema').rows).toEqual([[0]]);
  });

  it('rejects qualifiers as SQLite does', async () => {
    const d = mem();
    d.exec('CREATE TABLE m(x); CREATE TEMP TABLE t(x)');
    const msg = async (sql: string): Promise<string> => (await errorOf(() => d.exec(sql))).message;
    expect(await msg('CREATE INDEX temp.i ON m(x)')).toBe('cannot create a TEMP index on non-TEMP table "m"');
    expect(await msg('CREATE INDEX main.i ON t(x)')).toBe('no such table: main.t');
    expect(await msg('CREATE INDEX temp.i ON nope(x)')).toBe('no such table: nope');
    expect(await msg('CREATE INDEX nope.i ON m(x)')).toBe('unknown database nope');
    expect(await msg('CREATE TEMP TABLE main.t9(x)')).toBe('temporary table name must be unqualified');
    expect(await msg('CREATE TEMP VIEW main.v AS SELECT 1')).toBe('temporary table name must be unqualified');
    expect(await msg('CREATE TABLE nope.t(x)')).toBe('unknown database nope');
    expect(await msg('CREATE TEMP VIEW nope.v AS SELECT 1')).toBe('unknown database nope');
  });

  it('temp.sqlite_schema, sqlite_temp_schema and sqlite_temp_master list TEMP objects in creation order', () => {
    const d = mem();
    d.exec('CREATE TABLE m(x); CREATE TABLE temp.t7(x); CREATE INDEX temp.i7 ON t7(x); CREATE VIEW temp.v AS SELECT 1; CREATE TEMP TABLE t10(x UNIQUE); CREATE INDEX i8 ON t7(x)');
    const temp = [
      ['table', 't7', 't7', 'CREATE TABLE temp.t7(x)'],
      ['index', 'i7', 't7', 'CREATE INDEX temp.i7 ON t7(x)'],
      ['view', 'v', 'v', 'CREATE VIEW temp.v AS SELECT 1'],
      ['table', 't10', 't10', 'CREATE TEMP TABLE t10(x UNIQUE)'],
      ['index', 'smalt_autoindex_t10_1', 't10', null],
      ['index', 'i8', 't7', 'CREATE INDEX i8 ON t7(x)'],
    ];
    for (const from of ['temp.sqlite_schema', 'temp.sqlite_master', 'sqlite_temp_schema', 'sqlite_temp_master', 'temp.sqlite_temp_schema']) {
      expect(d.query(`SELECT type, name, tbl_name, sql FROM ${from}`).rows).toEqual(temp);
    }
    expect(d.query('SELECT name FROM sqlite_schema').rows).toEqual([['m']]);
    expect(() => d.query('SELECT * FROM main.sqlite_temp_master')).toThrow('no such table: main.sqlite_temp_master');
    // A CTE of the same name wins.
    expect(d.query('WITH sqlite_temp_schema(n) AS (SELECT 5) SELECT n FROM sqlite_temp_schema').rows).toEqual([[5]]);
  });
});
