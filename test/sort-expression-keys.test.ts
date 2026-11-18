/**
 * A sort by expressions, not only by its input's columns: the normalizer sorts by columns made for the keys
 * (plan-normalize `keyedSort`). Before, the planner crashed reading a key as a column: of VALUES or a compound
 * (`reading 'collation'`), or over a projection or filter (`reading 'k'`). And VALUES with no rows, given as rows.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';

const INT = 'int' as never;
const neg = (i: number) => p.call('neg', [p.col(0, i, INT)], INT);

describe('sort by expressions', () => {
  it('sorts VALUES by an expression, with a column key after it, and gives only the columns', () => {
    const db = Database.openMemory();
    const v = p.fromColumns([[3, 1, 2, 2], ['c', 'a', 'b', 'a']] as never, [INT, 'text'] as never);
    expect(db.queryPlan(p.sort(v, [p.asc(neg(0))])).rows).toEqual([[3, 'c'], [2, 'b'], [2, 'a'], [1, 'a']]);
    expect(db.queryPlan(p.sort(v, [p.asc(neg(0)), p.asc(p.col(0, 1, 'text' as never))])).rows).toEqual([[3, 'c'], [2, 'a'], [2, 'b'], [1, 'a']]);
    expect(db.queryPlan(p.limit(p.sort(v, [p.desc(neg(0))]), p.lit(2))).rows).toEqual([[1, 'a'], [2, 'b']]);
  });

  it('sorts a compound by an expression', () => {
    const db = Database.openMemory();
    const a = p.fromColumns([[1, 5]] as never, [INT] as never);
    const b = p.fromColumns([[3]] as never, [INT] as never);
    const u = { op: 'setop', kind: 'unionAll', inputs: [a, b], collations: ['binary'] } as never;
    expect(db.queryPlan(p.sort(u, [p.asc(neg(0))])).rows).toEqual([[5], [3], [1]]);
  });

  it('sorts a projection or a filter by an expression', () => {
    const db = Database.openMemory();
    const v = p.values([[p.lit(1)], [p.lit(2)], [p.lit(3)]]);
    expect(db.queryPlan(p.sort(p.project(v, [p.col(0, 0, INT)]), [p.asc(neg(0))])).rows).toEqual([[3], [2], [1]]);
    expect(db.queryPlan(p.sort(p.filter(v, p.call('cmp_gt', [p.col(0, 0, INT), p.lit(1)], 'bool' as never)), [p.asc(neg(0))])).rows).toEqual([[3], [2]]);
  });
});

describe('VALUES with no rows', () => {
  it('gives no rows, of its types, alone and under a filter', () => {
    const db = Database.openMemory();
    const empty = { op: 'values', rows: [], types: ['int', 'text'] } as never;
    const r = db.queryPlan(empty);
    expect(r.rows).toEqual([]);
    expect(r.columnTypes).toEqual(['int', 'text']);
    expect(db.queryPlan(p.filter(empty, p.lit(1, 'bool' as never))).rows).toEqual([]);
  });
});
