/**
 * Groups in the order of their first row (`aggregate` with `ordered: 'first'`, plan-normalize.ts `orderedGroups`) over
 * sorted rows: when every aggregate ignores the order of its rows, the rows are not sorted; each group takes the least
 * of its rows' sort keys (`sortKeyColumn`), which is its first row's in the sort, and only the groups are sorted. These
 * check the groups' order and values against JavaScript, for one and two keys, NULLs first and last, and keys that tie;
 * and that an aggregate that reads its rows in order (`implode`) still has them sorted.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import { rng } from './helpers.js';

type Row = [number | null, number | null, string, number];

/** Rows (a, b, g, v): sort keys a and b (with NULLs), the group g, a value v. */
function rows(seed: number): Row[] {
  const rand = rng(seed);
  return Array.from({ length: 400 }, (): Row => [
    rand() < 0.1 ? null : Math.floor(rand() * 50),
    rand() < 0.1 ? null : Math.floor(rand() * 5),
    `g${Math.floor(rand() * 12)}`,
    Math.floor(rand() * 100),
  ]);
}

const db = Database.openMemory();
const frameOf = (rs: Row[]): PlanOp =>
  p.fromColumns([rs.map((r) => r[0]), rs.map((r) => r[1]), rs.map((r) => r[2]), rs.map((r) => r[3])] as never, ['int', 'int', 'text', 'int'] as never);
const a = p.col(0, 0, 'int' as never);
const b = p.col(0, 1, 'int' as never);
const g = p.col(0, 2, 'text' as never);
const v = p.col(0, 3, 'int' as never);

/** The rows sorted as `keys` sort (stable), in JavaScript: NULLs first or last per key. */
function sortedJs(rs: Row[], keys: { at: 0 | 1; nullsFirst: boolean }[]): Row[] {
  return rs
    .map((r, i) => ({ r, i }))
    .sort((x, y) => {
      for (const k of keys) {
        const p1 = x.r[k.at];
        const p2 = y.r[k.at];
        if (p1 === p2) continue;
        if (p1 === null) return k.nullsFirst ? -1 : 1;
        if (p2 === null) return k.nullsFirst ? 1 : -1;
        return p1 - p2;
      }
      return x.i - y.i;
    })
    .map((x) => x.r);
}

describe('groups in the order of their first sorted row', () => {
  for (const seed of [1, 2, 3]) {
    for (const keys of [[{ at: 0, nullsFirst: false }], [{ at: 0, nullsFirst: true }], [{ at: 1, nullsFirst: false }, { at: 0, nullsFirst: true }]] as const) {
      it(`seed ${seed}, keys ${JSON.stringify(keys)}: the groups' order and values`, () => {
        const rs = rows(seed);
        const sortKeys = keys.map((k) => ({ ...p.asc(k.at === 0 ? a : b), nullsFirst: k.nullsFirst }));
        const sorted = p.sort(frameOf(rs), sortKeys as never);
        const grouped = p.aggregate(sorted, [g], [p.agg('count', [], 'int' as never, { star: true }), p.agg('sum', [v], 'int' as never), p.agg('min', [v], 'int' as never)], { ordered: 'first' } as never);
        const want = new Map<string, [string, number, number, number]>();
        for (const r of sortedJs(rs, [...keys])) {
          const cur = want.get(r[2]);
          if (cur) want.set(r[2], [r[2], cur[1] + 1, cur[2] + r[3], Math.min(cur[3], r[3])]);
          else want.set(r[2], [r[2], 1, r[3], r[3]]);
        }
        expect(db.queryPlan(grouped).rows).toEqual([...want.values()]);
      });
    }
  }

  it('sorts only the groups, not the rows', () => {
    const sorted = p.sort(frameOf(rows(5)), [{ ...p.asc(a), nullsFirst: false }] as never);
    const grouped = p.aggregate(sorted, [g], [p.agg('count', [], 'int' as never, { star: true })], { ordered: 'first' } as never);
    const plan = db.queryPlan({ kind: 'explain', mode: 'plan', query: { kind: 'query', plan: grouped } } as never).rows.map((r) => r.join(' ')).join('\n');
    expect(plan.match(/ORDER BY/g)).toHaveLength(1);
  });

  it('an aggregate that reads its rows in order (implode) still gets them sorted', () => {
    const rs = rows(4);
    const sorted = p.sort(frameOf(rs), [{ ...p.asc(a), nullsFirst: false }, { ...p.asc(v), nullsFirst: false }] as never);
    const grouped = p.aggregate(sorted, [g], [p.agg('implode', [v], 'list<int>' as never)], { ordered: 'first' } as never);
    const want = new Map<string, number[]>();
    for (const r of rs
      .map((r, i) => ({ r, i }))
      .sort((x, y) => (x.r[0] === y.r[0] ? x.r[3] - y.r[3] || x.i - y.i : x.r[0] === null ? 1 : y.r[0] === null ? -1 : x.r[0] - y.r[0]))
      .map((x) => x.r)) {
      want.set(r[2], [...(want.get(r[2]) ?? []), r[3]]);
    }
    expect(db.queryPlan(grouped).rows).toEqual([...want.entries()]);
  });
});
