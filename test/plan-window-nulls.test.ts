/**
 * `ignoreNulls` on navigation window functions (ADR 0016 section 5): lag, lead, first_value, last_value and nth_value
 * count only rows whose value is not NULL.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp, WindowCall, WindowFrame } from '../src/engine/plan/ops.js';

// t(id, g, v): two partitions; NULLs scattered.
const ROWS: [number, string, number | null][] = [[1, 'a', 10], [2, 'a', null], [3, 'a', null], [4, 'a', 40], [5, 'a', 50], [6, 'a', null], [7, 'b', null], [8, 'b', 80], [9, 'b', null]];
function db(): Database {
  const d = Database.openMemory();
  d.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g TEXT, v INT)');
  for (const r of ROWS) d.exec(`INSERT INTO t VALUES (${r[0]}, '${r[1]}', ${r[2] ?? 'NULL'})`);
  return d;
}
const v = p.col(0, 2, 'int');
const ALL: WindowFrame = { unit: 'ROWS', start: { kind: 'unboundedPreceding' }, end: { kind: 'unboundedFollowing' }, exclude: 'NO OTHERS' };
const UPTO: WindowFrame = { unit: 'ROWS', start: { kind: 'unboundedPreceding' }, end: { kind: 'currentRow' }, exclude: 'NO OTHERS' };
const call = (fn: string, args: PlanExpr[], ignoreNulls = true): WindowCall => ({ fn, args, star: false, type: 'int', collation: 'binary', ignoreNulls });
/** Each row's id with the window call's value, by id, partitioned by g. */
function run(d: Database, c: WindowCall, frame = ALL): unknown[][] {
  const w = { op: 'window', input: p.scan('t', [0, 1, 2]), partition: [{ expr: p.col(0, 1, 'text'), collation: 'binary' }], order: [p.asc(p.col(0, 0, 'int'))], frame, calls: [c] } as unknown as PlanOp;
  return d.queryPlan(p.sort(p.project(w, [p.col(0, 0, 'int'), p.col(0, 3, 'int')]), [p.asc(p.col(0, 0, 'int'))])).rows.map((r) => r[1] as unknown[]);
}

describe('ignoreNulls', () => {
  it('lag and lead: the n-th non-NULL value before or after the row', () => {
    const d = db();
    expect(run(d, call('lag', [v]))).toEqual([null, 10, 10, 10, 40, 50, null, null, 80]);
    expect(run(d, call('lag', [v, p.lit(2)]))).toEqual([null, null, null, null, 10, 40, null, null, null]);
    expect(run(d, call('lead', [v]))).toEqual([40, 40, 40, 50, null, null, 80, null, null]);
    expect(run(d, call('lead', [v, p.lit(1), p.lit(-1)]))).toEqual([40, 40, 40, 50, -1, -1, 80, -1, -1]);
    // Without the flag, as before.
    expect(run(d, call('lag', [v], false))).toEqual([null, 10, null, null, 40, 50, null, null, 80]);
  });

  it('first_value, last_value and nth_value: over the frame, skipping NULLs', () => {
    const d = db();
    expect(run(d, call('first_value', [v]))).toEqual([10, 10, 10, 10, 10, 10, 80, 80, 80]);
    expect(run(d, call('last_value', [v]))).toEqual([50, 50, 50, 50, 50, 50, 80, 80, 80]);
    expect(run(d, call('last_value', [v]), UPTO)).toEqual([10, 10, 10, 40, 50, 50, null, 80, 80]);
    expect(run(d, call('nth_value', [v, p.lit(2)]))).toEqual([40, 40, 40, 40, 40, 40, null, null, null]);
    expect(run(d, call('first_value', [v], false))).toEqual([10, 10, 10, 10, 10, 10, null, null, null]);
  });

  it('the validator allows it on navigation functions only', () => {
    const catalog = { tableColumns: (t: string) => (t === 't' ? 3 : undefined) };
    const w = (c: WindowCall) => ({ op: 'window', input: p.scan('t', [0, 1, 2]), partition: [], order: [], frame: ALL, calls: [c] }) as unknown as PlanOp;
    expect(() => p.validatePlan(w(call('lag', [v])), catalog)).not.toThrow();
    expect(() => p.validatePlan(w({ ...call('sum', [v]), ignoreNulls: true }), catalog)).toThrow(/sum does not ignore NULLs/);
    expect(() => p.validatePlan(w({ ...call('lag', [v]), ignoreNulls: 'yes' as never }), catalog)).toThrow(/ignoreNulls: expected true or false/);
  });
});
