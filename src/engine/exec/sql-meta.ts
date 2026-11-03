/**
 * SQL metadata of bound plan expressions (ADR 0014): what SQL knows about an expression besides its type, kept beside
 * the plan rather than in it, as a symbol-keyed property that serializing a plan leaves out.
 */
import type { PlanExpr } from '../plan/expr.js';
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

export const getMeta = (e: PlanExpr): SqlMeta | undefined => (e as WithMeta)[SQL_META];

export const setMeta = (e: PlanExpr, m: SqlMeta): void => {
  (e as WithMeta)[SQL_META] = m;
};

/** True when code generation should hand `e` to the closure compiler whole. */
export const isOpaque = (e: PlanExpr): boolean => (e as WithMeta)[SQL_META]?.opaque === true;
