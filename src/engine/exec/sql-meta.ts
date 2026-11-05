/**
 * SQL metadata of bound plan expressions (ADR 0014): what SQL knows about an expression besides its type, kept beside
 * the plan rather than in it, as a symbol-keyed property that serializing a plan leaves out.
 */
import type { BoundExpr } from '../plan/expr.js';
import type { PlanOp } from '../plan/ops.js';
import type { Collation } from '../values.js';
import type { Affinity } from './convert.js';

export interface SqlMeta {
  collation: Collation;
  /** Where the collation came from: `CollSrc` in exec/expr.ts. */
  collSrc: number;
  affinity: Affinity;
  /**
   * The node stands for an SQL form that code generation leaves to the closure compiler (BETWEEN, NOT LIKE,
   * NOT IN, COLLATE, unary +), as it did before plan expressions; set by the binder.
   */
  opaque?: true;
}

const SQL_META: unique symbol = Symbol('sql');
type WithMeta = { [SQL_META]?: SqlMeta };

export const getMeta = (e: BoundExpr): SqlMeta | undefined => (e as WithMeta)[SQL_META];

export const setMeta = (e: BoundExpr, m: SqlMeta): void => {
  (e as WithMeta)[SQL_META] = m;
};

/** True when code generation should hand `e` to the closure compiler whole. */
export const isOpaque = (e: BoundExpr): boolean => (e as WithMeta)[SQL_META]?.opaque === true;

const FLATTENED: unique symbol = Symbol('flattened');

/**
 * Marks a SELECT's plan whose views or FROM subqueries the SQL front end merged into it (exec/flatten.ts).
 * Decorrelation reads a subquery's SQL before flattening, so it does not apply to such a plan (as in the planner).
 */
export const markFlattened = (op: PlanOp): void => {
  (op as { [FLATTENED]?: true })[FLATTENED] = true;
};

export const isFlattened = (op: PlanOp): boolean => (op as { [FLATTENED]?: true })[FLATTENED] === true;

