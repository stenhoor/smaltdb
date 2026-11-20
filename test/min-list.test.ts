/**
 * `min_list(a, b, …)`: the least of the lists a group's rows make of its arguments, which is what
 * `min(list_of(a, b, …))` gives, without a list made for every row. Here against that, over values of every kind, and
 * as the engine's own rewrite uses it: an aggregate's groups in the order of their first row in a sort.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { PlanType } from '../src/engine/plan/types.js';

const M = 'map<text, any>' as PlanType;
const col = (index: number, type: PlanType = 'int'): PlanExpr => p.col(0, index, type);
const rows = (db: Database, plan: PlanOp): unknown[][] => db.queryPlan(plan).rows as unknown[][];
/** The operators of a plan as EXPLAIN ANALYZE names them, from the top. */
const operators = (db: Database, plan: PlanOp): string[] =>
  (db.queryPlan({ kind: 'explain', mode: 'analyze', query: { kind: 'query', plan } } as never).rows as unknown[][]).map((r) => String(r[2]));

/** A small generator, so a failure names its seed. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** Values that tie, order and differ in kind: numbers of both kinds, NaN, text, NULL, truth values, lists, blobs. */
const POOL: unknown[] = [null, 0, -0, 1, 2, -1, 1.5, 2 ** 53, 2n ** 60n, NaN, Infinity, -Infinity, '', 'a', 'b', 'ab', 'é', '😀', true, false, [1], [1, 2], Uint8Array.of(1), Uint8Array.of(1, 0)];

describe('min_list', () => {
  const db = Database.openMemory();

  it('gives what min over list_of gives, for values of every kind', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const next = random(seed);
      const pick = (): unknown => POOL[Math.floor(next() * POOL.length)];
      const n = 400;
      const group = Array.from({ length: n }, () => Math.floor(next() * 7));
      // Each row's values as the entries of a map: a map takes every kind in from JavaScript, and its values are `any`.
      const held = Array.from({ length: n }, () => ({ a: pick(), b: pick(), c: pick() }));
      const source = p.fromColumns([group, held] as never, ['int', M]);
      const value = (k: string): PlanExpr => p.call('map_get', [col(1, M), p.lit(k)], 'any');
      const args = [value('a'), value('b'), value('c')];
      const L = 'list<any>' as PlanType;
      const plan = p.aggregate(source, [col(0)], [p.agg('min_list', args, L), p.agg('min', [p.call('list_of', args, L)], L), p.agg('min_list', args.slice(0, 1), L), p.agg('min', [p.call('list_of', args.slice(0, 1), L)], L)]);
      const got = rows(db, plan);
      expect(got.length).toBeGreaterThan(1);
      for (const r of got) {
        expect(r[1], `seed ${seed}, group ${String(r[0])}`).toEqual(r[2]);
        expect(r[3]).toEqual(r[4]);
      }
    }
  });

  it('keeps the type its arguments share, and takes whole numbers as they are', () => {
    const source = p.fromColumns(
      [
        [1, 1, 2, 2, 2],
        [5, 3, 9, 9, 9],
        [7, 8, 2, 1, 3],
      ],
      ['int', 'int', 'int'],
    );
    const L = 'list<int>' as PlanType;
    const plan = p.aggregate(source, [col(0)], [p.agg('min_list', [col(1), col(2)], L), p.agg('min', [p.call('list_of', [col(1), col(2)], L)], L)]);
    expect(rows(db, plan)).toEqual([
      [1, [3, 8], [3, 8]],
      [2, [9, 1], [9, 1]],
    ]);
    // Text and a number together are a list of any kind: text sorts after numbers.
    const mixed = p.aggregate(p.fromColumns([[1, 1], ['b', 'a'], [2, 3]] as never, ['int', 'text', 'int']), [col(0)], [p.agg('min_list', [col(1, 'text'), col(2)], 'list<any>' as PlanType)]);
    expect(rows(db, mixed)).toEqual([[1, ['a', 3]]]);
  });

  it('is NULL over no rows, and the same with DISTINCT', () => {
    const none = p.filter(p.fromColumns([[1, 2], [3, 4]], ['int', 'int']), p.call('cmp_gt', [col(0), p.lit(9)], 'bool'));
    expect(rows(db, p.aggregate(none, [], [p.agg('min_list', [col(0), col(1)], 'list<int>' as PlanType)]))).toEqual([[null]]);
    // Rows alike in their first argument are all read: DISTINCT, which an operator applies to the first, is not.
    const source = p.fromColumns([[1, 1, 1], [9, 4, 6]], ['int', 'int']);
    const distinct = p.aggregate(source, [], [p.agg('min_list', [col(0), col(1)], 'list<int>' as PlanType, { distinct: true })]);
    expect(rows(db, distinct)).toEqual([[[1, 4]]]);
  });

  it('reads the rows its FILTER passes', () => {
    const source = p.fromColumns([[1, 2, 3, 4], [9, 8, 7, 6]], ['int', 'int']);
    const plan = p.aggregate(source, [], [p.agg('min_list', [col(1), col(0)], 'list<int>' as PlanType, { filter: p.call('cmp_lt', [col(0), p.lit(3)], 'bool') })]);
    expect(rows(db, plan)).toEqual([[[8, 2]]]);
  });
});

