/**
 * Semi and anti joins against a right side that isn't a base table (ADR 0031, section 1): a filtered and distinct copy,
 * a grouping, an explode, a VALUES list. The join becomes an EXISTS subquery (exec/plan-normalize.ts, `semiJoin`), and
 * the planner now decorrelates it whatever its FROM items are, so the right side runs once, into a hash table, instead
 * of once per left row. Results keep the left side's order, as before.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';

const N = 3000;
const kOf = (i: number): number => (i * 37) % 101;

function fixture(): Database {
  const d = Database.openMemory();
  d.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, k INT); CREATE TABLE tags(id INT, tag TEXT)');
  d.exec('BEGIN');
  for (let i = 1; i <= N; i++) d.exec(`INSERT INTO t VALUES (${i}, ${kOf(i)})`);
  for (let i = 1; i <= N; i += 3) d.exec(`INSERT INTO tags VALUES (${i}, '${i % 2 ? 'odd' : 'even'}')`);
  d.exec('COMMIT');
  return d;
}

const ids = Array.from({ length: N }, (_, i) => i + 1);
// The left side in an order of its own: k descending, then id.
const left: PlanOp = p.sort(p.scan('t', [0, 1]), [p.desc(p.col(0, 1, 'int')), p.asc(p.col(0, 0, 'int'))]);
const leftRows = ids.map((i) => [i, kOf(i)]).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
const idEq: PlanExpr = p.call('cmp_eq', [p.col(0, 0, 'int'), p.col(1, 0, 'int')], 'bool');
const eq = (e: PlanExpr, v: number | string): PlanExpr => p.call('cmp_eq', [e, p.lit(v)], 'bool');

/** Right sides that aren't base tables, each with the left ids it matches. */
const rights: [string, PlanOp, Set<number>][] = [
  ['a filtered, distinct copy', p.distinct(p.project(p.filter(p.scan('t', [0, 1]), eq(p.col(0, 1, 'int'), 5)), [p.col(0, 0, 'int')]), 1), new Set(ids.filter((i) => kOf(i) === 5))],
  [
    'a grouping',
    p.project(p.filter(p.aggregate(p.scan('t', [0, 1]), [p.col(0, 1, 'int')], [p.agg('count', [], 'int', { star: true })]), p.call('cmp_gt', [p.col(0, 1, 'int'), p.lit(30)], 'bool')), [p.col(0, 0, 'int')]),
    // Joined on id = k: the ids that are a k with more than 30 rows.
    new Set(ids.filter((i) => ids.filter((j) => kOf(j) === i).length > 30)),
  ],
  ['a VALUES list', p.values([[p.lit(3)], [p.lit(7)], [p.lit(7)], [p.lit(4000)]]), new Set([3, 7])],
  ['a filter over another table', p.project(p.filter(p.scan('tags', [0, 1]), eq(p.col(0, 1, 'text'), 'even')), [p.col(0, 0, 'int')]), new Set(ids.filter((i) => (i - 1) % 3 === 0 && i % 2 === 0))],
];

describe('semi and anti joins against a derived right side', () => {
  const d = fixture();
  for (const [name, right, matched] of rights) {
    it(`${name}: the left rows with a match, or without one, in the left order`, () => {
      expect(d.queryPlan(p.join('semi', left, right, idEq)).rows).toEqual(leftRows.filter((r) => matched.has(r[0])));
      expect(d.queryPlan(p.join('anti', left, right, idEq)).rows).toEqual(leftRows.filter((r) => !matched.has(r[0])));
    });
  }

  it('an explode: the left rows whose list holds an element', () => {
    const lists = Database.openMemory();
    lists.queryPlan({ kind: 'schema', op: { op: 'createTable', table: { name: 'l', columns: [{ name: 'id', declaredType: 'INTEGER', type: 'INTEGER', notNull: false, collation: 'binary' }, { name: 'v', declaredType: 'list<int>', type: 'LIST', notNull: false, collation: 'binary' }], keys: [], checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false } });
    const listOf = (i: number): number[] => (i % 5 === 0 ? [] : [i % 7, i % 11, i % 13]);
    const rows = Array.from({ length: 500 }, (_, i) => i + 1);
    lists.queryPlan({ kind: 'write', plan: p.append('l', p.values(rows.map((i) => [p.lit(i), p.call('list_of', listOf(i).map((x) => p.lit(x)), 'list<int>')])), [0, 1]) });
    const exploded = p.distinct(p.project(p.filter(p.explode(p.scan('l', [0, 1]), 1, 'list<int>'), eq(p.col(0, 1, 'int'), 3)), [p.col(0, 0, 'int')]), 1);
    const scan = p.scan('l', [0]);
    expect(lists.queryPlan(p.join('semi', scan, exploded, idEq)).rows).toEqual(rows.filter((i) => listOf(i).includes(3)).map((i) => [i]));
    expect(lists.queryPlan(p.join('anti', scan, exploded, idEq)).rows).toEqual(rows.filter((i) => !listOf(i).includes(3)).map((i) => [i]));
  });

  it('a condition that reads the right side only, or the left row beyond the keys, stays correct', () => {
    const right = p.project(p.filter(p.scan('t', [0, 1]), eq(p.col(0, 1, 'int'), 9)), [p.col(0, 0, 'int'), p.col(0, 1, 'int')]);
    const on = p.and(idEq, p.call('cmp_lt', [p.col(0, 0, 'int'), p.lit(1000)], 'bool'));
    expect(d.queryPlan(p.join('semi', left, right, on)).rows).toEqual(leftRows.filter((r) => r[1] === 9 && r[0] < 1000));
    // Not an equality between the sides: not decorrelated, still correct.
    const ge = p.call('cmp_ge', [p.col(0, 0, 'int'), p.col(1, 0, 'int')], 'bool');
    const few = p.project(p.filter(p.scan('t', [0, 1]), p.call('cmp_gt', [p.col(0, 0, 'int'), p.lit(N - 3)], 'bool')), [p.col(0, 0, 'int')]);
    expect(d.queryPlan(p.join('semi', left, few, ge)).rows).toEqual(leftRows.filter((r) => r[0] >= N - 2));
  });

  it('the planner decorrelates a derived right side: its plan runs once, as a hash semi-join', () => {
    const plan = d.planOf('SELECT id FROM t WHERE EXISTS (SELECT 1 FROM (SELECT k FROM t GROUP BY k) AS g WHERE g.k = t.id)');
    expect(plan.subplans.map((s) => s.label)).toEqual(['EXISTS (decorrelated: hash semi-join)']);
  });
});
