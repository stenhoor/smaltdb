/**
 * A nested plan's projection computes only the outputs the plan around it reads, where leaving one out can't hide an
 * error: a column, a constant, a parameter, or logic and CASE over those. The rows are the same as when every output
 * is computed, and an output that can fail is computed whether or not it is read.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { Fn } from '../src/engine/exec/expr.js';
import { type Operator, Project } from '../src/engine/exec/operators.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import type { SqlValue } from '../src/engine/values.js';

const col = (index: number, type: 'int' | 'text' | 'bool' = 'int', input = 0): PlanExpr => p.col(input, index, type);
const eq = (a: PlanExpr, b: PlanExpr): PlanExpr => p.call('cmp_eq', [a, b], 'bool');
const count = (plan: PlanOp, of?: PlanExpr): PlanOp => p.aggregate(plan, [], [of ? p.agg('count', [of], 'int') : p.agg('count', [], 'int', { star: true })]);

function open(): Database {
  const db = Database.openMemory();
  db.exec('CREATE TABLE t(a INTEGER, b INTEGER, c TEXT)');
  db.exec("INSERT INTO t VALUES (1, 10, 'x'), (2, NULL, 'y'), (3, 30, NULL), (4, 40, 'x')");
  return db;
}
const rows = (db: Database, plan: PlanOp): unknown[][] => db.queryPlan(plan).rows as unknown[][];

/** The table's columns, a constant, a CASE over them, and a sum: six outputs, the last one a call. */
const inner = (): PlanOp =>
  p.project(p.scan('t', [0, 1, 2]), [
    col(0),
    col(1),
    col(2, 'text'),
    p.lit('k'),
    p.caseWhen([{ when: p.isNull(col(1)), then: p.lit(-1) }], 'int', col(1)),
    p.call('add', [col(0), p.lit(100)], 'int'),
  ]);

describe('a nested plan whose outputs are not all read', () => {
  const db = open();

  it('gives the rows it gives when every output is computed', () => {
    expect(rows(db, p.project(inner(), [col(0)]))).toEqual([[1], [2], [3], [4]]);
    expect(rows(db, p.project(inner(), [col(4), col(3, 'text')]))).toEqual([[10, 'k'], [-1, 'k'], [30, 'k'], [40, 'k']]);
    expect(rows(db, p.project(inner(), [col(5), col(2, 'text'), col(1)]))).toEqual([[101, 'x', 10], [102, 'y', null], [103, null, 30], [104, 'x', 40]]);
    // Every output, and none.
    expect(rows(db, p.project(inner(), [col(0), col(1), col(2, 'text'), col(3, 'text'), col(4), col(5)]))).toHaveLength(4);
    expect(rows(db, count(inner()))).toEqual([[4]]);
    expect(rows(db, count(inner(), col(1)))).toEqual([[3]]);
  });

  it('computes an output that only a condition, a key or a join reads', () => {
    expect(rows(db, p.project(p.filter(inner(), eq(col(4), p.lit(-1))), [col(0)]))).toEqual([[2]]);
    expect(rows(db, p.project(p.sort(inner(), [p.desc(col(4))]), [col(0)]))).toEqual([[4], [3], [1], [2]]);
    expect(rows(db, p.aggregate(inner(), [col(2, 'text')], [p.agg('count', [], 'int', { star: true })]))).toEqual(expect.arrayContaining([['x', 2], ['y', 1], [null, 1]]));
    const joined = p.join('inner', p.fromColumns([[10, 40]], ['int']), inner(), eq(col(4, 'int', 1), col(0)));
    expect(rows(db, p.project(joined, [col(1)])).map((r) => r[0]).sort()).toEqual([1, 4]);
    // A row with no match is NULL in the nested plan's columns, read or not.
    const left = p.join('left', p.fromColumns([[10, 99]], ['int']), inner(), eq(col(1, 'int', 1), col(0)));
    expect(rows(db, p.project(left, [col(0), col(1), col(4, 'text')])).sort()).toEqual([[10, 1, 'k'], [99, null, null]]);
  });

  it('computes an output that can fail, read or not', () => {
    const failing = p.project(p.scan('t', [0]), [col(0), p.call('raise_error', [p.lit('not computed?')], 'int')]);
    expect(() => rows(db, p.project(failing, [col(0)]))).toThrow('not computed?');
    // Under a filter that passes no row it is never reached, as before.
    expect(rows(db, p.project(p.project(p.filter(p.scan('t', [0]), eq(col(0), p.lit(99))), [col(0), p.call('raise_error', [p.lit('no row')], 'int')]), [col(0)]))).toEqual([]);
  });

  it('is the same statement run again, and with other parameters', () => {
    const plan = p.project(p.filter(inner(), eq(col(0), p.param(0, 'int'))), [col(4)]);
    const st = db.preparePlan({ kind: 'query', plan, paramCount: 1 } as unknown as PlanStatementInput);
    expect(st.result([2]).rows).toEqual([[-1]]);
    expect(st.result([4]).rows).toEqual([[40]]);
    expect(st.result([2]).rows).toEqual([[-1]]);
  });

  it('leaves a nested plan with DISTINCT, an order or a limit as it is', () => {
    const distinct = p.distinct(p.project(p.scan('t', [2, 0]), [col(0, 'text'), p.lit(1)]), 2);
    expect(rows(db, count(distinct))).toEqual([[3]]);
    const limited = p.limit(p.sort(inner(), [p.desc(col(0))]), p.lit(2));
    expect(rows(db, p.project(limited, [col(4)]))).toEqual([[40], [30]]);
  });
});

describe('the projection', () => {
  /** A child that gives `n` rows and writes nothing. */
  const child = (n: number): Operator => {
    let left = 0;
    return { children: [], detail: '', open: () => void (left = n), next: () => left-- > 0, close: () => undefined };
  };

  it('does not call what nothing reads, when it can skip it', () => {
    const calls = [0, 0, 0];
    const fns: Fn[] = calls.map((_, i) => (): SqlValue => ++calls[i]!);
    const project = new Project(child(5), fns, [0, 1, 2]);
    project.canSkip = [true, true, false];
    const reads = [false, false, false];
    project.reads = reads;
    // Read after the projection is made and before it first opens, as a plan compiles.
    reads[0] = true;
    const r: SqlValue[] = [null, null, null];
    project.open(r);
    while (project.next());
    project.close();
    // The first is read; the second isn't and can be skipped; the third isn't but can fail.
    expect(calls).toEqual([5, 0, 5]);
    expect(r).toEqual([5, null, 5]);
  });

  it('computes everything when the planner says nothing about reads', () => {
    const calls = [0, 0];
    const project = new Project(child(3), calls.map((_, i) => (): SqlValue => ++calls[i]!), [0, 1]);
    project.canSkip = [true, true];
    project.open([null, null]);
    while (project.next());
    expect(calls).toEqual([3, 3]);
  });
});
