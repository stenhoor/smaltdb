/**
 * PRAGMA settings reach parallel readers (docs/research/m7-code-review.md, follow-up features): a reader is a
 * separate connection, so the owner sends its settings (work_mem, matview_rewrite) with every query
 * and morsel it hands over, and the reader applies them before running it.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { EngineServer, type PartialTask, type ReaderPool } from '../src/engine/server.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { ReaderSettings, Request, Response } from '../src/shared/protocol.js';
import type { SqlValue } from '../src/engine/values.js';
import { until } from './helpers/wait.js';

const one = (db: Database, sql: string): SqlValue => db.query(sql).rows[0][0];

describe('reader settings on the database', () => {
  it('reflect the PRAGMAs and apply to another connection', async () => {
    const vfs = new MemoryVfs();
    const owner = await Database.open(vfs, 'db', { sharedHandles: true });
    owner.exec('CREATE TABLE t(g INT, x INT); INSERT INTO t VALUES (1, 10), (1, 20), (2, 5)');
    owner.exec('CREATE MATERIALIZED VIEW mv AS SELECT g, sum(x) AS s FROM t GROUP BY g');
    const reader = await Database.openReader(vfs, 'db');
    expect(owner.readerSettings).toEqual({ workMem: 256 * 1024 * 1024, matviewRewrite: false });

    owner.exec('PRAGMA work_mem = 12345; PRAGMA matview_rewrite = on');
    expect(owner.readerSettings).toEqual({ workMem: 12345, matviewRewrite: true });

    const q = reader.prepare('EXPLAIN QUERY PLAN SELECT g, sum(x) FROM t GROUP BY g');
    expect(JSON.stringify(q.all())).not.toContain('mv');
    reader.refreshSnapshot();
    reader.applyReaderSettings(owner.readerSettings);
    expect(one(reader, 'PRAGMA work_mem')).toBe(12345);
    expect(one(reader, 'PRAGMA matview_rewrite')).toBe(1);
    // A statement prepared under the old setting is re-planned.
    expect(JSON.stringify(q.all())).toContain('mv');

    owner.exec('PRAGMA matview_rewrite = off');
    reader.applyReaderSettings(owner.readerSettings);
    expect(JSON.stringify(q.all())).not.toContain('mv');
  });
});

/** In-process stand-ins for reader workers that apply the settings they are sent, as worker.ts does. */
class SettingReaders implements ReaderPool {
  dispatched: { sql: string; settings: ReaderSettings }[] = [];
  partials: ReaderSettings[] = [];
  private busy = 0;
  constructor(private readonly readers: Database[]) {}
  dispatch(_session: string, req: Extract<Request, { op: 'query' }>, settings: ReaderSettings): boolean {
    this.dispatched.push({ sql: req.sql, settings });
    return false; // the owner answers it; only the hand-over is checked
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
    this.partials.push(task.settings);
    queueMicrotask(() => {
      this.busy--;
      try {
        r.refreshSnapshot();
        r.applyReaderSettings(task.settings);
        done(null, r.runPartial(task.sql, task.params as never, task.lo, task.hi));
      } catch (e) {
        done(String(e), null);
      }
    });
    return true;
  }
}

async function setup(rows: number) {
  const vfs = new MemoryVfs();
  const db = await Database.open(vfs, 'db', { sharedHandles: true, walAutoCheckpointBytes: 1 << 30 });
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, x REAL)');
  db.exec(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows}) INSERT INTO t SELECT i, i % 5000, i / 2.0 FROM n`);
  // Like worker.ts: each reader has its own scratch file.
  const readerDbs = await Promise.all([1, 2].map((i) => Database.openReader(vfs, 'db', { spillPath: `db-spill-r${i}` })));
  const readers = new SettingReaders(readerDbs);
  const log: { msg: Response }[] = [];
  const server = new EngineServer((_session, msg) => log.push({ msg }), { open: () => db, readers });
  let id = 1;
  const send = (body: Record<string, unknown>): number => {
    const rid = id++;
    server.receive(EngineServer.LOCAL, { ...body, id: rid } as Request);
    return rid;
  };
  const ended = (rid: number) => log.some((m) => m.msg.id === rid && (m.msg.kind === 'done' || m.msg.kind === 'error' || m.msg.kind === 'ok'));
  const errors = () => log.filter((m) => m.msg.kind === 'error').map((m) => m.msg);
  const run = async (body: Record<string, unknown>): Promise<number> => {
    const rid = send(body);
    await until(`request ${rid}`, () => ended(rid));
    return rid;
  };
  await run({ op: 'open', name: 'db', storage: 'opfs' });
  return { db, readerDbs, readers, send, run, ended, errors };
}

describe('the server hands its settings to readers', () => {
  it('with each query dispatched to a reader, as they are when it is dispatched', async () => {
    const t = await setup(100);
    await t.run({ op: 'exec', sql: 'PRAGMA work_mem = 4096; PRAGMA matview_rewrite = 1' });
    // A reader is used when other requests wait behind the query.
    const a = t.send({ op: 'query', sql: 'SELECT count(*) FROM t' });
    const b = t.send({ op: 'query', sql: 'SELECT 1' });
    await until('both queries', () => t.ended(a) && t.ended(b));
    expect(t.readers.dispatched[0]).toEqual({ sql: 'SELECT count(*) FROM t', settings: { workMem: 4096, matviewRewrite: true } });

    await t.run({ op: 'exec', sql: 'PRAGMA work_mem = 8192; PRAGMA matview_rewrite = 0' });
    const c = t.send({ op: 'query', sql: 'SELECT max(x) FROM t' });
    const d = t.send({ op: 'query', sql: 'SELECT 2' });
    await until('both queries', () => t.ended(c) && t.ended(d));
    expect(t.readers.dispatched.find((x) => x.sql === 'SELECT max(x) FROM t')?.settings).toEqual({ workMem: 8192, matviewRewrite: false });
    expect(t.errors()).toEqual([]);
  });

  it('with each morsel: readers use the owner\'s work_mem (and spill under it)', async () => {
    const t = await setup(250_000);
    const sql = 'SELECT g, count(*), sum(x) FROM t GROUP BY g ORDER BY g';
    const want = t.db.query(sql).rows;
    const spilled = () => t.readerDbs.reduce((n, r) => n + Number(one(r, 'PRAGMA spill_bytes')), 0);

    // Default work_mem: 5000 groups per morsel stay in memory.
    await t.run({ op: 'query', sql });
    expect(t.readers.partials.length).toBeGreaterThan(0);
    expect(spilled()).toBe(0);

    // A tiny work_mem on the owner: the readers' partial aggregates spill too, with the same result.
    await t.run({ op: 'exec', sql: 'PRAGMA work_mem = 16384' });
    const n = t.readers.partials.length;
    await t.run({ op: 'query', sql });
    expect(t.readers.partials.length).toBeGreaterThan(n);
    expect(t.readers.partials.slice(n).every((s) => s.workMem === 16384)).toBe(true);
    expect(spilled()).toBeGreaterThan(0);
    expect(t.errors()).toEqual([]);
    for (const r of t.readerDbs) expect(one(r, 'PRAGMA work_mem')).toBe(16384);
    expect(t.db.query(sql).rows).toEqual(want);
  }, 60_000); // builds a 250k-row table (morsels need 200k rows)
});
