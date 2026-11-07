/**
 * Order guarantees (ADR 0016 section 4): `sort` is stable, in memory, as a top-N and when it spills, on row and
 * columnar tables and with an index on the key; `filter`, `project`, `limit` and a `window` without its own order keep
 * their input's order; `semi` and `anti` joins keep the left input's order, top-level and nested, with and without a
 * condition and with conditions that read an enclosing plan's row; a `unionAll` gives its first input's rows, then its
 * second's.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';

const N = 3000;

function table(storage: 'row' | 'columnar', index = false): Database {
  const d = Database.openMemory();
  d.exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, k INT, v INT)${storage === 'columnar' ? " WITH (storage = 'columnar')" : ''}`);
  if (index) d.exec('CREATE INDEX t_k ON t(k)');
  d.exec('BEGIN');
  const ins = d.prepare('INSERT INTO t VALUES (?, ?, ?)');
  // k repeats (seven values) and the rows come in id order, so ties in k show whether order was kept.
  for (let i = 1; i <= N; i++) ins.run([i, i % 7, (i * 7919) % N]);
  d.exec('COMMIT');
  if (storage === 'columnar') d.exec('PRAGMA compact(t)');
  d.exec('ANALYZE');
  return d;
}

/** Rows sorted by `keyOf` with ties in the order of `inputOf`: what a stable sort of rows in that order gives. */
function stableSorted<T>(rows: T[], keyOf: (r: T) => number, desc: boolean): T[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (desc ? keyOf(b.r) - keyOf(a.r) : keyOf(a.r) - keyOf(b.r)) || a.i - b.i)
    .map((x) => x.r);
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const k = p.col(0, 1, 'int');
const id = p.col(0, 0, 'int');
/** Rows of the form [id, k], in id order: the plan input every test reorders. */
const byId = p.sort(p.scan('t', [0, 1]), [p.asc(id)]);

describe('sort is stable', () => {
  for (const [storage, index] of [['row', false], ['row', true], ['columnar', false]] as const) {
    describe(`${storage} table${index ? ' with an index on the key' : ''}`, () => {
      const d = table(storage, index);
      const expected = (desc: boolean) => stableSorted(ids(N).map((i) => [i, i % 7]), (r) => r[1], desc);
      const sorted = (desc: boolean, input: PlanOp = p.scan('t', [0, 1])) => p.sort(input, [desc ? p.desc(k) : p.asc(k)]);

      for (const desc of [false, true]) {
        const dir = desc ? 'descending' : 'ascending';
        it(`${dir}, in memory`, () => {
          expect(d.queryPlan(sorted(desc)).rows).toEqual(expected(desc));
          // Over an input already in an order of its own: ties keep that order, not the table's.
          const reversed = p.sort(p.scan('t', [0, 1]), [p.desc(id)]);
          const fromReversed = stableSorted(ids(N).reverse().map((i) => [i, i % 7]), (r) => r[1], desc);
          expect(d.queryPlan(sorted(desc, reversed)).rows).toEqual(fromReversed);
        });
        it(`${dir}, as a top-N`, () => {
          expect(d.queryPlan(p.limit(sorted(desc), 50)).rows).toEqual(expected(desc).slice(0, 50));
          expect(d.queryPlan(p.limit(sorted(desc), 50, 400)).rows).toEqual(expected(desc).slice(400, 450));
        });
        it(`${dir}, when it spills`, () => {
          d.exec('PRAGMA work_mem = 16384');
          try {
            expect(d.queryPlan(sorted(desc)).rows).toEqual(expected(desc));
          } finally {
            d.exec('PRAGMA work_mem = 67108864');
          }
        });
      }
    });
  }
});

