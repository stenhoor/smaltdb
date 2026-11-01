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
