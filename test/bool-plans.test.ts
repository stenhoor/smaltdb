/**
 * `bool` in plans (ADR 0018 section 1, step 4): a plan type whose values are 0 / 1 at run time. A call or a logic node
 * declared `bool` gives `true` / `false` in results, in process and through the client; declared `int` (what SQL
 * declares) it gives 0 / 1. Columns of values may hold JS booleans. `bool` is an integer to every operation.
 */
import * as client from '../src/client/index.js';
import { afterEach, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import { EngineServer } from '../src/engine/server.js';
import type { Request, Response } from '../src/shared/protocol.js';

const n = p.col(0, 0, 'int');
const flag = p.col(0, 1, 'bool');
/** n INT, flag BOOL (true, false, NULL, true). */
const frame = (): PlanOp => p.fromColumns([new Int32Array([1, 2, 3, 4]), [true, false, null, true]], ['int', 'bool']);
const gt2 = (type: 'bool' | 'int') => p.call('cmp_gt', [n, p.lit(2)], type);

describe('in process', () => {
  const d = Database.openMemory();
  const q = (plan: PlanOp) => d.queryPlan(plan);

  it('a bool column of JS booleans comes back as booleans', () => {
    const r = q(frame());
    expect(r.rows).toEqual([[1, true], [2, false], [3, null], [4, true]]);
    expect(r.columnTypes).toEqual(['int', 'bool']);
    // A Uint8Array given the type bool.
    expect(q(p.fromColumns([new Uint8Array([1, 0])], ['bool'])).rows).toEqual([[true], [false]]);
  });

  it('a comparison declared bool gives booleans; declared int, 0 / 1', () => {
    expect(q(p.project(frame(), [gt2('bool')])).rows).toEqual([[false], [false], [true], [true]]);
    expect(q(p.project(frame(), [gt2('int')])).rows).toEqual([[0], [0], [1], [1]]);
    expect(q(p.project(frame(), [p.call('cmp_eq', [n, p.lit(null)], 'bool')])).rows).toEqual([[null], [null], [null], [null]]);
  });

  it('logic nodes: bool (also when left out), or typed int', () => {
    const both = p.and(flag, gt2('bool'));
    expect(q(p.project(frame(), [p.typed(both, 'bool')])).rows).toEqual([[false], [false], [null], [true]]);
    expect(q(p.project(frame(), [both])).rows).toEqual([[false], [false], [null], [true]]);
    expect(q(p.project(frame(), [p.typed(both, 'int')])).rows).toEqual([[0], [0], [null], [1]]);
    expect(q(p.project(frame(), [p.typed(p.not(flag), 'bool'), p.typed(p.isNull(flag), 'bool')])).rows).toEqual([[false, false], [true, false], [null, true], [false, false]]);
  });

  it('a bool is an integer to operations: filters, arithmetic, sums', () => {
    expect(q(p.project(p.filter(frame(), flag), [n])).rows).toEqual([[1], [4]]);
    expect(q(p.project(frame(), [p.call('add', [flag, p.lit(10)], 'int')])).rows).toEqual([[11], [10], [null], [11]]);
    const r = q(p.aggregate(frame(), [], [p.agg('sum', [flag], 'int'), p.agg('max', [flag], 'bool'), p.agg('min', [flag], 'bool'), p.agg('count', [flag], 'int')]));
    expect(r.rows).toEqual([[2, true, false, 3]]);
    expect(r.columnTypes).toEqual(['int', 'bool', 'bool', 'int']);
    // Grouped by a bool, sorted by one.
    const g = q(p.sort(p.aggregate(frame(), [flag], [p.agg('count', [], 'int', { star: true })]), [p.asc(p.col(0, 0, 'bool'))]));
    expect(g.rows).toEqual([[null, 1], [false, 1], [true, 2]]);
  });

  it('bool beside int in a set operation is int; beside text, any', () => {
    const b = p.project(frame(), [flag]);
    const i = p.project(frame(), [n]);
    expect(q(p.setop('unionAll', b, i, 1)).columnTypes).toEqual(['int']);
    expect(q(p.setop('unionAll', b, p.project(frame(), [p.lit('x')]), 1)).columnTypes).toEqual(['any']);
  });

  it('the validator takes bool, and a logic node typed bool or int only', () => {
    const catalog = { tableColumns: () => undefined };
    expect(() => p.validatePlan(p.project(frame(), [p.typed(p.not(flag), 'bool')]), catalog)).not.toThrow();
    expect(() => p.validatePlan(p.project(frame(), [{ ...p.not(flag), type: 'text' } as never]), catalog)).toThrow(/a logic node's type is bool or int/);
  });
});

describe('through the client', () => {
  class FakeWorker {
    onmessage: ((e: { data: Response }) => void) | null = null;
    onerror: unknown = null;
    private readonly server = new EngineServer((_session, msg) => setTimeout(() => this.onmessage?.({ data: structuredClone(msg) })), {
      open: () => Database.openMemory(),
      refreshTimer: false,
    });
    postMessage(req: Request, transfer: Transferable[] = []): void {
      const r = structuredClone(req, { transfer });
      setTimeout(() => this.server.receive(EngineServer.LOCAL, r));
    }
    terminate(): void {}
  }
  (globalThis as { Worker?: unknown }).Worker ??= FakeWorker;
  const opened: client.Database[] = [];
  afterEach(async () => {
    for (const db of opened.splice(0)) await db.close();
  });
  const open = async () => {
    const db = await client.open(':memory:', { storage: 'memory', worker: new FakeWorker() as unknown as Worker });
    opened.push(db);
    return db;
  };
  const plan = () => p.project(frame(), [n, flag, gt2('bool'), gt2('int')]);
  const want = [[1, true, false, 0], [2, false, false, 0], [3, null, true, 1], [4, true, true, 1]];

  it('in every row mode, streamed and prepared', async () => {
    const db = await open();
    expect([...(await db.queryPlan(plan(), [], { rowMode: 'array' }))]).toEqual(want);
    const objects = (await db.queryPlan(plan())) as unknown as Record<string, unknown>[];
    expect(Object.values(objects[0]).slice(0, 2)).toEqual([1, true]);
    const columnar = (await db.queryPlan(plan(), [], { rowMode: 'columnar' })) as unknown as { data: Record<string, unknown> };
    expect([...(Object.values(columnar.data)[1] as unknown[])]).toEqual([true, false, null, true]);
    const streamed: unknown[] = [];
    for await (const b of db.streamPlan(plan(), [], { batchSize: 3, rowMode: 'array' })) streamed.push(...b);
    expect(streamed).toEqual(want);
    expect([...(await (await db.preparePlan(plan())).query([], { rowMode: 'array' }))]).toEqual(want);
  });
});