describe('filter, project, limit and window keep their input order', () => {
  const d = table('row');
  const reversed = p.sort(p.scan('t', [0, 1]), [p.desc(id)]);
  const reversedIds = ids(N).reverse();

  it('filter', () => {
    const gt = d.queryPlan(p.filter(reversed, p.call('cmp_gt', [k, p.lit(3)], 'int'))).rows.map((r) => r[0]);
    expect(gt).toEqual(reversedIds.filter((i) => i % 7 > 3));
    const eq = d.queryPlan(p.filter(byId, p.call('cmp_eq', [k, p.lit(3)], 'int'))).rows.map((r) => r[0]);
    expect(eq).toEqual(ids(N).filter((i) => i % 7 === 3));
  });

  it('project', () => {
    const r = d.queryPlan(p.project(reversed, [p.call('mul', [id, p.lit(2)], 'int')])).rows.map((x) => x[0]);
    expect(r).toEqual(reversedIds.map((i) => i * 2));
  });

  it('limit', () => {
    expect(d.queryPlan(p.limit(reversed, 5, 10)).rows.map((r) => r[0])).toEqual(reversedIds.slice(10, 15));
    expect(d.queryPlan(p.limit(p.project(byId, [id]), 100, 10)).rows.map((r) => r[0])).toEqual(ids(N).slice(10, 110));
  });

  it('a window without its own order, partitioned or not', () => {
    const count = { fn: 'count', args: [], star: true, distinct: false, collation: 'binary', type: 'int' } as const;
    const frame = { unit: 'ROWS', start: { kind: 'unboundedPreceding' }, end: { kind: 'unboundedFollowing' }, exclude: 'NO OTHERS' } as const;
    for (const partition of [[], [{ expr: k, collation: 'binary' as const }]]) {
      const w = { op: 'window', input: reversed, partition, order: [], frame, calls: [count] } as unknown as PlanOp;
      expect(d.queryPlan(w).rows.map((r) => r[0])).toEqual(reversedIds);
    }
  });

  it('a window without its own order numbers, navigates and frames its rows in input order', () => {
    const rows = { unit: 'ROWS', start: { kind: 'unboundedPreceding' }, end: { kind: 'currentRow' }, exclude: 'NO OTHERS' } as const;
    const calls = [p.windowCall('row_number', [], 'int'), p.windowCall('lag', [id], 'int'), p.windowCall('sum', [id], 'int')];
    for (const part of [false, true]) {
      const w = p.window(reversed, calls, { ...(part ? { partition: [k] } : {}), frame: rows as never });
      const got = d.queryPlan(w).rows as number[][];
      // Expected, walking the input (reversed ids) in order, per partition when there is one.
      const seen = new Map<number, { n: number; prev: number | null; sum: number }>();
      const want = reversedIds.map((i) => {
        const key = part ? i % 7 : 0;
        const st = seen.get(key) ?? { n: 0, prev: null, sum: 0 };
        const row = [i, i % 7, st.n + 1, st.prev, st.sum + i];
        seen.set(key, { n: st.n + 1, prev: i, sum: st.sum + i });
        return row;
      });
      expect(got, part ? 'partitioned' : 'one partition').toEqual(want);
    }
  });

  it('a window over a window, reading what the inner one computes', () => {
    const frame = { unit: 'ROWS', start: { kind: 'unboundedPreceding' }, end: { kind: 'currentRow' }, exclude: 'NO OTHERS' } as const;
    const call = (fn: string, args: PlanExpr[]) => ({ fn, args, star: false, collation: 'binary', type: 'int' }) as const;
    const inner = { op: 'window', input: p.limit(reversed, 5), partition: [], order: [], frame, calls: [call('row_number', [])] } as unknown as PlanOp;
    // A running sum of the inner window's row numbers: 1, 3, 6, 10, 15.
    const outer = { op: 'window', input: inner, partition: [], order: [], frame, calls: [call('sum', [p.col(0, 2, 'int')])] } as unknown as PlanOp;
    expect(d.queryPlan(outer).rows).toEqual(reversedIds.slice(0, 5).map((i, n) => [i, i % 7, n + 1, ((n + 1) * (n + 2)) / 2]));
  });
});

