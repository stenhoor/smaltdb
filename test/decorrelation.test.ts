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
  CREATE TABLE o(id INTEGER PRIMARY KEY, k INT, s TEXT COLLATE NOCASE, t TEXT, n ANY);
  CREATE TABLE i(id INTEGER PRIMARY KEY, k INT, s TEXT, t TEXT COLLATE RTRIM, n TEXT, v INT);
  INSERT INTO o VALUES (1, 1, 'A', 'x', 1), (2, 2, 'b', 'y ', '2'), (3, NULL, 'C', NULL, 3), (4, 4, 'd', 'z', NULL), (5, 1, 'a', 'x  ', 1.0);
  INSERT INTO i VALUES (1, 1, 'a', 'x', '1', 10), (2, 1, 'A', 'x ', '01', 20), (3, 2, 'B', 'y', '2', NULL), (4, NULL, NULL, NULL, NULL, 5), (5, 4, 'd', 'Z', 'four', 7), (6, 4, 'D', 'z', '4.0', 8);
`;

const canon = (v: unknown): string => (typeof v === 'number' ? (Number.isInteger(v) ? 'i' + v : 'r' + v) : JSON.stringify(v));

describe('subquery decorrelation', () => {
  it('matches SQLite on collations, affinity, NULLs, guards and empty-set aggregates', () => {
    const lite = newLite();
    const d = Database.openFile(new MemoryVfs().openSync('d.db'));
    // smaltdb tables are STRICT by default; compare with STRICT SQLite tables (ANY = no affinity).
    lite.exec(SETUP.replace('n ANY);', 'n ANY) STRICT;').replace('v INT);', 'v INT) STRICT;'));
    d.exec(SETUP);
    const qs = [
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM i WHERE i.k = o.k)',
      'SELECT id FROM o WHERE NOT EXISTS (SELECT 1 FROM i WHERE i.k = o.k)',
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM i WHERE i.s = o.s)', // NOCASE from the outer column? comparison uses the left operand
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM i WHERE o.s = i.s)',
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM i WHERE i.t = o.t)', // RTRIM on the inner column
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM i WHERE o.t = i.t)',
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM i WHERE i.n = o.k)', // TEXT vs INTEGER affinity
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM i WHERE o.n = i.n)',
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM i WHERE i.k = o.k AND i.v > 9 AND o.id < 5)',
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM i WHERE i.k = o.k AND i.s = o.s LIMIT 1)',
      // EXISTS over an aggregate always has its row (not a semi-join).
      'SELECT id FROM o WHERE EXISTS (SELECT count(*) FROM i WHERE i.k = o.k)',
      'SELECT id FROM o WHERE NOT EXISTS (SELECT max(v) FROM i WHERE i.k = o.k)',
      'SELECT id, (SELECT count(*) FROM i WHERE i.k = o.k) FROM o',
      'SELECT id, (SELECT sum(v) FROM i WHERE i.k = o.k) FROM o',
      'SELECT id, (SELECT max(v) * 2 + count(*) FROM i WHERE i.k = o.k AND v IS NOT NULL) FROM o',
      'SELECT id, (SELECT total(v) FROM i WHERE i.k = o.k) FROM o',
      'SELECT id, (SELECT group_concat(id) FROM i WHERE i.k = o.k) FROM o',
      'SELECT id, (SELECT count(*) FROM i WHERE i.s = o.s) FROM o',
      'SELECT id, (SELECT count(*) FROM i WHERE o.s = i.s) FROM o',
      'SELECT id FROM o WHERE (SELECT count(*) FROM i WHERE i.k = o.k) >= 2',
      'SELECT id, (SELECT count(*) FROM i JOIN o AS o2 ON o2.k = i.k WHERE i.k = o.k) FROM o',
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM i WHERE i.k = o.k AND EXISTS (SELECT 1 FROM o AS o3 WHERE o3.k = i.k))',
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM i WHERE i.k > o.k)', // not decorrelatable: stays correct
      'SELECT id, (SELECT v FROM i WHERE i.k = o.k ORDER BY v LIMIT 1) FROM o',
      // Derived FROM items (ADR 0031, section 1): decorrelated too, with the derived columns' collations and affinity.
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM (SELECT k FROM i GROUP BY k) AS g WHERE g.k = o.k)',
      'SELECT id FROM o WHERE NOT EXISTS (SELECT 1 FROM (SELECT k FROM i GROUP BY k) AS g WHERE g.k = o.k)',
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM (SELECT s FROM i WHERE v > 5 GROUP BY s) AS g WHERE g.s = o.s)',
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM (SELECT s FROM i WHERE v > 5 GROUP BY s) AS g WHERE o.s = g.s)',
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM (SELECT t FROM i GROUP BY t) AS g WHERE g.t = o.t)',
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM (SELECT n FROM i GROUP BY n) AS g WHERE g.n = o.k)',
      'SELECT id FROM o WHERE EXISTS (SELECT 1 FROM (SELECT k FROM i UNION ALL SELECT k FROM o) AS g WHERE g.k = o.k AND o.id > 1)',
      'SELECT id, (SELECT count(*) FROM (SELECT k, v FROM i WHERE v IS NOT NULL GROUP BY k, v) AS g WHERE g.k = o.k) FROM o',
      'SELECT id, (SELECT sum(v) FROM (SELECT k, v FROM i UNION ALL SELECT k, v FROM i) AS g WHERE g.k = o.k) FROM o',
    ];
    for (const q of qs) {
      const a = JSON.stringify(lite.selectArrays(q).map((r) => r.map(canon).join('|')).sort());
      const b = JSON.stringify(d.query(q).rows.map((r) => r.map(canon).join('|')).sort());
      expect(b, q).toBe(a);
    }
  });

  it('turns quadratic correlated subqueries into one pass', () => {
    const d = Database.openFile(new MemoryVfs().openSync('p.db'));
    d.exec('CREATE TABLE big(id INTEGER PRIMARY KEY, g INT, v INT); CREATE TABLE small(id INTEGER PRIMARY KEY, g INT)');
    const ins = d.prepare('INSERT INTO big VALUES (?, ?, ?)');
    d.exec('BEGIN');
    for (let i = 1; i <= 20000; i++) ins.run([i, i % 3000, i % 17]);
    for (let i = 1; i <= 3000; i++) d.run('INSERT INTO small VALUES (?, ?)', [i, i]);
    d.exec('COMMIT');
    const t0 = performance.now();
    const r = d.query('SELECT count(*), sum((SELECT sum(v) FROM big WHERE big.g = small.g)) FROM small WHERE EXISTS (SELECT 1 FROM big WHERE big.g = small.g AND big.v > 3)').rows;
    const ms = performance.now() - t0;
    expect(r[0][0]).toBe(2999);
    // Without decorrelation this reads 20k rows per outer row (60M rows); with it, each side once.
    expect(ms).toBeLessThan(1000);
  });
});
