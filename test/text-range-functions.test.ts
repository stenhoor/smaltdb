/**
 * ADR 0033 step 5: engine functions that Cypher needs and SQL users use too: `starts_with`, `ends_with`, `contains`,
 * `split` (scalars) and `range` (a table function).
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';

const db = Database.openMemory();
const one = (sql: string) => db.query(sql).rows[0]![0];
const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

/** A call of an engine function on literal arguments, evaluated in a plan. */
const call = (fn: string, args: unknown[], type = 'bool') =>
  db.queryPlan({ kind: 'query', plan: p.project(p.values([[]]), [p.call(fn, args.map((a) => p.lit(a as never)), type as never)]) } as unknown as PlanStatementInput).rows[0]![0];
const bytes = (...b: number[]) => new Uint8Array(b);

describe('starts_with, ends_with, contains', () => {
  it.each([
    ['starts_with', ['smaltdb', 'smalt'], true],
    ['starts_with', ['smaltdb', 'db'], false],
    ['starts_with', ['smaltdb', ''], true],
    ['starts_with', ['ab', 'abc'], false],
    ['ends_with', ['smaltdb', 'db'], true],
    ['ends_with', ['smaltdb', 'smalt'], false],
    ['ends_with', ['', ''], true],
    ['contains', ['smaltdb', 'alt'], true],
    ['contains', ['smaltdb', 'ALT'], false],
    ['contains', ['smaltdb', ''], true],
    ['contains', ['naïve café', 'é'], true],
    ['starts_with', [12345, 12], true],
    ['ends_with', [1.5, 5], true],
    ['contains', [bytes(0, 1, 2, 3), bytes(1, 2)], true],
    ['contains', [bytes(0, 1, 2, 3), bytes(2, 1)], false],
    ['starts_with', [bytes(0, 1), bytes(0)], true],
    ['ends_with', [bytes(0, 1), bytes(0)], false],
  ])('%s(%j) is %s', (fn, args, want) => {
    expect(call(fn as string, args as unknown[])).toBe(want);
  });

  it('NULL in gives NULL', () => {
    expect([call('starts_with', [null, 'a']), call('ends_with', ['a', null]), call('contains', [null, null])]).toEqual([null, null, null]);
  });

  it('are case-sensitive, by code point, whatever the column collation', () => {
    db.exec("CREATE TABLE IF NOT EXISTS words(w TEXT COLLATE NOCASE); DELETE FROM words; INSERT INTO words VALUES ('Graph'), ('graph')");
    const plan = p.filter(p.scan('words', [0]), p.call('starts_with', [p.col(0, 0, 'text', 'nocase'), p.lit('G')], 'bool'));
    expect(db.queryPlan({ kind: 'query', plan } as unknown as PlanStatementInput).rows).toEqual([['Graph']]);
  });
});

describe('split', () => {
  it.each([
    [['a,b,,c', ','], ['a', 'b', '', 'c']],
    [['a::b', '::'], ['a', 'b']],
    [['abc', ','], ['abc']],
    [['', ','], ['']],
    [['héllo', ''], ['h', 'é', 'l', 'l', 'o']],
    [['😀x', ''], ['😀', 'x']],
    [[1.25, '.'], ['1', '25']],
  ])('split(%j)', (args, want) => {
    expect(call('split', args, 'list<text>')).toEqual(want);
  });

  it('is a list<text>, usable with the list functions, and NULL in gives NULL', () => {
    const plan = p.project(p.values([[]]), [p.call('list_len', [p.call('split', [p.lit('a b c'), p.lit(' ')], 'list<text>' as never)], 'int')]);
    expect(db.queryPlan({ kind: 'query', plan } as unknown as PlanStatementInput).rows).toEqual([[3]]);
    expect([call('split', [null, ','], 'list<text>'), call('split', ['a', null], 'list<text>')]).toEqual([null, null]);
    expect(db.catalog.functions().some((f) => f.name === 'split')).toBe(true);
  });
});

describe('range', () => {
  const rows = (sql: string) => db.query(sql).rows.map((r) => r[0]);

  it('counts from start to stop, both included, step apart', () => {
    expect(rows('SELECT value FROM range(1, 5)')).toEqual([1, 2, 3, 4, 5]);
    expect(rows('SELECT value FROM range(0, 10, 3)')).toEqual([0, 3, 6, 9]);
    expect(rows('SELECT value FROM range(5, 1, -2)')).toEqual([5, 3, 1]);
    expect(rows('SELECT value FROM range(3, 3)')).toEqual([3]);
  });

  it('is empty when the step points away from stop, or an argument is NULL', () => {
    expect(rows('SELECT value FROM range(5, 1)')).toEqual([]);
    expect(rows('SELECT value FROM range(1, 5, -1)')).toEqual([]);
    expect(rows('SELECT value FROM range(NULL, 5)')).toEqual([]);
  });

  it('refuses a step of 0, and an argument that is not a whole number', () => {
    expect(code(() => db.query('SELECT value FROM range(1, 5, 0)'))).toBe('SMALT_RANGE');
    expect(() => db.query('SELECT value FROM range(1, 2.5)')).toThrow(/the stop must be a whole number, not 2.5/);
    expect(() => db.query("SELECT value FROM range('a', 2)")).toThrow(/the start must be a whole number/);
  });

  it('reads its arguments from a lateral row', () => {
    expect(db.query('SELECT n, value FROM (SELECT 2 AS n UNION ALL SELECT 3) JOIN range(1, n) ORDER BY n, value').rows).toEqual([
      [2, 1],
      [2, 2],
      [3, 1],
      [3, 2],
      [3, 3],
    ]);
  });

  it('makes rows as they are read: a long range with a limit costs nothing', () => {
    const t = performance.now();
    expect(rows('SELECT value FROM range(1, 9000000000000000000) LIMIT 3')).toEqual([1, 2, 3]);
    expect(performance.now() - t).toBeLessThan(1000);
    expect(one('SELECT count(*) FROM range(1, 100000)')).toBe(100000);
  });

  it('gives values past 2^53 exactly', () => {
    expect(rows('SELECT value FROM range(9007199254740992, 9007199254740994)')).toEqual([9007199254740992, 9007199254740993n, 9007199254740994n]);
  });

  it('is a source in plans too', () => {
    const plan = p.source('function', 'range', [p.lit(1), p.lit(3)], ['int']);
    expect(db.queryPlan({ kind: 'query', plan } as unknown as PlanStatementInput).rows).toEqual([[1], [2], [3]]);
  });
});