describe('semi and anti joins keep the left order', () => {
  const d = Database.openMemory();
  d.exec('CREATE TABLE l(id INTEGER PRIMARY KEY, k INT); CREATE TABLE r(id INTEGER PRIMARY KEY, k INT)');
  d.exec('BEGIN');
  for (let i = 1; i <= 2000; i++) d.exec(`INSERT INTO l VALUES (${i}, ${(i * 7919) % 300})`);
  for (let i = 1; i <= 500; i++) d.exec(`INSERT INTO r VALUES (${i}, ${(i * 31) % 200})`);
  d.exec('COMMIT; ANALYZE');
  const lk = (i: number) => (i * 7919) % 300;
  const rks = new Set(Array.from({ length: 500 }, (_, i) => ((i + 1) * 31) % 200));
  const on = p.call('cmp_eq', [p.col(0, 1, 'int'), p.col(1, 1, 'int')], 'int');
  // The left input in an order of its own (k descending, ties by id), not the table's.
  const left = p.sort(p.scan('l', [0, 1]), [p.desc(p.col(0, 1, 'int'))]);
  const leftRows = stableSorted(ids(2000).map((i) => [i, lk(i)]), (r) => r[1], true);

  it('with a condition', () => {
    expect(d.queryPlan(p.join('semi', left, p.scan('r', [0, 1]), on)).rows).toEqual(leftRows.filter((x) => rks.has(x[1])));
    expect(d.queryPlan(p.join('anti', left, p.scan('r', [0, 1]), on)).rows).toEqual(leftRows.filter((x) => !rks.has(x[1])));
  });

  it('without a condition: every left row, or none, by whether the right side has rows', () => {
    const empty = p.filter(p.scan('r', [0]), p.lit(0));
    expect(d.queryPlan(p.join('semi', left, p.scan('r', [0]))).rows).toEqual(leftRows);
    expect(d.queryPlan(p.join('semi', left, empty)).rows).toEqual([]);
    expect(d.queryPlan(p.join('anti', left, p.scan('r', [0]))).rows).toEqual([]);
    expect(d.queryPlan(p.join('anti', left, empty)).rows).toEqual(leftRows);
  });

  it('under other operations and inside a subquery that reads the enclosing row', () => {
    const counted = d.queryPlan(p.aggregate(p.join('semi', p.scan('l', [0, 1]), p.scan('r', [0, 1]), on), [], [p.agg('count', [], 'int', { star: true })])).rows;
    expect(counted).toEqual([[leftRows.filter((x) => rks.has(x[1])).length]]);
    // For each row of r: how many rows of l have its k, through a semi join whose condition reads that row of r.
    const matches = p.and(on, p.call('cmp_eq', [p.col(1, 1, 'int'), p.col(0, 1, 'int', 'binary', 1)], 'int'));
    const perRow = p.aggregate(p.join('semi', p.scan('l', [0, 1]), p.scan('r', [0, 1]), matches), [], [p.agg('count', [], 'int', { star: true })]);
    const q = p.project(p.limit(p.scan('r', [0, 1]), 20), [p.col(0, 0, 'int'), { k: 'subquery', mode: 'scalar', plan: perRow, type: 'int', collation: 'binary' }]);
    const expected = ids(20).map((i) => [i, ids(2000).filter((j) => lk(j) === (i * 31) % 200).length]);
    expect(d.queryPlan(q).rows).toEqual(expected);
    // Nested in an aggregate call's argument.
    const inAgg = p.aggregate(p.limit(p.scan('r', [0, 1]), 20), [], [p.agg('sum', [{ k: 'subquery', mode: 'scalar', plan: perRow, type: 'int', collation: 'binary' }], 'int')]);
    expect(d.queryPlan(inAgg).rows).toEqual([[expected.reduce((s, r) => s + r[1], 0)]]);
  });

  it('in the input of a write', () => {
    const w = Database.openMemory();
    w.exec('CREATE TABLE l(id INTEGER PRIMARY KEY, k INT); CREATE TABLE r(k INT); INSERT INTO l VALUES (1, 1), (2, 2), (3, 3), (4, 4); INSERT INTO r VALUES (2), (4)');
    const matched = (kind: 'semi' | 'anti') => p.join(kind, p.scan('l', [-1, 1]), p.scan('r', [0]), p.call('cmp_eq', [p.col(0, 1, 'int'), p.col(1, 0, 'int')], 'int'));
    expect(w.queryPlan({ kind: 'write', plan: p.remove('l', matched('semi'), 0) }).changes).toBe(2);
    expect(w.queryPlan(p.scan('l', [0])).rows).toEqual([[1], [3]]);
    const copied = p.append('r', p.project(matched('anti'), [p.col(0, 1, 'int')]), [0]);
    expect(w.queryPlan({ kind: 'write', plan: copied }).changes).toBe(2);
    expect(w.queryPlan(p.scan('r', [0])).rows).toEqual([[2], [4], [1], [3]]);
  });
});

