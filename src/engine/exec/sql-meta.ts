/**
 * SQL metadata of bound plan expressions: what SQL knows about an expression besides its type. It is kept in the plan
 * itself, as the expression's meaning fields (plan/expr.ts `ExprMeaning`, ADR 0016 section 2); `getMeta` / `setMeta`
 * read and write those fields in the engine's terms.
 */
import type { BoundExpr, ExprMeaning } from '../plan/expr.js';
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

const COLLATION_OF: Readonly<Record<string, number>> = { binary: 0, nocase: 1, rtrim: 2 };
const COLLATION_NAME = ['binary', 'nocase', 'rtrim'] as const;
const AFFINITY_OF: Readonly<Record<string, number>> = { NONE: 0, INTEGER: 1, REAL: 2, NUMERIC: 3, TEXT: 4, BLOB: 5 };
const AFFINITY_NAME = ['NONE', 'INTEGER', 'REAL', 'NUMERIC', 'TEXT', 'BLOB'] as const;

/**
 * Every metadata value, interned and frozen: there are few (collation, its source, affinity, opaque), and `getMeta` is
 * read often while planning plans built just now, so it allocates nothing.
 */
const METAS: SqlMeta[] = [];
for (let i = 0; i < 3 * 3 * 6 * 2; i++) {
  const opaque = i % 2 === 1;
  const affinity = AFFINITY_NAME[Math.floor(i / 2) % 6];
  const collSrc = Math.floor(i / 12) % 3;
  const collation = Math.floor(i / 36) as Collation;
  METAS.push(Object.freeze({ collation, collSrc, affinity, ...(opaque ? { opaque: true as const } : {}) }));
}
const metaIndex = (collation: number, collSrc: number, affinity: number, opaque: boolean): number => ((collation * 3 + collSrc) * 6 + affinity) * 2 + (opaque ? 1 : 0);

/** The `carries` values, interned and frozen: `[collation][from]`, `from` 0 a column, 1 explicit. */
const CARRIES = COLLATION_NAME.map((collation) => [Object.freeze({ collation, from: 'column' as const }), Object.freeze({ collation, from: 'explicit' as const })]);

/** The metadata of `e`, read from its meaning fields (plan/expr.ts `ExprMeaning`). Undefined when it has none. */
export const getMeta = (e: BoundExpr): SqlMeta | undefined => {
  const x = e as ExprMeaning;
  const carries = x.carries;
  if (carries === undefined && x.affinity === undefined && x.inline !== false) return undefined;
  return METAS[
    metaIndex(
      carries ? COLLATION_OF[carries.collation] : 0,
      carries ? (carries.from === 'explicit' ? 2 : 1) : 0,
      x.affinity === undefined ? 0 : AFFINITY_OF[x.affinity],
      x.inline === false,
    )
  ];
};

/** Writes `m` as `e`'s meaning fields: the engine's own rewrites and version-0 decoding (languages write the fields). */
export const setMeta = (e: BoundExpr, m: SqlMeta): void => {
  const x = e as { -readonly [K in keyof ExprMeaning]: ExprMeaning[K] };
  // `delete` only what is there: deleting puts an object in V8's slow dictionary mode.
  if (m.collSrc !== 0) x.carries = CARRIES[m.collation][m.collSrc === 2 ? 1 : 0];
  else if (x.carries !== undefined) delete x.carries;
  if (m.affinity !== 'NONE') x.affinity = m.affinity as ExprMeaning['affinity'];
  else if (x.affinity !== undefined) delete x.affinity;
  if (m.opaque) x.inline = false;
  else if (x.inline !== undefined) delete x.inline;
};

/** True when code generation should hand `e` to the closure compiler whole. */
export const isOpaque = (e: BoundExpr): boolean => (e as ExprMeaning).inline === false;

/**
 * Marks a SELECT's plan whose views or FROM subqueries the SQL front end merged into it (exec/flatten.ts):
 * `decorrelate: false`. Decorrelation reads a subquery's SQL before flattening, so it does not apply to such a plan.
 */
export const markFlattened = (op: PlanOp): void => {
  (op as { decorrelate?: false }).decorrelate = false;
};

export const isFlattened = (op: PlanOp): boolean => op.decorrelate === false;
