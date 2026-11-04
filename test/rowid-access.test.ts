/**
 * Rowid seeks and rowid ranges enforce their conditions exactly, so the planner drops the conditions they use (no
 * Filter above them): their results must equal SQLite's for every kind of operand (text, REAL, blob, NULL, values
 * outside the int64 range), on tiny tables (where a seek must still win over a scan) and larger ones, and as the
 * inner side of joins through columns of any affinity.
 */
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

type Sqlite = { exec(sql: string): void; selectArrays(sql: string): unknown[][] };
let sqlite3: { oo1: { DB: new (name: string) => Sqlite } };
beforeAll(async () => {
  sqlite3 = (await (sqliteInit as unknown as (o: object) => Promise<unknown>)({ print: () => {}, printErr: () => {} })) as never;
});

const OPERANDS = [
  '5', '5.0', '5.5', "'5'", "' 5'", "'5.0'", "'abc'", "x'05'", 'NULL', '-0.0', '9223372036854775807', '-9223372036854775808',
  '9223372036854775808', '1e19', '-1e19', '9.223372036854775807e18', '2', '1', '0', '-1', "'2'", 'CAST(3 AS TEXT)',
];

function queries(): string[] {
  const out: string[] = [];
  for (const v of OPERANDS) {
    out.push(`SELECT id, v FROM t WHERE id = ${v}`, `SELECT id FROM t WHERE ${v} = rowid`, `SELECT id FROM t WHERE id IN (${v}, 3)`);
    for (const op of ['<', '<=', '>', '>=']) out.push(`SELECT id FROM t WHERE id ${op} ${v} ORDER BY id`, `SELECT id FROM t WHERE id ${op} ${v} ORDER BY id DESC`);
    out.push(`SELECT id FROM t WHERE id > ${v} AND id <= 7 ORDER BY id`);
  }
  out.push(
    'SELECT k.s, t.id FROM k JOIN t ON t.id = k.s ORDER BY 1, 2',
    'SELECT k.r, t.id FROM k JOIN t ON t.id = k.r ORDER BY 1, 2',
    'SELECT k.n, t.id FROM k JOIN t ON t.id = k.n ORDER BY 1, 2',
    'SELECT k.b, t.id FROM k JOIN t ON t.id = k.b ORDER BY 1, 2',
    'SELECT k.s, t.id FROM k LEFT JOIN t ON t.id = k.s ORDER BY 1, 2',
    'SELECT count(*) FROM k WHERE EXISTS (SELECT 1 FROM t WHERE t.id = k.s)',
  );
  return out;
}

const SETUP = (rows: number): string => `
  CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);
  CREATE TABLE k(s TEXT, r REAL, n, b BLOB);
  WITH RECURSIVE c(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM c WHERE i < ${rows}) INSERT INTO t SELECT i, 'v' || i FROM c;
  INSERT INTO t VALUES (9223372036854775807, 'max'), (-9223372036854775808, 'min'), (0, 'zero'), (-1, 'neg');
  INSERT INTO k VALUES ('5', 5.0, 5, x'05'), (' 5', 5.5, '5', NULL), ('abc', 2.0, 2.5, x'02'), (NULL, NULL, NULL, NULL), ('3', 9.3e18, 'x', x'');
`;

const norm = (rows: unknown[][]): unknown[][] => rows.map((r) => r.map((v) => (typeof v === 'bigint' ? Number(v) : v instanceof Uint8Array ? Array.from(v) : v)));

describe('rowid access enforces its conditions exactly', () => {
  for (const rows of [2, 3000]) {
    it(`agrees with SQLite (${rows} rows)`, async () => {
      const db = await Database.open(new MemoryVfs(), 'db');
      const lite = new sqlite3.oo1.DB(':memory:');
      db.exec(SETUP(rows));
      lite.exec(SETUP(rows));
      db.exec('ANALYZE');
      for (const q of queries()) {
        const got = norm(db.query(q).rows as unknown[][]);
        const want = norm(lite.selectArrays(q));
        expect(got, q).toEqual(want);
      }
    });
  }

  it('drops the conditions a seek uses and seeks on tiny tables', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec(SETUP(2));
    db.exec('ANALYZE');
    const plan = (q: string): string => db.query(`EXPLAIN QUERY PLAN ${q}`).rows.map((r) => r[3]).join('\n');
    expect(plan('SELECT v FROM t WHERE id = 5')).toBe('SEARCH t USING INTEGER PRIMARY KEY (rowid=?)');
    expect(plan('SELECT v FROM t WHERE id IN (1, 2)')).toBe('SEARCH t USING INTEGER PRIMARY KEY (rowid=?)');
  });
});
