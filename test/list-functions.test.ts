/**
 * The functions of one list (ADR 0031 step 4): statistics, changing a list, sets, and the options of the earlier
 * functions. A NULL list gives NULL throughout.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanType } from '../src/engine/plan/types.js';

const db = Database.openMemory();
const L = (t: string) => t as PlanType;

/** `fn(col, ...rest)` declared `type` over a column of lists `xs` of type `t`. */
function over(t: string, xs: unknown[], fn: string, rest: PlanExpr[], type: string): unknown[] {
  const src = p.fromColumns([xs as never], [L(t)]);
  return db.queryPlan(p.project(src, [p.call(fn, [p.col(0, 0, L(t)), ...rest], L(type))])).rows.map((r) => r[0]);
}
const ints = (xs: unknown[], fn: string, rest: PlanExpr[], type: string) => over('list<int>', xs, fn, rest, type);
const list = (xs: (number | null)[]): PlanExpr => p.call('list_of', xs.map((x) => p.lit(x)), L('list<int>'));

describe('statistics', () => {
  const xs = [[3, 1, null, 2, 4], [], null, [7]];

  it('median, var and std over the non-null numbers', () => {
    expect(ints(xs, 'list_median', [], 'real')).toEqual([2.5, null, null, 7]);
    expect(ints(xs, 'list_var', [], 'real')).toEqual([5 / 3, null, null, null]);
    expect(ints(xs, 'list_var', [p.lit(0)], 'real')).toEqual([1.25, null, null, 0]);
    expect(ints(xs, 'list_std', [], 'real')[0]).toBeCloseTo(Math.sqrt(5 / 3), 12);
    expect(() => ints(xs, 'list_var', [p.lit(-1)], 'real')).toThrow(/ddof must not be negative/);
    expect(() => over('list<text>', [['a']], 'list_median', [], 'real')).toThrow(/list_median takes a list of numbers/);
  });

  it('n_unique counts NULL once; arg_min and arg_max skip it, the first of equals', () => {
    expect(ints([[1, null, 1, 2, null], [], null], 'list_n_unique', [], 'int')).toEqual([3, 0, null]);
    expect(ints([[3, 1, null, 1, 5, 5], [], [null]], 'list_arg_min', [], 'int')).toEqual([1, null, null]);
    expect(ints([[3, 1, null, 1, 5, 5], [], [null]], 'list_arg_max', [], 'int')).toEqual([4, null, null]);
  });

  it('count_matches, NULL counting NULL elements', () => {
    expect(ints([[1, 2, 1, null], []], 'list_count_matches', [p.lit(1)], 'int')).toEqual([2, 0]);
    expect(ints([[1, 2, 1, null], []], 'list_count_matches', [p.lit(null)], 'int')).toEqual([1, 0]);
  });

  it('all and any over the non-null elements', () => {
    const bs = [[1, 1, null], [1, 0], [], [null], null];
    expect(over('list<bool>', bs, 'list_all', [], 'bool')).toEqual([true, false, true, true, null]);
    expect(over('list<bool>', bs, 'list_any', [], 'bool')).toEqual([true, true, false, false, null]);
  });
});

