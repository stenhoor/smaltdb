/**
 * ORDER BY with a LIMIT over a join, read in order (planner.ts `orderedJoin`): the source the ORDER BY reads first,
 * through an access path whose rows come in that order (a table scan by rowid, an index seek by the column after its
 * equalities), every other source by an index lookup per row, and no sort; the join stops at the LIMIT. Used where
 * that costs less than the join and a sort of all its rows.
 *
 * A plan from outside SQL often sorts a projection of its join (`project(sort(project(join)))`): the normalizer
 * composes the two projections (plan-normalize.ts `composed`), so the join is the block's FROM and the planner sees
 * the table the ORDER BY reads.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';

const col = (index: number, type = 'int') => ({ k: 'col', input: 0, index, depth: 0, type, collation: 'binary' });
const eq = (a: object, b: object) => ({ k: 'call', fn: 'cmp_eq', args: [a, b], type: 'bool' });
const lit = (value: unknown, type: string) => ({ k: 'lit', value, type });

function graph(): Database {
  const db = Database.openMemory();
  db.exec('CREATE TABLE node(id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE lab(id INTEGER, label TEXT); CREATE INDEX lab_label ON lab(label, id)');
  // 3,000 nodes, every third labelled B, the rest A.
  db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) INSERT INTO node SELECT i, 'n' || i FROM n");
  db.exec("INSERT INTO lab SELECT id, CASE WHEN id % 3 = 0 THEN 'B' ELSE 'A' END FROM node");
  db.exec('ANALYZE');
  return db;
}

/** The first `count` nodes labelled `label` by id, as a plan builder writes it: the join projected, sorted, projected. */
function firstLabelled(label: string, count: number, nullsFirst = false): PlanStatementInput {
  const join = { op: 'join', kind: 'cross', inputs: [{ op: 'scan', table: 'node', columns: [0, 1] }, { op: 'scan', table: 'lab', columns: [0, 1] }] };
  const filtered = { op: 'filter', input: join, pred: { k: 'and', args: [eq(col(2), col(0)), eq(col(3, 'text'), lit(label, 'text'))] } };
  const projected = { op: 'project', input: filtered, exprs: [col(0), col(1, 'text'), col(0)] };
  const sorted = { op: 'sort', input: projected, keys: [{ expr: col(2), desc: false, nullsFirst, collation: 'binary' }] };
  const plan = { op: 'limit', count: lit(count, 'int'), input: { op: 'project', input: sorted, exprs: [col(0), col(1, 'text')] } };
  return { kind: 'query', plan, columns: [{ name: 'id', type: 'int' }, { name: 'name', type: 'text' }] } as unknown as PlanStatementInput;
}

const explain = (db: Database, q: PlanStatementInput): string =>
  db.queryPlan({ kind: 'explain', mode: 'plan', query: q } as unknown as PlanStatementInput).rows.map((r) => r.join(' ')).join('\n');

describe('ORDER BY with a LIMIT over a join', () => {
  it('reads the ordering table in order, looks up the other per row, and sorts nothing', () => {
    const db = graph();
    const q = firstLabelled('B', 10);
    const plan = explain(db, q);
    expect(plan).not.toContain('ORDER BY');
    expect(plan).toContain('SCAN node');
    expect(plan).toContain('SEARCH lab USING COVERING INDEX lab_label');
    expect(db.queryPlan(q).rows).toEqual(db.query("SELECT node.id, name FROM node JOIN lab ON lab.id = node.id WHERE label = 'B' ORDER BY node.id LIMIT 10").rows);
  });

  it('gives the same rows as a sort, at any LIMIT, for NULLS FIRST and LAST on the rowid', () => {
    const db = graph();
    for (const [label, count] of [['A', 1], ['A', 500], ['B', 999], ['B', 1000], ['B', 5000], ['C', 10]] as const) {
      const sql = `SELECT node.id, name FROM node JOIN lab ON lab.id = node.id WHERE label = '${label}' ORDER BY node.id LIMIT ${count}`;
      expect(db.queryPlan(firstLabelled(label, count)).rows, `${label} ${count}`).toEqual(db.query(sql).rows);
      expect(db.queryPlan(firstLabelled(label, count, true)).rows, `${label} ${count} nulls first`).toEqual(db.query(sql).rows);
    }
  });

  it('sorts as before when the LIMIT reads most of the join', () => {
    const db = graph();
    expect(explain(db, firstLabelled('A', 100000))).toContain('ORDER BY');
  });
});