describe("unionAll gives its first input's rows, then its second's, each in its order", () => {
  for (const storage of ['row', 'columnar'] as const) {
    it(storage, () => {
      const d = table(storage);
      // Two inputs in orders of their own (k descending; v ascending), over the same table.
      const first = p.filter(p.sort(p.scan('t', [0, 1]), [p.desc(k)]), p.call('cmp_lt', [id, p.lit(500)], 'int'));
      const second = p.project(p.sort(p.scan('t', [0, 2]), [p.asc(p.col(0, 1, 'int'))]), [id, p.col(0, 1, 'int')]);
      const rows = d.queryPlan(p.setop('unionAll', first, second, 2)).rows;
      const a = stableSorted(ids(499).map((i) => [i, i % 7]), (r) => r[1], true);
      const b = stableSorted(ids(N).map((i) => [i, (i * 7919) % N]), (r) => r[1], false);
      expect(rows).toEqual([...a, ...b]);
      // Nested: a union of unions keeps the order of all its inputs.
      const nested = d.queryPlan(p.setop('unionAll', p.setop('unionAll', first, first, 2), second, 2)).rows;
      expect(nested).toEqual([...a, ...a, ...b]);
    });
  }
});

describe('order on request', () => {
  const d = Database.openMemory();
  d.exec("CREATE TABLE a(id INTEGER PRIMARY KEY, k INT, name TEXT); CREATE TABLE b(id INTEGER PRIMARY KEY, k INT)");
  d.exec('BEGIN');
  const A = ids(400).map((i) => [i, (i * 37) % 23, ['x', 'X', 'y', 'Y', 'z'][i % 5]] as [number, number, string]);
  const B = ids(300).map((i) => [i, (i * 11) % 31] as [number, number]);
  for (const r of A) d.exec(`INSERT INTO a VALUES (${r[0]}, ${r[1]}, '${r[2]}')`);
  for (const r of B) d.exec(`INSERT INTO b VALUES (${r[0]}, ${r[1]})`);
  d.exec('COMMIT; ANALYZE');
  // Both inputs in an order of their own: a by k descending (ties by id), b by id descending.
  const left = p.sort(p.scan('a', [0, 1]), [p.desc(p.col(0, 1, 'int'))]);
  const leftRows = stableSorted(A.map((r) => [r[0], r[1]]), (r) => r[1], true);
  const right = p.sort(p.scan('b', [0, 1]), [p.desc(p.col(0, 0, 'int'))]);
  const rightRows = [...B].reverse().map((r) => [r[0], r[1]]);
  const on = p.call('cmp_eq', [p.col(0, 1, 'int'), p.col(1, 1, 'int')], 'int');
  const matches = (l: number[]) => rightRows.filter((r) => r[1] === l[1]);

  it('join with ordered: the left order, and for each left row its matches in the right order', () => {
    const inner = leftRows.flatMap((l) => matches(l).map((r) => [...l, ...r]));
    expect(d.queryPlan(p.join('inner', left, right, on, { ordered: true })).rows).toEqual(inner);
    const leftJoin = leftRows.flatMap((l) => (matches(l).length ? matches(l).map((r) => [...l, ...r]) : [[...l, null, null]]));
    expect(d.queryPlan(p.join('left', left, right, on, { ordered: true })).rows).toEqual(leftJoin);
    // A right or full join's unmatched right rows come last, in the right order.
    const unmatchedRight = rightRows.filter((r) => !leftRows.some((l) => l[1] === r[1])).map((r) => [null, null, ...r]);
    expect(unmatchedRight.length).toBeGreaterThan(0);
    expect(d.queryPlan(p.join('right', left, right, on, { ordered: true })).rows).toEqual([...inner, ...unmatchedRight]);
    expect(d.queryPlan(p.join('full', left, right, on, { ordered: true })).rows).toEqual([...leftJoin, ...unmatchedRight]);
    const small = p.limit(right, 3);
    expect(d.queryPlan(p.join('cross', p.limit(left, 4), small, undefined, { ordered: true })).rows).toEqual(leftRows.slice(0, 4).flatMap((l) => rightRows.slice(0, 3).map((r) => [...l, ...r])));
    // Semi and anti joins keep the left order with or without the flag.
    expect(d.queryPlan(p.join('semi', left, right, on, { ordered: true })).rows).toEqual(leftRows.filter((l) => matches(l).length > 0));
  });

  it('aggregate with ordered first: groups in the order of their first row', () => {
    const firstSeen = (keys: number[]) => keys.filter((x, i) => keys.indexOf(x) === i);
    const order = firstSeen(leftRows.map((r) => r[1]));
    const counted = d.queryPlan(p.aggregate(left, [p.col(0, 1, 'int')], [p.agg('count', [], 'int', { star: true })], { ordered: 'first' })).rows;
    expect(counted).toEqual(order.map((k) => [k, leftRows.filter((r) => r[1] === k).length]));
    // Over an input in a different order, the order follows it.
    const byId = p.sort(p.scan('a', [0, 1]), [p.asc(p.col(0, 0, 'int'))]);
    const keysById = firstSeen(A.map((r) => r[1]));
    expect(d.queryPlan(p.aggregate(byId, [p.col(0, 1, 'int')], [], { ordered: 'first' })).rows).toEqual(keysById.map((k) => [k]));
    // With carried columns: the same groups and values as without the flag, in order.
    const carried = (ordered?: 'first') =>
      d.queryPlan(p.aggregate(left, [p.col(0, 1, 'int')], [p.agg('max', [p.col(0, 0, 'int')], 'int')], { carry: [p.col(0, 0, 'int')], ...(ordered ? { ordered } : {}) })).rows;
    const withFlag = carried('first');
    expect(withFlag.map((r) => r[0])).toEqual(order);
    expect([...withFlag].sort((x, y) => (x[0] as number) - (y[0] as number))).toEqual([...carried()].sort((x, y) => (x[0] as number) - (y[0] as number)));
    // The carried column comes from the row with the maximum, as without the flag.
    expect(withFlag.every((r) => r[1] === r[2])).toBe(true);
    // Without keys: one row, as without the flag.
    expect(d.queryPlan(p.aggregate(left, [], [p.agg('count', [], 'int', { star: true })], { ordered: 'first' })).rows).toEqual([[400]]);
  });

  it('distinct with ordered first: rows in the order of their first occurrence, by each column collation', () => {
    const names = p.project(p.scan('a', [0, 2]), [p.col(0, 1, 'text')]);
    expect(d.queryPlan(p.distinct(names, 1, ['binary'], { ordered: 'first' })).rows).toEqual([['X'], ['y'], ['Y'], ['z'], ['x']]);
    const folded = d.queryPlan(p.distinct(names, 1, ['nocase'], { ordered: 'first' })).rows.map((r) => (r[0] as string).toLowerCase());
    expect(folded).toEqual(['x', 'y', 'z']);
    const pairs = p.project(left, [p.col(0, 1, 'int')]);
    expect(d.queryPlan(p.distinct(pairs, 1, undefined, { ordered: 'first' })).rows.map((r) => r[0])).toEqual([...new Set(leftRows.map((r) => r[1]))]);
  });

  it('the validator checks the flags', () => {
    const catalog = { tableColumns: (t: string) => (t === 'a' ? 3 : undefined) };
    const bad = (plan: PlanOp) => {
      try {
        p.validatePlan(plan, catalog as never);
      } catch (e) {
        return (e as Error).message;
      }
      return 'valid';
    };
    const scan = p.scan('a', [0, 1]);
    expect(bad({ ...p.join('inner', scan, scan), ordered: 'yes' } as unknown as PlanOp)).toMatch(/ordered: expected true/);
    expect(bad({ ...p.aggregate(scan, [p.col(0, 1, 'int')], []), ordered: 'last' } as unknown as PlanOp)).toMatch(/ordered: expected 'first'/);
    expect(bad({ ...p.distinct(scan, 2), ordered: true } as unknown as PlanOp)).toMatch(/ordered: expected 'first'/);
    expect(bad({ ...p.distinct(scan, 2), collations: ['binary'] } as unknown as PlanOp)).toMatch(/expected 2 collations/);
  });
});

