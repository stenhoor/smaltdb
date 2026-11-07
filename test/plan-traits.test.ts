/**
 * Traits, not names (ADR 0016 step 3): the planner and code generation recognise an operation by the traits it
 * declares. A function under a name the engine has never seen, declaring the traits of an equality, gets the same
 * index and rowid lookups, hash joins and zone maps as SQL's `cmp_eq`; without the traits it gets none of them.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Database, plan as p } from '../src/engine/index.js';
import { type ScalarFunction, scalarFunctions } from '../src/engine/exec/functions.js';
import type { FnTraits } from '../src/engine/exec/traits.js';
import { compareValues } from '../src/engine/values.js';

/** An equality under its own name (NULL when either side is NULL), optionally declaring traits. */
function register(name: string, traits?: FnTraits): void {
  const f: ScalarFunction = {
    minArgs: 2,
    maxArgs: 2,
    deterministic: true,
    resultType: () => 'int',
    compile([a, b]) {
      const fa = a.fn;
      const fb = b.fn;
      return {
        type: 'int',
        fn: (r) => {
          const x = fa(r);
          const y = fb(r);
          return x === null || y === null ? null : compareValues(x, y, a.collation) === 0 ? 1 : 0;
        },
      };
    },
    ...(traits ? { traits } : {}),
  };
  scalarFunctions.set(name, f);
}

afterEach(() => {
  scalarFunctions.delete('test_eq');
  scalarFunctions.delete('test_eq_plain');
});

function db(): Database {
  const d = Database.openMemory();
  d.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, k INT, v TEXT); CREATE INDEX t_k ON t(k)');
  d.exec('CREATE TABLE u(id INTEGER PRIMARY KEY, k INT, w TEXT)');
  d.exec("CREATE TABLE c(id INTEGER PRIMARY KEY, day INT, ms REAL) WITH (storage = 'columnar')");
  d.exec('BEGIN');
  const t = d.prepare('INSERT INTO t VALUES (?, ?, ?)');
  const u = d.prepare('INSERT INTO u VALUES (?, ?, ?)');
  const c = d.prepare('INSERT INTO c VALUES (?, ?, ?)');
  for (let i = 1; i <= 3000; i++) {
    t.run([i, i % 500, `v${i}`]);
    u.run([i, i % 700, `w${i}`]);
    c.run([i, Math.floor(i / 100), i / 2]);
  }
  d.exec('COMMIT');
  d.exec('PRAGMA compact(c); ANALYZE');
  return d;
}

const plan = (d: Database, stmt: Parameters<Database['queryPlan']>[0]): string =>
  d.queryPlan({ kind: 'explain', mode: 'plan', query: { kind: 'query', plan: stmt as never } } as never).rows.map((r) => String(r[3])).join(' | ');

describe('operations are recognised by their traits', () => {
  const k = p.col(0, 1, 'int');
  const id = p.col(0, 0, 'int');
  const eqWith = (fn: string, a: ReturnType<typeof p.col>, b: ReturnType<typeof p.lit>) => p.call(fn, [a, b], 'int');

  it('an index lookup, a rowid lookup and a hash join for an equality under another name', () => {
    register('test_eq', { compare: '=' });
    const d = db();
    const byIndex = p.filter(p.scan('t', [0, 1, 2]), eqWith('test_eq', k, p.lit(7)));
    expect(plan(d, byIndex)).toMatch(/SEARCH t USING INDEX t_k/);
    expect(d.queryPlan(byIndex).rows).toEqual(d.queryPlan(p.filter(p.scan('t', [0, 1, 2]), eqWith('cmp_eq', k, p.lit(7)))).rows);
    expect(plan(d, p.filter(p.scan('t', [0, 1, 2]), eqWith('test_eq', id, p.lit(42))))).toMatch(/SEARCH t USING INTEGER PRIMARY KEY/);
    const joinOn = (fn: string) => p.join('inner', p.scan('t', [0, 1]), p.scan('u', [0, 1]), p.call(fn, [p.col(0, 1, 'int'), p.col(1, 1, 'int')], 'int'));
    expect(plan(d, joinOn('test_eq'))).toMatch(/HASH JOIN/);
    const sorted = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();
    expect(sorted(d.queryPlan(joinOn('test_eq')).rows)).toEqual(sorted(d.queryPlan(joinOn('cmp_eq')).rows));
  });

  it('zone maps for an equality under another name on a columnar table', () => {
    register('test_eq', { compare: '=' });
    const d = db();
    const q = p.filter(p.scan('c', [0, 1, 2]), eqWith('test_eq', p.col(0, 1, 'int'), p.lit(12)));
    expect(plan(d, q)).toMatch(/zone maps: day = \?/);
    expect(d.queryPlan(q).rows.length).toBe(100);
  });

  it('none of them without the traits, with the same results', () => {
    register('test_eq_plain');
    const d = db();
    const q = p.filter(p.scan('t', [0, 1, 2]), eqWith('test_eq_plain', k, p.lit(7)));
    expect(plan(d, q)).not.toMatch(/SEARCH/);
    expect(d.queryPlan(q).rows).toEqual(d.queryPlan(p.filter(p.scan('t', [0, 1, 2]), eqWith('cmp_eq', k, p.lit(7)))).rows);
    const j = p.join('inner', p.scan('t', [0, 1]), p.scan('u', [0, 1]), p.call('test_eq_plain', [p.col(0, 1, 'int'), p.col(1, 1, 'int')], 'int'));
    expect(plan(d, j)).not.toMatch(/HASH JOIN/);
  });

  it('behaviour names and their sql.* aliases give the same plans and results (ADR 0016 step 4)', () => {
    const d = db();
    const q = (eq: string, add: string, div: string, inList: string) =>
      p.project(
        p.filter(p.scan('t', [0, 1, 2]), p.and(p.call(eq, [k, p.lit(7)], 'int'), p.call(inList, [id, p.lit(7), p.lit(507), p.lit(1007)], 'int'))),
        [p.call(add, [k, p.lit(1)], 'int'), p.call(div, [id, p.lit(2)], 'int')],
      );
    const named = q('cmp_eq', 'add', 'div_trunc', 'in_list');
    const aliased = q('cmp_eq', 'add', 'div_trunc', 'in_list');
    expect(d.queryPlan(named).rows).toEqual(d.queryPlan(aliased).rows);
    expect(d.queryPlan(named).rows.length).toBeGreaterThan(0);
    expect(plan(d, named)).toBe(plan(d, aliased));
  });
});
