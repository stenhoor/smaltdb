/**
 * Regression tests for client API, parameter and import/export bugs found while writing the user
 * docs. The client (src/client) runs in Node against an EngineServer through a fake Worker that
 * passes structured-cloned messages, as a real worker would.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as client from '../src/client/index.js';
import { Database } from '../src/engine/database.js';
import { SmaltError } from '../src/engine/errors.js';
import { importCSV, importJSON } from '../src/engine/io/import-export.js';
import { EngineServer } from '../src/engine/server.js';
import { OpfsVfs } from '../src/engine/vfs/opfs.js';
import type { Request, Response } from '../src/shared/protocol.js';
import { pause, until } from './helpers/wait.js';

/** A Worker stand-in: the engine server runs in this thread, messages are cloned and delivered on later ticks. */
class FakeWorker {
  onmessage: ((e: { data: Response }) => void) | null = null;
  onerror: unknown = null;
  private readonly server = new EngineServer((_session, msg) => setTimeout(() => this.onmessage?.({ data: structuredClone(msg) })), {
    open: () => Database.openMemory(),
    refreshTimer: false,
  });
  postMessage(req: Request): void {
    const r = structuredClone(req);
    setTimeout(() => this.server.receive(EngineServer.LOCAL, r));
  }
  terminate(): void {}
}
(globalThis as { Worker?: unknown }).Worker ??= FakeWorker;

const opened: client.Database[] = [];
async function openDb(): Promise<client.Database> {
  const db = await client.open(':memory:', { storage: 'memory', worker: new FakeWorker() as unknown as Worker });
  opened.push(db);
  return db;
}
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

/** A promise's state, for asserting that a call is still waiting. */
function track<T>(p: Promise<T>): { done: () => boolean; promise: Promise<T> } {
  let settled = false;
  const promise = p.finally(() => (settled = true));
  promise.catch(() => undefined);
  return { done: () => settled, promise };
}

/** A transaction whose callback inserts `value`, then waits for `release()` and throws. */
function heldTransaction(db: client.Database, value: number): { inserted: () => boolean; release: () => void; result: Promise<unknown> } {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let inserted = false;
  const result = db
    .transaction(async (tx) => {
      await tx.exec('INSERT INTO t VALUES (?)', [value]);
      inserted = true;
      await gate;
      throw new Error('callback failed');
    })
    .catch((e: Error) => e.message);
  return { inserted: () => inserted, release, result };
}

const codeOf = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => 'resolved',
    (e: { code?: string }) => e.code ?? String(e),
  );

