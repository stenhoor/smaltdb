/**
 * Window functions against SQLite (official WASM build 3.54) over every frame shape the evaluator treats differently:
 * growing frames, sliding ROWS frames (the running state that removes rows: count, sum, total, avg, min, max, and the
 * statistics), RANGE frames with offsets (binary-searched bounds), GROUPS frames, exclusions (recomputed frames),
 * navigation functions at the frame edges, with and without partitions, ascending and descending, on data with NULLs,
 * duplicates and FILTER. Values are multiples of 1/4 so every sum is exact in both engines.
 */
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { rng } from './helpers.js';

type Sqlite = { exec(sql: string): void; selectArrays(sql: string): unknown[][] };
let lite: Sqlite;
let db: Database;

beforeAll(async () => {
  const s3 = await (sqliteInit as unknown as (o: object) => Promise<{ oo1: { DB: new (n: string) => Sqlite } }>)({ print: () => {}, printErr: () => {} });
  lite = new s3.oo1.DB(':memory:');
  const r = rng(2026);
  const rows: string[] = [];
  for (let i = 1; i <= 400; i++) {
    const x = r() < 0.1 ? 'NULL' : String(Math.floor(r() * 80 - 30) / 4);
    const k = r() < 0.05 ? 'NULL' : String(Math.floor(r() * 30));
    const t = r() < 0.1 ? 'NULL' : `'${'abcde'[Math.floor(r() * 5)]}'`;
    rows.push(`(${i}, ${Math.floor(r() * 4)}, ${k}, ${x}, ${t})`);
  }
  const ddl = 'CREATE TABLE t(id INTEGER PRIMARY KEY, g INTEGER, k INTEGER, x REAL, s TEXT)';
  lite.exec(`${ddl} STRICT; INSERT INTO t VALUES ${rows.join(', ')}`);
  db = Database.openMemory();
  db.exec(`${ddl}; INSERT INTO t VALUES ${rows.join(', ')}`);
});

const FRAMES = [
  '',
  'ROWS UNBOUNDED PRECEDING',
  'ROWS 7 PRECEDING',
  'ROWS BETWEEN 3 PRECEDING AND 5 FOLLOWING',
  'ROWS BETWEEN 2 FOLLOWING AND 9 FOLLOWING',
  'ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING',
  'RANGE BETWEEN 3 PRECEDING AND 2 FOLLOWING',
  'RANGE BETWEEN 5 PRECEDING AND CURRENT ROW',
  'GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING',
  'ROWS BETWEEN 4 PRECEDING AND 4 FOLLOWING EXCLUDE CURRENT ROW',
  'RANGE BETWEEN 2 PRECEDING AND 2 FOLLOWING EXCLUDE TIES',
  'GROUPS BETWEEN 2 PRECEDING AND CURRENT ROW EXCLUDE GROUP',
  'ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING',
];
const FUNCS = [
  'count(*)',
  'count(x)',
  'sum(x)',
  'total(x)',
  'avg(x)',
  'min(x)',
  'max(x)',
  'min(s)',
  'max(s)',
  'sum(x) FILTER (WHERE g > 0)',
  'max(x) FILTER (WHERE g <> 1)',
  'group_concat(s)',
  'first_value(x)',
  'last_value(x)',
  'nth_value(x, 3)',
  'median(x)',
  'percentile_disc(x, 0.75)',
];

function compare(sqls: string[]): void {
  const bad: string[] = [];
  for (const sql of sqls) {
    const want = JSON.stringify(lite.selectArrays(sql));
    const got = JSON.stringify(db.query(sql).rows);
    if (want !== got) bad.push(sql);
  }
  expect(bad).toEqual([]);
}

describe('window frames match SQLite', () => {
  for (const [part, order] of [
    ['', 'k, id'],
    ['PARTITION BY g ', 'k, id'],
    ['PARTITION BY g ', 'k DESC, id'],
  ] as const) {
    it(`aggregates and navigation, ${part || 'no partition, '}ORDER BY ${order}`, () => {
      const sqls: string[] = [];
      for (const frame of FRAMES) {
        // RANGE with offsets needs exactly one ORDER BY term.
        const ob = frame.startsWith('RANGE') ? order.split(',')[0] : order;
        for (const f of FUNCS) sqls.push(`SELECT id, ${f} OVER (${part}ORDER BY ${ob} ${frame}) FROM t ORDER BY id`);
      }
      compare(sqls);
    });
  }

  it('ranking and lag/lead, with and without partitions, in sorted and unsorted input', () => {
    const sqls: string[] = [];
    for (const over of ['ORDER BY id', 'ORDER BY x', 'PARTITION BY g ORDER BY x DESC', 'PARTITION BY k ORDER BY s, id', 'ORDER BY s DESC NULLS LAST']) {
      for (const f of ['row_number()', 'rank()', 'dense_rank()', 'percent_rank()', 'cume_dist()', 'ntile(7)', 'lag(x)', 'lead(x, 2, -1)', 'lag(s, 3)']) {
        sqls.push(`SELECT id, ${f} OVER (${over}) FROM t ORDER BY id`);
      }
    }
    compare(sqls);
  });

  it('sliding sums stay exact when large values leave the frame', () => {
    const big = [1e15, -1e15 + 0.25, 0.5, 0.75, 1e300, 1, 2, 3, 4, 5, 6, 7];
    lite.exec(`DROP TABLE IF EXISTS b; CREATE TABLE b(id INTEGER PRIMARY KEY, x REAL); INSERT INTO b(x) VALUES ${big.map((x) => `(${x})`).join(', ')}`);
    db.exec(`DROP TABLE IF EXISTS b; CREATE TABLE b(id INTEGER PRIMARY KEY, x REAL); INSERT INTO b(x) VALUES ${big.map((x) => `(${x})`).join(', ')}`);
    const got = db.query('SELECT sum(x) OVER (ORDER BY id ROWS 1 PRECEDING) FROM b ORDER BY id').rows.map((r) => r[0]);
    // The exact sums of each two-row frame (SQLite's running sum may differ in the last places here).
    const want = big.map((x, i) => (i === 0 ? x : big[i - 1] + x));
    expect(got).toEqual(want);
  });
});
