/**
 * SQL's `bind` (ADR 0015 section 3): a parsed SQL statement as a bound statement (plan/bound.ts), the one entry point
 * the engine compiles from. Queries and writes become plans (select.ts), PRAGMA values plan expressions; transaction,
 * setting and maintenance statements name what they do in the engine's terms.
 */
import { SmaltError } from '../../errors.js';
import type { BindContext } from '../../plan/bind-context.js';
import type { BoundQuery, BoundStatement } from '../../plan/bound.js';
import type { ParsedStatement, SelectStmt } from '../ast.js';
import { toPlan, toValueExpr, toWritePlan } from './select.js';

/**
 * `ps` bound against `catalog`. `received` sees every plan the binder makes before it goes into the bound statement
 * (the engine validates there).
 */
export function bindStatement(ps: ParsedStatement, catalog: BindContext, received: <T extends { plan: import('../../plan/ops.js').PlanOp }>(fe: T) => T = (fe) => fe): BoundStatement {
  const stmt = ps.stmt;
  const query = (s: SelectStmt): BoundQuery => {
    const fe = received(toPlan(s, ps.text, catalog));
    return { kind: 'query', plan: fe.plan, columns: fe.columns };
  };
  switch (stmt.kind) {
    case 'select':
      return query(stmt);
    case 'insert':
    case 'update':
    case 'delete': {
      const fe = received(toWritePlan(stmt, ps.text, catalog));
      return { kind: 'write', plan: fe.plan, returning: fe.returning, source: fe.source };
    }
    case 'explain':
      if (stmt.stmt.kind !== 'select') throw new SmaltError('SMALT_UNSUPPORTED', 'EXPLAIN is only supported for SELECT statements');
      return { kind: 'explain', mode: stmt.analyze ? 'analyze' : 'plan', query: query(stmt.stmt) };
    case 'begin':
      return { kind: 'transaction', action: 'begin', mode: (stmt.mode?.toLowerCase() ?? 'deferred') as 'deferred' | 'immediate' | 'exclusive' };
    case 'commit':
      return { kind: 'transaction', action: 'commit' };
    case 'rollback':
      return stmt.savepoint === undefined ? { kind: 'transaction', action: 'rollback' } : { kind: 'transaction', action: 'rollback', savepoint: stmt.savepoint };
    case 'savepoint':
    case 'release':
      return { kind: 'transaction', action: stmt.kind, name: stmt.name };
    case 'pragma':
      return { kind: 'setting', name: stmt.name, ...(stmt.schema !== undefined ? { schema: stmt.schema } : {}), ...(stmt.value ? { value: toValueExpr(stmt.value, ps.text, catalog) } : {}) };
    case 'analyze':
      return { kind: 'maintenance', action: 'analyze', target: stmt.target, schema: stmt.schema };
    case 'vacuum':
      return { kind: 'maintenance', action: 'vacuum' };
    case 'refresh':
      return { kind: 'maintenance', action: 'refresh', view: stmt.name, schema: stmt.schema, concurrently: stmt.concurrently, withData: stmt.withData, ifChanged: stmt.ifChanged === true };
    default:
      return { kind: 'schema', sql: ps };
  }
}
