/**
 * `unpivot` (ADR 0016 section 5): columns as rows, in input order and then the columns' order, with the kept columns,
 * each column's name and its value.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import { planFromJSON, planToJSON } from '../src/engine/plan/codec.js';
import type { PlanOp } from '../src/engine/plan/ops.js';

function db(): Database {
  const d = Database.openMemory();
  d.exec("CREATE TABLE sales(id INTEGER PRIMARY KEY, shop TEXT, q1 INT, q2 INT, q3 INT); INSERT INTO sales VALUES (1, 'north', 10, 20, NULL), (2, 'south', 5, NULL, 15), (3, 'east', 7, 8, 9)");
  return d;
}

describe('unpivot', () => {
  it('gives each row one row per column, in order', () => {
    const d = db();
    // The input in an order of its own: shop descending.
    const input = p.sort(p.scan('sales', [0, 1, 2, 3, 4]), [p.desc(p.col(0, 1, 'text'))]);
    const r = d.queryPlan(p.unpivot(input, [1], [2, 3, 4], ['q1', 'q2', 'q3'], 'int'));
    expect(r.rows).toEqual([
      ['south', 'q1', 5], ['south', 'q2', null], ['south', 'q3', 15],
      ['north', 'q1', 10], ['north', 'q2', 20], ['north', 'q3', null],
      ['east', 'q1', 7], ['east', 'q2', 8], ['east', 'q3', 9],
    ]);
    expect(r.columnTypes).toEqual(['text', 'text', 'int']);
  });

  it('under other operations, with several or no kept columns, and through JSON', () => {
    const d = db();
    const long = p.unpivot(p.scan('sales', [0, 1, 2, 3, 4]), [0, 1], [4, 2], ['third', 'first']);
    expect(d.queryPlan(p.limit(long, 2)).rows).toEqual([[1, 'north', 'third', null], [1, 'north', 'first', 10]]);
    // Summed by quarter, nulls skipped.
    const byQuarter = p.aggregate(p.unpivot(p.scan('sales', [2, 3, 4]), [], [0, 1, 2], ['q1', 'q2', 'q3'], 'int'), [p.col(0, 0, 'text')], [p.agg('sum', [p.col(0, 1, 'int')], 'int')], { ordered: 'first' });
    expect(d.queryPlan(byQuarter).rows).toEqual([['q1', 22], ['q2', 28], ['q3', 24]]);
    expect(d.queryPlan(planFromJSON(planToJSON(long))).rows).toEqual(d.queryPlan(long).rows);
    // Into a table.
    d.exec('CREATE TABLE facts(shop TEXT, quarter TEXT, n INT)');
    d.queryPlan({ kind: 'write', plan: p.append('facts', p.unpivot(p.scan('sales', [1, 2, 3]), [0], [1, 2], ['q1', 'q2']), [0, 1, 2]) });
    expect(d.query('SELECT count(*), sum(n) FROM facts').rows).toEqual([[6, 50]]);
  });

  it('the validator checks it', () => {
    const catalog = { tableColumns: (t: string) => (t === 'sales' ? 5 : undefined) };
    const bad = (plan: PlanOp) => {
      try {
        p.validatePlan(plan, catalog);
      } catch (e) {
        return (e as Error).message;
      }
      return 'valid';
    };
    const scan = p.scan('sales', [0, 1, 2]);
    expect(bad(p.unpivot(scan, [0], [3], ['x']))).toMatch(/no column 3/);
    expect(bad(p.unpivot(scan, [0], [], []))).toMatch(/expected at least one column/);
    expect(bad(p.unpivot(scan, [0], [1, 2], ['x']))).toMatch(/expected 2 names, one per column/);
    expect(bad({ ...p.unpivot(scan, [0], [1], ['x']), type: 'number' } as unknown as PlanOp)).toMatch(/unknown type/);
  });
});
