/**
 * Plans from outside a language (ADR 0015 step 8: `Database.preparePlan`) in the layering the physical planner reads.
 * The planner plans a query block as SQL builds one: LIMIT, ORDER BY, DISTINCT, the projection, windows, HAVING, the
 * aggregate, WHERE, then a left-deep tree of FROM items (exec/planner.ts `flatShape`), with VALUES and compounds
 * under ORDER BY and LIMIT. A builder may write any valid plan: a sort straight over an aggregate, a filter or a scan
 * as the whole plan. Each block is filled in with identity projections where a layer is missing, and any other
 * operation becomes a nested FROM item, as SQL's FROM subqueries are. The result has the same rows and columns.
 *
 * SQL's plans have this layering already and are not normalized.
 */
import { type PlanExpr, typeOf } from '../plan/expr.js';
import type { PlanOp } from '../plan/ops.js';
import { planWidth } from './planner.js';

type Op<K extends PlanOp['op']> = Extract<PlanOp, { op: K }>;

/** `op` as a query block the planner reads. */
export function normalizePlan(op: PlanOp): PlanOp {
  return block(op);
}

/** A write's plan with its input normalized (an `append`'s rows; `update` and `delete` read their targets as given). */
export function normalizeWrite(op: PlanOp): PlanOp {
  return op.op === 'append' && op.input ? { ...op, input: block(op.input) } : op;
}

/** LIMIT? ORDER BY? then a compound, VALUES, or DISTINCT? over a projected core. */
function block(op: PlanOp): PlanOp {
  if (op.op === 'limit') return { ...op, count: expr(op.count), ...(op.offset ? { offset: expr(op.offset) } : {}), input: sorted(op.input) };
  return sorted(op);
}

function sorted(op: PlanOp): PlanOp {
  if (op.op === 'project' && op.input.op === 'sort') return projectedSort(op, op.input);
  if (op.op === 'sort') {
    const inner = op.input;
    // A sort over a compound or VALUES stays; over anything else it needs a projection under it (or a DISTINCT over one).
    const below = inner.op === 'setop' || inner.op === 'values' ? body(inner) : distinctProjected(inner);
    return { ...op, keys: op.keys.map((k) => ({ ...k, expr: expr(k.expr) })), input: below };
  }
  return body(op);
}

function body(op: PlanOp): PlanOp {
  if (op.op === 'setop') return { ...op, inputs: [block(op.inputs[0]), block(op.inputs[1])] };
  if (op.op === 'values') return { ...op, rows: op.rows.map((r) => r.map(expr)) };
  return distinctProjected(op);
}

function distinctProjected(op: PlanOp): PlanOp {
  if (op.op === 'distinct') return { ...op, input: projected(op.input) };
  return projected(op);
}

function projected(op: PlanOp): PlanOp {
  if (op.op === 'project') return { ...op, exprs: op.exprs.map(expr), input: core(op.input) };
  return { op: 'project', exprs: identity(op), input: core(op) };
}

/**
 * A projection of sorted rows keeps their order. As SQL plans ORDER BY on expressions that are not results: project
 * the results and the sorted input's columns, sort on those columns, then keep the results.
 */
function projectedSort(op: Op<'project'>, s: Op<'sort'>): PlanOp {
  const m = op.exprs.length;
  // Sort keys with subqueries would need their correlated columns moved too: plan those as a nested block.
  if (s.keys.some((k) => hasSubquery(k.expr))) return body(op);
  const all: PlanExpr[] = [...op.exprs, ...identity(s.input)];
  const keys = s.keys.map((k) => ({ ...k, expr: expr(shift(k.expr, m)) }));
  const results = op.exprs.map((e, i): PlanExpr => ({ k: 'col', input: 0, index: i, depth: 0, type: typeOf(e), collation: 'binary' }));
  return { op: 'project', exprs: results, input: { ...s, keys, input: distinctProjected({ op: 'project', exprs: all, input: s.input }) } };
}

/** `e` reading column `i + by` where it read column `i` of its own input. */
function shift(e: PlanExpr, by: number): PlanExpr {
  switch (e.k) {
    case 'col':
      return e.depth === 0 && e.input === 0 ? { ...e, index: e.index + by } : e;
    case 'call':
    case 'and':
    case 'or':
      return { ...e, args: e.args.map((a) => shift(a, by)) };
    case 'cast':
    case 'not':
    case 'isNull':
      return { ...e, arg: shift(e.arg, by) };
    case 'case':
      return { ...e, whens: e.whens.map((w) => ({ when: shift(w.when, by), then: shift(w.then, by) })), else: shift(e.else, by) };
    default:
      return e;
  }
}

