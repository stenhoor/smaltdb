/**
 * Order guarantees (ADR 0016 section 4): `sort` is stable, in memory, as a top-N and when it spills, on row and
 * columnar tables and with an index on the key; `filter`, `project`, `limit` and a `window` without its own order keep
 * their input's order; `semi` and `anti` joins keep the left input's order, top-level and nested, with and without a
 * condition and with conditions that read an enclosing plan's row.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
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
