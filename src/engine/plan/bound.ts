/**
 * Bound statements (ADR 0015 section 3): what a language hands the engine for each statement it binds, and what the
 * engine dispatches on. Plans and expressions are the plan layer's (plan/ops.ts, plan/expr.ts); names are resolved.
 *
 * | Kind | Contents |
 * | --- | --- |
 * | `query` | a plan, its result columns and parameter count |
 * | `write` | an `append` / `update` / `delete` plan, its RETURNING columns |
 * | `explain` | a bound query and the EXPLAIN mode |
 * | `transaction` | begin (deferred / immediate / exclusive), commit, rollback, savepoint, release |
 * | `setting` | read or set a setting (SQL's PRAGMA) |
 * | `maintenance` | analyze, vacuum, refresh a materialized view |
 * | `schema` | a schema operation |
 *
 * `schema` carries a schema operation (plan/schema.ts); ALTER TABLE still carries its SQL.
 */
import type { ResultColumnInfo } from '../exec/planner.js';
import type { ParsedStatement } from '../sql/ast.js';
import type { PlanExpr } from './expr.js';
import type { PlanOp } from './ops.js';
import type { PlanType } from './types.js';
import type { SchemaOp } from './schema.js';

/** A result column: name, type, declared type, collation and affinity. */
export type BoundColumn = ResultColumnInfo;

export interface BoundQuery {
  readonly kind: 'query';
  readonly plan: PlanOp;
  readonly columns: BoundColumn[];
}

export interface BoundWrite {
  readonly kind: 'write';
  /** An `append`, `update` or `delete` plan. */
  readonly plan: PlanOp;
  readonly returning?: { name: string; type: PlanType }[];
  /** An `append`'s input columns (INSERT … SELECT). */
  readonly source?: BoundColumn[];
}

export type BoundTransaction =
  | { readonly kind: 'transaction'; readonly action: 'begin'; readonly mode: 'deferred' | 'immediate' | 'exclusive' }
  | { readonly kind: 'transaction'; readonly action: 'commit' }
  | { readonly kind: 'transaction'; readonly action: 'rollback'; readonly savepoint?: string }
  | { readonly kind: 'transaction'; readonly action: 'savepoint' | 'release'; readonly name: string };

export type BoundStatement =
  | BoundQuery
  | BoundWrite
  | { readonly kind: 'explain'; readonly mode: 'plan' | 'analyze'; readonly query: BoundQuery }
  | BoundTransaction
  /** A setting by name: read it, or set it to `value` (an expression over constants and parameters). */
  | { readonly kind: 'setting'; readonly name: string; readonly schema?: string; readonly value?: PlanExpr }
  | { readonly kind: 'maintenance'; readonly action: 'analyze'; readonly target?: string; readonly schema?: string }
  | { readonly kind: 'maintenance'; readonly action: 'vacuum' }
  | {
      readonly kind: 'maintenance';
      readonly action: 'refresh';
      readonly view: string;
      readonly schema?: string;
      readonly concurrently: boolean;
      readonly withData: boolean;
      readonly ifChanged: boolean;
    }
  /** A schema operation; ALTER TABLE still as SQL until it becomes one. */
  | { readonly kind: 'schema'; readonly op: SchemaOp }
  | { readonly kind: 'schema'; readonly sql: ParsedStatement };
