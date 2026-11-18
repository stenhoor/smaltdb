/**
 * An update whose target rows come from a join marked `ordered`: the order the rows are visited in changes nothing
 * the update gives, so the join is planned as a join (plan-normalize `unorderedJoins`). Before, the planner
 * declined the write (`SMALT_INTERNAL`). Found by smaltcy's runner of Cypher writes on smaltdb.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';

const col = (i: number, input = 0) => ({ k: 'col', input, index: i, depth: 0, type: 'int', collation: 'binary' });
const join = (kind: 'inner', ordered: boolean) => ({
  op: 'join',
  kind,
  inputs: [
    { op: 'scan', table: 't', columns: [-1, 0] },
    { op: 'scan', table: 'u', columns: [0] },
  ],
  ...(kind === 'inner' ? { on: { k: 'call', fn: 'cmp_eq', args: [col(1, 0), col(0, 1)], type: 'bool' } } : {}),
  ...(ordered ? { ordered: true } : {}),
});
const setup = () => {
  const db = Database.openMemory();
  db.exec('CREATE TABLE t(a INTEGER); CREATE TABLE u(a INTEGER); INSERT INTO t VALUES (1), (2), (3); INSERT INTO u VALUES (2), (3)');
  return db;
};

describe('updates over ordered joins', () => {
  for (const ordered of [false, true]) {
    it(`update from an inner join${ordered ? ', ordered' : ''}`, () => {
      const db = setup();
      const plan = { op: 'update', table: 't', db: 'main', from: true, rowid: 0, input: join('inner', ordered), sets: [{ column: 0, value: { k: 'call', fn: 'mul', args: [col(2), { k: 'lit', value: 10, type: 'int' }], type: 'int' } }] };
      db.queryPlan({ kind: 'write', plan } as unknown as PlanStatementInput);
      expect(db.query('SELECT a FROM t ORDER BY a').rows).toEqual([[1], [20], [30]]);
    });
  }
});
