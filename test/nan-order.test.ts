/**
 * NaN as a value of `real` in the engine's total order (ADR 0018 section 2): NaN equals NaN and sorts after every
 * number, Infinity included, and before text. Sorts, distinct, grouping, joins, comparisons, index keys and zone maps
 * all follow it, on row tables with and without an index and on columnar tables; values from columns keep NaN.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import { sqlFunction } from '../src/engine/exec/sql-functions.js';
import { compareValues } from '../src/engine/values.js';

const X = [3, NaN, -Infinity, NaN, Infinity, null, 1];
const x = p.col(0, 1, 'real');
const NAN = p.lit(NaN, 'real');

/** t(id INTEGER PRIMARY KEY, x REAL) holding X, on `storage`, optionally with an index on x. */
function table(storage: 'row' | 'columnar', index: boolean): Database {
  const d = Database.openMemory();
  d.exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, x REAL)${storage === 'columnar' ? " WITH (storage = 'columnar')" : ''}`);
  if (index) d.exec('CREATE INDEX t_x ON t(x)');
  const nulls = new Uint8Array([1 << X.indexOf(null)]);
  const values = p.fromColumns([new Int32Array(X.map((_, i) => i + 1)), { data: Float64Array.from(X, (v) => v ?? 0), nulls }], ['int', 'real']);
  d.queryPlan({ kind: 'write', plan: p.append('t', values, [0, 1]) });
  if (storage === 'columnar') d.exec('PRAGMA compact(t)');
  return d;
}

const rows = (d: Database, plan: PlanOp) => d.queryPlan(plan).rows;
const xs = (d: Database, plan: PlanOp) => rows(d, plan).map((r) => r[r.length - 1]);
const scan = () => p.scan('t', [0, 1]);
const where = (op: string, value: ReturnType<typeof p.lit>) => p.sort(p.filter(scan(), p.call(op, [x, value], 'int')), [p.asc(p.col(0, 0, 'int'))]);

it('compareValues: NaN equals NaN, after every number and before text', () => {
  expect(compareValues(NaN, NaN)).toBe(0);
  for (const n of [Infinity, -Infinity, 0, 1e308, 2n ** 70n, -(2n ** 70n)]) {
    expect(compareValues(NaN, n), String(n)).toBe(1);
    expect(compareValues(n, NaN), String(n)).toBe(-1);
  }
  expect(compareValues(null, NaN)).toBe(-1);
  expect(compareValues(NaN, '')).toBe(-1);
});

it('the comparison operations follow it without generated code too', () => {
  // The closure path (used where a page's CSP forbids generated code, SMALT_NO_CODEGEN in tests), numeric fast path.
  const arg = (v: number) => ({ fn: () => v, type: 'real' as const });
  const cmp = (op: string, a: number, b: number) => sqlFunction(op).compile([arg(a), arg(b)], {}).fn([]);
  const cases: [string, number, number, number][] = [
    ['cmp_eq', NaN, NaN, 1], ['cmp_eq', NaN, 1, 0], ['cmp_ne', NaN, NaN, 0], ['cmp_ne', 1, NaN, 1],
    ['cmp_lt', 1, NaN, 1], ['cmp_lt', NaN, 1, 0], ['cmp_lt', NaN, NaN, 0], ['cmp_le', NaN, NaN, 1], ['cmp_le', Infinity, NaN, 1], ['cmp_le', NaN, Infinity, 0],
    ['cmp_gt', NaN, Infinity, 1], ['cmp_gt', Infinity, NaN, 0], ['cmp_gt', NaN, NaN, 0], ['cmp_ge', NaN, NaN, 1], ['cmp_ge', NaN, 1, 1], ['cmp_ge', 1, NaN, 0],
  ];
  for (const [op, a, b, want] of cases) expect(cmp(op, a, b), `${op}(${a}, ${b})`).toBe(want);
});

it('comparisons over values from columns follow the total order', () => {
  const d = Database.openMemory();
  const v = () => p.fromColumns([new Float64Array([1, NaN, Infinity, NaN])], ['real']);
  const c = p.col(0, 0, 'real');
  const keep = (op: string, value: ReturnType<typeof p.lit>) => d.queryPlan(p.filter(v(), p.call(op, [c, value], 'int'))).rows.map((r) => r[0]);
  expect(keep('cmp_eq', NAN)).toEqual([NaN, NaN]);
  expect(keep('cmp_ne', NAN)).toEqual([1, Infinity]);
  expect(keep('cmp_lt', NAN)).toEqual([1, Infinity]);
  expect(keep('cmp_le', p.lit(1, 'real'))).toEqual([1]);
  expect(keep('cmp_gt', p.lit(Infinity, 'real'))).toEqual([NaN, NaN]);
  expect(keep('cmp_ge', NAN)).toEqual([NaN, NaN]);
  expect(d.queryPlan(p.project(v(), [p.call('cmp_is', [c, NAN], 'int')])).rows.map((r) => r[0])).toEqual([0, 1, 0, 1]);
});

it('values from columns keep NaN; NULL comes from the bitmap', () => {
  const d = Database.openMemory();
  const v = d.queryPlan(p.fromColumns([{ data: new Float64Array([NaN, 1, 2]), nulls: new Uint8Array([0b100]) }], ['real']));
  expect(v.rows).toEqual([[NaN], [1], [null]]);
});

// Columnar tables take no index: their scans prune with zone maps.
for (const [storage, index] of [['row', false], ['row', true], ['columnar', false]] as const) {
  {
    describe(`${storage} table${index ? ', with an index on x' : ''}`, () => {
      const d = table(storage, index);

      it('stores and reads NaN, apart from NULL', () => {
        expect(xs(d, p.sort(scan(), [p.asc(p.col(0, 0, 'int'))]))).toEqual(X);
      });

      it('sorts NaN after every number, Infinity included, both ways', () => {
        expect(xs(d, p.sort(scan(), [p.asc(x), p.asc(p.col(0, 0, 'int'))]))).toEqual([null, -Infinity, 1, 3, Infinity, NaN, NaN]);
        expect(xs(d, p.sort(scan(), [p.desc(x), p.asc(p.col(0, 0, 'int'))]))).toEqual([NaN, NaN, Infinity, 3, 1, -Infinity, null]);
      });

      it('compares in the total order: NaN = NaN, NaN > Infinity', () => {
        expect(xs(d, where('cmp_eq', NAN))).toEqual([NaN, NaN]);
        expect(xs(d, where('cmp_ne', NAN))).toEqual([3, -Infinity, Infinity, 1]);
        expect(xs(d, where('cmp_gt', p.lit(1e308, 'real')))).toEqual([NaN, NaN, Infinity]);
        expect(xs(d, where('cmp_ge', NAN))).toEqual([NaN, NaN]);
        expect(xs(d, where('cmp_lt', NAN))).toEqual([3, -Infinity, Infinity, 1]);
        expect(xs(d, where('cmp_le', p.lit(Infinity, 'real')))).toEqual([3, -Infinity, Infinity, 1]);
        // Column against column: every non-NULL row equals itself, NaN too.
        expect(xs(d, p.filter(scan(), p.call('cmp_eq', [x, x], 'int'))).length).toBe(6);
        expect(xs(d, p.filter(scan(), p.call('cmp_ne', [x, x], 'int')))).toEqual([]);
      });

      it('distinct, grouping and joins treat NaN as one value', () => {
        expect(rows(d, p.distinct(p.project(scan(), [x]), 1)).length).toBe(6);
        const groups = rows(d, p.sort(p.aggregate(scan(), [x], [p.agg('count', [], 'int', { star: true })]), [p.asc(p.col(0, 0, 'real'))]));
        expect(groups).toEqual([[null, 1], [-Infinity, 1], [1, 1], [3, 1], [Infinity, 1], [NaN, 2]]);
        const self = p.join('inner', scan(), p.scan('t', [0, 1]), p.call('cmp_eq', [x, p.col(1, 1, 'real')], 'int'));
        // The four other values each match themselves; the two NaN rows match themselves and each other: 4 + 4.
        expect(rows(d, self).length).toBe(8);
      });
    });
  }
}

describe('zone maps', () => {
  it('keep NaN as the maximum, and a chunk of only NaN is not skipped', () => {
    const d = Database.openMemory();
    d.exec("CREATE TABLE z(id INTEGER PRIMARY KEY, x REAL) WITH (storage = 'columnar')");
    const n = 3000;
    const values = (from: number, f: (i: number) => number) => p.fromColumns([Int32Array.from({ length: n }, (_, i) => from + i), Float64Array.from({ length: n }, (_, i) => f(i))], ['int', 'real']);
    d.queryPlan({ kind: 'write', plan: p.append('z', values(1, () => NaN), [0, 1]) });
    d.queryPlan({ kind: 'write', plan: p.append('z', values(n + 1, (i) => i), [0, 1]) });
    d.exec('PRAGMA compact(z)');
    const count = (op: string, v: ReturnType<typeof p.lit>) => d.queryPlan(p.aggregate(p.filter(p.scan('z', [0, 1]), p.call(op, [x, v], 'int')), [], [p.agg('count', [], 'int', { star: true })])).rows[0][0];
    expect(count('cmp_eq', NAN)).toBe(n);
    expect(count('cmp_gt', p.lit(1e9, 'real'))).toBe(n);
    expect(count('cmp_lt', NAN)).toBe(n);
    expect(count('cmp_ge', p.lit(0, 'real'))).toBe(2 * n);
  });
});

it('a UNIQUE index holds one NaN, as NaN equals NaN, and a NaN beside NULLs', () => {
  const d = Database.openMemory();
  d.exec('CREATE TABLE u(x REAL UNIQUE)');
  const one = () => p.fromColumns([new Float64Array([NaN])], ['real']);
  const nulls = () => p.fromColumns([{ data: new Float64Array(2), nulls: new Uint8Array([0b11]) }], ['real']);
  d.queryPlan({ kind: 'write', plan: p.append('u', nulls(), [0]) });
  // NaN's key used to be NULL's, so a NaN conflicted with a NULL already there.
  d.queryPlan({ kind: 'write', plan: p.append('u', one(), [0]) });
  expect(d.queryPlan(p.scan('u', [0])).rows.length).toBe(3);
  expect(() => d.queryPlan({ kind: 'write', plan: p.append('u', one(), [0]) })).toThrow(expect.objectContaining({ code: 'SMALT_CONSTRAINT_UNIQUE' }));
});
