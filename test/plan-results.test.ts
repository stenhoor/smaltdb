/**
 * Results of plans (ADR 0016 section 8): each column's plan type, a write's counts beside its RETURNING rows, and
 * `streamPlan`, in process and through the client (over a stand-in worker, as test/bugfix-client.test.ts).
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as client from '../src/client/index.js';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import { EngineServer } from '../src/engine/server.js';
import type { Request, Response } from '../src/shared/protocol.js';

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
  await db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, qty REAL); INSERT INTO t VALUES (1, 'a', 1.5), (2, 'b', 2.5)");
  return db;
}
afterEach(async () => {
  for (const db of opened.splice(0)) await db.close();
});

const scanT = p.scan('t', [0, 1, 2]);
const insert = (id: number, returning = false) =>
  ({ kind: 'write', plan: p.append('t', p.values([[p.lit(id), p.lit(`n${id}`), p.lit(id / 2)]]), [0, 1, 2], returning ? { returning: [p.col(0, 0, 'int'), p.col(0, 1, 'text')] } : {}) }) as const;

describe('in process', () => {
  const db = (): Database => {
    const d = Database.openMemory();
    d.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, qty REAL); INSERT INTO t VALUES (1, 'a', 1.5), (2, 'b', 2.5)");
    return d;
  };

  it('a query gives its column types, and no counts', () => {
    const r = db().queryPlan(p.project(scanT, [p.col(0, 1, 'text'), p.call('mul', [p.col(0, 2, 'real'), p.lit(2)], 'real'), p.col(0, 0, 'int')]));
    expect(r.columnTypes).toEqual(['text', 'real', 'int']);
    expect(r.rows).toEqual([['a', 3, 1], ['b', 5, 2]]);
    expect(r.changes).toBeUndefined();
  });

  it('types columns from the plan: scans, joins, aggregates, set operations and values', () => {
    const d = db();
    const types = (plan: Parameters<Database['queryPlan']>[0]) => d.queryPlan(plan).columnTypes;
    expect(types(p.scan('t', [2, 1, -1]))).toEqual(['real', 'text', 'int']);
    expect(types(p.join('inner', p.scan('t', [0]), p.scan('t', [1])))).toEqual(['int', 'text']);
    expect(types(p.join('left', p.scan('t', [0]), p.scan('t', [2]), p.call('cmp_eq', [p.col(0, 0, 'int'), p.col(1, 0, 'real')], 'int')))).toEqual(['int', 'real']);
    expect(types(p.aggregate(scanT, [p.col(0, 1, 'text')], [p.agg('count', [], 'int', { star: true }), p.agg('avg', [p.col(0, 2, 'real')], 'real')]))).toEqual(['text', 'int', 'real']);
    expect(types(p.setop('unionAll', p.scan('t', [0, 1]), p.scan('t', [0, 2]), 2))).toEqual(['int', 'any']);
    expect(types(p.values([[p.lit(1), p.lit('x')]], ['int', 'text']))).toEqual(['int', 'text']);
    // A described type wins.
    expect(d.queryPlan({ kind: 'query', plan: p.scan('t', [0]), columns: [{ name: 'id', type: 'num' }] }).columnTypes).toEqual(['num']);
  });

  it('a write gives its counts, beside its RETURNING rows', () => {
    const d = db();
    const plain = d.queryPlan(insert(10));
    expect(plain).toMatchObject({ rows: [], changes: 1, lastInsertRowid: 10 });
    const returning = d.queryPlan(insert(11, true));
    expect(returning).toMatchObject({ rows: [[11, 'n11']], columnTypes: ['int', 'text'], changes: 1, lastInsertRowid: 11 });
    const removed = d.queryPlan({ kind: 'write', plan: p.remove('t', p.filter(p.scan('t', [-1]), p.call('cmp_gt', [p.col(0, 0, 'int'), p.lit(5)], 'int')), 0) });
    expect(removed.changes).toBe(2);
  });
});

describe('through the client', () => {
  it('results and prepared statements carry column types', async () => {
    const db = await openDb();
    const q = p.project(scanT, [p.col(0, 1, 'text'), p.col(0, 2, 'real')]);
    const arr = await db.queryPlan(q, [], { rowMode: 'array' });
    expect(arr.columnTypes).toEqual(['text', 'real']);
    const col = await db.queryPlan(q, [], { rowMode: 'columnar' });
    expect(col.columnTypes).toEqual(['text', 'real']);
    expect((await db.query('SELECT id, name FROM t', [], { rowMode: 'array' })).columnTypes).toEqual(['int', 'text']);
    const prepared = await db.preparePlan(q);
    expect(prepared.columnTypes).toEqual(['text', 'real']);
    expect((await db.prepare('SELECT qty FROM t')).columnTypes).toEqual(['real']);
    const rows = await db.queryPlan(q);
    // Columns not described are named column1, column2, … and typed from the plan.
    expect(rows).toEqual([{ column1: 'a', column2: 1.5 }, { column1: 'b', column2: 2.5 }]);
    expect(rows.changes).toBeUndefined();
  });

  it('a write through queryPlan gives its counts, not as enumerable fields', async () => {
    const db = await openDb();
    const plain = await db.queryPlan(insert(20));
    expect([...plain]).toEqual([]);
    expect(plain.changes).toBe(1);
    expect(plain.lastInsertRowid).toBe(20);
    const returning = await db.queryPlan(insert(21, true), [], { rowMode: 'array' });
    expect([...returning]).toEqual([[21, 'n21']]);
    expect(returning.changes).toBe(1);
    expect(returning.lastInsertRowid).toBe(21);
    expect(JSON.stringify(returning)).toBe('[[21,"n21"]]');
    const inTx = await db.transaction((tx) => tx.queryPlan(insert(22)));
    expect(inTx.changes).toBe(1);
  });

  it('streamPlan streams a plan in batches, in and out of a transaction', async () => {
    const db = await openDb();
    const rows = Array.from({ length: 100 }, (_, i) => [p.lit(i + 11), p.lit(null), p.lit(i)]);
    await db.queryPlan({ kind: 'write', plan: p.append('t', p.values(rows), [0, 1, 2]) });
    let seen = 0;
    let batches = 0;
    for await (const batch of db.streamPlan(p.scan('t', [0]), [], { batchSize: 25, rowMode: 'array' })) {
      batches++;
      seen += batch.length;
      expect(batch.columnTypes).toEqual(['int']);
    }
    expect(seen).toBe(102);
    expect(batches).toBeGreaterThan(1);
    const inTx = await db.transaction(async (tx) => {
      let n = 0;
      for await (const batch of tx.streamPlan(p.scan('t', [0]), [], { batchSize: 50 })) n += batch.length;
      return n;
    });
    expect(inTx).toBe(102);
  });
});
