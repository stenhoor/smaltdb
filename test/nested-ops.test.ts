/**
 * The list and struct operations (ADR 0020 step 2): building, the list_* operations, struct_field, implode, and
 * cast_text's JSON. Run with and without code generation and through the plan codec by the suite's modes.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanType } from '../src/engine/plan/types.js';
import { printPlan } from '../src/engine/plan/print.js';

const db = Database.openMemory();
const L = (t: string) => t as PlanType;

/** A column of lists `xs` of type `t`, and `fn(col, ...rest)` declared `type` over it. */
function over(t: string, xs: unknown[], fn: string, rest: PlanExpr[], type: string): unknown[] {
  const src = p.fromColumns([xs as never], [L(t)]);
  return db.queryPlan(p.project(src, [p.call(fn, [p.col(0, 0, L(t)), ...rest], L(type))])).rows.map((r) => r[0]);
}

describe('list operations', () => {
  const ints = [[3, 1, 2], [], null, [5, null, 5]];

  it('len, get, contains, slice, reverse', () => {
    expect(over('list<int>', ints, 'list_len', [], 'int')).toEqual([3, 0, null, 3]);
    expect(over('list<int>', ints, 'list_get', [p.lit(0)], 'int')).toEqual([3, null, null, 5]);
    expect(over('list<int>', ints, 'list_get', [p.lit(-1)], 'int')).toEqual([2, null, null, 5]);
    expect(over('list<int>', ints, 'list_get', [p.lit(9)], 'int')).toEqual([null, null, null, null]);
    expect(over('list<int>', ints, 'list_contains', [p.lit(5)], 'bool')).toEqual([false, false, null, true]);
    expect(over('list<int>', ints, 'list_contains', [p.lit(null)], 'bool')).toEqual([false, false, null, true]);
    expect(over('list<int>', ints, 'list_slice', [p.lit(1)], 'list<int>')).toEqual([[1, 2], [], null, [null, 5]]);
    expect(over('list<int>', ints, 'list_slice', [p.lit(-2), p.lit(1)], 'list<int>')).toEqual([[1], [], null, [null]]);
    expect(over('list<int>', ints, 'list_reverse', [], 'list<int>')).toEqual([[2, 1, 3], [], null, [5, null, 5]]);
  });

  it('sort, unique, concat, join', () => {
    expect(over('list<int>', ints, 'list_sort', [], 'list<int>')).toEqual([[1, 2, 3], [], null, [null, 5, 5]]);
    expect(over('list<int>', ints, 'list_sort', [p.lit(1)], 'list<int>')).toEqual([[3, 2, 1], [], null, [null, 5, 5]]);
    expect(over('list<int>', ints, 'list_unique', [], 'list<int>')).toEqual([[3, 1, 2], [], null, [5, null]]);
    expect(over('list<int>', ints, 'list_concat', [p.call('list_of', [p.lit(7)], L('list<int>'))], 'list<int>')).toEqual([[3, 1, 2, 7], [7], null, [5, null, 5, 7]]);
    expect(over('list<text>', [['a', 'b'], [], ['x', null]], 'list_join', [p.lit('-')], 'text')).toEqual(['a-b', '', 'x']);
    expect(over('list<date>', [[0, 1]], 'list_join', [p.lit(',')], 'text')).toEqual(['1970-01-01,1970-01-02']);
  });

  it('reductions skip nulls', () => {
    const xs = [[1, 2, null], [], [2.5, -1]];
    expect(over('list<int>', xs.slice(0, 2), 'list_sum', [], 'int')).toEqual([3, 0]);
    expect(over('list<real>', xs, 'list_mean', [], 'real')).toEqual([1.5, null, 0.75]);
    expect(over('list<real>', xs, 'list_min', [], 'real')).toEqual([1, null, -1]);
    expect(over('list<real>', xs, 'list_max', [], 'real')).toEqual([2, null, 2.5]);
    expect(() => over('list<text>', [['a']], 'list_sum', [], 'int')).toThrow(/list_sum takes a list of numbers/);
  });

  it('take lists only', () => {
    expect(() => over('int', [1], 'list_len', [], 'int')).toThrow(/list_len takes a list, not int/);
  });
});

