/**
 * Expressions over a list's elements (ADR 0031 step 5): `each` in map, filter and agg modes, reading the element, its
 * position and the row's columns, nested, and checked by the validator.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { EachAggCall, PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanType } from '../src/engine/plan/types.js';
import type { ColumnDef, StorageType } from '../src/engine/plan/schema.js';
import { printExpr } from '../src/engine/plan/print.js';

const db = Database.openMemory();
const L = (t: string) => t as PlanType;
const ints = [[3, 1, 2], [], null, [5, null, 5]];
const list = p.col(0, 0, L('list<int>'));
const el = p.element('int');

/** `expr` over a column of lists `xs` of type `t` (and an int column, `col(0, 1)`, of `k`). */
function over(expr: PlanExpr, xs: unknown[] = ints, t = 'list<int>', k: unknown[] = xs.map((_x, i) => i)): unknown[] {
  const src = p.fromColumns([xs as never, k as never], [L(t), 'int']);
  return db.queryPlan(p.project(src, [expr])).rows.map((r) => r[0]);
}

const agg = (fn: string, args: PlanExpr[], type: PlanType, more: Partial<EachAggCall<PlanExpr>> = {}): EachAggCall<PlanExpr> => ({ fn, args, star: args.length === 0, distinct: false, collation: 'binary', type, ...more });

describe('each: map', () => {
  it('gives the body for each element; a NULL list NULL, an empty one []', () => {
    expect(over(p.listMap(list, p.call('add', [el, p.lit(1)], 'int')))).toEqual([[4, 2, 3], [], null, [6, null, 6]]);
  });

  it('reads the position and the row', () => {
    expect(over(p.listMap(list, p.elementPosition()))).toEqual([[0, 1, 2], [], null, [0, 1, 2]]);
    expect(over(p.listMap(list, p.call('mul', [el, p.col(0, 1, 'int')], 'int')))).toEqual([[0, 0, 0], [], null, [15, null, 15]]);
  });

  it('changes the element type', () => {
    const e = p.listMap(list, p.cast('cast_text', el, 'text'));
    expect(printExpr(e)).toBe('each map(#0.0: cast_text(@value))');
    expect(over(e)).toEqual([['3', '1', '2'], [], null, ['5', null, '5']]);
  });
});

describe('each: filter', () => {
  it('keeps the elements whose body is true, in order', () => {
    expect(over(p.listFilter(list, p.call('cmp_gt', [el, p.lit(1)], 'bool')))).toEqual([[3, 2], [], null, [5, 5]]);
    expect(over(p.listFilter(list, p.isNotNull(el)))).toEqual([[3, 1, 2], [], null, [5, 5]]);
  });

  it('a NULL body drops the element', () => {
    expect(over(p.listFilter(list, p.lit(null, 'bool')))).toEqual([[], [], null, []]);
  });
});

describe('each: agg', () => {
  it('runs any aggregate over the elements', () => {
    const e = p.listAgg(list, [agg('sum', [el], 'int'), agg('count', [], 'int')], p.call('add', [p.aggResult(0, 'int'), p.aggResult(1, 'int')], 'int'));
    expect(over(e)).toEqual([9, null, null, 13]);
    expect(over(p.listAgg(list, [agg('count', [el], 'int', { distinct: true })], p.aggResult(0, 'int')))).toEqual([3, 0, null, 1]);
    expect(over(p.listAgg(list, [agg('max', [el], 'int', { filter: p.call('cmp_lt', [el, p.lit(3)], 'bool') })], p.aggResult(0, 'int')))).toEqual([2, null, null, null]);
    expect(over(p.listAgg(list, [agg('implode', [el], L('list<int>'))], p.aggResult(0, L('list<int>'))))).toEqual([[3, 1, 2], [], null, [5, null, 5]]);
  });

  it('reads the row in arguments and body', () => {
    const e = p.listAgg(list, [agg('sum', [p.call('add', [el, p.col(0, 1, 'int')], 'int')], 'int')], p.call('mul', [p.aggResult(0, 'int'), p.col(0, 1, 'int')], 'int'));
    expect(over(e)).toEqual([0, null, null, 3 * (5 + 3 + 5 + 3)]);
  });
});

