/** The plan validator (ADR 0015 step 5, plan/validate.ts): plans from an untrusted builder are checked first. */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { sqlLanguage } from 'smaltql';
import type { BindContext } from '../src/engine/plan/bind-context.js';
import { type ValidateCatalog, MAX_PLAN_DEPTH, validatePlan } from '../src/engine/plan/validate.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const catalog: ValidateCatalog = { tableColumns: (name) => ({ t: 3, u: 2 })[name.toLowerCase()] };
const scan = (table = 't', columns = [0, 1, 2]): PlanOp => ({ op: 'scan', table, columns });
const col = (index: number, input = 0, depth = 0): PlanExpr => ({ k: 'col', input, index, depth, type: 'int', collation: 'binary' });
const lit = (value: number): PlanExpr => ({ k: 'lit', value, type: 'int' });
const project = (input: PlanOp, exprs: PlanExpr[]): PlanOp => ({ op: 'project', input, exprs });
const bad = (p: PlanOp, msg: RegExp): void => {
  expect(() => validatePlan(p, catalog)).toThrow(msg);
  try {
    validatePlan(p, catalog);
  } catch (e) {
    expect((e as { code?: string }).code).toBe('SMALT_PLAN');
  }
};

describe('plan validator', () => {
  it('accepts the plans the SQL front end makes', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, s TEXT); CREATE TABLE u(x INT, y REAL)');
    const ctx = (db as unknown as { bindContext(): BindContext }).bindContext();
    const live: ValidateCatalog = { tableColumns: (n) => ctx.getTable(n)?.columns.length };
    for (const q of [
      'SELECT a, count(*), sum(x) FILTER (WHERE y > 1) FROM t JOIN u ON u.x = t.a GROUP BY a HAVING count(*) > ? ORDER BY 2 LIMIT 3',
      'SELECT id, (SELECT max(y) FROM u WHERE u.x = t.a) FROM t WHERE a IN (SELECT x FROM u WHERE y > t.id)',
      'SELECT a, rank() OVER (PARTITION BY s ORDER BY id ROWS BETWEEN 1 PRECEDING AND CURRENT ROW), lag(a, 1) OVER (ORDER BY id) FROM t',
      'WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5) SELECT i FROM n',
      'SELECT * FROM t, pragma_table_info(t.s) WHERE t.a = 1',
      'SELECT a FROM t UNION SELECT x FROM u',
    ]) {
      const plan = (sqlLanguage.parseOne(q).bind(ctx) as { plan: PlanOp }).plan;
      expect(() => validatePlan(plan, live), q).not.toThrow();
    }
  });

  it('refuse column references out of range', () => {
    bad(project(scan(), [col(3)]), /plan\.exprs\[0\]: column 3 of input 0, which has 3/);
    bad(project(scan(), [col(0, 1)]), /input 1, which does not exist/);
    bad(project(scan(), [col(0, 0, 1)]), /enclosing scope 1, which does not exist/);
    bad({ op: 'join', kind: 'inner', inputs: [scan(), scan('u', [0, 1])], on: col(2, 1) }, /plan\.on: column 2 of input 1, which has 2/);
    // A subquery reads its enclosing expression's input at depth 1.
    const sub = (i: number): PlanOp => project(scan(), [{ k: 'subquery', mode: 'scalar', plan: project(scan('u', [0, 1]), [col(i, 0, 1)]), type: 'any', collation: 'binary' }]);
    expect(() => validatePlan(sub(2), catalog)).not.toThrow();
    bad(sub(3), /column 3 of input 0, which has 3/);
  });

  it('refuse unknown tables, columns, functions and arities', () => {
    bad(scan('nope'), /no such table: nope/);
    bad(scan('t', [0, 5]), /table t has no column 5/);
    bad(project(scan(), [{ k: 'call', fn: 'no_such_fn', args: [], type: 'any' }]), /no such function: no_such_fn/);
    bad(project(scan(), [{ k: 'call', fn: 'sql.add', args: [lit(1)], type: 'int' }]), /wrong number of arguments to sql\.add: 1/);
    bad(project(scan(), [{ k: 'call', fn: 'abs', args: [lit(1), lit(2)], type: 'int' }]), /wrong number of arguments to abs: 2/);
    bad({ op: 'aggregate', input: scan(), keys: [], aggs: [{ fn: 'nope', args: [], star: false, distinct: false, collation: 'binary', type: 'int' }], carry: [] }, /no such aggregate function: nope/);
    bad(project(scan(), [{ k: 'lit', value: 1, type: 'bool' as never }]), /unknown type "bool"/);
    bad({ op: 'sort', input: scan(), keys: [{ expr: col(0), desc: false, nullsFirst: true, collation: 'french' as never }] }, /unknown collation "french"/);
    bad({ op: 'teleport' } as never, /unknown operation "teleport"/);
  });

  it('refuse mismatched set operations, stray working rows and deep nesting', () => {
    bad({ op: 'setop', kind: 'union', inputs: [scan(), scan('u', [0, 1])], collations: ['binary'] }, /inputs have 3 and 2 columns/);
    bad({ op: 'working', id: 7, types: ['int'] }, /working 7 outside its iterate/);
    let e: PlanExpr = lit(1);
    for (let i = 0; i <= MAX_PLAN_DEPTH; i++) e = { k: 'not', arg: e };
    bad(project(scan(), [e]), /nested more than 1000 deep/);
  });
});
