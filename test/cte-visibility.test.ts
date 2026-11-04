/**
 * Which names a non-recursive CTE's body sees: the CTEs before it in its WITH clause and the enclosing query's,
 * not itself (its own name means the table) — compared with SQLite.
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

const DDL = 'CREATE TABLE t(x INT); INSERT INTO t VALUES (1), (2), (3); CREATE TABLE b(y INT); INSERT INTO b VALUES (10);';
const QUERIES = [
  'WITH t AS (SELECT * FROM t WHERE x > 1) SELECT count(*) FROM t',
  'WITH t AS (SELECT x * 10 AS x FROM t) SELECT x FROM t ORDER BY x',
  'WITH a AS (SELECT 1 AS x), c AS (SELECT x + 1 AS y FROM a) SELECT * FROM c',
  'WITH a AS (SELECT * FROM b), b AS (SELECT 1 AS y) SELECT * FROM a',
  'WITH b AS (SELECT y + 1 AS y FROM b) SELECT (SELECT y FROM b), (WITH b AS (SELECT 5 AS y) SELECT y FROM b)',
  'WITH t AS (SELECT x FROM t WHERE x < 3) SELECT x, (SELECT count(*) FROM t AS u WHERE u.x <= t.x) FROM t ORDER BY x',
  'SELECT (WITH t AS (SELECT * FROM t) SELECT count(*) FROM t)',
];

describe('CTE visibility', () => {
  it('matches SQLite', async () => {
    const lite = new sqlite3.oo1.DB(':memory:');
    lite.exec(DDL);
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec(DDL);
    const run = (f: () => unknown[][]): unknown => {
      try {
        return f();
      } catch (e) {
        return `error: ${(e as Error).message.replace(/^.*result code 1: /, '')}`;
      }
    };
    const diffs: string[] = [];
    for (const q of QUERIES) {
      const got = JSON.stringify(run(() => db.query(q).rows as unknown[][]));
      const want = JSON.stringify(run(() => lite.selectArrays(q)));
      if (got !== want) diffs.push(`${q}\n  smaltdb ${got}\n  sqlite  ${want}`);
    }
    expect(diffs.join('\n')).toBe('');
  });
});