describe('changing a list', () => {
  it('drop_nulls, shift and diff', () => {
    expect(ints([[1, null, 2], [], null], 'list_drop_nulls', [], 'list<int>')).toEqual([[1, 2], [], null]);
    expect(ints([[1, 2, 3], []], 'list_shift', [], 'list<int>')).toEqual([[null, 1, 2], []]);
    expect(ints([[1, 2, 3]], 'list_shift', [p.lit(-2)], 'list<int>')).toEqual([[3, null, null]]);
    expect(ints([[1, 2, 3]], 'list_shift', [p.lit(5)], 'list<int>')).toEqual([[null, null, null]]);
    expect(ints([[1, 4, null, 10], []], 'list_diff', [], 'list<int>')).toEqual([[null, 3, null, null], []]);
    expect(ints([[1, 4, 9, 16]], 'list_diff', [p.lit(2)], 'list<int>')).toEqual([[null, null, 8, 12]]);
    expect(over('list<real>', [[1.5, 1]], 'list_diff', [], 'list<real>')).toEqual([[null, -0.5]]);
    expect(() => over('list<text>', [['a']], 'list_diff', [], 'list<text>')).toThrow(/list_diff takes a list of numbers, not of text/);
  });

  it('gather: NULL out of range, or an error with strict', () => {
    expect(ints([[10, 20, 30], [], null], 'list_gather', [list([2, -1, 0, null, 7])], 'list<int>')).toEqual([[30, 30, 10, null, null], [null, null, null, null, null], null]);
    expect(() => ints([[10]], 'list_gather', [list([1]), p.lit(1)], 'list<int>')).toThrow(/list_gather: index 1 is out of range for a list of 1/);
  });

  it('gather_every and item', () => {
    expect(ints([[0, 1, 2, 3, 4, 5]], 'list_gather_every', [p.lit(2)], 'list<int>')).toEqual([[0, 2, 4]]);
    expect(ints([[0, 1, 2, 3, 4, 5]], 'list_gather_every', [p.lit(4), p.lit(1)], 'list<int>')).toEqual([[1, 5]]);
    expect(() => ints([[1]], 'list_gather_every', [p.lit(0)], 'list<int>')).toThrow(/the step must be positive/);
    expect(ints([[7], [null], null], 'list_item', [], 'int')).toEqual([7, null, null]);
    expect(() => ints([[1, 2]], 'list_item', [], 'int')).toThrow(/list_item: the list has 2 elements, not 1/);
    expect(() => ints([[]], 'list_item', [], 'int')).toThrow(/has 0 elements/);
  });

  it('sample: n elements in order, the same for a seed', () => {
    const xs = [Array.from({ length: 20 }, (_x, i) => i)];
    const a = ints(xs, 'list_sample', [p.lit(5), p.lit(0), p.lit(42)], 'list<int>')[0] as number[];
    expect(a).toHaveLength(5);
    expect(new Set(a).size).toBe(5);
    expect([...a].sort((x, y) => x - y)).toEqual(a);
    expect(ints(xs, 'list_sample', [p.lit(5), p.lit(0), p.lit(42)], 'list<int>')[0]).toEqual(a);
    expect(ints(xs, 'list_sample', [p.lit(20)], 'list<int>')[0]).toEqual(xs[0]);
    expect(ints([[1, 2]], 'list_sample', [p.lit(5), p.lit(1), p.lit(1)], 'list<int>')[0]).toHaveLength(5);
    expect(() => ints([[1, 2]], 'list_sample', [p.lit(3)], 'list<int>')).toThrow(/cannot take 3 of 2 elements without replacement/);
    expect(ints([null], 'list_sample', [p.lit(1)], 'list<int>')).toEqual([null]);
  });
});

describe('sets', () => {
  const a = [[1, 2, 2, null, 3], [], null];
  const b = list([3, 4, null, 4]);

  it('each element once, in first-appearance order, left list then right; NULL is one value', () => {
    expect(ints(a, 'list_union', [b], 'list<int>')).toEqual([[1, 2, null, 3, 4], [3, 4, null], null]);
    expect(ints(a, 'list_intersect', [b], 'list<int>')).toEqual([[null, 3], [], null]);
    expect(ints(a, 'list_except', [b], 'list<int>')).toEqual([[1, 2], [], null]);
    expect(ints(a, 'list_symmetric_except', [b], 'list<int>')).toEqual([[1, 2, 4], [3, 4, null], null]);
  });
});

describe('options of the earlier functions', () => {
  it('list_sort NULLs last', () => {
    expect(ints([[3, null, 1]], 'list_sort', [p.lit(0), p.lit(1)], 'list<int>')).toEqual([[1, 3, null]]);
    expect(ints([[3, null, 1]], 'list_sort', [p.lit(1), p.lit(1)], 'list<int>')).toEqual([[3, 1, null]]);
  });

  it('list_join keeping NULLs gives NULL for a NULL element', () => {
    expect(over('list<text>', [['a', null, 'b'], ['a']], 'list_join', [p.lit('-'), p.lit(1)], 'text')).toEqual([null, 'a']);
    expect(over('list<text>', [['a', null, 'b']], 'list_join', [p.lit('-'), p.lit(0)], 'text')).toEqual(['a-b']);
  });

  it('list_contains with NULLs not equal', () => {
    expect(ints([[1, null], [1]], 'list_contains', [p.lit(null), p.lit(0)], 'bool')).toEqual([null, null]);
    expect(ints([[1, null], [1]], 'list_contains', [p.lit(null), p.lit(1)], 'bool')).toEqual([true, false]);
    expect(ints([[1, null]], 'list_contains', [p.lit(1), p.lit(0)], 'bool')).toEqual([true]);
  });

  it('list_get failing out of range when strict', () => {
    expect(ints([[1, 2]], 'list_get', [p.lit(5), p.lit(0)], 'int')).toEqual([null]);
    expect(ints([[1, 2]], 'list_get', [p.lit(-2), p.lit(1)], 'int')).toEqual([1]);
    expect(() => ints([[1, 2]], 'list_get', [p.lit(2), p.lit(1)], 'int')).toThrow(/list_get: index 2 is out of range for a list of 2/);
  });
});
