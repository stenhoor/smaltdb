/**
 * Morsel parallelism on plans (M7.4, ADR 0010; on plans per ADR 0015 step 5): an aggregate over one large table runs
 * as partial aggregates over rowid ranges on parallel readers ("partials"), merged on the owner.
 *
 *   ... ← aggregate(keys, aggs) ← [filter p] ← scan t
 *
 * becomes, on each reader, for rowids in [lo, hi) (the last two parameters, so every morsel is the same plan):
 *
 *   aggregate(keys, partial aggs) ← filter (p AND rowid >= ?lo AND rowid < ?hi) ← scan t
 *
 * and, on the owner, over the partial rows (the `smalt_partials()` source: keys, then partial aggregates):
 *
 *   ... ← project(the original aggregate's outputs) ← aggregate(keys, merging aggs) ← source smalt_partials
 *
 * The operations above the aggregate (HAVING, the result, ORDER BY, LIMIT, DISTINCT) read the aggregate's outputs by
 * position, so they run unchanged over the merge. Only aggregates that merge exactly qualify: count, sum, total, min
 * and max, and avg (as total and count), without DISTINCT, min / max comparing in BINARY; keys compared in BINARY (the
 * partials of a group meet by value); no bare columns, joins, subqueries or window functions.
 */
import type { AggCall, PlanOp } from '../plan/ops.js';
import { eachParts, type PlanExpr, typeOf } from '../plan/expr.js';
import type { PlanType } from '../plan/types.js';

type Aggregate = Extract<PlanOp, { op: 'aggregate' }>;
type Scan = Extract<PlanOp, { op: 'scan' }>;

/** A query that can run as partial aggregates over rowid ranges. */
export interface PlanMorsels {
  /** The scanned table. */
  table: string;
  /** The partial plan (a projection of the partial aggregate): rowids in [lo, hi) are the parameters `paramCount` and `paramCount + 1`. */
  partial: PlanOp;
  /** The merge plan over `smalt_partials()` (the query's own parameters only). */
  merge: PlanOp;
  /** The partial row's column types: keys, then partial aggregates. */
  types: PlanType[];
  keyCount: number;
}

/** The operations allowed above the aggregate: they read its outputs only. */
const ABOVE = new Set(['project', 'filter', 'sort', 'limit', 'distinct']);

/** No subquery and no column but the operation's own input (depth 0, input 0). */
function plain(e: PlanExpr | undefined): boolean {
  if (e === undefined) return true;
  switch (e.k) {
    case 'col':
      return e.depth === 0 && e.input === 0;
    case 'subquery':
    case 'inSubquery':
      return false;
    case 'call':
    case 'and':
    case 'or':
      return e.args.every(plain);
    case 'cast':
    case 'not':
    case 'isNull':
      return plain(e.arg);
    case 'case':
      return e.whens.every((w) => plain(w.when) && plain(w.then)) && plain(e.else);
    case 'each':
      return false; // no morsel plan for expressions over list elements yet
    default:
      return true;
  }
}

/** The expressions an operation above the aggregate evaluates. */
function exprsOf(op: PlanOp): (PlanExpr | undefined)[] {
  switch (op.op) {
    case 'project':
      return [...op.exprs];
    case 'filter':
      return [op.pred];
    case 'sort':
      return op.keys.map((k) => k.expr);
    case 'limit':
      return [op.count, op.offset];
    default:
      return [];
  }
}

const col = (index: number, type: PlanType): PlanExpr => ({ k: 'col', input: 0, index, depth: 0, type, collation: 'binary' });
const agg = (fn: string, args: PlanExpr[], type: PlanType, from?: AggCall): AggCall => ({
  fn,
  args,
  star: false,
  distinct: false,
  ...(from?.filter ? { filter: from.filter } : {}),
  collation: 'binary',
  type,
});

/**
 * `plan` as partial aggregates and their merge, or null when it does not qualify. `paramCount`: the query's
 * parameters (the range bounds follow them). `eligible`: whether readers can scan the table (they open the file).
 */