describe('each: nesting', () => {
  const nested = [[[1, 2], [3]], [[]], null, [null, [4, 5, 6]]];
  const outer = p.col(0, 0, L('list<list<int>>'));

  it('reads the innermost element by default and an outer one by depth', () => {
    const inner = p.element(L('list<int>'));
    // Each inner list's elements plus the inner list's position in the outer list.
    const e = p.listMap(outer, p.listMap(inner, p.call('add', [p.element('int'), p.elementPosition(1)], 'int')));
    expect(over(e, nested, 'list<list<int>>')).toEqual([[[1, 2], [4]], [[]], null, [null, [5, 6, 7]]]);
  });

  it('aggregates inner lists', () => {
    const e = p.listMap(outer, p.listAgg(p.element(L('list<int>')), [agg('sum', [p.element('int')], 'int')], p.aggResult(0, 'int')));
    expect(over(e, nested, 'list<list<int>>')).toEqual([[3, 3], [null], null, [null, 15]]);
  });
});

describe('each: validation', () => {
  const run = (e: PlanExpr) => () => over(e);

  it('refuses an element outside an each, or too far out', () => {
    expect(run(el)).toThrow(/element of each 0 levels out, which does not exist/);
    expect(run(p.listMap(list, p.element('int', 1)))).toThrow(/element of each 1 levels out/);
  });

  it('refuses an aggregate result outside an agg body, and the element in one', () => {
    expect(run(p.listMap(list, p.aggResult(0, 'int')))).toThrow(/eachAgg outside an agg body/);
    expect(run(p.listAgg(list, [agg('sum', [el], 'int')], p.aggResult(1, 'int')))).toThrow(/aggregate 1 of 1/);
    expect(run(p.listAgg(list, [agg('sum', [el], 'int')], el))).toThrow(/an agg body reads its aggregates, not the element/);
    expect(run(p.listAgg(list, [agg('sum', [p.aggResult(0, 'int')], 'int')], p.aggResult(0, 'int')))).toThrow(/eachAgg outside an agg body/);
  });

  it('refuses a non-list and an unknown aggregate', () => {
    expect(run(p.listMap(p.col(0, 1, 'int'), p.lit(1)))).toThrow(/each reads a list, not "int"/);
    expect(run(p.listAgg(list, [agg('nope', [el], 'int')], p.aggResult(0, 'int')))).toThrow(/no such aggregate function: nope/);
  });

  it('does not let a nested plan read the element', () => {
    const sub = p.scalar(p.project(p.values([[p.lit(1)]]), [p.element('int', 0)]), 'int');
    expect(run(p.listMap(list, sub))).toThrow(/element of each 0 levels out, which does not exist/);
  });
});

describe('each in operations over a table', () => {
  for (const storage of ['row', 'columnar'] as const) {
    it(`filters, groups and sorts by each on a ${storage} table`, () => {
      const tdb = Database.openMemory();
      const col = (name: string, type: StorageType, declaredType: string): ColumnDef => ({ name, declaredType, type, notNull: false, collation: 'binary' });
      tdb.queryPlan({ kind: 'schema', op: { op: 'createTable', table: { name: 't', columns: [col('id', 'INTEGER', 'INTEGER'), col('v', 'LIST', 'list<int>')], keys: [], checks: [], foreignKeys: [], storage }, temp: false, ifNotExists: false } });
      const n = 3000;
      const of = (i: number): number[] => Array.from({ length: i % 5 }, (_x, j) => i + j);
      const vals = (xs: number[]): PlanExpr => p.call('list_of', xs.map((x) => p.lit(x)), L('list<int>'));
      for (let s = 0; s < n; s += 500) {
        const rows = Array.from({ length: 500 }, (_x, k) => s + k).map((i) => [p.lit(i), vals(of(i))]);
        tdb.queryPlan({ kind: 'write', plan: p.append('t', p.values(rows, ['int', L('list<int>')]), [0, 1]) });
      }
      const v = p.col(0, 1, L('list<int>'));
      const sum = p.listAgg(v, [agg('sum', [el], 'int')], p.aggResult(0, 'int'));
      // Rows whose list sums past 10, by the number of their even elements.
      const kept = p.filter(p.scan('t', [0, 1]), p.call('cmp_gt', [sum, p.lit(10)], 'bool'));
      const evens = p.call('list_len', [p.listFilter(v, p.call('cmp_eq', [p.call('mod', [el, p.lit(2)], 'int'), p.lit(0)], 'bool'))], 'int');
      const grouped = p.aggregate(kept, [evens], [p.agg('count', [], 'int', { star: true })]);
      const got = tdb.queryPlan(p.sort(grouped, [p.asc(p.col(0, 0, 'int'))])).rows;
      const want = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        const xs = of(i);
        if (xs.reduce((a, b) => a + b, 0) <= 10) continue;
        const e = xs.filter((x) => x % 2 === 0).length;
        want.set(e, (want.get(e) ?? 0) + 1);
      }
      expect(got).toEqual([...want].sort((a, b) => a[0] - b[0]));
    });
  }
});
