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

const SETUP = (n: number): string => {
  const rows: string[] = [];
  for (let i = 1; i <= n; i++) rows.push(`(${i}, '${['Ann', 'bob', 'CY', 'dee'][i % 4]}${i % 50}', ${i % 7}, ${i % 3 === 0 ? 'NULL' : i % 11})`);
  return `CREATE TABLE p(id INTEGER PRIMARY KEY, name TEXT, a INT, b INT); INSERT INTO p VALUES ${rows.join(',')};`;
};

const plan = (d: Database, q: string): string => d.query('EXPLAIN QUERY PLAN ' + q).rows.map((r) => r[3]).join(' | ');

describe('expression and partial indexes', () => {
  it('results, constraints and errors match SQLite; plans use the indexes', () => {
    const lite = newLite();
    const d = Database.openFile(new MemoryVfs().openSync('x.db'));
    const ddl =
      SETUP(5000) +
      'CREATE INDEX p_lower ON p(lower(name)); CREATE INDEX p_sum ON p(a + b DESC, id); CREATE INDEX p_part ON p(a) WHERE b IS NOT NULL AND b = 10;' +
      'CREATE UNIQUE INDEX p_uq ON p(name || \'#\' || id);';
    lite.exec(ddl);
    d.exec(ddl);
    const queries = [
      "SELECT id FROM p WHERE lower(name) = 'ann4'",
      "SELECT count(*) FROM p WHERE lower(p.name) = 'bob5'",
      'SELECT id FROM p WHERE a + b = 12 ORDER BY id',
      'SELECT count(*) FROM p WHERE a + b > 14',
      'SELECT count(*) FROM p WHERE a = 3 AND b IS NOT NULL AND b = 10',
      'SELECT count(*) FROM p WHERE a = 3 AND b > 5',
      'SELECT count(*) FROM p WHERE a = 3',
      "SELECT id FROM p WHERE name || '#' || id = 'CY2#2'",
    ];
    for (const q of queries) expect(JSON.stringify(d.query(q).rows), q).toBe(JSON.stringify(lite.selectArrays(q)));
    expect(plan(d, "SELECT id FROM p WHERE lower(name) = 'ann4'")).toMatch(/INDEX p_lower/);
    expect(plan(d, 'SELECT id FROM p WHERE a + b = 12')).toMatch(/INDEX p_sum/);
    expect(plan(d, 'SELECT count(*) FROM p WHERE a = 3 AND b IS NOT NULL AND b = 10')).toMatch(/INDEX p_part/);
    expect(plan(d, 'SELECT count(*) FROM p WHERE a = 3 AND b > 5')).not.toMatch(/p_part/); // b > 5 does not imply b = 10
    expect(plan(d, 'SELECT count(*) FROM p WHERE a = 3')).not.toMatch(/p_part/); // does not imply the index WHERE
    // Writes maintain expression and partial indexes (rows moving in and out of the partial index).
    const writes = [
      "UPDATE p SET name = 'ZED' WHERE id % 97 = 0",
      'UPDATE p SET b = 10 WHERE id % 13 = 0',
      'UPDATE p SET b = 1 WHERE id % 17 = 0',
      'DELETE FROM p WHERE id % 19 = 0',
      "INSERT INTO p VALUES (9001, 'Ann4', 3, 9)",
      "INSERT INTO p VALUES (9002, 'x', 1, 1)",
      "UPDATE p SET name = 'CY2', id = 2 WHERE id = 9002",
    ];
    for (const w of writes) {
      let a: string;
      let b: string;
      try {
        lite.exec(w);
        a = 'ok';
      } catch (e) {
        a = (e as Error).message.replace(/^SQLITE_\w+: sqlite3 result code \d+: /, '');
      }
      try {
        d.exec(w);
        b = 'ok';
      } catch (e) {
        b = (e as Error).message;
      }
      expect(b, w).toBe(a);
      for (const q of queries) expect(JSON.stringify(d.query(q).rows), `${q} after ${w}`).toBe(JSON.stringify(lite.selectArrays(q)));
    }
    expect(d.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
    expect(d.query("SELECT * FROM pragma_index_info('p_sum')").rows).toEqual([
      [0, -2, null],
      [1, 0, 'id'],
    ]);
    const err = (sql: string): string => {
      try {
        d.exec(sql);
        return 'ok';
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(err('CREATE INDEX bad1 ON p(random())')).toMatch(/non-deterministic functions prohibited in index expressions/);
    expect(err('CREATE INDEX bad2 ON p(a) WHERE b > (SELECT 1)')).toMatch(/subqueries prohibited in partial index WHERE clauses/);
    expect(err('CREATE INDEX bad3 ON p(nope + 1)')).toMatch(/no such column: nope/);
    expect(err("CREATE UNIQUE INDEX bad4 ON p(a % 2)")).toMatch(/UNIQUE constraint failed/);
  });

  it('answer from the index alone while a partial index reads other columns', () => {
    const d = Database.openFile(new MemoryVfs().openSync('x.db'));
    d.exec(SETUP(2000));
    d.exec('CREATE INDEX pa ON p(a * 2); CREATE INDEX pn ON p(name) WHERE a > 3');
    // Matching the partial index's WHERE against the query reads nothing from the rows.
    expect(plan(d, 'SELECT id FROM p WHERE a * 2 = 6')).toBe('SEARCH p USING COVERING INDEX pa (=?)');
  });

  it('survive reopen, ALTER TABLE and ANALYZE', () => {
    const vfs = new MemoryVfs();
    let d = Database.openFile(vfs.openSync('y.db'), {}, vfs.openSync('y.db-wal'));
    d.exec(SETUP(300) + 'CREATE INDEX p_lower ON p(lower(name)) WHERE a > 2;');
    d.close();
    d = Database.openFile(vfs.openSync('y.db'), {}, vfs.openSync('y.db-wal'));
    d.exec("INSERT INTO p VALUES (1000, 'NEW', 5, 1)");
    expect(d.query("SELECT id FROM p WHERE lower(name) = 'new' AND a > 2").rows).toEqual([[1000]]);
    d.exec('ALTER TABLE p RENAME COLUMN name TO title');
    expect(d.query("SELECT sql FROM sqlite_schema WHERE name = 'p_lower'").rows).toEqual([['CREATE INDEX p_lower ON p(lower(title)) WHERE a > 2']]);
    expect(d.query("SELECT id FROM p WHERE lower(title) = 'new' AND a > 2").rows).toEqual([[1000]]);
    expect(() => d.exec('ALTER TABLE p DROP COLUMN title')).toThrow(/error in index p_lower after drop column/);
    d.exec('ANALYZE');
    expect(d.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });
});