export function planMorsels(plan: PlanOp, paramCount: number, eligible: (table: string, db?: 'main' | 'temp') => boolean): PlanMorsels | null {
  // The operations above the aggregate, outermost first.
  const above: PlanOp[] = [];
  let n: PlanOp = plan;
  while (ABOVE.has(n.op)) {
    if (!exprsOf(n).every(plain)) return null;
    above.push(n);
    n = (n as { input: PlanOp }).input;
  }
  if (n.op !== 'aggregate' || n.carry.length > 0) return null;
  const a: Aggregate = n;
  let where: PlanExpr | undefined;
  let s: PlanOp = a.input;
  if (s.op === 'filter') {
    where = s.pred;
    s = s.input;
  }
  if (s.op !== 'scan' || s.indexedBy !== undefined || s.db === 'temp' || !eligible(s.table, s.db)) return null;
  const scan: Scan = s;
  if (!plain(where) || a.keys.some((k) => k.collation !== 'binary' || !plain(k.expr) || hasParam(k.expr))) return null;
  if (a.aggs.length === 0 && a.keys.length === 0) return null;

  // Partial aggregates: one per distinct input (avg is total and count).
  const partials: AggCall[] = [];
  const index = new Map<string, number>();
  const partial = (c: AggCall): number => {
    const k = JSON.stringify(c, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v));
    let i = index.get(k);
    if (i === undefined) {
      index.set(k, (i = partials.length));
      partials.push(c);
    }
    return a.keys.length + i;
  };
  const nk = a.keys.length;
  // For each original aggregate: how to merge it (its partial columns).
  const plans: { fn: string; cols: number[] }[] = [];
  for (const c of a.aggs) {
    if (c.distinct || !c.args.every(plain) || !plain(c.filter)) return null;
    switch (c.fn) {
      case 'count':
        if (c.args.length > 1) return null;
        plans.push({ fn: 'count', cols: [partial(c)] });
        break;
      case 'min':
      case 'max':
      case 'sum':
      case 'total':
        if (c.args.length !== 1 || ((c.fn === 'min' || c.fn === 'max') && c.collation !== 'binary')) return null;
        plans.push({ fn: c.fn, cols: [partial(c)] });
        break;
      case 'avg':
        if (c.args.length !== 1) return null;
        plans.push({ fn: 'avg', cols: [partial(agg('total', [...c.args], 'real', c)), partial(agg('count', [...c.args], 'int', c))] });
        break;
      default:
        return null;
    }
  }
  const types: PlanType[] = [...a.keys.map((k) => typeOf(k.expr)), ...partials.map((p) => p.type)];

  // The partial plan: rowids in [lo, hi) from the parameters after the query's own.
  const rowidAt = scan.columns.indexOf(-1);
  const columns = rowidAt >= 0 ? scan.columns : [...scan.columns, -1];
  const rowid: PlanExpr = col(rowidAt >= 0 ? rowidAt : scan.columns.length, 'int');
  const bound = (fn: string, p: number): PlanExpr => ({ k: 'call', fn, args: [rowid, { k: 'param', index: p, type: 'int' }], type: 'int', collation: 'binary' });
  const range: PlanExpr[] = [bound('cmp_ge', paramCount), bound('cmp_lt', paramCount + 1)];
  const pred = [where, ...range].filter((x): x is PlanExpr => x !== undefined).reduce((x, y) => ({ k: 'and', args: [x, y] }));
  const partialAgg = copy(a, { input: { op: 'filter', input: copy(scan, { columns }), pred }, aggs: partials, carry: [] });
  // A query's root is a projection (the planner plans results from one).
  const partialPlan: PlanOp = { op: 'project', input: partialAgg, exprs: types.map((t, i) => col(i, t)) };

  // The merge: aggregate the partial rows, then give the original aggregate's outputs.
  const merges: AggCall[] = [];
  const merged = (fn: string, at: number, type: PlanType): PlanExpr => {
    merges.push(agg(fn, [col(at, types[at])], type));
    return col(nk + merges.length - 1, type);
  };
  const outputs: PlanExpr[] = a.keys.map((_k, i) => col(i, types[i]));
  a.aggs.forEach((c, i) => {
    const p = plans[i];
    switch (p.fn) {
      case 'count':
        // Over no partial rows (an empty range), sum() is NULL: a count is 0.
        outputs.push({ k: 'call', fn: 'coalesce', args: [merged('sum', p.cols[0], 'int'), { k: 'lit', value: 0, type: 'int' }], type: 'int' });
        break;
      case 'avg':
        outputs.push({ k: 'call', fn: 'div_trunc', args: [merged('total', p.cols[0], 'real'), merged('sum', p.cols[1], 'int')], type: 'real' });
        break;
      default:
        outputs.push(merged(p.fn, p.cols[0], c.type));
    }
  });
  const source: PlanOp = { op: 'source', kind: 'function', name: 'smalt_partials', args: [], types };
  let merge: PlanOp = {
    op: 'project',
    input: { op: 'aggregate', input: source, keys: a.keys.map((k, i) => ({ expr: col(i, typeOf(k.expr)), collation: 'binary' })), aggs: merges, carry: [] },
    exprs: outputs,
  };
  for (let i = above.length - 1; i >= 0; i--) merge = copy(above[i], { input: merge });
  return { table: scan.table, partial: partialPlan, merge, types, keyCount: nk };
}

/**
 * `op` with `changes`: its own fields only. Spreading would copy what the planner caches on an operation under a
 * symbol (its shape), which describes the original's inputs.
 */
function copy<T extends PlanOp>(op: T, changes: Partial<Record<string, unknown>>): PlanOp {
  return { ...Object.fromEntries(Object.entries(op)), ...changes } as unknown as PlanOp;
}

function hasParam(e: PlanExpr): boolean {
  switch (e.k) {
    case 'param':
      return true;
    case 'call':
    case 'and':
    case 'or':
      return e.args.some(hasParam);
    case 'cast':
    case 'not':
    case 'isNull':
      return hasParam(e.arg);
    case 'case':
      return e.whens.some((w) => hasParam(w.when) || hasParam(w.then)) || hasParam(e.else);
    case 'each':
      return eachParts(e).some(hasParam);
    default:
      return false;
  }
}
