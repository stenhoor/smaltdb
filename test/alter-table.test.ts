import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

type Lite = { exec(s: string): void; selectArrays(s: string): unknown[][] };
let newLite: () => Lite;
beforeAll(async () => {
  const s3 = (await (sqliteInit as unknown as (o: object) => Promise<{ oo1: { DB: new (n: string) => Lite } }>)({ print() {}, printErr() {} }));
  newLite = () => new s3.oo1.DB(':memory:');
});

const SETUP = [
  `CREATE TABLE t(id INTEGER PRIMARY KEY, a INT NOT NULL, "b c" TEXT, d INT CHECK (d > 0), UNIQUE (a))`,
  'CREATE INDEX ta ON t(a, d)',
  'CREATE TABLE child(id INTEGER PRIMARY KEY, tid INT REFERENCES t(id), a INT, FOREIGN KEY (a) REFERENCES t (a))',
  `CREATE VIEW v AS SELECT t.a, t.d, x.a AS xa, "b c" FROM t JOIN child AS x ON x.id = t.id WHERE t.d > 1 AND "b c" IS NOT NULL`,
  'CREATE VIEW w AS SELECT a, (SELECT count(*) FROM child WHERE child.tid = t.id) AS n FROM t WHERE d IN (SELECT d FROM t AS inner_t WHERE inner_t.a > 0)',
  "INSERT INTO t VALUES (1, 10, 'x', 5), (2, 20, NULL, 7), (3, 30, 'z', 9)",
  'INSERT INTO child VALUES (1, 1, 10), (2, 1, 20), (3, 2, 30)',
];

function run(statements: string[]): void {
  const lite = newLite();
  const d = Database.openFile(new MemoryVfs().openSync('a.db'));
  for (const s of SETUP) {
    lite.exec(s);
    d.exec(s);
  }
  const schema = "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name";
  for (const sql of statements) {
    let a: string;
    let b: string;
    try {
      a = JSON.stringify(lite.selectArrays(sql));
    } catch (e) {
      a = 'ERROR ' + (e as Error).message.replace(/^SQLITE_\w+: sqlite3 result code \d+: /, '');
    }
    try {
      b = JSON.stringify(d.query(sql).rows);
    } catch (e) {
      b = 'ERROR ' + (e as Error).message;
    }
    expect(b, sql).toBe(a);
    expect(JSON.stringify(d.query(schema).rows), `schema after: ${sql}`).toBe(JSON.stringify(lite.selectArrays(schema)));
  }
}

