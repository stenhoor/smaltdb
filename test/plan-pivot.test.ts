/**
 * `pivot` (ADR 0016 section 5): values of a column, given in the plan, become columns; one row per group, each value's
 * column the aggregate over the group's rows with that value.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanOp } from '../src/engine/plan/ops.js';

function db(): Database {
  const d = Database.openMemory();
  d.exec(`CREATE TABLE facts(shop TEXT, quarter TEXT, n INT);
    INSERT INTO facts VALUES ('north', 'q1', 10), ('north', 'q2', 20), ('south', 'q1', 5), ('south', 'Q3', 15), ('north', 'q1', 1), ('east', NULL, 4)`);
  return d;
}
const shop = p.col(0, 0, 'text');
const quarter = p.col(0, 1, 'text');
const n = p.col(0, 2, 'int');
const scan = p.scan('facts', [0, 1, 2]);

describe('pivot', () => {
  it('gives one row per group and one column per value and aggregate', () => {
    const d = db();
    const wide = p.pivot(scan, [shop], quarter, ['q1', 'q2', 'q3'], [p.agg('sum', [n], 'int')], { ordered: 'first' });
    const r = d.queryPlan(wide);
    expect(r.rows).toEqual([['north', 11, 20, null], ['south', 5, null, null], ['east', null, null, null]]);
    expect(r.columnTypes).toEqual(['text', 'int', 'int', 'int']);
    // Several aggregates: value by value, each value's calls together.
    const two = d.queryPlan(p.pivot(scan, [shop], quarter, ['q1', 'q2'], [p.agg('sum', [n], 'int'), p.agg('count', [], 'int', { star: true })], { ordered: 'first' })).rows;
    expect(two).toEqual([['north', 11, 2, 20, 1], ['south', 5, 1, null, 0], ['east', null, 0, null, 0]]);
  });

  it('compares by its collation, matches NULL as a value, keeps an aggregate filter, and works without keys', () => {
    const d = db();
    const nocase = d.queryPlan(p.pivot(scan, [shop], quarter, ['q3'], [p.agg('sum', [n], 'int')], { collation: 'nocase', ordered: 'first' })).rows;
    expect(nocase).toEqual([['north', null], ['south', 15], ['east', null]]);
    expect(d.queryPlan(p.pivot(scan, [], quarter, [null, 'q2'], [p.agg('sum', [n], 'int')])).rows).toEqual([[4, 20]]);
    const big = p.agg('count', [], 'int', { star: true, filter: p.call('cmp_gt', [n, p.lit(5)], 'int') });
    expect(d.queryPlan(p.pivot(scan, [], quarter, ['q1'], [big])).rows).toEqual([[1]]);
  });

  it('the validator checks it', () => {
    const catalog = { tableColumns: (t: string) => (t === 'facts' ? 3 : undefined) };
    const bad = (plan: PlanOp) => {
      try {
        p.validatePlan(plan, catalog);
      } catch (e) {
        return (e as Error).message;
      }
      return 'valid';
    };
    expect(bad(p.pivot(scan, [shop], quarter, [], [p.agg('sum', [n], 'int')]))).toMatch(/expected at least one value/);
    expect(bad(p.pivot(scan, [shop], quarter, ['q1'], []))).toMatch(/expected at least one aggregate/);
    expect(bad(p.pivot(scan, [shop], p.col(0, 7, 'text'), ['q1'], [p.agg('sum', [n], 'int')]))).not.toBe('valid');
    expect(bad(p.pivot(scan, [shop], quarter, [{} as never], [p.agg('sum', [n], 'int')]))).toMatch(/expected a value/);
  });
});
