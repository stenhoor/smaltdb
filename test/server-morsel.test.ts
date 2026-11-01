import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { EngineServer, type PartialTask, type ReaderPool } from '../src/engine/server.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { Request, Response } from '../src/shared/protocol.js';
import { columnValue } from '../src/shared/protocol.js';
import type { SqlValue } from '../src/engine/values.js';

/** In-process stand-ins for reader workers: snapshot readers answering after a delay. */
class FakeReaders implements ReaderPool {
  busy = 0;
  ran = 0;
  failNext = false;
  constructor(
    private readonly readers: Database[],
    private readonly delay = 5,
  ) {}
  dispatch(): boolean {
    return false;
  }
  forward(): boolean {
    return false;
  }
  idle(): number {
    return this.readers.length - this.busy;
  }
  partial(task: PartialTask, done: (err: string | null, rows: SqlValue[][] | null) => void): boolean {
    if (this.busy >= this.readers.length) return false;
    const r = this.readers[this.busy++];
    const fail = this.failNext;
    this.failNext = false;
    setTimeout(() => {
      this.busy--;
      this.ran++;
      if (fail) return done('reader failed', null);
      try {
        r.refreshSnapshot();
        done(null, r.runPartial(task.sql, task.params as never, task.lo, task.hi));
      } catch (e) {
        done(String(e), null);
      }
    }, this.delay);
    return true;
  }
}

async function setup() {
  const vfs = new MemoryVfs();
  const db = await Database.open(vfs, 'db', { sharedHandles: true, walAutoCheckpointBytes: 1 << 30 });
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, x REAL)');
  db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250000) INSERT INTO t SELECT i, i % 10, i / 2.0 FROM n');
  const readers = new FakeReaders(await Promise.all([1, 2, 3].map(() => Database.openReader(vfs, 'db'))));
  const log: { session: string; msg: Response }[] = [];
  const server = new EngineServer((session, msg) => log.push({ session, msg }), { open: () => db, readers });
  let id = 1;
  const send = (session: string, body: Record<string, unknown>): number => {
    const rid = id++;
    server.receive(session, { ...body, id: rid } as Request);
    return rid;
  };
  const settle = () => new Promise((r) => setTimeout(r, 60));
  const of = (session: string, rid: number) => log.filter((m) => m.session === session && m.msg.id === rid).map((m) => m.msg);
  const rows = (session: string, rid: number): unknown[][] => {
    const out: unknown[][] = [];
    for (const m of of(session, rid)) {
      if (m.kind !== 'batch') continue;
      for (let i = 0; i < m.length; i++) out.push(m.cols.map((c) => columnValue(c, i)));
    }
    return out;
  };
  send(EngineServer.LOCAL, { op: 'open', name: 'db', storage: 'opfs' });
  await settle();
  return { db, server, readers, send, settle, of, rows };
}

/**
 * Wait until `done()` holds (polling): server responses arrive after reader callbacks and
 * scheduling ticks, whose timing varies with machine load (fixed sleeps flaked on CI).
 */
async function until(what: string, done: () => boolean, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const SQL = 'SELECT g, count(*), sum(x), avg(x) FROM t GROUP BY g ORDER BY g';

const ended = (t: { of: (s: string, id: number) => { kind: string }[] }, session: string, id: number) => t.of(session, id).some((m) => m.kind === 'done' || m.kind === 'error' || m.kind === 'ok');

describe('morsel parallelism in the server', () => {
  it('splits a large aggregate across idle readers and merges it', async () => {
    const t = await setup();
    const want = t.db.query(SQL).rows;
    const q = t.send('local', { op: 'query', sql: SQL });
    await until('the morsel query', () => ended(t, 'local', q));
    expect(t.rows('local', q)).toEqual(want);
    expect(t.server.morselQueries).toBe(1);
    expect(t.readers.ran).toBe(3);
    // Small or unsuitable queries run on the owner.
    const s = t.send('local', { op: 'query', sql: 'SELECT count(DISTINCT g) FROM t' });
    await until('the owner query', () => ended(t, 'local', s));
    expect(t.rows('local', s)).toEqual([[10]]);
    expect(t.server.morselQueries).toBe(1);
  });

  it('holds writes until every morsel is back, so all see one commit', async () => {
    const t = await setup();
    const q = t.send('local', { op: 'query', sql: 'SELECT count(*), sum(g) FROM t' });
    const w = t.send('tab-b', { op: 'exec', sql: 'UPDATE t SET g = g + 1' });
    await until('the query and the write', () => ended(t, 'local', q) && ended(t, 'tab-b', w));
    expect(t.rows('local', q)).toEqual([[250000, 1125000]]);
    expect(t.of('tab-b', w).some((m) => m.kind === 'ok')).toBe(true);
    expect(t.db.query('SELECT sum(g) FROM t').rows).toEqual([[1375000]]);
  });

  it('answers on the owner when a reader fails, and honors cancel', async () => {
    const t = await setup();
    t.readers.failNext = true;
    const q = t.send('local', { op: 'query', sql: SQL });
    await until('the fallback query', () => ended(t, 'local', q));
    expect(t.rows('local', q)).toEqual(t.db.query(SQL).rows);
    expect(t.server.morselQueries).toBe(0);
    const c = t.send('local', { op: 'query', sql: SQL });
    t.server.receive('local', { id: 0, op: 'cancel', target: c });
    await until('the cancelled query', () => ended(t, 'local', c));
    await new Promise((r) => setTimeout(r, 50)); // its late partials must not answer it again
    expect(t.of('local', c).map((m) => m.kind)).toEqual(['error']);
  });
});
