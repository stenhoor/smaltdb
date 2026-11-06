/**
 * `sample` (ADR 0016 section 5): a count or a fraction of the rows, with or without replacement, fixed by a seed.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanOp } from '../src/engine/plan/ops.js';

const N = 1000;
function db(): Database {
  const d = Database.openMemory();
  d.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g INT)');
  d.exec('BEGIN');
  for (let i = 1; i <= N; i++) d.exec(`INSERT INTO t VALUES (${i}, ${i % 10})`);
  d.exec('COMMIT');
  return d;
}
const scan = p.scan('t', [0, 1]);
const ids = (d: Database, plan: PlanOp) => d.queryPlan(plan).rows.map((r) => r[0] as number);

describe('sample', () => {
  it('without replacement: exactly that many distinct rows, in input order, the same for the same seed', () => {
    const d = db();
    const a = ids(d, p.sample(scan, { count: 50 }, { seed: 7 }));
    expect(a).toHaveLength(50);
    expect(new Set(a).size).toBe(50);
    expect([...a].sort((x, y) => x - y)).toEqual(a);
    expect(ids(d, p.sample(scan, { count: 50 }, { seed: 7 }))).toEqual(a);
    const b = ids(d, p.sample(scan, { count: 50 }, { seed: 8 }));
    expect(b).not.toEqual(a);
    // Spread over the input, not its start.
    expect(Math.max(...a)).toBeGreaterThan(N / 2);
    // A fraction of the rows; more than there are gives them all; none.
    expect(ids(d, p.sample(scan, { fraction: 0.1 }, { seed: 1 }))).toHaveLength(100);
    expect(ids(d, p.sample(scan, { count: 5000 }))).toHaveLength(N);
    expect(ids(d, p.sample(scan, { count: 0 }))).toEqual([]);
    // Over a sorted input: its order is kept.
    const desc = ids(d, p.sample(p.sort(scan, [p.desc(p.col(0, 0, 'int'))]), { count: 20 }, { seed: 3 }));
    expect([...desc].sort((x, y) => y - x)).toEqual(desc);
    // With a parameter, and under other operations.
    expect(d.queryPlan(p.aggregate(p.sample(scan, { count: p.param(0, 'int') }, { seed: 2 }), [], [p.agg('count', [], 'int', { star: true })]), [12]).rows).toEqual([[12]]);
  });

  it('with replacement: that many draws, rows possibly repeated, the same for the same seed', () => {
    const d = db();
    const draws = ids(d, p.sample(p.filter(scan, p.call('cmp_le', [p.col(0, 0, 'int'), p.lit(20)], 'int')), { count: 100 }, { replace: true, seed: 5 }));
    expect(draws).toHaveLength(100);
    expect(new Set(draws).size).toBeLessThan(21);
    expect(draws.every((x) => x >= 1 && x <= 20)).toBe(true);
    expect(ids(d, p.sample(p.filter(scan, p.call('cmp_le', [p.col(0, 0, 'int'), p.lit(20)], 'int')), { count: 100 }, { replace: true, seed: 5 }))).toEqual(draws);
    expect(ids(d, p.sample(scan, { fraction: 0.05 }, { replace: true, seed: 9 }))).toHaveLength(50);
    expect(ids(d, p.sample(scan, { count: 0 }, { replace: true }))).toEqual([]);
  });

  it('the validator checks it', () => {
    const catalog = { tableColumns: (t: string) => (t === 't' ? 2 : undefined) };
    const bad = (plan: PlanOp) => {
      try {
        p.validatePlan(plan, catalog);
      } catch (e) {
        return (e as Error).message;
      }
      return 'valid';
    };
    expect(bad({ ...p.sample(scan, { count: 1 }), fraction: p.lit(0.5) } as PlanOp)).toMatch(/a count or a fraction/);
    expect(bad({ ...p.sample(scan, { count: 1 }), seed: 1.5 } as PlanOp)).toMatch(/integer seed/);
    expect(bad(p.sample(scan, { count: p.col(0, 0, 'int') }))).not.toBe('valid');
  });
});