describe('order-aware operations', () => {
  const d = Database.openMemory();
  d.exec("CREATE TABLE s(id INTEGER PRIMARY KEY, g TEXT, v INT, at INT)");
  d.exec('BEGIN');
  // Groups a, b, c; v repeats within groups; at is a key that is not the input order.
  const S = ids(600).map((i) => [i, ['a', 'b', 'c', 'A'][i % 4], (i * 13) % 50, (i * 7919) % 1000] as [number, string, number, number]);
  for (const r of S) d.exec(`INSERT INTO s VALUES (${r[0]}, '${r[1]}', ${r[2]}, ${r[3]})`);
  d.exec('COMMIT; ANALYZE');
  // The input in an order of its own: v descending, ties by id.
  const input = p.sort(p.scan('s', [0, 1, 2, 3]), [p.desc(p.col(0, 2, 'int'))]);
  const rows = stableSorted(S.map((r) => [...r] as (number | string)[]), (r) => r[2] as number, true);
  const groups = ['a', 'b', 'c', 'A'];
  const of = (g: string) => rows.filter((r) => r[1] === g);
  const g = p.col(0, 1, 'text');
  const id = p.col(0, 0, 'int');
  const at = p.col(0, 3, 'int');

  it('first and last by input order, and by an order key', () => {
    const plan = p.aggregate(input, [g], [p.agg('first', [id], 'int'), p.agg('last', [id], 'int'), p.agg('first', [id, at], 'int'), p.agg('last', [id, at], 'int')], { ordered: 'first' });
    const byAt = (r: (number | string)[][], last: boolean) => [...r].sort((x, y) => (last ? -1 : 1) * ((x[3] as number) - (y[3] as number)))[0][0];
    const expected = [...new Set(rows.map((r) => r[1]))].map((k) => {
      const m = of(k as string);
      return [k, m[0][0], m[m.length - 1][0], byAt(m, false), byAt(m, true)];
    });
    expect(d.queryPlan(plan).rows).toEqual(expected);
    // Ties in the key go by input order: first takes the earliest row, last the latest.
    const tied = d.queryPlan(p.aggregate(input, [g], [p.agg('first', [id, p.lit(0)], 'int'), p.agg('last', [id, p.lit(0)], 'int')], { ordered: 'first' })).rows;
    expect(tied).toEqual(expected.map((r) => [r[0], r[1], r[2]]));
    // Without keys, over a sorted input, and rows whose key is null skipped.
    expect(d.queryPlan(p.aggregate(input, [], [p.agg('first', [id], 'int'), p.agg('last', [id], 'int')])).rows).toEqual([[rows[0][0], rows[rows.length - 1][0]]]);
    const keyed = { k: 'case', whens: [{ when: p.call('cmp_lt', [id, p.lit(300)], 'int'), then: p.lit(null) }], else: at, type: 'int' } as PlanExpr;
    const firstAfter300 = [...rows].filter((r) => (r[0] as number) >= 300).sort((x, y) => (x[3] as number) - (y[3] as number))[0][0];
    expect(d.queryPlan(p.aggregate(input, [], [p.agg('first', [id, keyed], 'int')])).rows).toEqual([[firstAfter300]]);
  });

  it('limit from the end: the last rows, in input order', () => {
    const idsOf = (plan: PlanOp) => d.queryPlan(plan).rows.map((r) => r[0]);
    const all = rows.map((r) => r[0]);
    expect(idsOf(p.limit(input, 5, undefined, { fromEnd: true }))).toEqual(all.slice(-5));
    expect(idsOf(p.limit(input, 5, 10, { fromEnd: true }))).toEqual(all.slice(-15, -10));
    expect(idsOf(p.limit(input, 1000, 0, { fromEnd: true }))).toEqual(all);
    expect(idsOf(p.limit(input, 0, undefined, { fromEnd: true }))).toEqual([]);
    expect(idsOf(p.limit(input, -1, 595, { fromEnd: true }))).toEqual(all.slice(0, 5));
    // With parameters, and under other operations.
    expect(d.queryPlan(p.limit(input, p.param(0, 'int'), p.param(1, 'int'), { fromEnd: true }), [3, 1]).rows.map((r) => r[0])).toEqual(all.slice(-4, -1));
    expect(d.queryPlan(p.aggregate(p.limit(input, 7, undefined, { fromEnd: true }), [], [p.agg('count', [], 'int', { star: true })])).rows).toEqual([[7]]);
  });

  it('distinct keeping the first or last row of each set of duplicates', () => {
    const keep = (k: 'first' | 'last', options: { ordered?: 'first' } = {}) => d.queryPlan(p.distinct(input, 4, undefined, { on: [1], keep: k, ...options })).rows;
    const firsts = groups.map((x) => of(x)[0]);
    const lasts = groups.map((x) => of(x)[of(x).length - 1]);
    const inInputOrder = (picked: (number | string)[][]) => rows.filter((r) => picked.includes(r));
    expect(keep('first')).toEqual(inInputOrder(firsts));
    expect(keep('last')).toEqual(inInputOrder(lasts));
    // With ordered: 'first', in the order of each set's first row.
    const setOrder = [...new Set(rows.map((r) => r[1]))];
    expect(keep('last', { ordered: 'first' })).toEqual(setOrder.map((x) => lasts[groups.indexOf(x as string)]));
    // By the columns' collations: a and A are one set under nocase.
    const folded = d.queryPlan(p.distinct(input, 4, ['binary', 'nocase', 'binary', 'binary'], { on: [1], keep: 'first' })).rows;
    const firstOfFolded = (x: string) => rows.find((r) => (r[1] as string).toLowerCase() === x)!;
    expect(folded).toEqual(inInputOrder(['a', 'b', 'c'].map(firstOfFolded)));
    // Over every column, keeping the first: the distinct rows in the order of their first occurrence.
    const pairs = p.project(input, [p.col(0, 1, 'text'), p.call('mod', [p.col(0, 2, 'int'), p.lit(3)], 'int')]);
    const seen = new Set<string>();
    const expected = rows.map((r) => [r[1], (r[2] as number) % 3]).filter((r) => (seen.has(JSON.stringify(r)) ? false : (seen.add(JSON.stringify(r)), true)));
    expect(d.queryPlan(p.distinct(pairs, 2, undefined, { keep: 'first' })).rows).toEqual(expected);
  });

  it('the validator checks them', () => {
    const catalog = { tableColumns: (t: string) => (t === 's' ? 4 : undefined) };
    const bad = (plan: PlanOp) => {
      try {
        p.validatePlan(plan, catalog as never);
      } catch (e) {
        return (e as Error).message;
      }
      return 'valid';
    };
    const scan = p.scan('s', [0, 1]);
    expect(bad({ ...p.limit(scan, 1), fromEnd: 1 } as unknown as PlanOp)).toMatch(/fromEnd: expected true/);
    expect(bad(p.distinct(scan, 2, undefined, { on: [2] }))).toMatch(/no column 2/);
    expect(bad(p.distinct(scan, 2, undefined, { on: [1, 1] }))).toMatch(/listed twice/);
    expect(bad(p.distinct(scan, 2, undefined, { on: [] }))).toMatch(/at least one column/);
    expect(bad({ ...p.distinct(scan, 2), keep: 'any' } as unknown as PlanOp)).toMatch(/keep: expected 'first' or 'last'/);
    expect(bad(p.aggregate(scan, [], [p.agg('first', [], 'int')]))).not.toBe('valid');
  });
});
