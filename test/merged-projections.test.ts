/**
 * A projection straight over a projection is planned as one, where composing them changes nothing
 * (`composed` in exec/plan-normalize.ts): the rows are those of the two, one operator copies the row where two did,
 * and the planner sees the inner one's input rather than a nested plan. Not composed: an inner expression that could
 * fail and that nothing reads (it is computed for every row), one other than a column or a literal read twice, a
 * subquery, a projection over a sort, a limit or a DISTINCT, and readers that declare another type or collation.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { ColumnDef, StorageType } from '../src/engine/plan/schema.js';
import type { PlanType } from '../src/engine/plan/types.js';

const col = (index: number, type: PlanType = 'int'): PlanExpr => p.col(0, index, type);
const add = (a: PlanExpr, b: PlanExpr): PlanExpr => p.call('add', [a, b], 'int');

function open(): Database {
  const db = Database.openMemory();
  db.exec('CREATE TABLE t(a INTEGER, b INTEGER, c TEXT)');
  db.exec("INSERT INTO t VALUES (1, 10, 'x'), (2, NULL, 'y'), (3, 30, NULL), (4, 40, 'x')");
  return db;
}
const rows = (db: Database, plan: PlanOp, params?: unknown[]): unknown[][] => db.queryPlan(plan, params as never).rows as unknown[][];
/** The operators of a plan as EXPLAIN ANALYZE names them, from the top. */
const operators = (db: Database, plan: PlanOp): string[] =>
  (db.queryPlan({ kind: 'explain', mode: 'analyze', query: { kind: 'query', plan } } as never).rows as unknown[][]).map((r) => String(r[2]));
const projections = (db: Database, plan: PlanOp): number => operators(db, plan).filter((o) => o === 'PROJECT').length;

const scan = (): PlanOp => p.scan('t', [0, 1, 2]);
/** The table's columns and a constant. */
const plain = (): PlanOp => p.project(scan(), [col(0), col(1), col(2, 'text'), p.lit('k')]);
/** A column and a sum, which is a call: it could fail. */
const summed = (): PlanOp => p.project(scan(), [col(0), add(col(0), p.lit(100))]);

describe('a projection over a projection', () => {
  const db = open();

  it('is one projection, with the rows of the two', () => {
    const two = p.project(plain(), [col(1), col(3, 'text')]);
    expect(rows(db, two)).toEqual([[10, 'k'], [null, 'k'], [30, 'k'], [40, 'k']]);
    expect(projections(db, two)).toBe(1);
    const three = p.project(p.project(plain(), [col(1), col(0), col(3, 'text')]), [col(1)]);
    expect(rows(db, three)).toEqual([[1], [2], [3], [4]]);
    expect(projections(db, three)).toBe(1);
  });

  it('computes what it reads through the inner one: an expression over its columns, and an expression of it read once', () => {
    const over = p.project(plain(), [add(col(0), col(1)), col(2, 'text')]);
    expect(rows(db, over)).toEqual([[11, 'x'], [null, 'y'], [33, null], [44, 'x']]);
    expect(projections(db, over)).toBe(1);
    const once = p.project(summed(), [col(1)]);
    expect(rows(db, once)).toEqual([[101], [102], [103], [104]]);
    expect(projections(db, once)).toBe(1);
    // A column and a constant are read as often as asked.
    const often = p.project(plain(), [col(0), col(0), col(3, 'text'), col(3, 'text'), add(col(0), col(0))]);
    expect(rows(db, often)[1]).toEqual([2, 2, 'k', 'k', 4]);
    expect(projections(db, often)).toBe(1);
  });

  it('is one projection under an aggregate, a filter and a join too', () => {
    const counted = p.aggregate(p.project(plain(), [col(1), col(3, 'text')]), [], [p.agg('count', [col(0)], 'int')]);
    expect(rows(db, counted)).toEqual([[3]]);
    expect(projections(db, counted)).toBe(2);
    const filtered = p.project(p.filter(p.project(plain(), [col(1), col(0)]), p.call('cmp_gt', [col(0), p.lit(10)], 'bool')), [col(1)]);
    expect(rows(db, filtered)).toEqual([[3], [4]]);
    const joined = p.join('inner', p.fromColumns([[10, 40]], ['int']), p.project(plain(), [col(1), col(0)]), p.call('cmp_eq', [p.col(1, 0, 'int'), col(0)], 'bool'));
    expect(rows(db, p.project(joined, [col(2)])).map((r) => r[0]).sort()).toEqual([1, 4]);
  });

  it('keeps a parameter where the inner one reads it', () => {
    const inner = p.project(scan(), [col(0), p.param(0, 'int'), add(col(1), p.param(1, 'int'))]);
    const plan = p.project(inner, [col(2), col(1)]);
    const st = db.preparePlan({ kind: 'query', plan, paramCount: 2 } as never);
    expect(st.result([7, 1]).rows).toEqual([[11, 7], [null, 7], [31, 7], [41, 7]]);
    expect(st.result([8, 2]).rows).toEqual([[12, 8], [null, 8], [32, 8], [42, 8]]);
  });
});

