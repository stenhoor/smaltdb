/**
 * Join conditions that read a source after the one they join: an inner join's condition applies once that source is
 * joined (SQLite treats it as part of the WHERE); an outer join's is an error ("ON clause references tables to its
 * right"). Compared with SQLite.
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

const DDL = 'CREATE TABLE a(x INT); CREATE TABLE b(x INT); CREATE TABLE c(x INT); INSERT INTO a VALUES (1), (2), (NULL); INSERT INTO b VALUES (1), (2); INSERT INTO c VALUES (1), (3), (NULL);';
const QUERIES = [
  'SELECT a.x, b.x, c.x FROM a JOIN b ON c.x = a.x JOIN c ON 1 ORDER BY 1, 2, 3',
  'SELECT a.x, b.x, c.x FROM a JOIN b ON c.x = a.x AND b.x = a.x JOIN c ORDER BY 1, 2, 3',
  'SELECT a.x, b.x, c.x FROM a JOIN b ON c.x = b.x LEFT JOIN c ON 1 ORDER BY 1, 2, 3',
  'SELECT a.x, b.x, c.x FROM a JOIN b ON c.x = b.x LEFT JOIN c ON c.x = a.x ORDER BY 1, 2, 3',
  'SELECT count(*) FROM a JOIN b ON c.x > a.x JOIN c WHERE b.x = 1',
  'SELECT a.x, b.x, c.x FROM a LEFT JOIN b ON c.x = a.x JOIN c ON 1 ORDER BY 1, 2, 3',
  'SELECT a.x, b.x, c.x FROM a JOIN b ON 1 RIGHT JOIN c ON c.x = b.x ORDER BY 1, 2, 3',
];

describe('join conditions reading later sources', () => {
  it('give the rows or the error SQLite gives', async () => {
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
    for (const q of QUERIES) expect(run(() => db.query(q).rows as unknown[][]), q).toEqual(run(() => lite.selectArrays(q)));
  });
});
