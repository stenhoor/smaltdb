/**
 * Infinite REALs (from overflow such as 1e308 * 10) vs SQLite (official WASM build): sum, total and avg leave the
 * compensation term out when it is not finite (a NaN sum, Inf + -Inf, is NULL), and quote() writes 9.0e+999.
 */
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';

type Sqlite = { selectArrays(sql: string): unknown[][] };
let lite: Sqlite;

beforeAll(async () => {
  const sqlite3 = (await (sqliteInit as unknown as (o: object) => Promise<unknown>)({ print: () => {}, printErr: () => {} })) as { oo1: { DB: new (n: string) => Sqlite } };
  lite = new sqlite3.oo1.DB(':memory:');
});

const show = (rows: unknown[][]): string => JSON.stringify(rows, (_k, v) => (typeof v === 'number' ? String(v) : v));

function same(sql: string): void {
  expect(show(Database.openMemory().query(sql).rows), sql).toBe(show(lite.selectArrays(sql)));
}

describe('infinite values', () => {
  it('sum, total and avg', () => {
    for (const vals of ['(1e308 * 10), (1.0), (2.5)', '(1e308 * 10), (-1e308 * 10)', '(1.0), (-1e308 * 10)', '(1e308), (1e308)', '(1e308 * 10), (NULL)']) {
      same(`SELECT sum(x), total(x), avg(x), typeof(sum(x)) FROM (SELECT column1 AS x FROM (VALUES ${vals}))`);
    }
  });

  it('as a window aggregate and per group', () => {
    same('SELECT g, sum(x) FROM (SELECT column1 AS g, column2 AS x FROM (VALUES (1, 1e308 * 10), (1, 1.0), (2, -1e308 * 10), (2, 1e308 * 10), (3, 2.0))) GROUP BY g ORDER BY g');
    // A whole-partition window. (In a sliding frame SQLite's inverse step leaves NaN behind once the infinite row has
    // left the frame, giving NULL; smaltdb gives the sum of the rows still in the frame.)
    same('SELECT k, sum(x) OVER (PARTITION BY k > 2) FROM (SELECT column1 AS k, column2 AS x FROM (VALUES (1, 1.0), (2, 1e308 * 10), (3, 2.0), (4, 3.0))) ORDER BY k');
  });

  it('quote, CAST and printf', () => {
    same("SELECT quote(1e308 * 10), quote(-1e308 * 10), CAST(1e308 * 10 AS TEXT), printf('%f', -1e308 * 10), 9.0e+999 = 1e308 * 10");
  });
});
