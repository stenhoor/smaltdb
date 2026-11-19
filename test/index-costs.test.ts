/**
 * How the planner costs an index.
 *
 * A covering index: a plan's scan names the columns it reads, and when the index's key holds
 * them all, each entry costs an index step, not a table fetch. An equality on a column with few distinct values
 * (an edge table's `end`, where most edges end at a few nodes) then seeks the index instead of scanning the table: a
 * value that isn't there costs one descent, not a scan.
 *
 * An equality on literals: the planner counts the index's entries for them (up to a cap) when that is fewer than the
 * statistics' average, so a rare value of a column with few values (a label nearly no node has) isn't costed as a
 * common one.
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
    expect(explain(db, query([-1, 0, 1, 2], eq(2, 1)))).toContain('SCAN e');
  });
});

describe('an equality on a literal', () => {
  function labels(): Database {
    const db = Database.openMemory();
    db.exec('CREATE TABLE node(id INTEGER PRIMARY KEY, props TEXT); CREATE TABLE lab(id INTEGER, label TEXT); CREATE INDEX lab_label ON lab(label, id)');
    // 3,000 nodes labelled A, 3,000 labelled B, 5 labelled C.
    db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6005) INSERT INTO node SELECT i, 'x' FROM n");
    db.exec("INSERT INTO lab SELECT id, CASE WHEN id <= 3000 THEN 'A' WHEN id <= 6000 THEN 'B' ELSE 'C' END FROM node");
    db.exec('ANALYZE');
    return db;
  }
  const plan = (db: Database, sql: string) => db.query(`EXPLAIN QUERY PLAN ${sql}`).rows.map((r) => r[3]).join(' | ');

  it('is estimated from the entries the index holds for it, when fewer than the average', () => {
    const db = labels();
    const join = (label: string) => `SELECT node.id FROM node JOIN lab ON lab.id = node.id WHERE lab.label = '${label}'`;
    // The average (about 2,000 per label) would hash-join both tables; C's 5 entries are sought, then 5 nodes.
    expect(plan(db, join('C'))).toBe('SEARCH lab USING COVERING INDEX lab_label (=?) | SEARCH node USING INTEGER PRIMARY KEY (rowid=?)');
    expect(plan(db, join('none'))).toBe('SEARCH lab USING COVERING INDEX lab_label (=?) | SEARCH node USING INTEGER PRIMARY KEY (rowid=?)');
    expect(db.query(join('C')).rows.length).toBe(5);
    expect(db.query(join('none')).rows).toEqual([]);
  });
});
