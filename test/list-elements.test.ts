/**
 * `list_elements` (ADR 0031, section 2) and `explode` on it: a list's elements as rows, and `explode` as an ordered
 * lateral join with them, with no iteration and no sort. Order (the input's, then each list's) is checked on row and
 * columnar tables large enough to span many pages and row groups.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import { normalizePlan } from '../src/engine/exec/plan-normalize.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { PlanType } from '../src/engine/plan/types.js';
import type { ColumnDef, StorageType } from '../src/engine/plan/schema.js';

const L = (t: string) => t as PlanType;
const list = (xs: readonly (number | null)[]): PlanExpr => p.call('list_of', xs.map((x) => p.lit(x)), L('list<int>'));
const elements = (args: PlanExpr[], type = 'int'): PlanOp => ({ op: 'source', kind: 'function', name: 'list_elements', args, types: [L(type), 'int'] });

describe('list_elements', () => {
  const db = Database.openMemory();

  it('one row per element, with its position from 0, in order; nested elements stay lists', () => {
    expect(db.queryPlan(elements([list([7, null, 9])])).rows).toEqual([[7, 0], [null, 1], [9, 2]]);
    const nested = p.call('list_of', [list([1, 2]), list([])], L('list<list<int>>'));
    const r = db.queryPlan(p.project(elements([nested], 'list<int>'), [p.call('list_len', [p.col(0, 0, L('list<int>'))], 'int'), p.col(0, 1, 'int')]));
    expect(r.rows).toEqual([[2, 0], [0, 1]]);
  });

  it('an empty or NULL list gives no row, or one NULL element at position 0 with the flags', () => {
    const empty = list([]);
    const none = p.lit(null, L('list<int>'));
    const rows = (a: PlanExpr[]) => db.queryPlan(elements(a)).rows;
    expect(rows([empty])).toEqual([]);
    expect(rows([none])).toEqual([]);
    expect(rows([empty, p.lit(1), p.lit(0)])).toEqual([[null, 0]]);
    expect(rows([none, p.lit(0), p.lit(1)])).toEqual([[null, 0]]);
    expect(rows([none, p.lit(1), p.lit(0)])).toEqual([]);
  });

  it('a lateral source: its argument reads the left row', () => {
    const left = p.values([[p.lit('a'), list([1, 2])], [p.lit('b'), list([])], [p.lit('c'), list([3])]], ['text', L('list<int>')]);
    const r = db.queryPlan(p.join('inner', left, elements([p.col(0, 1, L('list<int>'))]), undefined, { ordered: true }));
    expect(r.rows.map((x) => [x[0], x[2], x[3]])).toEqual([['a', 1, 0], ['a', 2, 1], ['c', 3, 0]]);
  });

  it('refuses a value that is not a list', () => {
    expect(() => db.queryPlan(elements([p.lit('x')]))).toThrow(/list_elements takes a list/);
  });
});

describe('explode on list_elements', () => {
  it('normalizes to an ordered lateral join: no iteration, no sort', () => {
    const plan = normalizePlan(p.explode(p.values([[list([1])]], [L('list<int>')]), 0, L('list<int>'), { position: true }));
    const text = JSON.stringify(plan);
    expect(text).toContain('"list_elements"');
    expect(text).not.toContain('"iterate"');
    expect(text).not.toContain('"sort"');
  });

  for (const storage of ['row', 'columnar'] as const) {
    it(`keeps the input's order, then each list's, on a ${storage} table of 20,000 rows`, () => {
      const db = Database.openMemory();
      const col = (name: string, type: StorageType, declaredType: string): ColumnDef => ({ name, declaredType, type, notNull: false, collation: 'binary' });
      db.queryPlan({ kind: 'schema', op: { op: 'createTable', table: { name: 't', columns: [col('id', 'INTEGER', 'INTEGER'), col('v', 'LIST', 'list<int>')], keys: [], checks: [], foreignKeys: [], storage }, temp: false, ifNotExists: false } });
      const N = 20_000;
      const listOf = (i: number): number[] | null => (i % 11 === 0 ? null : i % 7 === 0 ? [] : Array.from({ length: (i % 5) + 1 }, (_, j) => i * 10 + j));
      const rows = Array.from({ length: N }, (_, i) => i + 1);
      for (let at = 0; at < N; at += 2000) {
        const chunk = rows.slice(at, at + 2000);
        db.queryPlan({ kind: 'write', plan: p.append('t', p.values(chunk.map((i) => [p.lit(i), listOf(i) === null ? p.lit(null, L('list<int>')) : list(listOf(i)!)]), ['int', L('list<int>')]), [0, 1]) });
      }
      // The input's order is the scan's own (a columnar table's need not be the order rows were written).
      const scanned = db.queryPlan(p.scan('t', [0])).rows.map((r) => r[0] as number);
      expect(scanned.length).toBe(N);
      const expected: unknown[][] = [];
      for (const i of scanned) {
        const l = listOf(i);
        if (l === null) expected.push([i, null, 0]);
        else l.forEach((x, j) => expected.push([i, x, j]));
      }
      const r = db.queryPlan(p.explode(p.scan('t', [0, 1]), 1, L('list<int>'), { position: true }));
      expect(r.rows.length).toBe(expected.length);
      expect(r.rows).toEqual(expected);
      // Under a filter and a limit, as a language composes it.
      const top = db.queryPlan(p.limit(p.filter(p.explode(p.scan('t', [0, 1]), 1, L('list<int>')), p.call('cmp_gt', [p.col(0, 0, 'int'), p.lit(N - 3)], 'bool')), p.lit(100)));
      expect(top.rows).toEqual(expected.filter((x) => (x[0] as number) > N - 3).map((x) => [x[0], x[1]]));
    });
  }
});