describe('1. calls from outside a transaction callback do not join it', () => {
  it('PreparedStatement.run waits for the transaction instead of being rolled back with it', async () => {
    const db = await openDb();
    await db.exec('CREATE TABLE t(a INTEGER)');
    const stmt = await db.prepare('INSERT INTO t VALUES (99)');
    const held = heldTransaction(db, 50);
    await until('the insert in the transaction', held.inserted);
    const run = track(stmt.run());
    await pause();
    expect(run.done()).toBe(false); // waits for the transaction
    held.release();
    expect(await held.result).toBe('callback failed');
    expect(await run.promise).toMatchObject({ changes: 1 });
    expect(await db.query('SELECT a FROM t')).toEqual([{ a: 99 }]);
  });

  it('PreparedStatement.query and stream and db.stream wait too (they would read uncommitted rows)', async () => {
    const db = await openDb();
    await db.exec('CREATE TABLE t(a INTEGER)');
    const sel = await db.prepare('SELECT count(*) AS n FROM t');
    const held = heldTransaction(db, 50);
    await until('the insert in the transaction', held.inserted);
    const q = track(sel.query());
    const collect = async (it: AsyncIterableIterator<{ n: number }[]>): Promise<number[]> => {
      const out: number[] = [];
      for await (const batch of it) for (const r of batch) out.push(r.n);
      return out;
    };
    const s1 = track(collect(sel.stream<{ n: number }>()));
    const s2 = track(collect(db.stream<{ n: number }>('SELECT count(*) AS n FROM t')));
    await pause();
    expect([q.done(), s1.done(), s2.done()]).toEqual([false, false, false]);
    held.release();
    await held.result;
    expect(await q.promise).toEqual([{ n: 0 }]);
    expect(await s1.promise).toEqual([0]);
    expect(await s2.promise).toEqual([0]);
  });

  it('a stream closed before its transaction-delayed start sends nothing', async () => {
    const db = await openDb();
    await db.exec('CREATE TABLE t(a INTEGER)');
    const held = heldTransaction(db, 50);
    await until('the insert in the transaction', held.inserted);
    const it = db.stream('SELECT a FROM t');
    await it.return!();
    held.release();
    await held.result;
    expect(await it.next()).toEqual({ value: undefined, done: true });
    expect(await db.exec('INSERT INTO t VALUES (1)')).toMatchObject({ changes: 1 }); // no stream holds reads
  });

  it('tx.stream and tx.statement run inside the transaction', async () => {
    const db = await openDb();
    await db.exec('CREATE TABLE t(a INTEGER)');
    const insert = await db.prepare('INSERT INTO t VALUES (?)');
    const count = await db.prepare('SELECT count(*) AS n FROM t');
    const seen = await db.transaction(async (tx) => {
      const ins = tx.statement(insert);
      expect(ins.paramCount).toBe(1);
      for (const v of [1, 2, 3]) await ins.run([v]);
      const counted = await tx.statement(count).query<{ n: number }>();
      const streamed: number[] = [];
      for await (const batch of tx.stream<{ a: number }>('SELECT a FROM t ORDER BY a', undefined, { batchSize: 2 })) for (const r of batch) streamed.push(r.a);
      for await (const batch of tx.statement(count).stream<{ n: number }>()) streamed.push(batch[0].n);
      return { counted, streamed };
    });
    expect(seen).toEqual({ counted: [{ n: 3 }], streamed: [1, 2, 3, 3] });
    await expect(db.transaction(async (tx) => tx.statement(insert).run([4]).then(() => Promise.reject(new Error('undo'))))).rejects.toThrow('undo');
    expect(await db.query('SELECT count(*) AS n FROM t')).toEqual([{ n: 3 }]);
  });

  it('tx rejects with SMALT_MISUSE once the callback has finished', async () => {
    const db = await openDb();
    await db.exec('CREATE TABLE t(a INTEGER)');
    const stmt = await db.prepare('INSERT INTO t VALUES (7)');
    let leaked!: client.Transaction;
    await db.transaction(async (tx) => {
      leaked = tx;
    });
    expect(await codeOf(leaked.exec('INSERT INTO t VALUES (1)'))).toBe('SMALT_MISUSE');
    expect(await codeOf(leaked.query('SELECT 1'))).toBe('SMALT_MISUSE');
    expect(await codeOf(leaked.statement(stmt).run())).toBe('SMALT_MISUSE');
    expect(await codeOf(leaked.stream('SELECT 1').next())).toBe('SMALT_MISUSE');
    expect(await db.query('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }]);
  });
});

describe('2. db methods during a transaction callback', () => {
  it('a db.exec issued while the callback runs waits for the transaction and then runs on its own', async () => {
    // Called from inside the callback and awaited there, this call would never finish: the client
    // cannot tell such a call from one made elsewhere in the app (see docs/guide/transactions.md).
    const db = await openDb();
    await db.exec('CREATE TABLE t(a INTEGER)');
    const held = heldTransaction(db, 50);
    await until('the insert in the transaction', held.inserted);
    const outside = track(db.exec('INSERT INTO t VALUES (98)'));
    await pause();
    expect(outside.done()).toBe(false);
    held.release();
    await held.result;
    await outside.promise;
    expect(await db.query('SELECT a FROM t')).toEqual([{ a: 98 }]);
  });
});

describe('3. the callback ending the transaction itself', () => {
  it("tx.exec('COMMIT') keeps the work and the promise resolves", async () => {
    const db = await openDb();
    await db.exec('CREATE TABLE t(a INTEGER)');
    const r = await db.transaction(async (tx) => {
      await tx.exec('INSERT INTO t VALUES (2)');
      await tx.exec('COMMIT');
      return 'done';
    });
    expect(r).toBe('done');
    expect(await db.query('SELECT a FROM t')).toEqual([{ a: 2 }]);
    // The next transaction is not affected.
    await db.transaction((tx) => tx.exec('INSERT INTO t VALUES (3)'));
    expect(await db.query('SELECT count(*) AS n FROM t')).toEqual([{ n: 2 }]);
  });

  it("tx.exec('ROLLBACK') rejects the promise with SMALT_ERROR; nothing is committed", async () => {
    const db = await openDb();
    await db.exec('CREATE TABLE t(a INTEGER)');
    const p = db.transaction(async (tx) => {
      await tx.exec('INSERT INTO t VALUES (2)');
      await tx.exec('ROLLBACK');
      return 'done';
    });
    await expect(p).rejects.toMatchObject({ code: 'SMALT_ERROR', message: 'the transaction was rolled back inside the transaction callback' });
    expect(await db.query('SELECT count(*) AS n FROM t')).toEqual([{ n: 0 }]);
    expect(await db.transaction(async (tx) => (await tx.exec('INSERT INTO t VALUES (3)')).changes)).toBe(1);
  });

  it('a callback that commits and then throws rejects with its own error', async () => {
    const db = await openDb();
    await db.exec('CREATE TABLE t(a INTEGER)');
    const p = db.transaction(async (tx) => {
      await tx.exec('INSERT INTO t VALUES (2); COMMIT');
      throw new Error('after commit');
    });
    await expect(p).rejects.toThrow('after commit');
    expect(await db.query('SELECT count(*) AS n FROM t')).toEqual([{ n: 1 }]);
  });
});

describe('4. exec reports changes of its own INSERT, UPDATE or DELETE', () => {
  it('a SELECT reports 0 with and without parameters; a script reports its last DML statement', async () => {
    const db = await openDb();
    await db.exec('CREATE TABLE u(a)');
    expect((await db.exec('INSERT INTO u VALUES (1)')).changes).toBe(1);
    expect((await db.exec('SELECT * FROM u')).changes).toBe(0);
    expect((await db.exec('SELECT ?', [1])).changes).toBe(0);
    expect((await db.exec('INSERT INTO u VALUES (2), (3); SELECT * FROM u')).changes).toBe(2);
    expect((await db.exec('UPDATE u SET a = a + 1; DELETE FROM u WHERE a > 100')).changes).toBe(0);
    expect((await db.exec('CREATE TABLE v(b)')).changes).toBe(0);
  });
});

describe('5-7. parameter binding', () => {
  const d = (): Database => Database.openMemory();

  it('5. an object cannot bind ? slots: SMALT_RANGE instead of a silent NULL', async () => {
    expect(() => d().query('SELECT :a, ?', { a: 1 })).toThrow(expect.objectContaining({ code: 'SMALT_RANGE' }));
    expect(() => d().query('SELECT ?2', { a: 1 })).toThrow(/bind them with an array/);
    expect(d().query('SELECT :a, @a, $b', { a: 1, $b: 2 }).rows).toEqual([[1, 1, 2]]);
    expect(d().query('SELECT ?, ?', [1, 2]).rows).toEqual([[1, 2]]);
    const db = await openDb();
    expect(await codeOf(db.query('SELECT :a, ?', { a: 1 }))).toBe('SMALT_RANGE');
  });

  it('6. bigints outside 64 bits reject with SMALT_RANGE; NaN binds as NULL; ±Infinity as REAL', async () => {
    expect(() => d().query('SELECT typeof(?), ?', [2n ** 70n, 2n ** 70n])).toThrow(expect.objectContaining({ code: 'SMALT_RANGE', message: 'parameter ?1: integer 1180591620717411303424 is out of range (INTEGER values are 64-bit signed)' }));
    expect(() => d().query('SELECT :x', { x: 2n ** 63n })).toThrow(/parameter :x: integer 9223372036854775808 is out of range/);
    expect(() => d().query('SELECT ?', [-(2n ** 63n) - 1n])).toThrow(expect.objectContaining({ code: 'SMALT_RANGE' }));
    expect(d().query('SELECT typeof(?), ?, ?', [2n ** 63n - 1n, 2n ** 63n - 1n, -(2n ** 63n)]).rows).toEqual([['integer', 2n ** 63n - 1n, -(2n ** 63n)]]);
    expect(d().query('SELECT typeof(?), ? IS NULL', [NaN, NaN]).rows).toEqual([['null', 1]]);
    expect(d().query('SELECT typeof(?), ?, typeof(?), ?', [Infinity, Infinity, -Infinity, -Infinity]).rows).toEqual([['real', Infinity, 'real', -Infinity]]);
    const db = await openDb();
    expect(await codeOf(db.query('SELECT ?', [2n ** 70n]))).toBe('SMALT_RANGE');
    expect(await db.query('SELECT typeof(?) AS t', [NaN])).toEqual([{ t: 'null' }]);
    await db.exec('CREATE TABLE r(x REAL)');
    await db.exec('INSERT INTO r VALUES (?)', [NaN]);
    expect(await db.query('SELECT x FROM r')).toEqual([{ x: null }]);
  });

  it('7. booleans and undefined are accepted by the Params type and bind as 1, 0 and NULL', async () => {
    const db = await openDb();
    // No casts: these must type-check (tsc runs over the tests).
    const params: client.Params = [true, false, undefined];
    expect([...(await db.query('SELECT ?, ?, ?', params, { rowMode: 'array' }))]).toEqual([[1, 0, null]]);
    expect(await db.query('SELECT :on AS v', { on: true })).toEqual([{ v: 1 }]);
    const stmt = await db.prepare('SELECT ? AS v');
    expect(await stmt.query([false])).toEqual([{ v: 0 }]);
    expect(d().query('SELECT ?, :b', [true, undefined]).rows).toEqual([[1, null]]);
  });
});

describe('8. exec with parameters and several statements', () => {
  it('rejects with SMALT_MISUSE in the client, as in the engine', async () => {
    const msg = 'parameters can only be bound with a single statement';
    expect(() => Database.openMemory().exec('SELECT ?; SELECT 1', [1])).toThrow(expect.objectContaining({ code: 'SMALT_MISUSE', message: msg }));
    const db = await openDb();
    await expect(db.exec('SELECT ?; SELECT 1', [1])).rejects.toMatchObject({ code: 'SMALT_MISUSE', message: msg });
    // A real syntax error stays one.
    expect(await codeOf(db.exec('SELEC ?; SELECT 1', [1]))).toBe('SMALT_SYNTAX');
  });
});

describe('9-11. JSON and CSV import', () => {
  const d = (): Database => Database.openMemory();
  const tables = (db: Database): unknown[][] => db.query("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").rows;

  it('9. says which item is wrong', () => {
    expect(() => importJSON(d(), 'v', '[1, 2]', { create: true })).toThrow('JSON item 1: expected an object or an array, found a number (JSON import expects an array of objects or of arrays, or NDJSON lines of either)');
    expect(() => importJSON(d(), 'v', '[{"a": 1}, "x"]', { create: true })).toThrow('JSON item 2: expected an object or an array, found a string');
    expect(() => importJSON(d(), 'v', '[{"a": 1}, {"a": 2}, [3]]', { create: true })).toThrow('JSON item 3: expected an object like JSON item 1, found an array (all items must be objects or all arrays)');
    expect(() => importJSON(d(), 'v', '{"a": 1}\n[1]\n')).toThrow('NDJSON line 2: expected an object like NDJSON line 1, found an array');
  });

  // An integer column (inferred from 1) cannot store text beyond 64 bits: the second row fails after
  // the table was created.
  const BAD_JSON = '[{"x": 1}, {"x": "12345678901234567890"}]';
  const BAD_CSV = 'x\n1\n12345678901234567890\n';

  it('10. a failed import with create: true leaves no table behind (engine)', () => {
    const e = d();
    e.exec('CREATE TABLE keep(a)');
    expect(() => importJSON(e, 'j', BAD_JSON, { create: true })).toThrow('JSON item 2: cannot store TEXT value in INTEGER column j.x');
    expect(() => importCSV(e, 'c', BAD_CSV, { create: true })).toThrow('CSV line 3: cannot store TEXT value in INTEGER column c.x');
    expect(tables(e)).toEqual([['keep']]);
    // Inside an open transaction: the import's table and rows go; the transaction stays open with its work.
    e.exec('BEGIN; INSERT INTO keep VALUES (1)');
    expect(() => importJSON(e, 'j', BAD_JSON, { create: true })).toThrow(/^JSON item 2/);
    expect(() => importCSV(e, 'c', BAD_CSV, { create: true })).toThrow(/^CSV line 3/);
    expect(() => importJSON(e, 'keep', '[{"a": 2}, {"a": 3}, {"b": 4}]')).toThrow(/no column named b/);
    expect(() => importCSV(e, 'keep', 'a\n5\n6\n"7\n')).toThrow(/unterminated/);
    expect(e.inTransaction).toBe(true);
    e.exec('COMMIT');
    expect(tables(e)).toEqual([['keep']]);
    expect(e.query('SELECT a FROM keep').rows).toEqual([[1]]);
  });

  it('10. a failed import inside an open transaction keeps none of its rows', () => {
    const e = d();
    e.exec('CREATE TABLE t(a INTEGER NOT NULL)');
    e.exec('BEGIN');
    expect(() => importJSON(e, 't', '[[1], [2], [null]]')).toThrow(/^JSON item 3: /);
    e.exec('COMMIT');
    expect(e.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
  });

  it('10. a failed import with create: true leaves no table behind (client)', async () => {
    const db = await openDb();
    await expect(db.importJSON('j', BAD_JSON, { create: true })).rejects.toMatchObject({ code: 'SMALT_CONSTRAINT_DATATYPE' });
    await expect(db.importCSV('c', BAD_CSV, { create: true })).rejects.toMatchObject({ code: 'SMALT_CONSTRAINT_DATATYPE' });
    expect(await db.query("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'")).toEqual([{ n: 0 }]);
  });
  it('11. JSON integers beyond 2^53 keep their exact value; beyond 64 bits they are REAL, as in SQLite', async () => {
    const e = d();
    importJSON(e, 'w', '[{"x": 1234567890123456789, "y": "12345678901234567890", "z": 9007199254740993}, {"x": -9223372036854775808, "y": "a", "z": 1}]', { create: true });
    expect(e.query('SELECT x, typeof(x), y, z FROM w ORDER BY rowid').rows).toEqual([
      [1234567890123456789n, 'integer', '12345678901234567890', 9007199254740993n],
      [-9223372036854775808n, 'integer', 'a', 1],
    ]);
    importJSON(e, 'r', '[[12345678901234567890, 1.5e300], [1, 2]]', { create: true, columns: ['a', 'b'] });
    expect(e.query('SELECT typeof(a), a, typeof(b) FROM r ORDER BY rowid').rows).toEqual([
      ['real', 12345678901234567890, 'real'],
      ['real', 1, 'real'],
    ]);
    importJSON(e, 'n', '{"id": 18014398509481985, "doc": {"big": 18014398509481985, "s": "\\u00e9\\"", "__proto__": 1}}\n{"id": 2, "doc": [true, null]}\n', { create: true });
    expect(e.query('SELECT id, doc FROM n ORDER BY rowid').rows).toEqual([
      [18014398509481985n, '{"big":18014398509481985,"s":"é\\"","__proto__":1}'],
      [2, '[true,null]'],
    ]);
    // Invalid JSON is still reported by JSON.parse.
    expect(() => importJSON(e, 'n', '[{"id": 12345678901234567890,}]')).toThrow(/^invalid JSON: /);
    const db = await openDb();
    await db.importJSON('w', '[{"x": 1234567890123456789}]', { create: true });
    expect(await db.query('SELECT x FROM w')).toEqual([{ x: 1234567890123456789n }]);
  });
});

describe('12. OpfsVfs without OPFS', () => {
  it('rejects with SMALT_CANTOPEN', async () => {
    const err = await new OpfsVfs().open('x.db').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SmaltError);
    expect(err).toMatchObject({ code: 'SMALT_CANTOPEN', message: expect.stringMatching(/^cannot open x\.db: OPFS sync access handles are not available here/) });
    await expect(Database.open(new OpfsVfs(), 'x.db')).rejects.toMatchObject({ code: 'SMALT_CANTOPEN' });
  });
});
