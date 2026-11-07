/**
 * `values` from columns (ADR 0016 section 5): rows given as one array per column (typed arrays, value arrays, null
 * bitmaps), read in place; through the client the arrays cross as binary data beside the plan's JSON, copied or with
 * `transfer` handed over.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as client from '../src/client/index.js';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import { planFromJSON, planToJSON } from '../src/engine/plan/codec.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import { EngineServer } from '../src/engine/server.js';
import type { Request, Response } from '../src/shared/protocol.js';

/** id INT, name TEXT and qty REAL (row 2 NULL by their bitmaps), big INT (beyond 2^53). */
function frame(): PlanOp {
  const nulls = new Uint8Array([0b010]);
  return p.fromColumns([new Int32Array([1, 2, 3]), { data: ['a', 'b', 'c'], nulls }, { data: new Float64Array([1.5, 0, 3]), nulls }, new BigInt64Array([1n, 2n ** 60n, 3n])], ['int', 'text', 'real', 'int']);
}
const ROWS = [[1, 'a', 1.5, 1], [2, null, null, 2n ** 60n], [3, 'c', 3, 3]];

describe('in process', () => {
  it('reads each kind of column, and is used as any input', () => {
    const d = Database.openMemory();
    expect(d.queryPlan(frame()).rows).toEqual(ROWS);
    expect(d.queryPlan(frame()).columnTypes).toEqual(['int', 'text', 'real', 'int']);
    expect(d.queryPlan(p.filter(frame(), p.call('cmp_gt', [p.col(0, 0, 'int'), p.lit(1)], 'int'))).rows).toEqual(ROWS.slice(1));
    expect(d.queryPlan(p.sort(frame(), [p.desc(p.col(0, 2, 'real'))])).rows).toEqual([ROWS[2], ROWS[0], ROWS[1]]);
    expect(d.queryPlan(p.aggregate(frame(), [], [p.agg('sum', [p.col(0, 0, 'int')], 'int'), p.agg('count', [p.col(0, 1, 'text')], 'int')])).rows).toEqual([[6, 2]]);
    d.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, qty REAL, big INT)');
    expect(d.queryPlan({ kind: 'write', plan: p.append('t', frame(), [0, 1, 2, 3]) })).toMatchObject({ changes: 3, lastInsertRowid: 3 });
    expect(d.query('SELECT * FROM t').rows).toEqual(ROWS);
    const joined = p.join('inner', frame(), p.scan('t', [0, 1]), p.call('cmp_eq', [p.col(0, 0, 'int'), p.col(1, 0, 'int')], 'int'));
    expect(d.queryPlan(p.project(joined, [p.col(0, 0, 'int'), p.col(0, 5, 'text')])).rows).toEqual([[1, 'a'], [2, null], [3, 'c']]);
    // Every typed array, and plain value arrays with blobs and bigints.
    const kinds = [new Float32Array([0.5]), new Int16Array([-2]), new Int8Array([-1]), new Uint32Array([4e9]), new Uint16Array([65535]), new Uint8Array([255]), [new Uint8Array([1, 2])], [12n ** 20n]];
    expect(d.queryPlan(p.fromColumns(kinds, kinds.map(() => 'any'))).rows).toEqual([[0.5, -2, -1, 4e9, 65535, 255, new Uint8Array([1, 2]), 12n ** 20n]]);
    // No rows, and no columns.
    expect(d.queryPlan(p.fromColumns([new Float64Array(0)], ['real'])).rows).toEqual([]);
  });

  it('survives JSON, as tagged typed arrays', () => {
    const d = Database.openMemory();
    const json = planToJSON(frame());
    expect(json).toContain('{"$typed":"i32","data":[1,2,3]}');
    expect(json).toContain('{"$typed":"i64","data":["1","1152921504606846976","3"]}');
    expect(d.queryPlan(planFromJSON(json)).rows).toEqual(ROWS);
  });

  it('the validator checks the columns', () => {
    const catalog = { tableColumns: () => undefined };
    const bad = (plan: PlanOp) => {
      try {
        p.validatePlan(plan, catalog);
      } catch (e) {
        return (e as Error).message;
      }
      return 'valid';
    };
    expect(bad(p.fromColumns([new Int32Array(2)], ['int', 'int']))).toMatch(/expected 2 columns, one per type/);
    expect(bad(p.fromColumns([new Int32Array(2), new Int32Array(3)], ['int', 'int']))).toMatch(/expected 2 values, as the first column has/);
    expect(bad(p.fromColumns([[1, {} as never]], ['any']))).toMatch(/expected a value at 1/);
    expect(bad(p.fromColumns([{ data: new Int32Array(9), nulls: new Uint8Array(1) }], ['int']))).toMatch(/null bitmap of at least 2 bytes/);
    expect(bad(p.fromColumns([new DataView(new ArrayBuffer(4)) as never], ['int']))).toMatch(/expected a typed array/);
    expect(bad({ ...p.fromColumns([new Int32Array(1)], ['int']), rows: [[p.lit(1)]] })).toMatch(/expected no rows beside columns/);
  });
});

