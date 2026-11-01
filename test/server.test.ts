import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { EngineServer } from '../src/engine/server.js';
import type { Request, Response } from '../src/shared/protocol.js';
import { columnValue } from '../src/shared/protocol.js';

type Msg = { session: string; msg: Response };

/** A server over an in-memory database with a recording transport. */
function setup(interrupt?: SharedArrayBuffer) {
  const log: Msg[] = [];
  const watched: string[] = [];
  const server = new EngineServer((session, msg) => log.push({ session, msg }), {
    open: () => Database.openMemory(),
    watchSession: (s) => watched.push(s),
  });
  let id = 1;
  const send = (session: string, body: Record<string, unknown>): number => {
    const rid = id++;
    server.receive(session, { ...body, id: rid } as Request);
    return rid;
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));
  const of = (session: string, rid: number) => log.filter((m) => m.session === session && m.msg.id === rid).map((m) => m.msg);
  const done = (session: string, rid: number) => of(session, rid).some((m) => m.kind === 'ok' || m.kind === 'done' || m.kind === 'error');
  const rows = (session: string, rid: number): unknown[][] => {
    const out: unknown[][] = [];
    for (const m of of(session, rid)) {
      if (m.kind !== 'batch') continue;
      for (let i = 0; i < m.length; i++) out.push(m.cols.map((c) => columnValue(c, i)));
    }
    return out;
  };
  send(EngineServer.LOCAL, { op: 'open', name: ':memory:', storage: 'memory', interrupt });
  return { server, log, watched, send, settle, of, done, rows };
}

