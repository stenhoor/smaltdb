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
  CREATE TABLE kv(k TEXT PRIMARY KEY, v INT NOT NULL DEFAULT 0, n INT DEFAULT 1, CHECK (v >= 0));
  CREATE TABLE inv(id INTEGER PRIMARY KEY, sku TEXT UNIQUE, qty INT, price REAL);
  CREATE TABLE moves(sku TEXT, delta INT);
  INSERT INTO kv VALUES ('a', 1, 1), ('b', 2, 1);
  INSERT INTO inv VALUES (1, 'x', 10, 1.5), (2, 'y', 0, 2.0), (3, 'z', 5, NULL);
  INSERT INTO moves VALUES ('x', 3), ('y', -1), ('q', 9), ('x', 100);
`;

/** Run each statement on both engines; compare returned rows (or errors) and final contents. */
function compare(statements: string[]): void {
  const lite = newLite();
  const d = Database.openFile(new MemoryVfs().openSync('x.db'));
  lite.exec(SETUP);
  d.exec(SETUP);
  for (const sql of statements) {
    let a: unknown;
    let b: unknown;
    try {
      a = lite.selectArrays(sql);
    } catch (e) {
      a = 'ERROR ' + (e as Error).message.replace(/^SQLITE_\w+: sqlite3 result code \d+: /, '');
    }
    try {
      b = d.query(sql).rows;
    } catch (e) {
      b = 'ERROR ' + (e as Error).message;
    }
    expect(JSON.stringify(b), sql).toBe(JSON.stringify(a));
  }
  for (const t of ['kv', 'inv', 'moves']) {
    const q = `SELECT * FROM ${t} ORDER BY 1, 2`;
    expect(JSON.stringify(d.query(q).rows), q).toBe(JSON.stringify(lite.selectArrays(q)));
  }
}

describe('RETURNING', () => {
  it('INSERT / UPDATE / DELETE return the written rows', () => {
    compare([
      "INSERT INTO kv(k) VALUES ('c') RETURNING *",
      "INSERT INTO kv VALUES ('d', 4, 2), ('e', 5, 3) RETURNING k, v * 10 AS ten, rowid > 0",
      "INSERT INTO inv(sku, qty) VALUES ('w', 7) RETURNING id, sku, price IS NULL",
      "INSERT INTO inv(sku, qty) SELECT sku || '2', delta FROM moves WHERE delta > 0 RETURNING id, sku",
      'UPDATE kv SET v = v + 1 WHERE v >= 2 RETURNING k, v',
      "UPDATE inv SET qty = qty * 2 WHERE sku = 'nope' RETURNING *",
      'DELETE FROM kv WHERE v > 4 RETURNING k, v',
      'DELETE FROM moves RETURNING sku',
      "INSERT INTO kv VALUES ('bad', -1, 1) RETURNING k",
      'UPDATE kv SET v = 1 RETURNING count(*)',
    ]);
  });
});

describe('upsert (ON CONFLICT)', () => {
  it('DO NOTHING / DO UPDATE with excluded, WHERE, rowid targets and errors', () => {
    compare([
      "INSERT INTO kv VALUES ('a', 10, 1) ON CONFLICT DO NOTHING",
      "INSERT INTO kv VALUES ('a', 10, 1), ('f', 6, 1) ON CONFLICT (k) DO NOTHING RETURNING k",
      "INSERT INTO kv(k, v) VALUES ('a', 5) ON CONFLICT (k) DO UPDATE SET v = v + excluded.v, n = n + 1 RETURNING *",
      "INSERT INTO kv(k, v) VALUES ('b', 100) ON CONFLICT (k) DO UPDATE SET v = excluded.v WHERE excluded.v < kv.v RETURNING *",
      "INSERT INTO kv(k, v) VALUES ('b', 1) ON CONFLICT (k) DO UPDATE SET v = excluded.v WHERE excluded.v < kv.v RETURNING *",
      "INSERT INTO inv VALUES (1, 'new', 1, 1.0) ON CONFLICT (id) DO UPDATE SET qty = qty + excluded.qty RETURNING id, sku, qty",
      "INSERT INTO inv VALUES (9, 'x', 1, 1.0) ON CONFLICT (sku) DO UPDATE SET qty = inv.qty + excluded.qty RETURNING id, qty",
      "INSERT INTO inv VALUES (9, 'x', 1, 1.0) ON CONFLICT (id) DO NOTHING",
      "INSERT INTO inv VALUES (2, 'x', 1, 1.0) ON CONFLICT (sku) DO NOTHING ON CONFLICT (id) DO UPDATE SET qty = -5",
      "INSERT INTO inv(sku, qty) SELECT sku, delta FROM moves WHERE true ON CONFLICT (sku) DO UPDATE SET qty = qty + excluded.qty",
      "INSERT INTO kv(k, v) VALUES ('a', 1) ON CONFLICT (v) DO NOTHING",
      "INSERT INTO kv(k, v) VALUES ('a', 1) ON CONFLICT (k) DO UPDATE SET v = -3",
      "INSERT INTO inv VALUES (3, 'y', 0, 0) ON CONFLICT (id) DO UPDATE SET sku = excluded.sku",
    ]);
  });
});

describe('UPDATE ... FROM', () => {
  it('joins the target with FROM sources', () => {
    compare([
      'UPDATE inv SET qty = qty + m.delta FROM moves m WHERE m.sku = inv.sku AND m.delta < 50 RETURNING sku, qty',
      'UPDATE inv SET price = s.total FROM (SELECT sku, sum(delta) AS total FROM moves GROUP BY sku) AS s WHERE s.sku = inv.sku',
      "UPDATE kv SET v = inv.qty FROM inv WHERE inv.sku = 'x' AND kv.k = 'a'",
      'UPDATE kv SET n = 0 FROM inv WHERE inv.qty > 1000',
    ]);
  });
});