describe('through the client', () => {
  class FakeWorker {
    onmessage: ((e: { data: Response }) => void) | null = null;
    onerror: unknown = null;
    readonly transferred: Transferable[][] = [];
    private readonly server = new EngineServer((_session, msg) => setTimeout(() => this.onmessage?.({ data: structuredClone(msg) })), {
      open: () => Database.openMemory(),
      refreshTimer: false,
    });
    postMessage(req: Request, transfer: Transferable[] = []): void {
      this.transferred.push(transfer);
      const r = structuredClone(req, { transfer });
      setTimeout(() => this.server.receive(EngineServer.LOCAL, r));
    }
    terminate(): void {}
  }
  (globalThis as { Worker?: unknown }).Worker ??= FakeWorker;
  const opened: client.Database[] = [];
  afterEach(async () => {
    for (const d of opened.splice(0)) await d.close();
  });
  const open = async () => {
    const worker = new FakeWorker();
    const db = await client.open(':memory:', { storage: 'memory', worker: worker as unknown as Worker });
    opened.push(db);
    return { db, worker };
  };

  it('the arrays travel beside the JSON, copied by default', async () => {
    const { db, worker } = await open();
    const ids = new Int32Array([1, 2, 3]);
    const plan = p.fromColumns([ids, ['x', 'y', 'z']], ['int', 'text']);
    expect([...(await db.queryPlan(plan, [], { rowMode: 'array' }))]).toEqual([[1, 'x'], [2, 'y'], [3, 'z']]);
    expect(worker.transferred.at(-1)).toEqual([]);
    expect(ids.length).toBe(3);
    // Streamed, prepared, and in a transaction.
    let n = 0;
    for await (const b of db.streamPlan(plan, [], { batchSize: 2 })) n += b.length;
    expect(n).toBe(3);
    expect([...(await (await db.preparePlan(plan)).query([], { rowMode: 'array' }))]).toEqual([[1, 'x'], [2, 'y'], [3, 'z']]);
    await db.exec('CREATE TABLE t(id INT, name TEXT)');
    await db.transaction((tx) => tx.queryPlan({ kind: 'write', plan: p.append('t', plan, [0, 1]) }));
    expect(await db.query('SELECT count(*) AS n FROM t')).toEqual([{ n: 3 }]);
  });

  it('with transfer, the buffers are handed over', async () => {
    const { db, worker } = await open();
    const qty = new Float64Array([2.5, 4]);
    const nulls = new Uint8Array([0b10]);
    const r = await db.queryPlan(p.fromColumns([qty, { data: new Int32Array([7, 8]), nulls }], ['real', 'int']), [], { rowMode: 'array', transfer: true });
    expect([...r]).toEqual([[2.5, 7], [4, null]]);
    expect(worker.transferred.at(-1)!.length).toBe(3);
    expect(qty.length).toBe(0); // detached: the worker has it
  });
});
