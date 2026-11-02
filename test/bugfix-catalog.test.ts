/**
 * Regression tests for catalog, DDL and external-table bugs found while writing the user docs.
 * Expected values were checked against SQLite (@sqlite.org/sqlite-wasm) where SQLite has the feature.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const mem = (): Database => Database.openFile(new MemoryVfs().openSync('t.db'));

const errorOf = async (p: Promise<unknown> | (() => unknown)): Promise<{ code: string; message: string }> => {
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (e) {
    return { code: (e as { code: string }).code, message: (e as Error).message };
  }
  throw new Error('expected an error');
};

describe('INSERT ... DEFAULT VALUES', () => {
  it('stores every column default and assigns the rowid', () => {
    const d = mem();
    d.exec('CREATE TABLE a(x INTEGER DEFAULT 3); INSERT INTO a DEFAULT VALUES');
    expect(d.query('SELECT rowid, x FROM a').rows).toEqual([[1, 3]]);
    expect(d.query('INSERT INTO a DEFAULT VALUES RETURNING *, rowid').rows).toEqual([[3, 2]]);
    d.exec("CREATE TABLE b(id INTEGER PRIMARY KEY, y DEFAULT 'q')");
    expect(d.query('INSERT INTO b DEFAULT VALUES RETURNING *').rows).toEqual([[1, 'q']]);
    expect(d.query('INSERT INTO b DEFAULT VALUES RETURNING *').rows).toEqual([[2, 'q']]);
  });

  it('honours OR conflict clauses and NOT NULL; rejects a column list and upsert like SQLite', async () => {
    const d = mem();
    d.exec('CREATE TABLE c(x UNIQUE DEFAULT 1); INSERT INTO c DEFAULT VALUES; INSERT OR IGNORE INTO c DEFAULT VALUES');
    expect(d.query('INSERT OR REPLACE INTO c DEFAULT VALUES RETURNING rowid').rows).toEqual([[2]]);
    expect(d.query('SELECT rowid, x FROM c').rows).toEqual([[2, 1]]);
    expect(await errorOf(() => d.exec('INSERT INTO c(x) DEFAULT VALUES'))).toEqual({ code: 'SMALT_ERROR', message: '0 values for 1 columns' });
    expect((await errorOf(() => d.exec('INSERT INTO c DEFAULT VALUES ON CONFLICT DO NOTHING'))).message).toMatch(/^near "ON": syntax error/);
    d.exec('CREATE TABLE n(x NOT NULL)');
    expect(await errorOf(() => d.exec('INSERT INTO n DEFAULT VALUES'))).toEqual({ code: 'SMALT_CONSTRAINT_NOTNULL', message: 'NOT NULL constraint failed: n.x' });
  });
});
