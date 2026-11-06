/**
 * As-of joins (ADR 0016 section 5): each left row, in left order, with the right row whose key is nearest its own in a
 * direction, within a tolerance, among the rows an equality condition matches; NULLs where none does.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanOp } from '../src/engine/plan/ops.js';

function db(): Database {
  const d = Database.openMemory();
  d.exec(`CREATE TABLE trades(id INTEGER PRIMARY KEY, sym TEXT, t INT);
    INSERT INTO trades VALUES (1, 'a', 10), (2, 'b', 10), (3, 'a', 25), (4, 'a', 3), (5, 'b', 40);
    CREATE TABLE quotes(sym TEXT, t INT, px REAL);
    INSERT INTO quotes VALUES ('a', 5, 1.0), ('a', 20, 2.0), ('a', 30, 3.0), ('b', 9, 10.0), ('b', 11, 11.0)`);
  return d;
}
const trades = p.scan('trades', [0, 1, 2]);
const quotes = p.scan('quotes', [0, 1, 2]);
const sameSym = p.call('cmp_eq', [p.col(0, 1, 'text'), p.col(1, 0, 'text')], 'int');
const lt = p.col(0, 2, 'int');
const rt = p.col(1, 1, 'int');
/** Each trade's id with the matched quote's time and price. */
const run = (d: Database, options: Parameters<typeof p.asofJoin>[4]) => d.queryPlan(p.project(p.asofJoin(trades, quotes, lt, rt, options), [p.col(0, 0, 'int'), p.col(0, 4, 'int'), p.col(0, 5, 'real')])).rows;

describe('asof join', () => {
  it('backward, forward and nearest, by symbol, in left order', () => {
    const d = db();
    expect(run(d, { on: sameSym })).toEqual([[1, 5, 1], [2, 9, 10], [3, 20, 2], [4, null, null], [5, 11, 11]]);
    expect(run(d, { on: sameSym, direction: 'forward' })).toEqual([[1, 20, 2], [2, 11, 11], [3, 30, 3], [4, 5, 1], [5, null, null]]);
    // Nearest: ties go to the smaller key (trade 2 at 10 is 1 from 9 and 11; trade 3 at 25 is 5 from 20 and 30).
    expect(run(d, { on: sameSym, direction: 'nearest' })).toEqual([[1, 5, 1], [2, 9, 10], [3, 20, 2], [4, 5, 1], [5, 11, 11]]);
  });

  it('within a tolerance, without a by condition, and over a sorted left input', () => {
    const d = db();
    expect(run(d, { on: sameSym, tolerance: 5 })).toEqual([[1, 5, 1], [2, 9, 10], [3, 20, 2], [4, null, null], [5, null, null]]);
    expect(run(d, { on: sameSym, direction: 'nearest', tolerance: 2 })).toEqual([[1, null, null], [2, 9, 10], [3, null, null], [4, 5, 1], [5, null, null]]);
    // Any symbol: the latest quote at or before each trade.
    expect(run(d, {})).toEqual([[1, 9, 10], [2, 9, 10], [3, 20, 2], [4, null, null], [5, 30, 3]]);
    const byTime = p.sort(trades, [p.desc(lt)]);
    const r = d.queryPlan(p.project(p.asofJoin(byTime, quotes, lt, rt, { on: sameSym }), [p.col(0, 0, 'int'), p.col(0, 5, 'real')])).rows;
    expect(r).toEqual([[5, 11], [3, 2], [1, 1], [2, 10], [4, null]]);
  });

  it('the validator checks it', () => {
    const catalog = { tableColumns: (t: string) => (t === 'trades' || t === 'quotes' ? 3 : undefined) };
    const bad = (plan: PlanOp) => {
      try {
        p.validatePlan(plan, catalog);
      } catch (e) {
        return (e as Error).message;
      }
      return 'valid';
    };
    expect(bad({ ...p.join('inner', trades, quotes), kind: 'asof' } as PlanOp)).toMatch(/an asof join needs its match/);
    expect(bad({ ...p.asofJoin(trades, quotes, lt, rt), kind: 'inner' } as PlanOp)).toMatch(/only an asof join has a match/);
    expect(bad(p.asofJoin(trades, quotes, lt, rt, { direction: 'sideways' as never }))).toMatch(/unknown direction/);
    expect(bad(p.asofJoin(trades, quotes, lt, rt, { tolerance: p.col(0, 0, 'int') }))).not.toBe('valid');
  });
});