describe('building and structs', () => {
  it('list_of and struct_of, and struct_field', () => {
    const r = db.queryPlan(
      p.project(p.values([[]]), [
        p.call('list_of', [p.lit(1), p.lit(null), p.lit(3)], L('list<int>')),
        p.call('struct_of', [p.lit('a'), p.lit(2.5)], L('struct<name text, score real>')),
        p.call('struct_field', [p.call('struct_of', [p.lit('a'), p.lit(2.5)], L('struct<name text, score real>')), p.lit(1)], 'real'),
        p.call('list_of', [p.call('list_of', [p.lit(1)], L('list<int>')), p.call('list_of', [], L('list<int>'))], L('list<list<int>>')),
      ]),
    ).rows[0];
    expect(r).toEqual([[1, null, 3], { name: 'a', score: 2.5 }, 2.5, [[1], []]]);
    expect(() => over('struct<a int>', [{ a: 1 }], 'struct_field', [p.lit(3)], 'int')).toThrow(/has no field 3/);
    expect(() => over('list<int>', [[1]], 'struct_field', [p.lit(0)], 'int')).toThrow(/struct_field takes a struct/);
  });
});

describe('implode', () => {
  it("collects a group's values in its order, nulls included", () => {
    const src = p.fromColumns([['a', 'b', 'a', 'a'], [1, 2, null, 3]], ['text', 'int']);
    const agg = p.aggregate(src, [p.col(0, 0, 'text')], [p.agg('implode', [p.col(0, 1, 'int')], L('list<int>'))]);
    const rows = db.queryPlan(p.sort(agg, [p.asc(p.col(0, 0, 'text'))])).rows;
    expect(rows).toEqual([['a', [1, null, 3]], ['b', [2]]]);
  });
});

describe('JSON text', () => {
  it('cast_text gives a list or struct as JSON', () => {
    const t = 'list<struct<d date, ok bool, n list<int>, big int>>';
    const v = [{ d: '2026-11-07', ok: true, n: [1, 2], big: 2n ** 60n }, null];
    expect(over(t, [v], 'cast_text', [], 'text')).toEqual(['[{"d":"2026-11-07","ok":true,"n":[1,2],"big":1152921504606846976},null]']);
    expect(over('list<text>', [['a"b', null]], 'cast_text', [], 'text')).toEqual(['["a\\"b",null]']);
  });
});

