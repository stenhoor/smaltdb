/**
 * DDL as language-neutral definitions (ADR 0015 step 6c, plan/schema.ts): CHECK, DEFAULT and index expressions are
 * plan expressions with their text; CHECKs are bound at CREATE TABLE and DEFAULT functions when used, as in SQLite.
 */
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import type { BindContext } from '../src/engine/plan/bind-context.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

type Lite = { exec(s: string): void };
let lite: () => Lite;
beforeAll(async () => {
  const s3 = await (sqliteInit as unknown as (o: object) => Promise<{ oo1: { DB: new (n: string) => Lite } }>)({ print() {}, printErr() {} });
  lite = () => new s3.oo1.DB(':memory:');
});

/** The error each statement raises, or 'ok'. */
function outcomes(run: (q: string) => void, qs: string[]): string[] {
  return qs.map((q) => {
    try {
      run(q);
      return 'ok';
    } catch (e) {
      return (e as Error).message.replace(/^SQLITE_ERROR: sqlite3 result code 1: /, '');
    }
  });
}

describe('schema definitions', () => {
  it('bind CHECKs at CREATE TABLE and DEFAULT functions when used, as SQLite does', async () => {
    const qs = [
      'CREATE TABLE t1(a CHECK (b > 0))',
      'CREATE TABLE t3(a CHECK (nofn(a)))',
      'CREATE TABLE t2(a, b DEFAULT (nofn(1)))',
      'INSERT INTO t2(a) VALUES (1)',
      'CREATE TABLE t4(a CHECK (a > 0), b DEFAULT (upper(\'x\')))',
      'INSERT INTO t4(a) VALUES (0)',
    ];
    const db = await Database.open(new MemoryVfs(), 'db');
    const sqliteDb = lite();
    const got = outcomes((q) => db.exec(q), qs);
    const want = outcomes((q) => sqliteDb.exec(q), qs);
    expect(got.map((g) => g !== 'ok')).toEqual(want.map((w) => w !== 'ok'));
    expect(got.slice(0, 2)).toEqual(['no such column: b', 'no such function: nofn']);
  });

  it('keep expressions as plan expressions with their text', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, a INT CHECK (a >= 0), b TEXT DEFAULT ('x' || 'y'), CONSTRAINT pos CHECK (length(b) < 9))");
    db.exec('CREATE INDEX ta ON t(a * 2) WHERE b IS NOT NULL');
    const t = db.getTable('t')!;
    expect(t.checks.map((c) => [c.name, c.text, c.expr?.k])).toEqual([[undefined, 'a >= 0', 'call'], ['pos', 'length(b) < 9', 'call']]);
    expect(t.columns[2].default).toMatchObject({ text: "'x' || 'y'", expr: { k: 'call' }, value: null });
    const idx = t.indexes.find((i) => i.name === 'ta')!;
    expect(idx.columns[0].expr).toMatchObject({ text: 'a * 2', expr: { k: 'call', fn: 'sql.mul' } });
    expect(idx.where).toMatchObject({ text: 'b IS NOT NULL', expr: { k: 'isNull' } });
    expect(db.query("PRAGMA table_info(t)").rows.map((r) => r[4])).toEqual([null, null, "'x' || 'y'"]);
  });
});