describe('two projections stay two', () => {
  const db = open();

  it('where an expression that could fail is read by nothing: it is computed for every row', () => {
    const unread = p.project(summed(), [col(0)]);
    expect(rows(db, unread)).toEqual([[1], [2], [3], [4]]);
    expect(projections(db, unread)).toBe(2);
    const failing = p.project(scan(), [col(0), p.call('raise_error', [p.lit('computed, though unread')], 'int')]);
    expect(() => rows(db, p.project(failing, [col(0)]))).toThrow('computed, though unread');
  });

  it('where an expression other than a column or a constant is read twice: it is computed once a row', () => {
    const twice = p.project(summed(), [col(1), col(1)]);
    expect(rows(db, twice)).toEqual([[101, 101], [102, 102], [103, 103], [104, 104]]);
    expect(projections(db, twice)).toBe(2);
    // A random number read twice is one number.
    const random = p.project(p.project(scan(), [p.call('random', [], 'int')]), [col(0), col(0)]);
    for (const r of rows(db, random)) expect(r[0]).toBe(r[1]);
  });

  it('where the inner one is over a sort, a limit or a DISTINCT, whose order and rows it keeps', () => {
    const sorted = p.project(p.project(p.sort(scan(), [p.desc(col(0))]), [col(0), col(1)]), [col(1)]);
    expect(rows(db, sorted)).toEqual([[40], [30], [null], [10]]);
    const limited = p.project(p.project(p.limit(p.sort(scan(), [p.desc(col(0))]), p.lit(2)), [col(0), col(1)]), [col(1)]);
    expect(rows(db, limited)).toEqual([[40], [30]]);
    const distinct = p.project(p.project(p.distinct(p.project(scan(), [col(2, 'text')]), 1), [col(0, 'text'), p.lit(1)]), [col(0, 'text')]);
    expect(rows(db, distinct).map((r) => r[0]).sort()).toEqual([null, 'x', 'y']);
  });

  it('where a subquery reads the row', () => {
    // Whether a row of t has this row's b as its a: the subquery reads the enclosing row's second column.
    const exists = p.exists(p.filter(p.scan('t', [0]), p.call('cmp_eq', [col(0), { ...col(1), depth: 1 } as PlanExpr], 'bool')));
    const plan = p.project(p.project(scan(), [col(0), add(col(0), p.lit(1))]), [col(1), exists]);
    expect(rows(db, plan).map((r) => [r[0], r[1] === true || r[1] === 1])).toEqual([[2, true], [3, true], [4, true], [5, false]]);
  });

  it('where the reader declares another type or collation than the column has', () => {
    // Text compared without case through a column that declares it so: the declaration stays the reader's.
    const nocase = p.project(p.project(scan(), [col(2, 'text')]), [p.call('cmp_eq', [{ ...col(0, 'text'), collation: 'nocase' } as PlanExpr, p.lit('X')], 'bool')]);
    const direct = p.project(scan(), [p.call('cmp_eq', [{ ...col(2, 'text'), collation: 'nocase' } as PlanExpr, p.lit('X')], 'bool')]);
    expect(rows(db, nocase)).toEqual(rows(db, direct));
  });
});

describe('a column read through a projection keeps the type its reader declares', () => {
  const M = 'map<text, any>' as PlanType;
  const column = (name: string, type: StorageType, declaredType: string): ColumnDef => ({ name, declaredType, type, notNull: false, collation: 'binary' });
  const db = Database.openMemory();
  db.queryPlan({ kind: 'schema', op: { op: 'createTable', table: { name: 'm', columns: [column('id', 'INTEGER', 'INTEGER'), column('props', 'MAP', M)], keys: [], checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false } });
  const people = [
    { city: 'Oslo', age: 30 },
    { city: 'Lund', age: 40 },
    { city: 'Oslo', age: 50 },
    { city: 'Lund', age: 20 },
    { city: 'Bonn', age: 10 },
  ];
  db.queryPlan({ kind: 'write', plan: p.append('m', p.fromColumns([people.map((_, i) => i), people] as never, ['int', M]), [0, 1]) });
  const get = (index: number, key: string): PlanExpr => p.call('map_get', [col(index, M), p.lit(key)], 'any');

  it('a map passed through as a column of any kind is read as the map it is', () => {
    // The inner projection declares the map as `any`, as the engine's own rewrites pass columns through.
    const through = p.project(p.scan('m', [0, 1]), [col(0), col(1, 'any')]);
    expect(rows(db, p.project(through, [get(1, 'city'), get(1, 'age')]))).toEqual(people.map((x) => [x.city, x.age]));
  });

  it('groups in the order of their first row read their keys through the projections under them', () => {
    // An aggregate that keeps the order of a sort under projections: its rewrite passes every column through.
    const sorted = p.sort(p.project(p.scan('m', [0, 1]), [col(0), col(1, M)]), [p.desc(col(0))]);
    const input = p.project(p.project(sorted, [col(0), col(1, M)]), [col(0), col(1, M), get(1, 'age')]);
    const grouped = p.aggregate(input, [get(1, 'city')], [p.agg('count', [col(0)], 'int'), p.agg('sum', [col(2, 'any')], 'any')], { ordered: 'first' });
    // Sorted by id descending: Bonn first, then Lund, then Oslo.
    expect(rows(db, grouped)).toEqual([
      ['Bonn', 1, 10],
      ['Lund', 2, 60],
      ['Oslo', 2, 80],
    ]);
  });
});