describe('explode', () => {
  const src = () => p.fromColumns([[1, 2, 3, 4], [[10, 20], [], null, [30]], ['a', 'b', 'c', 'd']], ['int', L('list<int>'), 'text']);

  it('one row per element, in the input order then the list order; as Polars, an empty list gives none, a NULL one NULL row', () => {
    expect(db.queryPlan(p.explode(src(), 1, L('list<int>'))).rows).toEqual([
      [1, 10, 'a'],
      [1, 20, 'a'],
      [3, null, 'c'],
      [4, 30, 'd'],
    ]);
    const ids = (o: Parameters<typeof p.explode>[3]) => db.queryPlan(p.explode(src(), 1, L('list<int>'), o)).rows.map((x) => x[0]);
    expect(ids({ emptyAsNull: true })).toEqual([1, 1, 2, 3, 4]);
    expect(ids({ keepNulls: false })).toEqual([1, 1, 4]);
    expect(ids({ emptyAsNull: true, keepNulls: false })).toEqual([1, 1, 2, 4]);
    const r = db.queryPlan(p.explode(src(), 1, L('list<int>'), { position: true }));
    expect(r.rows.map((x) => x[3])).toEqual([0, 1, 0, 0]);
  });

  it('nested lists and structs, and composed with other operations', () => {
    const t = 'list<struct<k text, v int>>';
    const nested = p.fromColumns([[[{ k: 'x', v: 1 }, { k: 'y', v: 2 }], [{ k: 'z', v: 3 }]]] as never, [L(t)]);
    expect(db.queryPlan(p.explode(nested, 0, L(t))).rows).toEqual([[{ k: 'x', v: 1 }], [{ k: 'y', v: 2 }], [{ k: 'z', v: 3 }]]);
    const exploded = p.explode(src(), 1, L('list<int>'));
    const sum = p.aggregate(exploded, [], [p.agg('sum', [p.col(0, 1, 'int')], 'int')]);
    expect(db.queryPlan(sum).rows).toEqual([[60]]);
    // explode then implode gives the lists back (an empty list's row is gone; a NULL list's NULL row comes back as [null]).
    const back = p.aggregate(exploded, [p.col(0, 0, 'int')], [p.agg('implode', [p.col(0, 1, 'int')], L('list<int>'))], { ordered: 'first' } as never);
    expect(db.queryPlan(p.sort(back, [p.asc(p.col(0, 0, 'int'))])).rows).toEqual([[1, [10, 20]], [3, [null]], [4, [30]]]);
  });

  it('several list columns zipped by position, as long as each other in each row', () => {
    const zip = () => p.fromColumns([[1, 2, 3, 4], [[10, 20], [], null, [30]], [['a', 'b'], [], null, ['c']], [[true, false], [], null, [null]]], ['int', L('list<int>'), L('list<text>'), L('list<bool>')]);
    const also = [{ column: 2, type: L('list<text>') }, { column: 3, type: L('list<bool>') }];
    const r = db.queryPlan(p.explode(zip(), 1, L('list<int>'), { also, position: true }));
    expect(r.rows).toEqual([
      [1, 10, 'a', true, 0],
      [1, 20, 'b', false, 1],
      [3, null, null, null, 0],
      [4, 30, 'c', null, 0],
    ]);
    expect(r.columnTypes).toEqual(['int', 'int', 'text', 'bool', 'int']);
    const ids = (o: Parameters<typeof p.explode>[3]) => db.queryPlan(p.explode(zip(), 1, L('list<int>'), { also, ...o })).rows.map((x) => x[0]);
    expect(ids({ emptyAsNull: true })).toEqual([1, 1, 2, 3, 4]);
    expect(ids({ keepNulls: false })).toEqual([1, 1, 4]);
    expect(printPlan(p.explode(zip(), 1, L('list<int>'), { also }))).toMatch(/^explode 1 list<int>, 2 list<text>, 3 list<bool>/);
  });

  it('zipped lists of different lengths are an error; a NULL list matches only NULL', () => {
    const run = (b: unknown[]) => () => db.queryPlan(p.explode(p.fromColumns([[[1, 2], [3]], b] as never, [L('list<int>'), L('list<int>')]), 0, L('list<int>'), { also: [{ column: 1, type: L('list<int>') }] }));
    expect(run([[1], [3]])).toThrow(/lists zipped together have different lengths: 2 and 1/);
    expect(run([[1, 2, 3], [3]])).toThrow(/different lengths: 2 and 3/);
    expect(run([[1, 2], null])).toThrow(/different lengths: 1 and null/);
    expect(run([[1, 2], [4]])).not.toThrow();
  });

  it('checks the zipped columns', () => {
    const one = (also: unknown) => () => db.queryPlan(p.explode(src(), 1, L('list<int>'), { also } as never));
    expect(one([{ column: 9, type: L('list<int>') }])).toThrow(/also\[0\]\.column: no column 9/);
    expect(one([{ column: 1, type: L('list<int>') }])).toThrow(/column 1 is exploded twice/);
    expect(one([{ column: 2, type: 'text' }])).toThrow(/also\[0\]\.type: expected a list type/);
  });

  it('a long list', () => {
    const xs = Array.from({ length: 2000 }, (_, i) => i);
    const r = db.queryPlan(p.explode(p.fromColumns([[xs]] as never, [L('list<int>')]), 0, L('list<int>')));
    expect(r.rows.map((x) => x[0])).toEqual(xs);
  });

  it('checks its column and type', () => {
    expect(() => db.queryPlan(p.explode(src(), 5, L('list<int>')))).toThrow(/no column 5/);
    expect(() => db.queryPlan(p.explode(src(), 1, 'int'))).toThrow(/expected a list type/);
  });
});
