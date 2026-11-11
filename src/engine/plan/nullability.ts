/**
 * Which output columns of a plan can never be NULL (ADR 0027, decision 1: a view's interface records it). The
 * analysis is conservative, as the owner chose (2026-11-11): a column is NOT NULL only when that is proven, and any
 * column it can't follow can be NULL. Proven NOT NULL:
 *
 * - a table's NOT NULL column, its INTEGER PRIMARY KEY and its rowid;
 * - a literal that isn't NULL, and constant rows whose every value in a column isn't;
 * - `count`, which gives 0 for no rows;
 * - a NOT NULL column carried through a filter, projection, sort, limit, sample or distinct, an inner or cross join
 *   (and the side of an outer, semi, anti or as-of join that keeps every row), a grouping key, or a union of two
 *   NOT NULL columns.
 */
import type { PlanExpr } from './expr.js';
import type { PlanOp } from './ops.js';

/** A table's columns, by position: whether each can never be NULL (undefined: the table isn't known). */
export type NotNullColumns = (table: string, db?: 'main' | 'temp') => readonly boolean[] | undefined;

/** For each output column of `op`, whether it can never be NULL; a column past the end of the result can be NULL. */
export function notNullColumns(op: PlanOp, table: NotNullColumns): boolean[] {
  switch (op.op) {
    case 'scan': {
      const cols = table(op.table, op.db);
      return op.columns.map((c) => c === -1 || cols?.[c] === true);
    }
    case 'values': {
      if (op.columns) return op.columns.map((col) => Array.from(col as ArrayLike<unknown>).every((v) => v !== null && v !== undefined));
      return op.types.map((_, i) => op.rows.length > 0 && op.rows.every((r) => litNotNull(r[i])));
    }
    case 'filter':
    case 'sort':
    case 'limit':
    case 'sample':
    case 'distinct':
      return notNullColumns(op.input, table);
    case 'project': {
      const input = notNullColumns(op.input, table);
      return op.exprs.map((e) => exprNotNull(e, input));
    }
    case 'join': {
      const [l, r] = op.inputs.map((x) => notNullColumns(x, table)) as [boolean[], boolean[]];
      if (op.kind === 'semi' || op.kind === 'anti') return l;
      // Where the left input's width isn't known, the right input's columns can't be placed: none is proven.
      const left = columnsOf(op.inputs[0], l);
      const right = columnsOf(op.inputs[1], r);
      if (left === undefined || right === undefined) return [];
      switch (op.kind) {
        case 'inner':
        case 'cross':
          return [...left, ...right];
        case 'left':
        case 'asof':
          return [...left, ...right.map(() => false)];
        case 'right':
          return [...left.map(() => false), ...right];
        default:
          return [...left.map(() => false), ...right.map(() => false)];
      }
    }
    case 'setop': {
      const [l, r] = op.inputs.map((x) => notNullColumns(x, table)) as [boolean[], boolean[]];
      // EXCEPT and INTERSECT give rows of the left input; a UNION's column is NOT NULL when it is on both sides.
      return op.kind === 'except' || op.kind === 'intersect' ? l : l.map((x, i) => x && r[i] === true);
    }
    case 'aggregate': {
      const input = notNullColumns(op.input, table);
      return [
        ...op.keys.map((k) => exprNotNull(k.expr, input)),
        ...op.aggs.map((a) => a.fn.toLowerCase() === 'count'),
        ...op.carry.map(() => false),
      ];
    }
    default:
      return [];
  }
}

/** `nn` as long as the number of columns `op` gives, or undefined when its shape doesn't say how many. */
function columnsOf(op: PlanOp, nn: boolean[]): boolean[] | undefined {
  const n = widthOf(op);
  if (n === undefined) return undefined;
  return Array.from({ length: n }, (_, i) => nn[i] === true);
}

/** How many columns `op` gives, where its shape says so. */
function widthOf(op: PlanOp): number | undefined {
  switch (op.op) {
    case 'scan':
      return op.columns.length;
    case 'values':
    case 'source':
    case 'working':
      return op.types.length;
    case 'project':
      return op.exprs.length;
    case 'filter':
    case 'sort':
    case 'limit':
    case 'sample':
    case 'distinct':
      return widthOf(op.input);
    case 'join': {
      const l = widthOf(op.inputs[0]);
      if (op.kind === 'semi' || op.kind === 'anti') return l;
      const r = widthOf(op.inputs[1]);
      return l === undefined || r === undefined ? undefined : l + r;
    }
    case 'setop':
      return widthOf(op.inputs[0]);
    case 'aggregate':
      return op.keys.length + op.aggs.length + op.carry.length;
    default:
      return undefined;
  }
}

const litNotNull = (e: PlanExpr | undefined): boolean => e !== undefined && e.k === 'lit' && e.value !== null && e.value !== undefined;

/** Whether `e`, over an input whose columns are NOT NULL where `input` says, can never be NULL. */
function exprNotNull(e: PlanExpr, input: readonly boolean[]): boolean {
  if (e.k === 'lit') return litNotNull(e);
  if (e.k === 'col') return e.input === 0 && e.depth === 0 && input[e.index] === true;
  return false;
}
