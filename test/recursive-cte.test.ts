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
  CREATE TABLE org(name TEXT PRIMARY KEY, boss TEXT, height INT);
  INSERT INTO org VALUES ('Alice', NULL, 160), ('Bob', 'Alice', 170), ('Cindy', 'Alice', 165), ('Dave', 'Bob', 180), ('Emma', 'Bob', 158), ('Fred', 'Cindy', 172), ('Gail', 'Fred', 150);
  CREATE TABLE edge(a INT, b INT);
  INSERT INTO edge VALUES (1, 2), (2, 3), (3, 1), (3, 4), (4, 5), (5, 2), (6, 7);
`;

describe('WITH RECURSIVE', () => {
  it('matches SQLite (order-sensitive where SQLite defines the order)', () => {
    const lite = newLite();
    const d = Database.openFile(new MemoryVfs().openSync('r.db'));
    lite.exec(SETUP);
    d.exec(SETUP);
    const queries: [string, boolean][] = [
      ['WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 10) SELECT x FROM c', true],
      ['WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 7) SELECT sum(x), count(*) FROM c', true],
      ['WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 5 OFFSET 2) SELECT x FROM c', true],
      ['WITH RECURSIVE fib(a, b, n) AS (SELECT 0, 1, 1 UNION ALL SELECT b, a + b, n + 1 FROM fib WHERE n < 30) SELECT a FROM fib', true],
      [
        "WITH RECURSIVE under(name, lvl) AS (SELECT 'Alice', 0 UNION ALL SELECT org.name, under.lvl + 1 FROM org JOIN under ON org.boss = under.name ORDER BY 2 DESC) SELECT name, lvl FROM under",
        true,
      ],
      [
        "WITH RECURSIVE under(name, lvl) AS (SELECT 'Alice', 0 UNION ALL SELECT org.name, under.lvl + 1 FROM org, under WHERE org.boss = under.name ORDER BY 2) SELECT name, lvl FROM under",
        true,
      ],
      ['WITH RECURSIVE reach(n) AS (SELECT 1 UNION SELECT edge.b FROM edge JOIN reach ON edge.a = reach.n) SELECT n FROM reach', false],
      ['WITH RECURSIVE reach(n) AS (VALUES (6) UNION SELECT b FROM edge, reach WHERE a = n) SELECT n FROM reach', false],
      [
        "WITH RECURSIVE chain(name, path) AS (SELECT name, name FROM org WHERE boss IS NULL UNION ALL SELECT o.name, c.path || '/' || o.name FROM org o JOIN chain c ON o.boss = c.name) SELECT path FROM chain WHERE name = 'Gail'",
        true,
      ],
      [
        'WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x * 2 FROM t WHERE x < 100), u AS (SELECT x FROM t WHERE x > 10) SELECT count(*), max(x) FROM u',
        true,
      ],
      ['SELECT (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < height / 10) SELECT count(*) FROM c), name FROM org', false],
      ['WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3 UNION ALL SELECT x + 10 FROM c WHERE x < 3) SELECT x FROM c', true],
      ['WITH RECURSIVE c(x) AS (SELECT x FROM c) SELECT * FROM c', true],
      ['WITH RECURSIVE c(x, y) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3) SELECT * FROM c', true],
      ['WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 3) SELECT a.x, b.x FROM c a JOIN c b ON b.x = a.x + 1', false],
    ];
    for (const [q, ordered] of queries) {
      let a: unknown;
      let b: unknown;
      try {
        a = lite.selectArrays(q);
      } catch (e) {
        a = 'ERROR';
      }
      try {
        b = d.query(q).rows;
      } catch (e) {
        b = 'ERROR';
      }
      const norm = (x: unknown): string => (Array.isArray(x) ? JSON.stringify(ordered ? x : [...x].map((r) => JSON.stringify(r)).sort()) : String(x));
      expect(norm(b), q).toBe(norm(a));
    }
  });

  it('generates many rows without recursion depth limits', () => {
    const d = Database.openFile(new MemoryVfs().openSync('r.db'));
    expect(d.query('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 200000) SELECT count(*), sum(x) FROM c').rows).toEqual([[200000, 20000100000]]);
    d.exec('CREATE TABLE n(v INT)');
    d.exec('INSERT INTO n WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 1000) SELECT x FROM c');
    expect(d.query('SELECT count(*) FROM n').rows).toEqual([[1000]]);
  });
});
