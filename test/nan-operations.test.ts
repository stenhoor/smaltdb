/**
 * NaN in operations (ADR 0018 section 2): the operations whose behaviour is IEEE 754 keep a NaN result (`div_float`,
 * `div_floor`, `mod_floor`, the checked arithmetic on reals, `cast_real_strict`, and the aggregates `sum_float` and
 * `avg_float`), and those whose behaviour is SQLite's keep turning it into NULL (`add`, `sub`, `mul`, `div_trunc`,
 * `sum`, `total`, `avg`).
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';

const d = Database.openMemory();
const real = (v: number) => p.lit(v, 'real');
/** One value of a call on literals. */
const one = (fn: string, args: PlanExpr[], type: 'int' | 'real' | 'num' = 'real') => d.queryPlan(p.project(p.values([[]]), [p.call(fn, args, type)])).rows[0][0];
/** An aggregate over the values `xs` of a REAL column. */
const agg = (fn: string, xs: number[]) => d.queryPlan(p.aggregate(p.fromColumns([Float64Array.from(xs)], ['real']), [], [p.agg(fn, [p.col(0, 0, 'real')], 'real')])).rows[0][0];

describe('IEEE operations keep NaN', () => {
  it('division and remainder', () => {
    expect(one('div_float', [real(0), real(0)])).toBeNaN();
    expect(one('div_float', [real(NaN), real(2)])).toBeNaN();
    expect(one('div_float', [real(1), real(0)])).toBe(Infinity);
    expect(one('div_floor', [real(NaN), real(2)])).toBeNaN();
    expect(one('div_floor', [real(Infinity), real(Infinity)])).toBeNaN();
    expect(one('mod_floor', [real(Infinity), real(2)])).toBeNaN();
    expect(one('mod_floor', [real(NaN), real(2)])).toBeNaN();
    // Division by zero stays NULL, as documented for div_floor and mod_floor.
    expect(one('div_floor', [real(1), real(0)])).toBeNull();
    expect(one('mod_floor', [real(1), real(0)])).toBeNull();
  });

  it('the checked arithmetic on reals', () => {
    expect(one('add_checked', [real(Infinity), real(-Infinity)])).toBeNaN();
    expect(one('sub_checked', [real(Infinity), real(Infinity)])).toBeNaN();
    expect(one('mul_checked', [real(0), real(Infinity)])).toBeNaN();
    expect(one('add_checked', [real(NaN), real(1)])).toBeNaN();
    expect(one('add_checked', [real(1.5), real(1)])).toBe(2.5);
  });

  it('conversion', () => {
    expect(one('cast_real_strict', [real(NaN)])).toBeNaN();
    expect(one('cast_real', [real(NaN)])).toBeNaN();
  });

  it('sum_float and avg_float', () => {
    expect(agg('sum_float', [1, NaN, 2])).toBeNaN();
    expect(agg('sum_float', [Infinity, -Infinity])).toBeNaN();
    expect(agg('sum_float', [1, 2.5])).toBe(3.5);
    expect(agg('sum_float', [1, Infinity])).toBe(Infinity);
    expect(agg('avg_float', [1, NaN])).toBeNaN();
    expect(agg('avg_float', [1, 2])).toBe(1.5);
    expect(agg('sum_float', [])).toBeNull();
    // On integers it is sum.
    const ints = d.queryPlan(p.aggregate(p.fromColumns([new Int32Array([1, 2])], ['int']), [], [p.agg('sum_float', [p.col(0, 0, 'int')], 'int')]));
    expect(ints.rows).toEqual([[3]]);
    expect(ints.columnTypes).toEqual(['int']);
  });

  it('sum_float over a sliding frame drops a NaN once it leaves the frame', () => {
    const xs = [1, NaN, 2, 3, 4];
    const v = p.fromColumns([Int32Array.from(xs, (_, i) => i), Float64Array.from(xs)], ['int', 'real']);
    const w = p.window(v, [p.windowCall('sum_float', [p.col(0, 1, 'real')], 'real')], { order: [p.asc(p.col(0, 0, 'int'))], frame: p.frame('ROWS', p.preceding(1), p.following(0)) });
    const sums = d.queryPlan(w).rows.map((r) => r[2]);
    // Frames: [1], [1, NaN], [NaN, 2], [2, 3], [3, 4].
    expect(sums).toEqual([1, NaN, NaN, 5, 7]);
  });
});

describe("SQLite's operations keep turning NaN into NULL", () => {
  it('arithmetic', () => {
    expect(one('add', [real(Infinity), real(-Infinity)])).toBeNull();
    expect(one('mul', [real(0), real(Infinity)])).toBeNull();
    expect(one('div_trunc', [real(0), real(0)])).toBeNull();
  });

  it('sum, total and avg', () => {
    expect(agg('sum', [Infinity, -Infinity])).toBeNull();
    expect(agg('total', [Infinity, -Infinity])).toBeNull();
    expect(agg('avg', [Infinity, -Infinity])).toBeNull();
  });
});

it('sum_float and avg_float are in the function catalog', () => {
  expect(d.catalog.function('sum_float', 'aggregate')).toMatchObject({ name: 'sum_float', kind: 'aggregate' });
  expect(d.catalog.function('avg_float', 'aggregate')).toMatchObject({ name: 'avg_float', kind: 'aggregate', result: 'real' });
});
