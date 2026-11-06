/**
 * Materialized-view matching on plans (M7.5, ADR 0010; on plans per ADR 0015 section 4): answer part of a plan from a
 * fresh materialized view instead of its base table, when the view provably holds what that part needs. Opt-in with
 * `PRAGMA matview_rewrite = 1`.
 *
 * Two shapes, both over a single base table, matched at any subtree of a plan (a statement, a subquery, an inlined
 * view, an INSERT source, a decorrelated subquery's inner side):
 *
 * - **Aggregate roll-up.** The view is `project ← aggregate(keys…, aggregates…) ← [filter p] ← scan t`. A subtree
 *   `project ← [filter (HAVING)] ← aggregate ← [filter] ← scan t` whose filter is `p` plus conjuncts on view keys,
 *   grouped by view keys (BINARY), with aggregates the view's columns merge into, is answered by merging the view's
 *   rows: `count` → `coalesce(sum, 0)`, `sum` / `total` / `min` / `max` → themselves, `avg` → `total(sum) / sum(count)`.
 * - **Selection / projection.** The view is `project(plain columns) ← [filter p] ← scan t`. A subtree
 *   `project ← [filter] ← scan t` whose filter is `p` plus anything, reading only view columns, reads the view instead.
 *
 * Columns are compared by table column (plans reference them by position), expressions structurally. A rewritten
 * expression keeps the SQL metadata (collation source, affinity) of the expression it replaces, so comparisons and
 * conversions are those of the query over the base table.
 */
import type { AggCall, PlanOp } from '../plan/ops.js';
import { type ColExpr, type PlanExpr, typeOf } from '../plan/expr.js';
import type { CollationName, PlanType } from '../plan/types.js';
import { getMeta, setMeta } from './sql-meta.js';

/** A fresh, populated materialized view: its table, its definition as a plan, and its columns. */
export interface PlanMatview {
  name: string;
  plan: PlanOp;
  types: readonly PlanType[];
  collations: readonly CollationName[];
}

type Scan = Extract<PlanOp, { op: 'scan' }>;
type Aggregate = Extract<PlanOp, { op: 'aggregate' }>;

interface Shape {
  project: readonly PlanExpr[];
  having?: PlanExpr;
  agg?: Aggregate;
  where?: PlanExpr;
  scan: Scan;
}

/** The roll-up or projection shape of `op`, or null. */
function shapeOf(op: PlanOp): Shape | null {
  if (op.op !== 'project') return null;
  let n = op.input;
  let having: PlanExpr | undefined;
  if (n.op === 'filter' && n.input.op === 'aggregate') {
    having = n.pred;
    n = n.input;
  }
  let agg: Aggregate | undefined;
  if (n.op === 'aggregate') {
    if (n.carry.length > 0) return null;
    agg = n;
    n = n.input;
  }
  let where: PlanExpr | undefined;
  if (n.op === 'filter') {
    where = n.pred;
    n = n.input;
  }
  if (n.op !== 'scan' || n.indexedBy !== undefined || n.db === 'temp') return null;
  const s: Shape = { project: op.exprs, having, agg, where, scan: n };
  // Only the scan's own columns: no subqueries, no columns of an enclosing query.
  const exprs = [...s.project, s.having, s.where, ...(agg ? [...agg.keys.map((k) => k.expr), ...agg.aggs.flatMap((a) => [...a.args, a.filter])] : [])];
  return exprs.every((e) => e === undefined || plain(e)) ? s : null;
}

/** No subquery and no column but the operation's own input. */
function plain(e: PlanExpr): boolean {
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
    default:
      return true;
  }
}

/** A structural key for `e` over a scan's columns: columns by table column index. */
function key(e: PlanExpr | undefined, scan: Scan): string {
  return JSON.stringify(e ?? null, (_k, v) => {
    if (typeof v === 'bigint') return `${v}n`;
    if (v instanceof Uint8Array) return [...v];
    if (v && typeof v === 'object' && v.k === 'col') return { c: scan.columns[(v as ColExpr).index] };
    return v;
  });
}

function aggKey(a: AggCall, scan: Scan, fn = a.fn): string {
  return JSON.stringify([fn, a.args.map((x) => key(x, scan)), a.star, a.distinct, key(a.filter, scan), a.collation]);
}

function conjuncts(e: PlanExpr | undefined, out: PlanExpr[] = []): PlanExpr[] {
  if (!e) return out;
  if (e.k === 'and' && !getMeta(e)?.opaque) for (const x of e.args) conjuncts(x, out);
  else out.push(e);
  return out;
}

function andAll(es: PlanExpr[]): PlanExpr | undefined {
  return es.length === 0 ? undefined : es.reduce((a, b) => ({ k: 'and', args: [a, b] }));
}