describe('ALTER TABLE', () => {
  it('ADD COLUMN', () => {
    run([
      "ALTER TABLE t ADD COLUMN e TEXT DEFAULT 'zz'",
      'ALTER TABLE t ADD COLUMN f INT NOT NULL',
      'ALTER TABLE t ADD COLUMN g INT NOT NULL DEFAULT -3',
      'ALTER TABLE t ADD COLUMN h INT PRIMARY KEY',
      'ALTER TABLE t ADD COLUMN h INT UNIQUE',
      'ALTER TABLE t ADD COLUMN h INT DEFAULT (1+1)',
      'ALTER TABLE t ADD COLUMN i INT DEFAULT CURRENT_TIME',
      'ALTER TABLE t ADD COLUMN a INT',
      'ALTER TABLE t ADD k REAL',
      'SELECT * FROM t ORDER BY id',
      "INSERT INTO t(id, a, d) VALUES (4, 40, 1)",
      'SELECT * FROM t ORDER BY id',
      "SELECT id FROM t WHERE e = 'zz' AND g = -3 ORDER BY id",
      'SELECT count(*), sum(g) FROM t',
      'ALTER TABLE v ADD COLUMN x INT',
      'ALTER TABLE sqlite_schema ADD COLUMN x INT',
      'ALTER TABLE nope ADD COLUMN x INT',
    ]);
  });

  it('RENAME TO and RENAME COLUMN rewrite dependent SQL', () => {
    run([
      'ALTER TABLE t RENAME COLUMN a TO aa',
      'ALTER TABLE t RENAME COLUMN nope TO z',
      'ALTER TABLE t RENAME COLUMN d TO aa',
      'SELECT * FROM v ORDER BY 1',
      'SELECT * FROM w ORDER BY 1',
      'ALTER TABLE t RENAME TO u',
      'ALTER TABLE u RENAME TO child',
      'SELECT * FROM v ORDER BY 1',
      'SELECT * FROM w ORDER BY 1',
      'SELECT * FROM u ORDER BY id',
      'INSERT INTO u VALUES (4, 10, NULL, 1)',
      'ALTER TABLE u RENAME COLUMN "b c" TO bc',
      'SELECT * FROM v ORDER BY 1',
      'ALTER TABLE child RENAME COLUMN a TO ca',
      'SELECT * FROM v ORDER BY 1',
      'ALTER TABLE u RENAME COLUMN id TO ident',
      'SELECT * FROM w ORDER BY 1',
      'ALTER TABLE child RENAME TO kids',
      'SELECT * FROM kids ORDER BY id',
    ]);
  });

  it('DROP COLUMN', () => {
    run([
      'ALTER TABLE t DROP COLUMN a',
      'ALTER TABLE t DROP COLUMN d',
      'ALTER TABLE t DROP COLUMN id',
      'ALTER TABLE t DROP COLUMN nope',
      'ALTER TABLE t DROP COLUMN "b c"',
      'DROP VIEW v',
      'ALTER TABLE t DROP COLUMN "b c"',
      'SELECT * FROM t ORDER BY id',
      'SELECT * FROM w ORDER BY 1',
      'ALTER TABLE t ADD COLUMN e TEXT DEFAULT 5',
      'ALTER TABLE t DROP COLUMN e',
      'SELECT * FROM t ORDER BY id',
      'CREATE TABLE one(x)',
      'ALTER TABLE one DROP COLUMN x',
      'ALTER TABLE child DROP COLUMN a',
    ]);
  });

  it('ALTER inside a transaction rolls back cleanly, and survives reopen', () => {
    const vfs = new MemoryVfs();
    let d = Database.openFile(vfs.openSync('p.db'), {}, vfs.openSync('p.db-wal'));
    for (const s of SETUP) d.exec(s);
    d.exec('BEGIN');
    d.exec('ALTER TABLE t RENAME TO u');
    d.exec("ALTER TABLE u ADD COLUMN e TEXT DEFAULT 'q'");
    expect(d.query('SELECT e FROM u WHERE id = 1').rows).toEqual([['q']]);
    d.exec('ROLLBACK');
    expect(d.query('SELECT count(*) FROM t').rows).toEqual([[3]]);
    expect(() => d.query('SELECT * FROM u')).toThrow(/no such table/);
    d.exec("DROP VIEW v; ALTER TABLE t ADD COLUMN e TEXT DEFAULT 'q'; ALTER TABLE t DROP COLUMN \"b c\"; ALTER TABLE t RENAME COLUMN d TO dd");
    d.close();
    d = Database.openFile(vfs.openSync('p.db'), {}, vfs.openSync('p.db-wal'));
    expect(d.query('SELECT * FROM t ORDER BY id').rows).toEqual([
      [1, 10, 5, 'q'],
      [2, 20, 7, 'q'],
      [3, 30, 9, 'q'],
    ]);
    expect(d.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });
});

describe('ALTER TABLE changes stored definitions', () => {
  const reopen = (vfs: MemoryVfs): Database => Database.openFile(vfs.openSync('d.db'), {}, vfs.openSync('d.db-wal'));
  const checks = (d: Database, table: string): unknown =>
    (d as unknown as { bindContext(): { getTable(n: string): { checks: { text: string; name?: string }[] } } }).bindContext().getTable(table)!.checks.map((c) => c.name ?? c.text);

  it('DROP COLUMN moves later columns, the rowid and expressions over them', () => {
    const vfs = new MemoryVfs();
    let d = reopen(vfs);
    d.exec('CREATE TABLE t(a, b CHECK (b > 0), c, d, CHECK (d > c), CHECK (rowid < 100))');
    d.exec('CREATE INDEX td ON t(d * 2) WHERE c IS NOT NULL');
    d.exec('INSERT INTO t VALUES (1, 2, 3, 4), (5, 6, 7, 8)');
    d.exec('ALTER TABLE t DROP COLUMN b');
    expect(checks(d, 't')).toEqual(['d > c', 'rowid < 100']);
    expect(() => d.exec('INSERT INTO t VALUES (1, 9, 2)')).toThrow(/CHECK constraint failed: d > c/);
    expect(() => d.exec('INSERT INTO t(rowid, a, c, d) VALUES (200, 1, 2, 3)')).toThrow(/CHECK constraint failed: rowid < 100/);
    d.exec('INSERT INTO t VALUES (9, 1, 2)');
    expect(d.query('SELECT a FROM t INDEXED BY td WHERE d * 2 = 16 AND c IS NOT NULL').rows).toEqual([[5]]);
    d.close();
    d = reopen(vfs);
    expect(d.query('SELECT * FROM t ORDER BY a').rows).toEqual([[1, 3, 4], [5, 7, 8], [9, 1, 2]]);
    expect(d.query('SELECT a FROM t INDEXED BY td WHERE d * 2 = 4 AND c IS NOT NULL').rows).toEqual([[9]]);
    expect(() => d.exec('INSERT INTO t VALUES (1, 9, 2)')).toThrow(/CHECK constraint failed: d > c/);
    expect(d.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('ADD COLUMN binds its CHECK over the new row, and RENAME COLUMN renames expression texts', () => {
    const vfs = new MemoryVfs();
    let d = reopen(vfs);
    d.exec('CREATE TABLE t(a, b, CHECK (rowid > 0))');
    d.exec('CREATE INDEX ta ON t(a + b)');
    d.exec('INSERT INTO t VALUES (1, 2)');
    d.exec('ALTER TABLE t ADD COLUMN c INT DEFAULT 7 CHECK (c > a)');
    expect(() => d.exec('INSERT INTO t VALUES (9, 1, 3)')).toThrow(/CHECK constraint failed: c > a/);
    d.exec('ALTER TABLE t RENAME COLUMN a TO x');
    expect(checks(d, 't')).toEqual(['rowid > 0', 'c > x']);
    expect(d.query("SELECT sql FROM sqlite_schema WHERE name = 'ta'").rows).toEqual([['CREATE INDEX ta ON t(x + b)']]);
    d.close();
    d = reopen(vfs);
    expect(d.query('SELECT x, b, c FROM t').rows).toEqual([[1, 2, 7]]);
    expect(() => d.exec('INSERT INTO t VALUES (9, 1, 3)')).toThrow(/CHECK constraint failed: c > x/);
    expect(d.query('SELECT x FROM t INDEXED BY ta WHERE x + b = 3').rows).toEqual([[1]]);
    expect(d.query("SELECT sql FROM sqlite_schema WHERE name = 't'").rows).toEqual([['CREATE TABLE t(x, b, c INT DEFAULT 7 CHECK (c > x), CHECK (rowid > 0))']]);
  });

  it('RENAME TO moves definitions, automatic indexes and foreign keys', () => {
    const vfs = new MemoryVfs();
    let d = reopen(vfs);
    d.exec('PRAGMA foreign_keys = ON');
    d.exec('CREATE TABLE p(id INTEGER PRIMARY KEY, code TEXT UNIQUE)');
    d.exec('CREATE TABLE c(pid REFERENCES p(id) ON DELETE CASCADE)');
    d.exec("INSERT INTO p VALUES (1, 'a'); INSERT INTO c VALUES (1)");
    d.exec('ALTER TABLE p RENAME TO q');
    d.close();
    d = reopen(vfs);
    d.exec('PRAGMA foreign_keys = ON');
    expect(d.query("SELECT name FROM sqlite_schema WHERE tbl_name = 'q' ORDER BY name").rows).toEqual([['q'], ['smalt_autoindex_q_1']]);
    expect(() => d.exec("INSERT INTO q VALUES (2, 'a')")).toThrow(/UNIQUE/);
    expect(() => d.exec('INSERT INTO c VALUES (5)')).toThrow(/FOREIGN KEY/);
    d.exec('DELETE FROM q WHERE id = 1');
    expect(d.query('SELECT count(*) FROM c').rows).toEqual([[0]]);
    expect(d.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });
});
