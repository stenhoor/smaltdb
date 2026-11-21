/**
 * A column nothing reads is not decoded (ADR 0041, section 3). A table's column is decoded for the readers it has
 * when its scan first opens, and a reader can go away after the plan is made: an output of a nested plan's projection
 * that nothing reads, or a conjunct that a generated scan decides in its own code. Here: what a table access says is
 * read, and queries whose columns lose their readers, each against the rows worked out from the data.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { type ColumnUse, TableAccess } from '../src/engine/exec/operators.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';

describe('what a table access says is read', () => {
  /** An access to a table whose column 0 is its rowid. Its tree and reader are not used here. */
  const access = () => new TableAccess(null as never, null as never, 't', 0);
  const reader = (): ColumnUse => ({ gone: false });

  it('a column with a reader that always runs is needed, whatever else reads it', () => {
    const a = access();
    const output = reader();
    a.use(1, 11);
    a.use(1, 11, output);
    a.use(2, 12, output);
    output.gone = true;
    expect(a.needed(1)).toBe(true);
    expect(a.needed(2)).toBe(false);
    expect(a.needed(3)).toBe(false);
    expect(a.decode).toEqual([1, 11, 2, 12]);
    expect(a.reads()).toEqual([1, 11]);
  });

  it('a column is needed while one of its readers is left', () => {
    const a = access();
    const [x, y] = [reader(), reader()];
    a.use(1, 11, x);
    a.use(1, 11, y);
    expect(a.needed(1)).toBe(true);
    x.gone = true;
    expect(a.needed(1)).toBe(true);
    y.gone = true;
    expect(a.needed(1)).toBe(false);
    expect(a.reads()).toEqual([]);
  });

  it("a reader the scan answers itself is gone for that table, and not for another's", () => {
    const [a, b] = [access(), access()];
    const conjunct = reader();
    a.use(1, 11, conjunct);
    b.use(1, 21, conjunct);
    a.decides(conjunct);
    expect(a.needed(1)).toBe(false);
    expect(b.needed(1)).toBe(true);
    // The scan's own code still finds the column: the decode list keeps it.
    expect(a.decode).toEqual([1, 11]);
  });

  it('the columns read are the decode list itself while each has a reader; the rowid is never among them', () => {
    const a = access();
    const output = reader();
    a.use(0, 10, output);
    a.use(2, 12, output);
    a.use(1, 11);
    expect(a.reads()).toBe(a.decode);
    expect(a.decode).toEqual([2, 12, 1, 11]);
    expect(a.rowidReg).toBe(10);
    output.gone = true;
    expect(a.reads()).toEqual([1, 11]);
    expect(a.registers()).toEqual([12, 11, 10]);
  });
});

interface T {
  id: number;
  a: number | null;
  b: number | null;
  s: string;
  big: string;
  z: number;
}
interface U {
  id: number;
  t: number;
  w: number | null;
}

/**
 * `t` (400 rows; every 37th, and half of those whose `a` is 3, hold a text of 6,000 characters, which does not fit
 * its page; the first 200 were written before column `z` was added, so their records are short) and `u` (60 rows that
 * point at rows of `t`, some at none).
 */
function fixture(): { db: Database; t: T[]; u: U[] } {
  const db = Database.openMemory();
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b REAL, s TEXT, big TEXT); CREATE TABLE u(id INTEGER PRIMARY KEY, t INT, w INT); CREATE INDEX u_t ON u(t)');
  const t: T[] = [];
  const row = (i: number, z: number): T => ({ id: i, a: i % 11 === 0 ? null : i % 17, b: i % 13 === 0 ? null : i / 8, s: `v${i % 9}`, big: i % 37 === 0 || (i % 17 === 3 && i % 2 === 0) ? 'x'.repeat(6000) : `r${i}`, z });
  const insert = db.prepare('INSERT INTO t(id, a, b, s, big) VALUES (?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 1; i <= 200; i++) {
    const r = row(i, 7);
    t.push(r);
    insert.run([r.id, r.a, r.b, r.s, r.big]);
  }
  db.exec('COMMIT; ALTER TABLE t ADD COLUMN z INT DEFAULT 7; BEGIN');
  const insertZ = db.prepare('INSERT INTO t(id, a, b, s, big, z) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 201; i <= 400; i++) {
    const r = row(i, i % 5 === 0 ? 7 : i % 5);
    t.push(r);
    insertZ.run([r.id, r.a, r.b, r.s, r.big, r.z]);
  }
  const u: U[] = [];
  const insertU = db.prepare('INSERT INTO u VALUES (?, ?, ?)');
  for (let i = 1; i <= 60; i++) {
    const r: U = { id: i, t: i % 10 === 0 ? 1000 + i : i * 7 - 3, w: i % 6 === 0 ? null : i % 17 };
    u.push(r);
    insertU.run([r.id, r.t, r.w]);
  }
  db.exec('COMMIT');
  return { db, t, u };
}