/** `e` with `f` applied to every node bottom-up (null from `f` fails the whole rewrite); SQL metadata kept. */
function mapExpr(e: PlanExpr, f: (e: PlanExpr) => PlanExpr | null | undefined): PlanExpr | null {
  const hit = f(e);
  if (hit !== undefined) return hit;
  let failed = false;
  const m = (x: PlanExpr): PlanExpr => {
    const r = failed ? x : mapExpr(x, f);
    if (r === null) failed = true;
    return r ?? x;
  };
  let out: PlanExpr;
  switch (e.k) {
    case 'call':
    case 'and':
    case 'or':
      out = { ...e, args: e.args.map(m) };
      break;
    case 'cast':
    case 'not':
    case 'isNull':
      out = { ...e, arg: m(e.arg) } as PlanExpr;
      break;
    case 'case':
      out = { ...e, whens: e.whens.map((w) => ({ when: m(w.when), then: m(w.then) })), else: m(e.else) };
      break;
    default:
      out = e;
  }
  return failed ? null : out;
}

/** A column of the view's scan, standing for `orig` (whose SQL metadata it keeps). */
function viewCol(v: PlanMatview, i: number, orig: PlanExpr | null): PlanExpr {
  const c: PlanExpr = { k: 'col', input: 0, index: i, depth: 0, type: v.types[i], collation: v.collations[i] };
  const meta = orig && getMeta(orig);
  if (meta) setMeta(c, meta);
  return c;
}

const viewScan = (v: PlanMatview): Scan => ({ op: 'scan', table: v.name, columns: v.types.map((_t, i) => i) });

/** Rebuild `project ← [filter H] ← aggregate|… ← [filter W] ← scan` from its parts. */
function build(project: readonly PlanExpr[], having: PlanExpr | undefined, agg: Omit<Aggregate, 'input'> | undefined, where: PlanExpr | undefined, scan: Scan): PlanOp {
  let n: PlanOp = scan;
  if (where) n = { op: 'filter', input: n, pred: where };
  if (agg) n = { ...agg, input: n } as Aggregate;
  if (having) n = { op: 'filter', input: n, pred: having };
  return { op: 'project', input: n, exprs: project };
}

/** The query's filter conjuncts beyond the view's, or null when the view's filter is not part of the query's. */
function extraConjuncts(q: Shape, v: Shape): PlanExpr[] | null {
  const qc = conjuncts(q.where);
  const vKeys = new Set(conjuncts(v.where).map((c) => key(c, v.scan)));
  const qKeys = new Set(qc.map((c) => key(c, q.scan)));
  for (const k of vKeys) if (!qKeys.has(k)) return null;
  return qc.filter((c) => !vKeys.has(key(c, q.scan)));
}

function rollUp(q: Shape, v: Shape, view: PlanMatview): PlanOp | null {
  const qa = q.agg!;
  const va = v.agg!;
  if (v.having) return null;
  const nk = va.keys.length;
  // View columns: which aggregate output each holds.
  const keyCol = new Map<string, number>();
  const aggCol = new Map<string, number>();
  for (let i = 0; i < v.project.length; i++) {
    const e = v.project[i];
    if (e.k !== 'col' || e.depth !== 0) return null;
    if (e.index < nk) keyCol.set(key(va.keys[e.index].expr, v.scan), i);
    else {
      const a = va.aggs[e.index - nk];
      aggCol.set(aggKey(a, v.scan), i);
      // total(x) merges from a sum(x) column too.
      if (a.fn === 'sum') aggCol.set(aggKey(a, v.scan, 'total'), i);
    }
  }
  const extra = extraConjuncts(q, v);
  if (!extra) return null;
  // An ungrouped view answers only ungrouped queries over exactly its filter.
  if (nk === 0 && (qa.keys.length > 0 || extra.length > 0)) return null;
  // Keys meet by value: BINARY only.
  if (qa.keys.some((k) => k.collation !== 'binary') || va.keys.some((k) => k.collation !== 'binary')) return null;
  const onKeys = (e: PlanExpr): PlanExpr | null =>
    mapExpr(e, (x) => {
      const i = keyCol.get(key(x, q.scan));
      if (i !== undefined) return viewCol(view, i, x);
      return x.k === 'col' ? null : undefined;
    });
  const keys: { expr: PlanExpr; collation: CollationName }[] = [];
  for (const k of qa.keys) {
    const i = keyCol.get(key(k.expr, q.scan));
    if (i === undefined) return null;
    keys.push({ expr: viewCol(view, i, k.expr), collation: 'binary' });
  }
  const where: PlanExpr[] = [];
  for (const c of extra) {
    const r = onKeys(c);
    if (r === null) return null;
    where.push(r);
  }
  // Merge aggregates over the view's columns, and what each of the query's aggregate outputs becomes.
  const merge: AggCall[] = [];
  const out = (fn: string, i: number, type: PlanType): PlanExpr => {
    merge.push({ fn, args: [viewCol(view, i, null)], star: false, distinct: false, collation: 'binary', type });
    return { k: 'col', input: 0, index: keys.length + merge.length - 1, depth: 0, type, collation: 'binary' };
  };
  const outputs: PlanExpr[] = keys.map((k, i) => ({ k: 'col', input: 0, index: i, depth: 0, type: typeOf(k.expr), collation: 'binary' }));
  for (const a of qa.aggs) {
    if (a.distinct) return null;
    const col = (fn = a.fn): number | undefined => aggCol.get(aggKey(a, q.scan, fn));
    switch (a.fn) {
      case 'count': {
        const i = col();
        if (i === undefined) return null;
        // Merged over no view rows, sum() is NULL: a count is 0.
        outputs.push({ k: 'call', fn: 'coalesce', args: [out('sum', i, 'int'), { k: 'lit', value: 0, type: 'int' }], type: 'int' });
        break;
      }
      case 'sum':
      case 'min':
      case 'max': {
        if (a.fn !== 'sum' && a.collation !== 'binary') return null;
        const i = col();
        if (i === undefined) return null;
        outputs.push(out(a.fn, i, a.type));
        break;
      }
      case 'total': {
        const i = col();
        if (i === undefined) return null;
        outputs.push(out('total', i, 'real'));
        break;
      }
      case 'avg': {
        const s = col('total');
        const n = col('count');
        if (s === undefined || n === undefined) return null;
        outputs.push({ k: 'call', fn: 'div_trunc', args: [out('total', s, 'real'), out('sum', n, 'int')], type: 'real' });
        break;
      }
      default:
        return null;
    }
  }
  // HAVING and the result read the aggregate's outputs: substitute what each became.
  const sub = (e: PlanExpr): PlanExpr | null =>
    mapExpr(e, (x) => {
      if (x.k !== 'col') return undefined;
      const r = outputs[x.index];
      if (!r) return null;
      const meta = getMeta(x);
      const c = { ...r };
      if (meta) setMeta(c, meta);
      return c;
    });
  const project: PlanExpr[] = [];
  for (const e of q.project) {
    const r = sub(e);
    if (r === null) return null;
    project.push(r);
  }
  const having = q.having ? sub(q.having) : undefined;
  if (having === null) return null;
  return build(project, having, { op: 'aggregate', keys, aggs: merge, carry: [] }, andAll(where), viewScan(view));
}