describe('EngineServer', () => {
  it('serves queries and statements from several sessions', async () => {
    const t = setup();
    t.send('local', { op: 'exec', sql: 'CREATE TABLE t(a INT); INSERT INTO t VALUES (1), (2), (3)' });
    const q = t.send('tab-b', { op: 'query', sql: 'SELECT sum(a) FROM t' });
    await t.settle();
    expect(t.rows('tab-b', q)).toEqual([[6]]);
    const p = t.send('tab-b', { op: 'prepare', sql: 'SELECT a FROM t WHERE a = ?' });
    await t.settle();
    const stmt = (t.of('tab-b', p)[0] as { stmt: number }).stmt;
    const sq = t.send('tab-b', { op: 'stmtQuery', stmt, params: [2] });
    await t.settle();
    expect(t.rows('tab-b', sq)).toEqual([[2]]);
  });

  it('streams with credits and pauses without them', async () => {
    const t = setup();
    t.send('local', { op: 'exec', sql: 'CREATE TABLE t(a INT); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100) INSERT INTO t SELECT i FROM n' });
    const q = t.send('local', { op: 'query', sql: 'SELECT a FROM t', batchSize: 10, credit: 2 });
    await t.settle();
    expect(t.rows('local', q).length).toBe(20);
    expect(t.done('local', q)).toBe(false);
    t.server.receive('local', { id: 0, op: 'credit', target: q, n: 100 });
    await t.settle();
    expect(t.rows('local', q).length).toBe(100);
    expect(t.done('local', q)).toBe(true);
  });

  it("makes another session's write wait for an open stream, and fails the stream owner's own write", async () => {
    const t = setup();
    t.send('local', { op: 'exec', sql: 'CREATE TABLE t(a INT); INSERT INTO t VALUES (1), (2), (3), (4)' });
    const q = t.send('tab-a', { op: 'query', sql: 'SELECT a FROM t', batchSize: 1, credit: 1 });
    await t.settle();
    const own = t.send('tab-a', { op: 'exec', sql: 'INSERT INTO t VALUES (5)' });
    const other = t.send('tab-b', { op: 'exec', sql: 'INSERT INTO t VALUES (6)' });
    const read = t.send('tab-c', { op: 'query', sql: 'SELECT count(*) FROM t' });
    await t.settle();
    expect(t.of('tab-a', own)[0]).toMatchObject({ kind: 'error', code: 'SMALT_BUSY' });
    expect(t.done('tab-b', other)).toBe(false); // waits for the stream
    expect(t.rows('tab-c', read)).toEqual([[4]]); // reads proceed
    t.server.receive('tab-a', { id: 0, op: 'cancel', target: q });
    await t.settle();
    expect(t.of('tab-a', q).at(-1)).toMatchObject({ kind: 'error', code: 'SMALT_INTERRUPT' });
    expect(t.of('tab-b', other)[0]).toMatchObject({ kind: 'ok', changes: 1 });
  });

  it("isolates a session's transaction from other sessions", async () => {
    const t = setup();
    t.send('local', { op: 'exec', sql: 'CREATE TABLE t(a INT)' });
    t.send('tab-a', { op: 'exec', sql: 'BEGIN; INSERT INTO t VALUES (1)' });
    const readB = t.send('tab-b', { op: 'query', sql: 'SELECT count(*) FROM t' });
    await t.settle();
    expect(t.done('tab-b', readB)).toBe(false); // waits: it would see uncommitted rows
    expect(t.watched).toContain('tab-a');
    t.send('tab-a', { op: 'exec', sql: 'INSERT INTO t VALUES (2); COMMIT' });
    await t.settle();
    expect(t.rows('tab-b', readB)).toEqual([[2]]);
  });

  it('rolls back the transaction of a session that disappears', async () => {
    const t = setup();
    t.send('local', { op: 'exec', sql: 'CREATE TABLE t(a INT)' });
    t.send('tab-a', { op: 'exec', sql: 'BEGIN; INSERT INTO t VALUES (1)' });
    const readB = t.send('tab-b', { op: 'query', sql: 'SELECT count(*) FROM t' });
    await t.settle();
    t.server.sessionGone('tab-a');
    await t.settle();
    expect(t.rows('tab-b', readB)).toEqual([[0]]);
    expect(t.server.db!.inTransaction).toBe(false);
  });

  it('cancels queued requests and interrupts a running statement through the flag', async () => {
    const sab = new SharedArrayBuffer(4);
    const flag = new Int32Array(sab);
    const t = setup(sab);
    t.send('local', { op: 'exec', sql: 'CREATE TABLE t(a INT, b TEXT); WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 50000) INSERT INTO t SELECT i, hex(randomblob(20)) FROM n' });
    await t.settle();
    // Queue a request behind another session's transaction, then cancel it while it waits.
    t.send('tab-a', { op: 'exec', sql: 'BEGIN' });
    const queued = t.send('local', { op: 'query', sql: 'SELECT 1' });
    t.server.receive('local', { id: 0, op: 'cancel', target: queued });
    t.send('tab-a', { op: 'exec', sql: 'COMMIT' });
    await t.settle();
    expect(t.of('local', queued)).toEqual([{ id: queued, kind: 'error', code: 'SMALT_INTERRUPT', message: 'interrupted' }]);
    // A long statement whose id is in the flag stops part-way, and its writes roll back.
    const nextId = queued + 2; // after the COMMIT request
    Atomics.store(flag, 0, nextId);
    const long = t.send('local', { op: 'exec', sql: 'UPDATE t SET b = b || b' });
    expect(long).toBe(nextId);
    await t.settle();
    expect(t.of('local', long)[0]).toMatchObject({ kind: 'error', code: 'SMALT_INTERRUPT' });
    expect(Atomics.load(flag, 0)).toBe(0);
    const check = t.send('local', { op: 'query', sql: 'SELECT max(length(b)) FROM t' });
    await t.settle();
    expect(t.rows('local', check)).toEqual([[40]]);
  });

  it('lets another tab join and detach without closing the database', async () => {
    const t = setup();
    const join = t.send('tab-b', { op: 'open', name: 'x', storage: 'memory' });
    const close = t.send('tab-b', { op: 'close' });
    const q = t.send('local', { op: 'query', sql: 'SELECT 1' });
    await t.settle();
    expect(t.of('tab-b', join)[0].kind).toBe('ok');
    expect(t.of('tab-b', close)[0].kind).toBe('ok');
    expect(t.rows('local', q)).toEqual([[1]]);
  });
});