describe('groups in the order of their first row in a sort', () => {
  const db = Database.openMemory();
  db.exec('CREATE TABLE t(g TEXT, k INTEGER, v INTEGER)');
  db.exec("INSERT INTO t VALUES ('b', 3, 1), ('a', 5, 2), ('b', 1, 3), ('c', NULL, 4), ('a', 2, 5), ('c', 2, 6), ('d', NULL, 7)");
  const scan = (): PlanOp => p.scan('t', [0, 1, 2]);
  const grouped = (input: PlanOp): PlanOp => p.aggregate(input, [col(0, 'text')], [p.agg('count', [], 'int', { star: true }), p.agg('sum', [col(2)], 'int')], { ordered: 'first' });

  it('come by their least sort keys, NULL keys where the sort puts them, ties by the rows as they came', () => {
    // k ascending, NULLs first (the default): c and d have NULLs (c came first), then b (1), then a (2).
    expect(rows(db, grouped(p.sort(scan(), [p.asc(col(1))])))).toEqual([
      ['c', 2, 10],
      ['d', 1, 7],
      ['b', 2, 4],
      ['a', 2, 7],
    ]);
    // NULLs last: b (1), then a and c tie at 2 (a's row came first), then d.
    expect(rows(db, grouped(p.sort(scan(), [p.asc(col(1), { nullsFirst: false })])))).toEqual([
      ['b', 2, 4],
      ['a', 2, 7],
      ['c', 2, 10],
      ['d', 1, 7],
    ]);
    // Two keys, under a projection that reorders the columns.
    const under = p.project(p.sort(scan(), [p.asc(col(2)), p.asc(col(1))]), [col(0, 'text'), col(1), col(2)]);
    expect(rows(db, grouped(under))).toEqual([
      ['b', 2, 4],
      ['a', 2, 7],
      ['c', 2, 10],
      ['d', 1, 7],
    ]);
  });

  it('numbers the rows under a projection the sort reads, so one projection is left over the rows', () => {
    // As a front end's plans are: a projection under the sort that gives it its key, and projections over the sort.
    const under = p.project(scan(), [col(0, 'text'), col(2), p.lit('x'), col(1)]);
    const over = p.project(p.project(p.sort(under, [p.asc(col(3))]), [col(1), col(0, 'text'), col(2, 'text')]), [col(0), col(1, 'text')]);
    const plan = p.aggregate(over, [col(1, 'text')], [p.agg('count', [], 'int', { star: true }), p.agg('sum', [col(0)], 'int')], { ordered: 'first' });
    expect(rows(db, plan)).toEqual([
      ['c', 2, 10],
      ['d', 1, 7],
      ['b', 2, 4],
      ['a', 2, 7],
    ]);
    // Under the aggregate: one projection, the rows' numbers, the table.
    const ops = operators(db, plan);
    expect(ops.slice(ops.indexOf('USE TEMP B-TREE FOR GROUP BY') + 1).map((o) => o.split(' ')[0])).toEqual(['PROJECT', 'WINDOW', 'SCAN']);
  });

  it('are the same groups where the sort reads a projection, or two, and projections read the sort', () => {
    const next = random(23);
    const n = 300;
    const g = Array.from({ length: n }, () => `g${Math.floor(next() * 12)}`);
    const k = Array.from({ length: n }, () => (next() < 0.1 ? null : Math.floor(next() * 20)));
    const source = (): PlanOp => p.fromColumns([g, k, k.map((_, i) => i)] as never, ['text', 'int', 'int']);
    // By hand: the rows in the sort's order (stable, NULLs first), each group at its first row.
    const order = g.map((_, i) => i).sort((x, y) => {
      const a = k[x]!;
      const b = k[y]!;
      if (a === null || b === null) return a === b ? x - y : a === null ? -1 : 1;
      return a - b || x - y;
    });
    const want = [...new Set(order.map((i) => g[i]))];
    const add = (a: PlanExpr, b: PlanExpr): PlanExpr => p.call('add', [a, b], 'int');
    // The key first: the columns in another order; and the key computed, then read twice by a second projection,
    // which keeps the two apart.
    const one = p.project(source(), [col(1), col(0, 'text'), col(2)]);
    const two = p.project(p.project(source(), [col(0, 'text'), add(col(1), p.lit(5)), col(2)]), [col(1), col(0, 'text'), col(2), col(1)]);
    for (const [name, input] of [
      ['one projection', one],
      ['two projections', two],
    ] as const) {
      const read = p.project(p.project(p.sort(input, [p.asc(col(0))]), [col(1, 'text'), col(2), col(0)]), [col(0, 'text'), col(1)]);
      const plan = p.aggregate(read, [col(0, 'text')], [p.agg('count', [], 'int', { star: true }), p.agg('max', [col(1)], 'int')], { ordered: 'first' });
      const got = rows(db, plan);
      expect(got.map((r) => r[0]), name).toEqual(want);
      for (const r of got) {
        const of = g.flatMap((x, i) => (x === r[0] ? [i] : []));
        expect([r[1], r[2]], `${name}, ${String(r[0])}`).toEqual([of.length, of[of.length - 1]]);
      }
    }
  });

  it('are the groups a sort of the rows and then the aggregate would give', () => {
    const next = random(11);
    const n = 300;
    const data = [Array.from({ length: n }, () => `g${Math.floor(next() * 12)}`), Array.from({ length: n }, () => (next() < 0.1 ? null : Math.floor(next() * 20))), Array.from({ length: n }, (_, i) => i)];
    const source = (): PlanOp => p.fromColumns(data as never, ['text', 'int', 'int']);
    for (const nullsFirst of [true, false]) {
      const sort = p.sort(source(), [p.asc(col(1), { nullsFirst })]);
      const got = rows(db, grouped(sort)).map((r) => r[0]);
      // By hand: the rows in the sort's order (stable), each group at its first row.
      const order = data[0]!.map((_, i) => i).sort((x, y) => {
        const a = data[1]![x] as number | null;
        const b = data[1]![y] as number | null;
        if (a === null || b === null) return a === b ? x - y : (a === null) === nullsFirst ? -1 : 1;
        return a - b || x - y;
      });
      expect(got, `nulls first: ${nullsFirst}`).toEqual([...new Set(order.map((i) => data[0]![i]))]);
    }
  });
});
