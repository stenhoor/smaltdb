/**
 * The planner's cost of a covering index: a plan's scan names the columns it reads, and when the index's key holds
 * them all, each entry costs an index step, not a table fetch. An equality on a column with few distinct values
 * (an edge table's `end`, where most edges end at a few nodes) then seeks the index instead of scanning the table: a
 * value that isn't there costs one descent, not a scan.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';

const col = (index: number) => ({ k: 'col', input: 0, index, depth: 0, type: 'int', collation: 'binary' });
const eq = (index: number, value: number) => ({ k: 'call', fn: 'cmp_eq', args: [col(index), { k: 'lit', value, type: 'int' }], type: 'bool' });

function edges(): Database {
  const db = Database.openMemory();
  db.exec('CREATE TABLE e(start INTEGER, "end" INTEGER, props TEXT); CREATE INDEX e_end ON e("end", start)');
  // 4,000 edges ending at 4 nodes: about 1,000 per value of `end`.
  db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 4000) INSERT INTO e SELECT i, i % 4, 'x' FROM n");
  db.exec('ANALYZE');
  return db;
}

const query = (columns: number[], pred: object) =>
  ({ kind: 'query', plan: { op: 'filter', input: { op: 'scan', table: 'e', columns }, pred }, columns: columns.map((_c, i) => ({ name: `c${i}`, type: 'int' })) }) as unknown as PlanStatementInput;
const explain = (db: Database, q: PlanStatementInput): string =>
  db.queryPlan({ kind: 'explain', mode: 'plan', query: q } as unknown as PlanStatementInput).rows.map((r) => r.join(' ')).join('\n');

describe('a covering index', () => {
  it('is sought for an equality that matches many rows when the scan reads only its key columns and the rowid', () => {
    const db = edges();
    const q = query([-1, 0, 1], eq(2, 99));
    expect(explain(db, q)).toContain('SEARCH e USING COVERING INDEX e_end (=?)');
    expect(db.queryPlan(q).rows).toEqual([]);
    expect(db.queryPlan(query([-1, 0, 1], eq(2, 1))).rows.length).toBe(1000);
  });

  it('is not costed as covering when the scan reads a column outside it: the table is scanned', () => {
    const db = edges();
    expect(explain(db, query([-1, 0, 1, 2], eq(2, 99)))).toContain('SCAN e');
  });
});
