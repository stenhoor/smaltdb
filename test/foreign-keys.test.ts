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

const SCHEMA = `
  CREATE TABLE artist(id INTEGER PRIMARY KEY, name TEXT UNIQUE);
  CREATE TABLE album(id INTEGER PRIMARY KEY, artist INT REFERENCES artist(id) ON DELETE CASCADE ON UPDATE CASCADE, title TEXT);
  CREATE TABLE track(id INTEGER PRIMARY KEY, album INT REFERENCES album(id) ON DELETE CASCADE, name TEXT);
  CREATE TABLE fan(id INTEGER PRIMARY KEY, artist INT REFERENCES artist(id) ON DELETE SET NULL, favorite TEXT DEFAULT 'none' REFERENCES artist(name) ON DELETE SET DEFAULT ON UPDATE CASCADE);
  CREATE TABLE contract(artist INT REFERENCES artist(id) ON DELETE RESTRICT, year INT);
  CREATE TABLE note(artist INT REFERENCES artist(id), body TEXT);
  CREATE TABLE emp(id INTEGER PRIMARY KEY, boss INT REFERENCES emp(id) ON DELETE CASCADE);
  CREATE TABLE pk2(a INT, b TEXT, PRIMARY KEY (a, b));
  CREATE TABLE ref2(x INT, y TEXT, FOREIGN KEY (x, y) REFERENCES pk2(a, b));
  CREATE TABLE lazy(artist INT REFERENCES artist(id) DEFERRABLE INITIALLY DEFERRED);
  CREATE TABLE orphan(x INT REFERENCES nowhere(id));
  INSERT INTO artist VALUES (1, 'none'), (2, 'Bach'), (3, 'Cage');
  INSERT INTO album VALUES (10, 2, 'Goldberg'), (11, 2, 'Partitas'), (12, 3, '4''33');
  INSERT INTO track VALUES (100, 10, 'Aria'), (101, 10, 'Var 1'), (102, 12, 'Silence');
  INSERT INTO fan VALUES (1, 2, 'Bach'), (2, 3, 'Cage');
  INSERT INTO emp VALUES (1, NULL), (2, 1), (3, 2), (4, 2), (5, NULL);
  INSERT INTO pk2 VALUES (1, 'a'), (2, 'b');
`;

function run(statements: string[]): void {
  const lite = newLite();
  const d = Database.openFile(new MemoryVfs().openSync('f.db'));
  lite.exec('PRAGMA foreign_keys = ON');
  lite.exec(SCHEMA);
  d.exec(SCHEMA);
  const tables = ['artist', 'album', 'track', 'fan', 'contract', 'note', 'emp', 'pk2', 'ref2', 'lazy'];
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
    for (const t of tables) {
      const qq = `SELECT * FROM ${t} ORDER BY rowid`;
      const get = (f: () => unknown[][]): string => {
        try {
          return JSON.stringify(f());
        } catch {
          return 'missing';
        }
      };
      expect(get(() => d.query(qq).rows), `${t} after: ${sql}`).toBe(get(() => lite.selectArrays(qq)));
    }
  }
}

describe('foreign keys (enforced by default; SQLite with PRAGMA foreign_keys = ON)', () => {
  it('child-side checks', () => {
    run([
      'INSERT INTO album VALUES (13, 9, NULL)',
      'INSERT INTO album VALUES (13, NULL, NULL)',
      'INSERT INTO album VALUES (14, 3, NULL)',
      'UPDATE album SET artist = 42 WHERE id = 14',
      "INSERT INTO ref2 VALUES (1, 'a'), (NULL, 'zz')",
      "INSERT INTO ref2 VALUES (1, 'b')",
      "INSERT INTO note VALUES (2, 'ok'), (7, 'bad')",
      'CREATE TABLE bad(artist_name TEXT REFERENCES artist(title))',
      "INSERT INTO bad VALUES ('x')",
      "INSERT INTO artist VALUES (50, 'mismatch blocks parent writes too')",
      'DROP TABLE bad',
      "INSERT INTO artist VALUES (50, 'ok again')",
      'INSERT INTO orphan VALUES (1)',
      'INSERT INTO orphan VALUES (NULL)',
    ]);
  });

  it('parent-side actions', () => {
    run([
      'DELETE FROM artist WHERE id = 3',
      "INSERT INTO note VALUES (2, 'n')",
      'DELETE FROM artist WHERE id = 2',
      'DELETE FROM note',
      'INSERT INTO contract VALUES (2, 2020)',
      'DELETE FROM artist WHERE id = 2',
      'DELETE FROM contract',
      'UPDATE artist SET id = 20 WHERE id = 2',
      "UPDATE artist SET name = 'J.S. Bach' WHERE id = 20",
      'DELETE FROM artist WHERE id = 20',
      'DELETE FROM emp WHERE id = 2',
      'DELETE FROM emp',
      "DELETE FROM pk2 WHERE a = 2",
      "INSERT INTO ref2 VALUES (1, 'a')",
      'DELETE FROM pk2',
    ]);
  });

  it('REPLACE, upsert, multi-row statements and DROP TABLE', () => {
    run([
      "INSERT OR REPLACE INTO artist VALUES (2, 'Bach2')",
      "INSERT INTO note VALUES (3, 'x')",
      "INSERT OR REPLACE INTO artist VALUES (3, 'Cage')",
      "INSERT INTO artist VALUES (3, 'Cage') ON CONFLICT (id) DO UPDATE SET id = 30",
      'UPDATE emp SET id = id + 10',
      "INSERT INTO emp VALUES (6, 7), (7, 6)",
      'DROP TABLE contract',
      'DROP TABLE artist',
      'DELETE FROM note',
      'DROP TABLE artist',
    ]);
  });

  it('deferred constraints, PRAGMA foreign_keys and savepoints', () => {
    const d = Database.openFile(new MemoryVfs().openSync('f.db'));
    d.exec(SCHEMA);
    expect(d.query('PRAGMA foreign_keys').rows).toEqual([[1]]);
    d.exec('BEGIN');
    d.exec('INSERT INTO lazy VALUES (99)');
    expect(() => d.exec('COMMIT')).toThrow(/FOREIGN KEY constraint failed/);
    d.exec("INSERT INTO artist VALUES (99, 'late')");
    d.exec('COMMIT');
    expect(d.query('SELECT * FROM lazy').rows).toEqual([[99]]);
    expect(() => d.exec('INSERT INTO lazy VALUES (98)')).toThrow(/FOREIGN KEY constraint failed/); // autocommit checks at once
    // A failed statement inside a transaction rolls back just that statement.
    d.exec('BEGIN');
    d.exec("INSERT INTO note VALUES (2, 'kept')");
    expect(() => d.exec("INSERT INTO note VALUES (2, 'a'), (77, 'b')")).toThrow(/FOREIGN KEY/);
    d.exec('COMMIT');
    expect(d.query('SELECT body FROM note').rows).toEqual([['kept']]);
    d.exec('PRAGMA foreign_keys = OFF');
    expect(d.query('PRAGMA foreign_keys').rows).toEqual([[0]]);
    d.exec("INSERT INTO note VALUES (77, 'unchecked')");
    d.exec('DELETE FROM artist WHERE id = 2');
    expect(d.query('SELECT count(*) FROM album WHERE artist = 2').rows).toEqual([[2]]);
    d.exec('PRAGMA foreign_keys = ON');
    expect(() => d.exec('INSERT INTO album VALUES (50, 1234, NULL)')).toThrow(/FOREIGN KEY/);
  });
});

