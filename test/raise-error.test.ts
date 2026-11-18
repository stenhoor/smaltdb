/** raise_error (a language's own errors in a plan, as smaltcy's Cypher type errors): raised only where a row reaches it. */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';

const INT = 'int' as never;
const x = p.col(0, 0, INT);
const big = (code?: string) =>
  p.caseWhen([{ when: p.call('cmp_gt', [x, p.lit(2)], 'bool' as never), then: p.call('raise_error', [p.lit('too big'), ...(code ? [p.lit(code)] : [])], INT) }], INT, x);
const rows = (...xs: number[]) => p.fromColumns([xs] as never, [INT]);

describe('raise_error', () => {
  it('raises with its message and code when a row reaches it', () => {
    const db = Database.openMemory();
    expect(() => db.queryPlan(p.project(rows(1, 2, 3), [big('SMALTCY_TYPE')]))).toThrow(expect.objectContaining({ code: 'SMALTCY_TYPE', message: expect.stringContaining('too big') }));
    expect(() => db.queryPlan(p.project(rows(3), [big()]))).toThrow(expect.objectContaining({ code: 'SMALT_ERROR' }));
  });

  it("doesn't raise in a branch not taken, with literal arguments too", () => {
    const db = Database.openMemory();
    expect(db.queryPlan(p.project(rows(1, 2), [big('SMALTCY_TYPE')])).rows).toEqual([[1], [2]]);
    expect(db.queryPlan(p.filter(rows(1, 2), p.call('cmp_lt', [big(), p.lit(5)], 'bool' as never))).rows).toEqual([[1], [2]]);
  });

  it('refuses a code that is not one', () => {
    const db = Database.openMemory();
    expect(() => db.queryPlan(p.project(rows(3), [big('not a code')]))).toThrow(expect.objectContaining({ code: 'SMALT_MISUSE' }));
  });
});
