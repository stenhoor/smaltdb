/**
 * Statements given as plan data (ADR 0014 section 4, ADR 0015 step 8): what `Database.preparePlan` / `queryPlan` take.
 * A bound statement (plan/bound.ts) in public terms: a query's result columns are described in plan types and
 * collation names, and everything but a query's plan may be left out where it has a usual value. A bare plan operation
 * is a query whose columns are named `column1`, `column2`, … with types not known until run time.
 *
 * The engine validates every plan it is given (plan/validate.ts) before planning it.
 */
import type { Affinity } from '../exec/convert.js';
import type { ResultColumnInfo } from '../exec/planner.js';
import { SmaltError } from '../errors.js';
import { Collation } from '../values.js';
import type { BoundQuery, BoundStatement, BoundWrite } from './bound.js';
import type { PlanOp } from './ops.js';
import type { CollationName, PlanType } from './types.js';

/** A result column of a query (or an INSERT's input): its name, and what the engine knows of its values. */
export interface PlanColumn {
  readonly name: string;
  /** Default `any`. */
  readonly type?: PlanType;
  /** The declared type of the table column it reads directly, if any. */
  readonly declaredType?: string;
  /** Default `binary`. */
  readonly collation?: CollationName;
  /** SQLite's column affinity, which comparisons with the column apply. Default `NONE`. */
  readonly affinity?: Affinity;
}

/** A query: its plan and result columns (by default `column1`, `column2`, … of type `any`). */
export interface PlanQuery {
  readonly kind: 'query';
  readonly plan: PlanOp;
  readonly columns?: readonly PlanColumn[];
}

/** A write: an `append`, `update` or `delete` plan. */
export interface PlanWrite {
  readonly kind: 'write';
  readonly plan: PlanOp;
  /** RETURNING columns: names and types of the plan's `returning` expressions. */
  readonly returning?: readonly { readonly name: string; readonly type: PlanType }[];
  /** An `append`'s input columns (its `input` plan's output). */
  readonly source?: readonly PlanColumn[];
}

/** A statement as plan data: a query, a write, EXPLAIN of a query, or any other bound statement as it is. */
export type PlanStatementInput =
  | PlanOp
  | PlanQuery
  | PlanWrite
  | { readonly kind: 'explain'; readonly mode: 'plan' | 'analyze'; readonly query: PlanQuery }
  | Exclude<BoundStatement, BoundQuery | BoundWrite | { readonly kind: 'explain' }>;

const COLLATIONS: Readonly<Record<CollationName, Collation>> = { binary: Collation.Binary, nocase: Collation.NoCase, rtrim: Collation.RTrim };

/** A result column in the engine's terms. */
function resultColumn(c: PlanColumn | undefined, i: number): ResultColumnInfo {
  const collation = COLLATIONS[c?.collation ?? 'binary'];
  if (collation === undefined) throw new SmaltError('SMALT_PLAN', `column ${i + 1}: unknown collation ${String(c?.collation)}`);
  return { name: c?.name ?? `column${i + 1}`, type: c?.type ?? 'any', ...(c?.declaredType !== undefined ? { declType: c.declaredType } : {}), collation, affinity: c?.affinity ?? 'NONE' };
}

/**
 * `input` as the engine's bound statement. `width(plan)` validates a plan and gives its output width (the number of
 * columns it produces); a query's columns must match it.
 */
export function toBoundStatement(stmt: PlanStatementInput, width: (plan: PlanOp) => number): BoundStatement {
  let input = stmt;
  if (!input || typeof input !== 'object') throw new SmaltError('SMALT_PLAN', 'a plan statement must be an object');
  if (typeof (input as { op?: unknown }).op === 'string') return toBoundStatement({ kind: 'query', plan: input as PlanOp }, width);
  input = input as Exclude<PlanStatementInput, PlanOp>;
  switch (input.kind) {
    case 'query':
      return query(input, width);
    case 'explain':
      return { kind: 'explain', mode: input.mode, query: query(input.query, width) };
    case 'write': {
      width(input.plan);
      return { kind: 'write', plan: input.plan, ...(input.returning ? { returning: input.returning.map((r) => ({ name: r.name, type: r.type })) } : {}), ...(input.source ? { source: input.source.map(resultColumn) } : {}) };
    }
    default:
      return input;
  }
}

function query(q: PlanQuery, width: (plan: PlanOp) => number): BoundQuery {
  if (!q || q.kind !== 'query') throw new SmaltError('SMALT_PLAN', 'EXPLAIN takes a query');
  const n = width(q.plan);
  if (q.columns && q.columns.length !== n) throw new SmaltError('SMALT_PLAN', `the plan produces ${n} column(s), but ${q.columns.length} are described`);
  return { kind: 'query', plan: q.plan, columns: Array.from({ length: n }, (_, i) => resultColumn(q.columns?.[i], i)) };
}

/** The number of positional parameters a statement reads: one more than the highest `param` index in it. */
export function paramCount(stmt: unknown): number {
  let n = 0;
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) {
      for (const v of x) walk(v);
      return;
    }
    if (!x || typeof x !== 'object' || x instanceof Uint8Array) return;
    const o = x as Record<string, unknown>;
    if (o.k === 'param' && typeof o.index === 'number') n = Math.max(n, o.index + 1);
    for (const k in o) walk(o[k]);
  };
  walk(stmt);
  if (n > MAX_PARAMS) throw new SmaltError('SMALT_PLAN', `a statement may read at most ${MAX_PARAMS} parameters (parameter index ${n - 1})`);
  return n;
}

/** SQLite's limit on parameters (SQLITE_MAX_VARIABLE_NUMBER). */
export const MAX_PARAMS = 32766;