describe('foreign keys: random statements vs SQLite', () => {
  const actions = ['NO ACTION', 'RESTRICT', 'CASCADE', 'SET NULL', 'SET DEFAULT'];
  for (let variant = 0; variant < Number(process.env.FK_VARIANTS ?? 6); variant++) {
    it(`variant ${variant}`, () => {
      let seed = 1234 + variant * 99;
      const r = (): number => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed / 4294967296;
      };
      const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
      const del1 = pick(actions);
      const upd1 = pick(actions);
      const del2 = pick(actions);
      const defer = variant % 3 === 2 ? ' DEFERRABLE INITIALLY DEFERRED' : '';
      const schema = `
        CREATE TABLE p(id INTEGER PRIMARY KEY, k INT UNIQUE);
        CREATE TABLE c(id INTEGER PRIMARY KEY, pid INT DEFAULT 1 REFERENCES p(id) ON DELETE ${del1} ON UPDATE ${upd1}${defer}, pk INT REFERENCES p(k) ON DELETE ${del2} ON UPDATE CASCADE);
        CREATE TABLE s(id INTEGER PRIMARY KEY, up INT REFERENCES s(id) ON DELETE ${pick(['CASCADE', 'SET NULL', 'NO ACTION'])});
      `;
      const lite = newLite();
      const d = Database.openFile(new MemoryVfs().openSync('r.db'));
      lite.exec('PRAGMA foreign_keys = ON');
      lite.exec(schema);
      d.exec(schema);
      const key = (): string => (r() < 0.1 ? 'NULL' : String(1 + Math.floor(r() * 8)));
      for (let i = 0; i < 400; i++) {
        const sql = pick([
          () => `INSERT INTO p VALUES (${key()}, ${key()})`,
          () => `INSERT OR REPLACE INTO p VALUES (${key()}, ${key()})`,
          () => `INSERT INTO c(pid, pk) VALUES (${key()}, ${key()})`,
          () => `INSERT INTO s VALUES (${key()}, ${key()})`,
          () => `DELETE FROM p WHERE id = ${key()}`,
          () => `DELETE FROM p WHERE k > ${key()}`,
          () => `DELETE FROM s WHERE id = ${key()}`,
          () => `UPDATE p SET id = ${key()} WHERE id = ${key()}`,
          () => `UPDATE p SET k = k + 1 WHERE id = ${key()}`,
          () => `UPDATE c SET pid = ${key()} WHERE id % 3 = ${Math.floor(r() * 3)}`,
          () => `DELETE FROM c WHERE pid = ${key()}`,
          () => `UPDATE s SET up = ${key()} WHERE id = ${key()}`,
        ])();
        let a: string;
        let b: string;
        try {
          lite.exec(sql);
          a = 'ok';
        } catch (e) {
          a = (e as Error).message.replace(/^SQLITE_\w+: sqlite3 result code \d+: /, '');
        }
        try {
          d.exec(sql);
          b = 'ok';
        } catch (e) {
          b = (e as Error).message;
        }
        if (b !== a && process.env.FK_DEBUG) {
          console.log(schema);
          for (const t of ['p', 'c', 's']) console.log(t, JSON.stringify(lite.selectArrays(`SELECT * FROM ${t} ORDER BY id`)), JSON.stringify(d.query(`SELECT * FROM ${t} ORDER BY id`).rows));
        }
        expect(b, sql).toBe(a);
        for (const t of ['p', 'c', 's']) {
          const qq = `SELECT * FROM ${t} ORDER BY id`;
          expect(JSON.stringify(d.query(qq).rows), `${t} after ${sql}`).toBe(JSON.stringify(lite.selectArrays(qq)));
        }
      }
    });
  }
});