function hasSubquery(e: PlanExpr): boolean {
  switch (e.k) {
    case 'subquery':
    case 'inSubquery':
      return true;
    case 'call':
    case 'and':
    case 'or':
      return e.args.some(hasSubquery);
    case 'cast':
    case 'not':
    case 'isNull':
      return hasSubquery(e.arg);
    case 'case':
      return e.whens.some((w) => hasSubquery(w.when) || hasSubquery(w.then)) || hasSubquery(e.else);
    default:
      return false;
  }
}

/** Windows, HAVING over an aggregate, the aggregate, WHERE, then the FROM items. */
function core(op: PlanOp): PlanOp {
  if (op.op === 'window') {
    return {
      ...op,
      partition: op.partition.map((p) => ({ ...p, expr: expr(p.expr) })),
      order: op.order.map((k) => ({ ...k, expr: expr(k.expr) })),
      calls: op.calls.map((c) => ({ ...c, args: c.args.map(expr), ...(c.filter ? { filter: expr(c.filter) } : {}) })),
      input: core(op.input),
    };
  }
  if (op.op === 'filter' && op.input.op === 'aggregate') return { ...op, pred: expr(op.pred), input: aggregated(op.input) };
  if (op.op === 'aggregate') return aggregated(op);
  return where(op);
}

function aggregated(op: Op<'aggregate'>): PlanOp {
  return {
    ...op,
    keys: op.keys.map((k) => ({ ...k, expr: expr(k.expr) })),
    aggs: op.aggs.map((a) => ({ ...a, args: a.args.map(expr), ...(a.filter ? { filter: expr(a.filter) } : {}) })),
    carry: op.carry.map(expr),
    input: where(op.input),
  };
}

function where(op: PlanOp): PlanOp {
  if (op.op === 'filter') return { ...op, pred: expr(op.pred), input: from(op.input) };
  return from(op);
}

/** A left-deep join tree of FROM items; any other operation is a nested block. */
function from(op: PlanOp): PlanOp {
  switch (op.op) {
    case 'join': {
      const [l, r] = op.inputs;
      // Joins nest to the left: a join on the right is a nested block.
      return { ...op, inputs: [from(l), r.op === 'join' ? block(r) : from(r)], ...(op.on ? { on: expr(op.on) } : {}) };
    }
    case 'scan':
    case 'working':
      return op;
    case 'source':
      return { ...op, args: op.args.map(expr), ...(op.named ? { named: Object.fromEntries(Object.entries(op.named).map(([k, v]) => [k, expr(v)])) } : {}) };
    case 'iterate':
      return { ...op, init: block(op.init), steps: op.steps.map(block), ...(op.limit ? { limit: expr(op.limit) } : {}), ...(op.offset ? { offset: expr(op.offset) } : {}) };
    case 'values':
      // A single empty row is SQL's FROM-less SELECT; other VALUES are blocks of their own.
      return op.rows.length === 1 && op.rows[0].length === 0 ? op : block(op);
    default:
      return block(op);
  }
}

/** The columns of `op`, passed through. */
function identity(op: PlanOp): PlanExpr[] {
  return Array.from({ length: planWidth(op) }, (_, i): PlanExpr => ({ k: 'col', input: 0, index: i, depth: 0, type: 'any', collation: 'binary' }));
}

/** Nested plans inside an expression (subqueries), normalized. */
function expr(e: PlanExpr): PlanExpr {
  switch (e.k) {
    case 'subquery':
      return { ...e, plan: block(e.plan) };
    case 'inSubquery':
      return { ...e, probe: expr(e.probe), plan: block(e.plan) };
    case 'call':
      return { ...e, args: e.args.map(expr) };
    case 'and':
    case 'or':
      return { ...e, args: e.args.map(expr) };
    case 'cast':
    case 'not':
    case 'isNull':
      return { ...e, arg: expr(e.arg) };
    case 'case':
      return { ...e, whens: e.whens.map((w) => ({ when: expr(w.when), then: expr(w.then) })), else: expr(e.else) };
    default:
      return e;
  }
}