describe('queries whose columns lose their readers give the rows they gave', () => {
  const { db, t, u } = fixture();
  /** A statement's rows, run three times (the decoders are built on the first): the same each time. */
  const rows = (sql: string, params: unknown[] = []): unknown[][] => {
    const st = db.prepare(sql);
    const first = st.all(params as never);
    expect(st.all(params as never), sql).toEqual(first);
    expect(db.query(sql, params as never).rows, sql).toEqual(first);
    return first;
  };
  const byId = <X extends { id: number }>(xs: X[]) => [...xs].sort((x, y) => x.id - y.id);

  it('columns only a scan’s own conjuncts read, with rows that do not fit their page and short records among them', () => {
    const want = t.filter((r) => r.a === 3 && r.b !== null && r.b > 10);
    expect(want.some((r) => r.big.length > 5000)).toBe(true);
    expect(rows('SELECT id FROM t WHERE a = 3 AND b > 10')).toEqual(want.map((r) => [r.id]));
    expect(rows('SELECT count(*) FROM t WHERE a = 3 AND b > 10')).toEqual([[want.length]]);
    // A column added later: the rows written before it have no value of their own for it.
    const added = t.filter((r) => r.z === 7 && r.a === 3);
    expect(added.some((r) => r.id <= 200) && added.some((r) => r.id > 200)).toBe(true);
    expect(rows('SELECT id FROM t WHERE z = 7 AND a = 3')).toEqual(added.map((r) => [r.id]));
  });

  it('a column a conjunct and something after the scan both read', () => {
    const want = t.filter((r) => r.a === 3 && r.b !== null && r.b > 10);
    expect(rows('SELECT id, a FROM t WHERE a = 3 AND b > 10')).toEqual(want.map((r) => [r.id, r.a]));
    expect(rows('SELECT b, id FROM t WHERE a = 3 AND b > 10 ORDER BY b DESC')).toEqual([...want].sort((x, y) => y.b! - x.b!).map((r) => [r.b, r.id]));
    expect(rows('SELECT s, count(*), max(a) FROM t WHERE b > 10 GROUP BY s ORDER BY s')).toEqual(
      [...new Set(t.map((r) => r.s))].sort().flatMap((s) => {
        const of = t.filter((r) => r.s === s && r.b !== null && r.b > 10);
        const as = of.flatMap((r) => (r.a === null ? [] : [r.a]));
        return of.length ? [[s, of.length, as.length ? Math.max(...as) : null]] : [];
      }),
    );
  });

  it('a conjunct the closure compiler runs (a function of a text), and one with a parameter', () => {
    const want = t.filter((r) => r.big.length > 100 && r.s === 'v1');
    expect(want.length).toBeGreaterThan(0);
    expect(rows("SELECT id FROM t WHERE length(big) > 100 AND s = 'v1'")).toEqual(want.map((r) => [r.id]));
    expect(rows('SELECT id FROM t WHERE a = ? AND s <> ?', [5, 'v2'])).toEqual(t.filter((r) => r.a === 5 && r.s !== 'v2').map((r) => [r.id]));
  });

  it('a conjunct inside a subquery that reads the row outside it: that row’s column stays read', () => {
    // `u.w` is read by nothing but the conjunct in the subquery, which a generated scan of `t` decides.
    const first = (x: U) => t.find((r) => r.a === x.w && x.w !== null && r.b !== null && r.b > 10)?.id ?? null;
    expect(rows('SELECT u.id, (SELECT t.id FROM t WHERE t.a = u.w AND t.b > 10 ORDER BY t.id LIMIT 1) FROM u ORDER BY u.id')).toEqual(u.map((x) => [x.id, first(x)]));
    const any = (x: U) => t.some((r) => r.a === x.w && x.w !== null && r.z === 7);
    expect(rows('SELECT u.id FROM u WHERE EXISTS (SELECT 1 FROM t WHERE t.a = u.w AND t.z = 7) ORDER BY u.id')).toEqual(u.filter(any).map((x) => [x.id]));
    expect(rows('SELECT u.id FROM u WHERE NOT EXISTS (SELECT 1 FROM t WHERE t.a = u.w AND t.z = 7) ORDER BY u.id')).toEqual(u.filter((x) => !any(x)).map((x) => [x.id]));
  });

  it('joins: a column only a join condition reads, on either side, and the rows an outer join fills in', () => {
    const at = new Map(t.map((r) => [r.id, r]));
    const inner = u.flatMap((x) => {
      const r = at.get(x.t);
      return r && r.a !== null && r.a > 5 ? [[x.id, r.id]] : [];
    });
    expect(rows('SELECT u.id, t.id FROM u JOIN t ON t.id = u.t WHERE t.a > 5 ORDER BY u.id')).toEqual(inner);
    const left = u.map((x) => {
      const r = at.get(x.t);
      return [x.id, r && r.a !== null && r.a > 5 ? r.id : null, r && r.a !== null && r.a > 5 ? r.s : null];
    });
    expect(rows('SELECT u.id, t.id, t.s FROM u LEFT JOIN t ON t.id = u.t AND t.a > 5 ORDER BY u.id')).toEqual(left);
    // No index to join by: the scans are generated, and `t.a`, `u.w` are read by the join condition alone.
    const pairs = byId(u).flatMap((x) => byId(t).flatMap((r) => (x.w !== null && r.a === x.w && r.z === 3 ? [[x.id, r.id]] : [])));
    expect(rows('SELECT u.id, t.id FROM u JOIN t ON t.a = u.w WHERE t.z = 3 ORDER BY u.id, t.id')).toEqual(pairs);
    // `t.a` read by a conjunct the scan of `t` decides and by the join condition, which runs after the scan.
    expect(rows('SELECT u.id, t.id FROM u JOIN t ON t.a = u.w WHERE t.a > 2 AND t.z = 3 ORDER BY u.id, t.id')).toEqual(pairs.filter(([, id]) => t[id! - 1]!.a! > 2));
  });

  const col = (input: number, index: number): PlanExpr => p.col(input, index, 'any');
  const count = { fn: 'count', args: [], star: true, distinct: false, collation: 'binary', type: 'int' };
  const run = (plan: PlanOp): unknown[][] => {
    const first = db.queryPlan(plan).rows as unknown[][];
    expect(db.queryPlan(plan).rows).toEqual(first);
    return first;
  };

  it('a nested plan whose outputs nothing reads: its rows, joined and counted', () => {
    // The nested plan gives id, a, s and big; the plan around it reads the id (and `a` in the second).
    const nested = p.project(p.scan('t', [0, 1, 3, 4]), [col(0, 0), col(0, 1), col(0, 2), col(0, 3)]);
    const joined: PlanOp = { op: 'join', kind: 'inner', inputs: [nested, p.scan('u', [0, 1])], on: p.call('cmp_eq', [col(0, 0), col(1, 1)], 'bool') } as unknown as PlanOp;
    const ids = new Set(t.map((r) => r.id));
    expect(run({ op: 'aggregate', input: joined, keys: [], aggs: [count], carry: [] } as unknown as PlanOp)).toEqual([[u.filter((x) => ids.has(x.t)).length]]);
    const at = new Map(t.map((r) => [r.id, r]));
    const want = byId(u).flatMap((x) => (at.has(x.t) ? [[x.id, at.get(x.t)!.a]] : []));
    expect(run({ op: 'sort', input: p.project(joined, [col(0, 4), col(0, 1)]), keys: [{ expr: col(0, 0), desc: false, nullsFirst: false, collation: 'binary' }] } as unknown as PlanOp)).toEqual(want);
  });

  it('a nested plan with a condition on a column it also gives, which nothing reads', () => {
    const nested = p.project(p.filter(p.scan('t', [0, 1, 2, 4]), p.call('cmp_gt', [col(0, 2), p.lit(10, 'int')], 'bool')), [col(0, 0), col(0, 1), col(0, 2), col(0, 3)]);
    const joined: PlanOp = { op: 'join', kind: 'inner', inputs: [nested, p.scan('u', [0, 1])], on: p.call('cmp_eq', [col(0, 0), col(1, 1)], 'bool') } as unknown as PlanOp;
    const at = new Map(t.map((r) => [r.id, r]));
    const hit = (x: U) => {
      const r = at.get(x.t);
      return r !== undefined && r.b !== null && r.b > 10;
    };
    expect(run({ op: 'aggregate', input: joined, keys: [], aggs: [count], carry: [] } as unknown as PlanOp)).toEqual([[u.filter(hit).length]]);
    // And read after all: the condition's column as a result.
    const want = byId(u).flatMap((x) => (hit(x) ? [[x.id, at.get(x.t)!.b]] : []));
    expect(run({ op: 'sort', input: p.project(joined, [col(0, 4), col(0, 2)]), keys: [{ expr: col(0, 0), desc: false, nullsFirst: false, collation: 'binary' }] } as unknown as PlanOp)).toEqual(want);
  });
});
