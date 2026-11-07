/**
 * Logic nodes take any number of arguments (`p.and(a, b, c)`, `p.or(a, b, c)`): every one counts, in filters and in
 * values, with and without code generation (the suite's modes). Two compilers once read only the first two.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';

const db = Database.openMemory();
const src = p.fromColumns([[1, 2, 3, 4, null]], ['int']);
const eq = (v: number) => p.call('cmp_eq', [p.col(0, 0, 'int'), p.lit(v)], 'bool');
const gt = (v: number) => p.call('cmp_gt', [p.col(0, 0, 'int'), p.lit(v)], 'bool');
const ids = (pred: Parameters<typeof p.filter>[1]) => db.queryPlan(p.filter(src, pred)).rows.map((r) => r[0]);
const value = (e: Parameters<typeof p.project>[1][number]) => db.queryPlan(p.project(src, [e])).rows.map((r) => r[0]);

describe('logic nodes of any number of arguments', () => {
  it('or and and read every argument, in a filter and as a value', () => {
    expect(ids(p.or(eq(1), eq(2), eq(3)))).toEqual([1, 2, 3]);
    expect(ids(p.and(gt(0), gt(1), gt(2)))).toEqual([3, 4]);
    expect(value(p.or(eq(1), eq(2), eq(4)))).toEqual([true, true, false, true, null]);
    expect(value(p.and(gt(0), gt(1), gt(2), gt(3)))).toEqual([false, false, false, true, null]);
    expect(value(p.or(eq(9)))).toEqual([false, false, false, false, null]);
  });

  it('agree with JavaScript over random truth values, NULL included', () => {
    const tv = fc.constantFrom<0 | 1 | null>(0, 1, null);
    fc.assert(
      fc.property(fc.array(tv, { minLength: 1, maxLength: 6 }), (xs) => {
        const lits = xs.map((x) => p.lit(x, x === null ? 'null' : 'int'));
        const one = (e: Parameters<typeof p.project>[1][number]) => db.queryPlan(p.project(p.values([[]]), [e])).rows[0]![0];
        // Three-valued logic: false wins an and, true wins an or, else NULL if any is NULL.
        const and = xs.includes(0) ? false : xs.includes(null) ? null : true;
        const or = xs.includes(1) ? true : xs.includes(null) ? null : false;
        expect(one(p.and(...lits))).toBe(and);
        expect(one(p.or(...lits))).toBe(or);
      }),
      { numRuns: 300 },
    );
  });

  it('refuse none', () => {
    expect(() => db.queryPlan(p.filter(src, p.or()))).toThrow(/expected at least one argument/);
  });
});
