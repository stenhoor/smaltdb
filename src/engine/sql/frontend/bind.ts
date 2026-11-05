/**
 * SQL's `bind` (ADR 0015 section 3): a parsed SQL statement as a bound statement (plan/bound.ts), the one entry point
 * the engine compiles from. Queries and writes become plans (select.ts), PRAGMA values plan expressions; transaction,
 * setting and maintenance statements name what they do in the engine's terms.
 */
import { SmaltError } from '../../language-support.js';
import type { BindContext } from '../../language-support.js';
import type { BoundQuery, BoundStatement } from '../../language-support.js';
import type { ParsedStatement, SelectStmt } from '../ast.js';
import { toPlan, toValueExpr, toWritePlan } from './select.js';
import { checkNewTable, toAlterAction, toIndexDef, toTableDef, withBoundChecks } from './ddl.js';
import type { KeyDef, Source, TableDef } from '../../language-support.js';

const sql = (ps: ParsedStatement): Source => ({ language: 'sql', text: ps.text });

/** Whether `k` (a PRIMARY KEY) makes its column the rowid: a single ASC column declared exactly INTEGER. */
const rowidKey = (def: TableDef, k: KeyDef): boolean => k.columns.length === 1 && !k.columns[0].desc && def.columns[k.columns[0].column].declaredType === 'INTEGER';

/**
 * `ps` bound against `catalog`. `received` sees every plan the binder makes before it goes into the bound statement
 * (the engine validates there).
 */
export function bindStatement(ps: ParsedStatement, catalog: BindContext, received: <T extends { plan: import('../../language-support.js').PlanOp }>(fe: T) => T = (fe) => fe): BoundStatement {
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
    case 'createTable': {
      // SQL's rules for DEFAULT and CHECK first, then the CHECKs bound (a bad one fails here, as in SQLite).
      let def = toTableDef(stmt, ps.text, catalog);
      checkNewTable(stmt);
      def = withBoundChecks(def, stmt, ps.text, catalog);
      if (def.keys.some((k) => k.autoincrement) && !def.keys.some((k) => k.kind === 'primaryKey' && rowidKey(def, k))) throw new SmaltError('SMALT_ERROR', 'AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY');
      return { kind: 'schema', op: { op: 'createTable', table: def, ...(stmt.schema !== undefined ? { schema: stmt.schema } : {}), temp: stmt.temp, ifNotExists: stmt.ifNotExists, source: sql(ps) } };
    }
    case 'createIndex': {
      const table = catalog.indexTarget(stmt.table, stmt.schema);
      return { kind: 'schema', op: { op: 'createIndex', index: toIndexDef(stmt, ps.text, table, catalog), ...(stmt.schema !== undefined ? { schema: stmt.schema } : {}), ifNotExists: stmt.ifNotExists, source: sql(ps) } };
    }
    case 'createView':
      return {
        kind: 'schema',
        op: {
          op: 'createView',
          name: stmt.name,
          ...(stmt.schema !== undefined ? { schema: stmt.schema } : {}),
          temp: stmt.temp,
          ifNotExists: stmt.ifNotExists,
          ...(stmt.columns ? { columns: stmt.columns } : {}),
          materialized: stmt.materialized,
          ...(stmt.with ? { options: stmt.with } : {}),
          ...(stmt.withData !== undefined ? { withData: stmt.withData } : {}),
          source: sql(ps),
        },
      };
    case 'createConnection':
      return { kind: 'schema', op: { op: 'createConnection', name: stmt.name, ifNotExists: stmt.ifNotExists, options: stmt.with, source: sql(ps) } };
    case 'createExternalTable':
      return {
        kind: 'schema',
        op: { op: 'createExternalTable', name: stmt.name, ifNotExists: stmt.ifNotExists, columns: stmt.columns.map((c) => ({ name: c.name, declaredType: c.type ?? '', constrained: c.constraints.length > 0 })), options: stmt.with, source: sql(ps) },
      };
    case 'drop':
      return { kind: 'schema', op: { op: 'drop', objectType: stmt.objectType, name: stmt.name, ...(stmt.schema !== undefined ? { schema: stmt.schema } : {}), ifExists: stmt.ifExists } };
    case 'alterTable':
      return { kind: 'schema', op: { op: 'alterTable', table: stmt.table, ...(stmt.schema !== undefined ? { schema: stmt.schema } : {}), action: toAlterAction(stmt, ps.text, catalog), source: sql(ps) } };
  }
}
