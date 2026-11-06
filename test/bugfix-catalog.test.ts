/**
 * Regression tests for catalog, DDL and external-table bugs found while writing the user docs.
 * Expected values were checked against SQLite (@sqlite.org/sqlite-wasm) where SQLite has the feature.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { tableSchemaFromDef } from '../src/engine/catalog/schema.js';
import { Database } from '../src/engine/database.js';
import type { TableDef } from '../src/engine/plan/schema.js';
import { EngineServer } from '../src/engine/server.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { Request, Response } from '../src/shared/protocol.js';
import type { SqlValue } from '../src/engine/values.js';
import { until } from './helpers/wait.js';
import external from '@smaltdb/external';
import { registerFile } from '@smaltdb/external/client';
import io from '@smaltdb/io';

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
    let db = await Database.open(vfs, 'db', { plugins: [external, io] });
    await registerFile(db, 'x.csv', 'a,b\n1,NA\n2,z\n');
    await db.execAsync(`CREATE EXTERNAL TABLE p WITH (location='file:x.csv', "null"='NA')`);
    expect(db.query("SELECT sql FROM sqlite_schema WHERE name = 'p'").rows).toEqual([[`CREATE EXTERNAL TABLE "p" ("a" INTEGER, "b" TEXT) WITH (location = 'file:x.csv', "null" = 'NA')`]]);
    await db.execAsync(`CREATE EXTERNAL TABLE p2 WITH (location='file:x.csv', null='NA')`);
    // The text earlier versions stored for p (an unquoted keyword key).
    await db.execAsync(`CREATE EXTERNAL TABLE p3 ("a" INTEGER, "b" TEXT) WITH (location = 'file:x.csv', null = 'NA')`);
    db.exec('CREATE TABLE q(x)');
    db.close();
    db = await Database.open(vfs, 'db', { plugins: [external, io] });
    await registerFile(db, 'x.csv', 'a,b\n1,NA\n2,z\n');
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

describe('ANALYZE with a schema', () => {
  it('accepts main., temp. and a bare schema name like SQLite', () => {
    const d = mem();
    d.exec('CREATE TABLE t(x); CREATE INDEX i ON t(x); INSERT INTO t VALUES (1), (2); CREATE TABLE u(y)');
    d.exec('ANALYZE main.t');
    expect(d.query('SELECT DISTINCT tbl FROM smalt_stat').rows).toEqual([['t']]);
    d.exec('ANALYZE main.i; ANALYZE temp');
    expect(d.query('SELECT DISTINCT tbl FROM smalt_stat').rows).toEqual([['t']]);
    d.exec('ANALYZE main');
    expect(d.query('SELECT DISTINCT tbl FROM smalt_stat ORDER BY 1').rows).toEqual([['t'], ['u']]);
    d.exec('CREATE TEMP TABLE tt(x); CREATE INDEX ti ON tt(x); ANALYZE temp.tt; ANALYZE temp.ti');
    expect(() => d.exec('ANALYZE nope.t')).toThrow('unknown database nope');
    expect(() => d.exec('ANALYZE main.nope')).toThrow('no such table or index: main.nope');
    expect(() => d.exec('ANALYZE main.tt')).toThrow('no such table or index: main.tt');
    expect(() => d.exec('ANALYZE temp.t')).toThrow('no such table or index: temp.t');
  });
});

describe('information_schema.connections.connection_type', () => {
  it('is the normalised type: lower case, https shown as http', () => {
    const d = Database.openMemory({ plugins: [external] });
    d.exec("CREATE CONNECTION a WITH (type = 'https', url = 'https://x.org/')");
    d.exec("CREATE CONNECTION b WITH (type = 'S3', region = 'eu', bucket = 'b')");
    d.exec("CREATE CONNECTION c WITH (url = 'https://x.org/')");
    d.exec("CREATE CONNECTION e WITH (type = 'Azure', account = 'acc')");
    expect(d.query('SELECT connection_name, connection_type FROM information_schema.connections ORDER BY 1').rows).toEqual([
      ['a', 'http'],
      ['b', 's3'],
      ['c', 'http'],
      ['e', 'azure'],
    ]);
    expect(() => d.exec("CREATE CONNECTION f WITH (type = 'ftp')")).toThrow("connection f: type 'ftp' is not supported (http, s3, azure)");
  });
});

describe('information_schema.table_constraints deferrability', () => {
  it('is_deferrable for any DEFERRABLE, initially_deferred for INITIALLY DEFERRED', () => {
    const d = mem();
    d.exec('CREATE TABLE p(id INTEGER PRIMARY KEY)');
    d.exec(
      'CREATE TABLE c(a REFERENCES p, b REFERENCES p DEFERRABLE, c REFERENCES p DEFERRABLE INITIALLY DEFERRED, d REFERENCES p DEFERRABLE INITIALLY IMMEDIATE, e REFERENCES p NOT DEFERRABLE, f REFERENCES p NOT DEFERRABLE INITIALLY DEFERRED)',
    );
    expect(d.query("SELECT constraint_name, is_deferrable, initially_deferred FROM information_schema.table_constraints WHERE table_name = 'c'").rows).toEqual([
      ['c_a_fkey', 'NO', 'NO'],
      ['c_b_fkey', 'YES', 'NO'],
      ['c_c_fkey', 'YES', 'YES'],
      ['c_d_fkey', 'YES', 'NO'],
      ['c_e_fkey', 'NO', 'NO'],
      ['c_f_fkey', 'NO', 'NO'],
    ]);
  });
});

describe('external tables in pragmas and writes', () => {
  it('table_info lists the columns; writes, indexes and ALTER fail clearly', async () => {
    const db = await Database.open(new MemoryVfs(), 'db', { plugins: [external, io] });
    await registerFile(db, 'x.csv', 'a,b\n1,NA\n2,z\n');
    await db.execAsync("CREATE EXTERNAL TABLE ext WITH (location = 'file:x.csv')");
    const cols = [
      [0, 'a', 'INTEGER', 0, null, 0],
      [1, 'b', 'TEXT', 0, null, 0],
    ];
    expect(db.query('PRAGMA table_info(ext)').rows).toEqual(cols);
    expect(db.query("SELECT * FROM pragma_table_info('ext')").rows).toEqual(cols);
    expect(db.query('PRAGMA table_xinfo(ext)').rows).toEqual(cols.map((r) => [...r, 0]));
    expect(db.query('PRAGMA index_list(ext)').rows).toEqual([]);
    expect(db.query('PRAGMA foreign_key_list(ext)').rows).toEqual([]);
    for (const sql of ['INSERT INTO ext VALUES (1, 2)', 'REPLACE INTO main.ext VALUES (1, 2)', 'UPDATE ext SET a = 1', 'DELETE FROM ext']) {
      expect(await errorOf(() => db.exec(sql))).toEqual({ code: 'SMALT_ERROR', message: 'table ext may not be modified' });
    }
    expect(await errorOf(() => db.exec('CREATE INDEX ei ON ext(a)'))).toEqual({ code: 'SMALT_ERROR', message: 'table ext may not be indexed' });
    expect(await errorOf(() => db.exec('ALTER TABLE ext ADD COLUMN c'))).toEqual({ code: 'SMALT_ERROR', message: 'table ext may not be altered' });
  });
});

describe('REFRESH MATERIALIZED VIEW … IF CHANGED through every async entry point', () => {
  it('runs with queryAsync and runAsync as with execAsync', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec('CREATE TABLE t(x INT); INSERT INTO t VALUES (1); CREATE MATERIALIZED VIEW c AS SELECT count(*) AS n FROM t');
    db.exec('INSERT INTO t VALUES (2)');
    expect(await db.runAsync('REFRESH MATERIALIZED VIEW c IF CHANGED')).toMatchObject({ changes: 1 });
    expect(db.query('SELECT n FROM c').rows).toEqual([[2]]);
    expect(await db.runAsync('REFRESH MATERIALIZED VIEW c IF CHANGED')).toMatchObject({ changes: 0 }); // unchanged: not refreshed
    db.exec('INSERT INTO t VALUES (3)');
    expect(await db.queryAsync('REFRESH MATERIALIZED VIEW c IF CHANGED')).toEqual({ columns: [], rows: [] });
    expect(db.query('SELECT n FROM c').rows).toEqual([[3]]);
    expect((await errorOf(() => db.run('REFRESH MATERIALIZED VIEW c IF CHANGED'))).code).toBe('SMALT_ASYNC_REQUIRED');
  });

  it('runs through the engine server: query, exec with parameters, prepared statements', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    const log: Response[] = [];
    const server = new EngineServer((_s, msg) => log.push(msg), { open: () => db, refreshTimer: false });
    let id = 1;
    const call = async (body: Record<string, unknown>): Promise<Response> => {
      const rid = id++;
      server.receive(EngineServer.LOCAL, { ...body, id: rid } as Request);
      await until(`request ${rid}`, () => log.some((m) => m.id === rid && (m.kind === 'ok' || m.kind === 'error' || m.kind === 'done')));
      return log.find((m) => m.id === rid && (m.kind === 'ok' || m.kind === 'error' || m.kind === 'done'))!;
    };
    await call({ op: 'open', name: 'db', storage: 'memory' });
    db.exec('CREATE TABLE t(x INT); CREATE MATERIALIZED VIEW c AS SELECT count(*) AS n FROM t');
    const n = (): SqlValue => db.query('SELECT n FROM c').rows[0][0];
    db.exec('INSERT INTO t VALUES (1)');
    expect((await call({ op: 'query', sql: 'REFRESH MATERIALIZED VIEW c IF CHANGED' })).kind).not.toBe('error');
    expect(n()).toBe(1);
    db.exec('INSERT INTO t VALUES (2)');
    expect((await call({ op: 'exec', sql: 'REFRESH MATERIALIZED VIEW c IF CHANGED', params: [] })).kind).toBe('ok');
    expect(n()).toBe(2);
    db.exec('INSERT INTO t VALUES (3)');
    const prep = await call({ op: 'prepare', sql: 'REFRESH MATERIALIZED VIEW c IF CHANGED' });
    expect(prep.kind).toBe('ok');
    expect((await call({ op: 'stmtRun', stmt: (prep as { stmt: number }).stmt })).kind).toBe('ok');
    expect(n()).toBe(3);
  });
});

describe('smaltdb_version()', () => {
  it('is the version in package.json', () => {
    const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
    expect(mem().query('SELECT smaltdb_version()').rows).toEqual([[version]]);
  });
});

describe('CREATE TABLE / ADD COLUMN checks SQLite makes', () => {
  const msg = async (d: Database, sql: string): Promise<string> => (await errorOf(() => d.exec(sql))).message;

  it('AUTOINCREMENT only on an INTEGER PRIMARY KEY (also as a table constraint)', async () => {
    const d = mem();
    for (const sql of [
      'CREATE TABLE a1(x TEXT PRIMARY KEY AUTOINCREMENT)',
      'CREATE TABLE a2(x INT PRIMARY KEY AUTOINCREMENT)',
      'CREATE TABLE a3(x INTEGER PRIMARY KEY DESC AUTOINCREMENT)',
      'CREATE TABLE a6(x INTEGER, y, PRIMARY KEY(x, y AUTOINCREMENT))',
      'CREATE TEMP TABLE a7(x TEXT PRIMARY KEY AUTOINCREMENT)',
    ]) {
      expect(await msg(d, sql)).toBe('AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY');
    }
    d.exec('CREATE TABLE a4(x INTEGER, PRIMARY KEY(x AUTOINCREMENT)); CREATE TABLE a5(x INTEGER PRIMARY KEY AUTOINCREMENT); INSERT INTO a4 VALUES (NULL)');
    expect(d.query('SELECT x FROM a4').rows).toEqual([[1]]);
  });

  it('CHECK and DEFAULT reject subqueries, column references and parameters', async () => {
    const d = mem();
    d.exec('CREATE TABLE z(a)');
    for (const sql of ['CREATE TABLE c1(x CHECK (x > (SELECT 1)))', 'CREATE TABLE c2(x, CHECK (EXISTS (SELECT 1)))', 'CREATE TABLE c3(x CHECK (x IN z))', 'CREATE TEMP TABLE c4(x CHECK (x IN (SELECT a FROM z)))']) {
      expect(await msg(d, sql)).toBe('subqueries prohibited in CHECK constraints');
    }
    expect((await errorOf(() => d.run('CREATE TABLE c5(x CHECK (x > ?))', [1]))).message).toBe('parameters prohibited in CHECK constraints');
    expect(await msg(d, 'CREATE TABLE d1(x DEFAULT (1 IN (SELECT 1)))')).toBe('default value of column [x] is not constant');
    expect(await msg(d, 'CREATE TABLE d2(x DEFAULT ((SELECT 1)))')).toBe('default value of column [x] is not constant');
    expect(await msg(d, 'CREATE TABLE d3(x, y DEFAULT (x + 1))')).toBe('default value of column [y] is not constant');
    expect((await errorOf(() => d.run('CREATE TABLE d4(x DEFAULT (?))', [1]))).message).toBe('default value of column [x] is not constant');
    expect(await msg(d, 'ALTER TABLE z ADD COLUMN b CHECK ((SELECT 1))')).toBe('error in table z after add column: subqueries prohibited in CHECK constraints');
    expect(await msg(d, 'ALTER TABLE z ADD COLUMN c DEFAULT (1 IN (SELECT 1))')).toBe('default value of column [c] is not constant');
    d.exec("CREATE TABLE ok(x DEFAULT (random()), y CHECK (y IN (1, 2)), z DEFAULT abc)");
  });

  it('stored definitions are not re-checked, so databases created before these checks still open', () => {
    // The catalog loader builds schemas from definitions only; the new checks run on CREATE / ADD COLUMN. These are the
    // definitions an older version stored for tables the checks now refuse.
    const column = (name: string, type: 'TEXT' | 'ANY' = 'ANY') => ({ name, declaredType: type === 'TEXT' ? 'TEXT' : '', type, notNull: false, collation: 'binary' as const });
    const a: TableDef = { name: 'a', storage: 'row', columns: [column('x', 'TEXT')], keys: [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], autoincrement: true }], checks: [], foreignKeys: [] };
    const c: TableDef = { name: 'c', storage: 'row', columns: [column('x'), { ...column('y'), default: { text: '(1 IN (SELECT 1))', value: null } }], keys: [], checks: [{ text: 'x > (SELECT 1)', ofColumn: 0 }], foreignKeys: [] };
    expect(() => tableSchemaFromDef(a, 'CREATE TABLE a(x TEXT PRIMARY KEY AUTOINCREMENT)', 2)).not.toThrow();
    expect(() => tableSchemaFromDef(c, 'CREATE TABLE c(x CHECK (x > (SELECT 1)), y DEFAULT (1 IN (SELECT 1)))', 2)).not.toThrow();
  });

  it('ADD COLUMN … REFERENCES with a non-NULL default fails when foreign keys are on and the table has rows', async () => {
    const d = mem();
    d.exec('CREATE TABLE p(id INTEGER PRIMARY KEY); INSERT INTO p VALUES (1); CREATE TABLE ch(a)');
    d.exec('ALTER TABLE ch ADD COLUMN z DEFAULT 1 REFERENCES p'); // empty table: allowed, as in SQLite
    d.exec('INSERT INTO ch(a) VALUES (5)');
    for (const col of ['c DEFAULT 1 REFERENCES p', "g DEFAULT 'x' REFERENCES p", 'h DEFAULT (1) REFERENCES p', 'n INTEGER DEFAULT -1 CONSTRAINT q REFERENCES p']) {
      expect(await errorOf(() => d.exec(`ALTER TABLE ch ADD COLUMN ${col}`))).toEqual({ code: 'SMALT_ERROR', message: 'Cannot add a REFERENCES column with non-NULL default value' });
    }
    d.exec('ALTER TABLE ch ADD COLUMN d DEFAULT NULL REFERENCES p; ALTER TABLE ch ADD COLUMN e REFERENCES p; ALTER TABLE ch ADD COLUMN f DEFAULT (NULL) REFERENCES p');
    d.exec('PRAGMA foreign_keys = off; ALTER TABLE ch ADD COLUMN o DEFAULT 1 REFERENCES p');
    expect(d.query('SELECT * FROM ch').rows).toEqual([[5, 1, null, null, null, 1]]);
  });
});

describe('rowid exhaustion', () => {
  it('picks random free rowids in 1 .. 2^62 once the largest rowid is taken, as SQLite does', () => {
    const d = mem();
    d.exec("CREATE TABLE t(x); INSERT INTO t(rowid, x) VALUES (9223372036854775807, 'max')");
    for (let i = 0; i < 5; i++) expect(d.query("INSERT INTO t(x) VALUES ('r') RETURNING rowid > 0 AND rowid <= 4611686018427387904").rows).toEqual([[1]]);
    d.exec('CREATE TABLE b(id INTEGER PRIMARY KEY, x); INSERT INTO b VALUES (9223372036854775807, 1); INSERT INTO b(x) VALUES (2)');
    expect(d.query('SELECT count(DISTINCT id) FROM b').rows).toEqual([[2]]);
  });

  it('fails with SMALT_FULL after 100 taken candidates, and at once for AUTOINCREMENT', async () => {
    const d = mem();
    d.exec('CREATE TABLE t(x); INSERT INTO t(rowid, x) VALUES (1, 1), (9223372036854775807, 2)');
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
      (a as unknown as BigUint64Array).fill(0n); // candidate 1, which is taken
      return a;
    });
    try {
      expect((await errorOf(() => d.exec('INSERT INTO t(x) VALUES (3)'))).code).toBe('SMALT_FULL');
      expect(spy).toHaveBeenCalledTimes(100);
    } finally {
      spy.mockRestore();
    }
    d.exec('CREATE TABLE a(id INTEGER PRIMARY KEY AUTOINCREMENT, x); INSERT INTO a VALUES (9223372036854775807, 1)');
    expect((await errorOf(() => d.exec('INSERT INTO a(x) VALUES (2)'))).code).toBe('SMALT_FULL');
  });
});

describe('table_xinfo hidden column; schema-qualified pragma functions', () => {
  it('matches SQLite', () => {
    const d = mem();
    d.exec("CREATE TABLE t(a INT PRIMARY KEY, b TEXT NOT NULL DEFAULT 'x', c)");
    const xinfo = [
      [0, 'a', 'INT', 0, null, 1, 0],
      [1, 'b', 'TEXT', 1, "'x'", 0, 0],
      [2, 'c', '', 0, null, 0, 0],
    ];
    expect(d.query('PRAGMA table_xinfo(t)').rows).toEqual(xinfo);
    expect(d.query("SELECT * FROM pragma_table_xinfo('t')")).toEqual({ columns: ['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk', 'hidden'], rows: xinfo });
    expect(d.query('PRAGMA table_info(t)').columns).toEqual(['cid', 'name', 'type', 'notnull', 'dflt_value', 'pk']);
    expect(d.query("SELECT name FROM main.pragma_table_info('t')").rows).toEqual([['a'], ['b'], ['c']]);
    expect(d.query("SELECT name FROM temp.pragma_table_info('t')").rows).toEqual([['a'], ['b'], ['c']]);
  });
});
