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

const SETUP = `
  CREATE TABLE emp(id INTEGER PRIMARY KEY, name TEXT, dept INT, salary REAL);
  CREATE TABLE dept(id INTEGER PRIMARY KEY, title TEXT);
  INSERT INTO dept VALUES (1, 'eng'), (2, 'ops'), (3, 'empty');
  INSERT INTO emp VALUES (1, 'ann', 1, 100), (2, 'bob', 1, 80), (3, 'cy', 2, 70), (4, 'di', NULL, 60), (5, 'ed', 2, NULL);
  CREATE VIEW eng AS SELECT id, name, salary FROM emp WHERE dept = 1;
  CREATE VIEW named(who, pay) AS SELECT name, salary FROM emp;
  CREATE VIEW by_dept AS SELECT d.title, count(e.id) AS n, sum(e.salary) AS total FROM dept d LEFT JOIN emp e ON e.dept = d.id GROUP BY d.title;
  CREATE VIEW rich AS SELECT * FROM named WHERE pay > 75;
  CREATE VIEW top2 AS SELECT name FROM emp ORDER BY salary DESC LIMIT 2;
  CREATE VIEW u AS SELECT name FROM emp WHERE dept = 1 UNION SELECT title FROM dept;
`;

describe('views', () => {
  it('query results match SQLite', () => {
    const lite = newLite();
    const d = Database.openFile(new MemoryVfs().openSync('v.db'));
    lite.exec(SETUP);
    d.exec(SETUP);
    const queries = [
      'SELECT * FROM eng',
      'SELECT name FROM eng WHERE salary > 90',
      'SELECT * FROM named',
      'SELECT who FROM named WHERE pay IS NULL',
      'SELECT * FROM by_dept',
      'SELECT * FROM rich',
      'SELECT * FROM top2',
      'SELECT * FROM u',
      'SELECT e.name, b.n FROM emp e JOIN dept dd ON dd.id = e.dept JOIN by_dept b ON b.title = dd.title',
      'SELECT count(*) FROM eng a, eng b',
      'SELECT x.name FROM eng AS x WHERE x.id IN (SELECT id FROM eng WHERE salary < 90)',
      'WITH eng AS (SELECT 42 AS id) SELECT * FROM eng', // a CTE shadows the view
      'SELECT (SELECT max(pay) FROM named)',
      'SELECT name FROM emp WHERE EXISTS (SELECT 1 FROM eng WHERE eng.id = emp.id)',
    ];
    for (const q of queries) {
      const a = JSON.stringify(lite.selectArrays(q).map((r) => r.map(String)).sort());
      const b = JSON.stringify(d.query(q).rows.map((r) => r.map(String)).sort());
      expect(b, q).toBe(a);
    }
    expect(d.query('SELECT * FROM named').columns).toEqual(['who', 'pay']);
  });

  it('DDL behaves like SQLite', () => {
    const d = Database.openFile(new MemoryVfs().openSync('v.db'));
    d.exec(SETUP);
    const err = (sql: string): string => {
      try {
        d.exec(sql);
        return 'ok';
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(err('CREATE VIEW eng AS SELECT 1')).toMatch(/view eng already exists/);
    expect(err('CREATE VIEW IF NOT EXISTS eng AS SELECT 1')).toBe('ok');
    expect(err('CREATE VIEW emp AS SELECT 1')).toMatch(/table emp already exists/);
    expect(err('CREATE TABLE eng(x)')).toMatch(/view eng already exists/);
    expect(err('INSERT INTO eng VALUES (1, 2, 3)')).toMatch(/cannot modify eng because it is a view/);
    expect(err('UPDATE eng SET salary = 1')).toMatch(/cannot modify eng because it is a view/);
    expect(err('DELETE FROM eng')).toMatch(/cannot modify eng because it is a view/);
    expect(err('CREATE INDEX ei ON eng(id)')).toMatch(/views may not be indexed/);
    expect(err('DROP TABLE eng')).toMatch(/use DROP VIEW to delete view eng/);
    expect(err('DROP VIEW emp')).toMatch(/use DROP TABLE to delete table emp/);
    expect(err('DROP VIEW nope')).toMatch(/no such view: nope/);
    expect(err('DROP VIEW IF EXISTS nope')).toBe('ok');
    // Not resolved until used, like SQLite.
    expect(err('CREATE VIEW later AS SELECT * FROM not_yet')).toBe('ok');
    expect(() => d.query('SELECT * FROM later')).toThrow(/no such table: not_yet/);
    d.exec('CREATE TABLE not_yet(z); INSERT INTO not_yet VALUES (7)');
    expect(d.query('SELECT * FROM later').rows).toEqual([[7]]);
    // Column-count mismatch and circular definitions are reported at use.
    d.exec('CREATE VIEW short(x) AS SELECT 1, 2');
    expect(() => d.query('SELECT * FROM short')).toThrow(/expected 1 columns for 'short' but got 2/);
    d.exec('CREATE VIEW c1 AS SELECT * FROM c2; CREATE VIEW c2 AS SELECT * FROM c1');
    expect(() => d.query('SELECT * FROM c1')).toThrow(/circularly defined/);
    // Catalog rows.
    expect(d.query("SELECT type, name, tbl_name, rootpage, sql FROM sqlite_schema WHERE name = 'eng'").rows).toEqual([
      ['view', 'eng', 'eng', 0, 'CREATE VIEW eng AS SELECT id, name, salary FROM emp WHERE dept = 1'],
    ]);
    // Dropping the base table leaves the view dangling.
    d.exec('DROP VIEW rich; DROP VIEW named');
    expect(d.query("SELECT count(*) FROM sqlite_schema WHERE type = 'view' AND name IN ('rich', 'named')").rows).toEqual([[0]]);
  });

  it('persist across reopen and see new data', () => {
    const vfs = new MemoryVfs();
    let d = Database.openFile(vfs.openSync('p.db'), {}, vfs.openSync('p.db-wal'));
    d.exec(SETUP);
    d.close();
    d = Database.openFile(vfs.openSync('p.db'), {}, vfs.openSync('p.db-wal'));
    expect(d.query('SELECT name FROM eng ORDER BY id').rows).toEqual([['ann'], ['bob']]);
    d.exec("INSERT INTO emp VALUES (6, 'fay', 1, 90)");
    const st = d.prepare('SELECT count(*) FROM eng');
    expect(st.all()).toEqual([[3]]);
    d.exec('DROP VIEW eng; CREATE VIEW eng AS SELECT id FROM emp WHERE dept = 2');
    expect(st.all()).toEqual([[2]]); // prepared statement re-plans after the schema change
  });
});