function projection(q: Shape, v: Shape, view: PlanMatview): PlanOp | null {
  if (v.having) return null;
  // View columns: plain columns of the table, by table column index.
  const byColumn = new Map<number, number>();
  for (let i = 0; i < v.project.length; i++) {
    const e = v.project[i];
    if (e.k !== 'col' || e.depth !== 0) return null;
    byColumn.set(v.scan.columns[e.index], i);
  }
  const extra = extraConjuncts(q, v);
  if (!extra) return null;
  const onView = (e: PlanExpr): PlanExpr | null =>
    mapExpr(e, (x) => {
      if (x.k !== 'col') return undefined;
      const i = byColumn.get(q.scan.columns[x.index]);
      return i === undefined ? null : viewCol(view, i, x);
    });
  const project: PlanExpr[] = [];
  for (const e of q.project) {
    const r = onView(e);
    if (r === null) return null;
    project.push(r);
  }
  const where: PlanExpr[] = [];
  for (const c of extra) {
    const r = onView(c);
    if (r === null) return null;
    where.push(r);
  }
  return build(project, undefined, undefined, andAll(where), viewScan(view));
}

/** `op` answered from the first of `views` that can, or null. */
function matchOne(op: PlanOp, views: readonly PlanMatview[]): PlanOp | null {
  const q = shapeOf(op);
  if (!q) return null;
  for (const view of views) {
    const v = shapeOf(view.plan);
    if (!v || v.scan.table.toLowerCase() !== q.scan.table.toLowerCase()) continue;
    const r = q.agg ? (v.agg ? rollUp(q, v, view) : null) : v.agg ? null : projection(q, v, view);
    if (r) return r;
  }
  return null;
}

/**
 * `plan` with every subtree that one of `views` answers read from that view: statements, subqueries, inlined views,
 * set operation and join inputs, recursive CTE parts. Unchanged parts are kept as they are.
 */
export function matchMatviews(plan: PlanOp, views: readonly PlanMatview[]): PlanOp {
  if (views.length === 0) return plan;
  const visit = (x: unknown): unknown => {
    if (Array.isArray(x)) {
      let changed = false;
      const out = x.map((y) => {
        const r = visit(y);
        if (r !== y) changed = true;
        return r;
      });
      return changed ? out : x;
    }
    if (!x || typeof x !== 'object' || x instanceof Uint8Array) return x;
    const o = x as Record<string, unknown>;
    if (typeof o.op === 'string') {
      const hit = matchOne(o as unknown as PlanOp, views);
      if (hit) return hit;
    }
    let out: Record<string, unknown> | null = null;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (!v || typeof v !== 'object') continue;
      const r = visit(v);
      if (r !== v) (out ??= { ...o })[k] = r;
    }
    return out ?? o;
  };
  return visit(plan) as PlanOp;
}
