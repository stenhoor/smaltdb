/**
 * The public plan API (ADR 0014 section 4, ADR 0015 step 8): statements given as plan data to `Database.preparePlan`
 * / `queryPlan`, built with the `plan` builders, validated before they are planned.
 */
import { describe, expect, it } from 'vitest';
import { Database, plan as p } from '../src/engine/index.js';
import type { PlanStatementInput } from '../src/engine/index.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

function db(): Database {
  const d = Database.openFile(new MemoryVfs().openSync('p.db'));
  d.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, n INT)');
  d.exec("INSERT INTO t VALUES (1, 'a', 10), (2, 'b', 20), (3, 'c', 30), (4, 'd', NULL)");
  return d;
}

const id = p.col(0, 0, 'int');
const name = p.col(0, 1, 'text');
const n = p.col(0, 2, 'int');

describe('plan API', () => {
  it('runs a query plan built with the builders, as SQL would', () => {
    const d = db();
    // SELECT name, n * 2 FROM t WHERE n > ? ORDER BY n DESC LIMIT 2
    const q = p.limit(p.sort(p.project(p.filter(p.scan('t', [0, 1, 2]), p.call('cmp_gt', [n, p.param(0, 'int')], 'int')), [name, p.call('mul', [n, p.lit(2)], 'int'), n]), [p.desc(p.col(0, 2, 'int'))]), 2);
    const r = d.queryPlan({ kind: 'query', plan: p.project(q, [p.col(0, 0, 'text'), p.col(0, 1, 'int')]), columns: [{ name: 'name', type: 'text' }, { name: 'twice', type: 'int' }] }, [15]);
    expect(r).toEqual({ columns: ['name', 'twice'], columnTypes: ['text', 'int'], rows: [['c', 60], ['b', 40]] });
    expect(d.query('SELECT name, n * 2 FROM t WHERE n > ? ORDER BY n DESC LIMIT 2', [15]).rows).toEqual(r.rows);
  });

  it('names the columns of a bare plan column1, column2, …, typed from the plan', () => {
    const d = db();
    const st = d.preparePlan(p.project(p.scan('t', [0, 1]), [id, name]));
    expect(st.columns).toEqual(['column1', 'column2']);
    expect(st.columnTypes).toEqual(['int', 'text']);
    expect(st.all()).toHaveLength(4);
    expect(() => d.preparePlan({ kind: 'query', plan: p.scan('t', [0]), columns: [{ name: 'a' }, { name: 'b' }] })).toThrow(/produces 1 column\(s\), but 2 are described/);
  });

  it('groups and aggregates', () => {
    const d = db();
    d.exec("INSERT INTO t VALUES (5, 'a', 5)");
    const g = p.sort(p.aggregate(p.scan('t', [1, 2]), [p.col(0, 0, 'text')], [p.agg('sum', [p.col(0, 1, 'int')], 'int'), p.agg('count', [], 'int', { star: true })]), [p.asc(p.col(0, 0, 'text'))]);
    expect(d.queryPlan(g).rows).toEqual([['a', 15, 2], ['b', 20, 1], ['c', 30, 1], ['d', null, 1]]);
  });

  it("compares text with the collation a comparison call names", () => {
    const d = db();
    d.exec("INSERT INTO t VALUES (5, 'B', 50)");
    const ids = (pred: p.PlanExpr): unknown[] => d.queryPlan(p.project(p.filter(p.scan('t', [0, 1, 2]), pred), [id])).rows.flat();
    // A column against a literal (a fused scan's text equality) and against an expression (generated code).
    expect(ids(p.call('cmp_eq', [name, p.lit('b')], 'int', 'nocase'))).toEqual([2, 5]);
    expect(ids(p.call('cmp_eq', [name, p.lit('b')], 'int'))).toEqual([2]);
    expect(ids(p.call('cmp_eq', [name, p.call('upper', [p.lit('b')], 'text')], 'int', 'nocase'))).toEqual([2, 5]);
    expect(ids(p.call('cmp_ne', [name, p.call('upper', [p.lit('b')], 'text')], 'int', 'nocase'))).toEqual([1, 3, 4]);
    expect(ids(p.call('cmp_eq', [name, p.call('upper', [p.lit('b')], 'text')], 'int'))).toEqual([5]);
    // As SQL compares them.
    expect(d.query("SELECT id FROM t WHERE name = 'b' COLLATE NOCASE ORDER BY id").rows.flat()).toEqual([2, 5]);
  });

  it('takes positional parameters only, as many as the plan reads', () => {
    const d = db();
    const q = p.filter(p.scan('t', [0]), p.call('cmp_eq', [id, p.param(1, 'int')], 'int'));
    const st = d.preparePlan(q);
    expect(st.paramCount).toBe(2);
    expect(st.all([null, 3])).toEqual([[3]]);
    expect(() => st.all([3])).toThrow(/expects 2 parameter\(s\), got 1/);
    expect(() => st.all({ a: 1 } as never)).toThrow(/positional/);
    expect(() => d.preparePlan(p.filter(p.scan('t', [0]), p.param(40000)))).toThrow(/at most 32766 parameters/);
  });

  it('validates every plan before planning it', () => {
    const d = db();
    const bad: [PlanStatementInput, RegExp][] = [
      [p.scan('nope', [0]), /no such table: nope/],
      [p.scan('t', [7]), /column 7/],
      [p.project(p.scan('t', [0]), [p.col(0, 3, 'int')]), /column/],
      [p.project(p.scan('t', [0]), [p.call('no_such_fn', [], 'int')]), /no_such_fn/],
      [{ kind: 'query', plan: { op: 'teleport' } as never }, /unknown operation|teleport/],
    ];
    for (const [q, msg] of bad) expect(() => d.preparePlan(q), String(msg)).toThrow(expect.objectContaining({ code: 'SMALT_PLAN', message: expect.stringMatching(msg) }));
  });

  it('writes: append, update and delete plans, with RETURNING', () => {
    const d = db();
    const ins = d.preparePlan({ kind: 'write', plan: p.append('t', p.values([[p.lit(9), p.param(0, 'text'), p.lit(90)]]), [0, 1, 2], { returning: [p.col(0, 1, 'text')] }), returning: [{ name: 'name', type: 'text' }] });
    expect(ins.columns).toEqual(['name']);
    expect(ins.all(['z'])).toEqual([['z']]);
    // UPDATE t SET n = n + 1 WHERE id = 9: the input gives the target's columns, then its rowid.
    const up = p.update('t', p.filter(p.scan('t', [0, 1, 2, -1]), p.call('cmp_eq', [id, p.lit(9)], 'int')), 3, [{ column: 2, value: p.call('add', [n, p.lit(1)], 'int') }]);
    expect(d.preparePlan({ kind: 'write', plan: up }).run().changes).toBe(1);
    expect(d.query('SELECT n FROM t WHERE id = 9').rows).toEqual([[91]]);
    expect(d.preparePlan({ kind: 'write', plan: p.remove('t', p.filter(p.scan('t', [0, -1]), p.isNull(p.col(0, 0, 'int'))), 1) }).run().changes).toBe(0);
    expect(d.preparePlan({ kind: 'write', plan: p.remove('t', p.filter(p.scan('t', [2, -1]), p.isNull(p.col(0, 0, 'int'))), 1) }).run().changes).toBe(1);
    expect(d.query('SELECT count(*) FROM t').rows).toEqual([[4]]);
  });

  it('runs other bound statements: schema operations and transactions', () => {
    const d = db();
    const create: PlanStatementInput = {
      kind: 'schema',
      op: {
        op: 'createTable',
        table: { name: 'u', columns: [{ name: 'x', declaredType: 'INTEGER', type: 'INTEGER', notNull: true, collation: 'binary' }], keys: [], checks: [], foreignKeys: [], storage: 'row' },
        temp: false,
        ifNotExists: false,
        source: { language: 'sql', text: 'CREATE TABLE u(x INTEGER NOT NULL)' },
      },
    };
    d.preparePlan(create).run();
    d.preparePlan({ kind: 'transaction', action: 'begin', mode: 'deferred' }).run();
    d.preparePlan({ kind: 'write', plan: p.append('u', p.values([[p.lit(1)], [p.lit(2)]]), [0]) }).run();
    d.preparePlan({ kind: 'transaction', action: 'rollback' }).run();
    expect(d.query('SELECT count(*) FROM u').rows).toEqual([[0]]);
    expect(() => d.preparePlan({ kind: 'write', plan: p.append('u', p.values([[p.lit(null)]]), [0]) }).run()).toThrow(/u\.x must not be null/);
  });

  it('caches plans by their canonical form, and replans after schema changes', () => {
    const d = db();
    const a = { op: 'scan', table: 't', columns: [0] } as const;
    const b = { columns: [0], table: 't', op: 'scan' } as const;
    expect(d.queryPlan(a).rows).toEqual(d.queryPlan(b).rows);
    expect((d as unknown as { planCache: Map<string, unknown> }).planCache.size).toBe(1);
    const st = d.preparePlan(p.project(p.scan('t', [0]), [p.call('add', [id, p.lit(1)], 'int')]));
    expect(st.all()).toEqual([[2], [3], [4], [5]]);
    d.exec('ALTER TABLE t ADD COLUMN e INT DEFAULT 0');
    expect(st.all()).toEqual([[2], [3], [4], [5]]);
    d.exec('DROP TABLE t');
    expect(() => st.all()).toThrow(/no such table: t/);
  });

  it('runs a plan read back from its JSON form', () => {
    const d = db();
    const q = p.filter(p.scan('t', [0, 1]), p.call('like', [name, p.lit('%b%')], 'int'));
    expect(d.queryPlan(p.planFromJSON(p.planToJSON(q))).rows).toEqual(d.queryPlan(q).rows);
    expect(d.queryPlan(q).rows).toEqual([[2, 'b']]);
  });

  it('knows a plan over a TEMP table reads memory objects', () => {
    const d = db();
    d.exec('CREATE TEMP TABLE tt(a)');
    expect(d.preparePlan(p.scan('t', [0])).usesMemoryObjects).toBe(false);
    expect(d.preparePlan(p.scan('tt', [0], { db: 'temp' })).usesMemoryObjects).toBe(true);
  });

  it('plans shapes SQL never builds, with the same rows as the SQL that means them', () => {
    const d = db();
    d.exec('CREATE TABLE u(tid INT, tag TEXT)');
    d.exec("INSERT INTO u VALUES (1, 'x'), (1, 'y'), (3, 'z')");
    const tid = (i: number) => p.col(0, i, 'int');
    const cases: [PlanStatementInput, string][] = [
      [p.scan('t', [1]), 'SELECT name FROM t'],
      [p.filter(p.filter(p.scan('t', [0, 2]), p.isNotNull(p.col(0, 1, 'int'))), p.call('cmp_gt', [p.col(0, 1, 'int'), p.lit(10)], 'int')), 'SELECT id, n FROM t WHERE n IS NOT NULL AND n > 10'],
      [p.sort(p.aggregate(p.scan('u', [0]), [tid(0)], [p.agg('count', [], 'int', { star: true })]), [p.desc(p.col(0, 1, 'int')), p.asc(tid(0))]), 'SELECT tid, count(*) FROM u GROUP BY tid ORDER BY 2 DESC, 1'],
      [p.distinct(p.scan('u', [0]), 1), 'SELECT DISTINCT tid FROM u'],
      [p.project(p.limit(p.sort(p.scan('t', [0]), [p.desc(id)]), 2), [p.call('mul', [id, p.lit(10)], 'int')]), 'SELECT id * 10 FROM (SELECT id FROM t ORDER BY id DESC LIMIT 2)'],
      [p.join('left', p.scan('t', [0]), p.join('inner', p.scan('u', [0, 1]), p.scan('t', [0])), p.call('cmp_eq', [p.col(0, 0, 'int'), p.col(1, 0, 'int')], 'int')), 'SELECT t.id, x.* FROM t LEFT JOIN (SELECT u.tid, u.tag, t2.id FROM u JOIN t AS t2) AS x ON t.id = x.tid'],
      [p.values([[p.lit(1), p.lit('a')], [p.lit(2), p.lit('b')]]), "VALUES (1, 'a'), (2, 'b')"],
      [p.project(p.scan('t', [0]), [id, p.scalar(p.aggregate(p.filter(p.scan('u', [0]), p.call('cmp_eq', [tid(0), p.col(0, 0, 'int', 'binary', 1)], 'int')), [], [p.agg('count', [], 'int', { star: true })]), 'int')]), 'SELECT id, (SELECT count(*) FROM u WHERE u.tid = t.id) FROM t'],
      [p.project(p.sort(p.scan('t', [0, 1, 2]), [p.desc(p.col(0, 2, 'int'), { nullsFirst: false }), p.asc(id)]), [name, p.call('mul', [id, p.lit(2)], 'int')]), 'SELECT name, id * 2 FROM t ORDER BY n DESC NULLS LAST, id'],
      [p.limit(p.project(p.sort(p.scan('t', [0, 1]), [p.desc(id)]), [name]), 2), 'SELECT name FROM t ORDER BY id DESC LIMIT 2'],
      [p.setop('unionAll', p.scan('t', [0]), p.sort(p.scan('u', [0]), [p.asc(tid(0))]), 1), 'SELECT id FROM t UNION ALL SELECT * FROM (SELECT tid FROM u ORDER BY tid)'],
    ];
    const sorted = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();
    for (const [q, sql] of cases) {
      const ordered = /ORDER BY/.test(sql) && !/UNION/.test(sql) && !/FROM \(SELECT/.test(sql);
      const got = d.queryPlan(q).rows;
      const want = d.query(sql).rows;
      if (ordered) expect(got, sql).toEqual(want);
      else expect(sorted(got), sql).toEqual(sorted(want));
    }
  });
});
