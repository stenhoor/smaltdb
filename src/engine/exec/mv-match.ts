/**
 * Materialized-view matching (M7.5, ADR 0010): answer a query from a fresh materialized view
 * instead of its base table, when the view provably holds what the query needs. Opt-in with
 * `PRAGMA matview_rewrite = 1`.
 *
 * Two shapes, both over a single base table:
 *
 * - **Aggregate roll-up.** The view is `SELECT keys…, aggregates… FROM t [WHERE p] GROUP BY keys`.
 *   A query over `t` whose WHERE is `p` plus conjuncts on view keys, grouped by a subset of the
 *   view's keys, with aggregates whose partial inputs (morsel.ts) are view columns, is answered by
 *   merging the view's rows: `count` → `sum`, `sum`/`total`/`min`/`max` → themselves, `avg` →
 *   `total(sum) / sum(count)`. (A view's rows are exactly partial aggregates of the query.)
 * - **Selection / projection.** The view is `SELECT cols FROM t [WHERE p]` (plain columns or `*`).
 *   A non-aggregate query over `t` whose WHERE is `p` plus anything, using only view columns, reads
 *   the view instead.
 *
 * Expressions are compared structurally, after dropping table qualifiers and lower-casing names.
 */
import type { ColumnExpr, Expr, FromItem, SelectStmt } from '../sql/ast.js';
import { type MorselTableInfo, analyzeMorsels, exprKey } from './morsel.js';
import { isAggregateCall } from './planner.js';

const NO_POS = { pos: 0, end: 0 };

/** A fresh, populated materialized view over one table. */
export interface MatviewCandidate {
  name: string;
  select: SelectStmt;
  /** The view's column names, in order. */
  columns: string[];
}

/** Copy of `x` with column qualifiers removed and column names lower-cased (single-table queries). */
function normalize<T>(x: T): T {
  return JSON.parse(
    JSON.stringify(x, (k, v) => {
      if (typeof v === 'bigint') return { __big: v.toString() };
      if (v instanceof Uint8Array) return { __bytes: [...v] };
      if (v && typeof v === 'object' && v.kind === 'column') {
        const { table: _t, schema: _s, ...rest } = v as ColumnExpr;
        return { ...rest, name: (v as ColumnExpr).name.toLowerCase() };
      }
      return v;
    }),
    (_k, v) => (v && typeof v === 'object' && '__big' in v ? BigInt(v.__big) : v && typeof v === 'object' && '__bytes' in v ? new Uint8Array(v.__bytes) : v),
  ) as T;
}

function conjuncts(e: Expr | undefined): Expr[] {
  if (!e) return [];
  if (e.kind === 'binary' && e.op === 'AND') return [...conjuncts(e.left), ...conjuncts(e.right)];
  return [e];
}

function andAll(list: Expr[]): Expr | undefined {
  return list.reduce<Expr | undefined>((acc, e) => (acc ? ({ kind: 'binary', op: 'AND', left: acc, right: e, ...NO_POS } as Expr) : e), undefined);
}

/** A single-table SELECT core without the clauses a view or query must not have here. */
function simpleCore(s: SelectStmt): (SelectStmt['core'] & { kind: 'select' }) | null {
  if (s.with || s.compound.length > 0) return null;
  const c = s.core;
  if (c.kind !== 'select' || c.distinct || c.windows.length > 0) return null;
  if (!c.from || c.from.kind !== 'table' || c.from.indexedBy !== undefined) return null;
  if (c.from.schema && c.from.schema.toLowerCase() !== 'main') return null;
  return c;
}

/** Whether an expression tree contains a node of one of `kinds` (or a call to an aggregate). */
function contains(x: unknown, pred: (o: Record<string, unknown>) => boolean): boolean {
  if (Array.isArray(x)) return x.some((y) => contains(y, pred));
  if (typeof x !== 'object' || x === null || x instanceof Uint8Array) return false;
  const o = x as Record<string, unknown>;
  return pred(o) || Object.values(o).some((v) => contains(v, pred));
}

const isAggregate = (o: Record<string, unknown>): boolean => o.kind === 'call' && isAggregateCall(o as unknown as Expr);
// A nested SELECT statement (it has a `core`; a SELECT core is also of kind 'select').
const hasSubquery = (o: Record<string, unknown>): boolean => o.kind === 'subquery' || o.kind === 'exists' || o.kind === 'inSelect' || (o.kind === 'select' && 'core' in o);

/** Replace sub-expressions found in `map` (by structural key) with column references; null if a table column remains. */
function remap(e: Expr, map: Map<string, string>): Expr | null {
  const hit = map.get(exprKey(e));
  if (hit !== undefined) return { kind: 'column', name: hit, ...NO_POS };
  if (e.kind === 'column') return null;
  let failed = false;
  const rec = (v: unknown): unknown => {
    if (failed) return v;
    if (Array.isArray(v)) return v.map(rec);
    if (v && typeof v === 'object' && !(v instanceof Uint8Array)) {
      const o = v as Record<string, unknown>;
      if (typeof o.kind === 'string' && 'pos' in o) {
        const r = remap(o as unknown as Expr, map);
        if (r === null) failed = true;
        return r;
      }
      const out: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(o)) out[k] = rec(x);
      return out;
    }
    return v;
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(e)) out[k] = k === 'pos' || k === 'end' ? v : rec(v);
  return failed ? null : (out as unknown as Expr);
}

/**
 * A rewrite of `query` (source text `text`) that reads one of `views` instead of its base table,
 * or null. `info` describes base tables (as for morsels).
 */
export function matchMatview(query: SelectStmt, text: string, views: MatviewCandidate[], info: (table: string) => MorselTableInfo | undefined): { stmt: SelectStmt; view: string } | null {
  const qc = simpleCore(query);
  if (!qc || contains([qc.columns, qc.where, qc.groupBy, qc.having, query.orderBy, query.limit, query.offset], hasSubquery)) return null;
  const table = (qc.from as { name: string }).name.toLowerCase();
  const nq = normalize(query);
  const nqc = nq.core as typeof qc;
  const qConj = conjuncts(nqc.where);
  const qAggregate = nqc.groupBy.length > 0 || contains(nqc.columns, isAggregate) || contains(nqc.having, isAggregate);
  for (const v of views) {
    const vc = simpleCore(v.select);
    if (!vc || (vc.from as { name: string }).name.toLowerCase() !== table || vc.having || v.select.orderBy.length || v.select.limit) continue;
    if (contains([vc.columns, vc.where, vc.groupBy], hasSubquery)) continue;
    const nv = normalize(v.select).core as typeof vc;
    // The view's filter must be part of the query's.
    const qKeys = new Set(qConj.map(exprKey));
    const vConj = conjuncts(nv.where);
    if (!vConj.every((c) => qKeys.has(exprKey(c)))) continue;
    const vKeys = new Set(vConj.map(exprKey));
    const extra = qConj.filter((c) => !vKeys.has(exprKey(c)));
    const vAggregate = nv.groupBy.length > 0 || contains(nv.columns, isAggregate);
    const r = qAggregate ? (vAggregate ? rollUp(query, text, nq, v, nv, extra, info) : null) : vAggregate ? null : project(nq, query, v, nv, extra);
    if (r) return { stmt: r, view: v.name };
  }
  return null;
}

/** View output columns that are plain expressions (not aggregates), by structural key -> column name. */
function outputMap(nv: SelectStmt['core'] & { kind: 'select' }, v: MatviewCandidate, keysOnly: boolean): Map<string, string> | null {
  const map = new Map<string, string>();
  const groupKeys = new Set(nv.groupBy.map(exprKey));
  for (let i = 0; i < nv.columns.length; i++) {
    const rc = nv.columns[i];
    if (rc.kind !== 'expr') return null; // `*` handled by the caller
    if (keysOnly && !groupKeys.has(exprKey(rc.expr))) continue;
    map.set(exprKey(rc.expr), v.columns[i]);
  }
  return map;
}

function rollUp(
  query: SelectStmt,
  text: string,
  nq: SelectStmt,
  v: MatviewCandidate,
  nv: SelectStmt['core'] & { kind: 'select' },
  extra: Expr[],
  info: (table: string) => MorselTableInfo | undefined,
): SelectStmt | null {
  if (nv.columns.some((c) => c.kind !== 'expr')) return null;
  // The query as partial aggregates (normalized, so expressions compare with the view's).
  const m = analyzeMorsels(nq, text, info);
  if (!m) return null;
  const keys = outputMap(nv, v, true)!;
  // Aggregate columns of the view; total(x) can be merged from a sum(x) column too.
  const aggs = new Map<string, string>();
  nv.columns.forEach((rc, i) => {
    if (rc.kind !== 'expr' || !isAggregateCall(rc.expr)) return;
    aggs.set(exprKey(rc.expr), v.columns[i]);
    const c = rc.expr as Expr & { kind: 'call' };
    if (c.name === 'sum') aggs.set(exprKey({ ...c, name: 'total' }), v.columns[i]);
  });
  const cols: Expr[] = [];
  for (let i = 0; i < m.partialExprs.length; i++) {
    const e = m.partialExprs[i];
    const name = i < m.keyCount ? keys.get(exprKey(e)) : aggs.get(exprKey(e));
    if (name === undefined) return null;
    cols.push({ kind: 'column', name, ...NO_POS });
  }
  // An ungrouped view answers only ungrouped queries over exactly its filter.
  if (nv.groupBy.length === 0 && (m.keyCount > 0 || extra.length > 0)) return null;
  const where: Expr[] = [];
  for (const c of extra) {
    const r = remap(c, keys);
    if (r === null) return null;
    where.push(r);
  }
  const source: FromItem = {
    kind: 'subquery',
    select: {
      kind: 'select',
      core: {
        kind: 'select',
        distinct: false,
        columns: cols.map((e, i) => ({ kind: 'expr', expr: e, alias: i < m.keyCount ? `k${i}` : `a${i - m.keyCount}`, ...NO_POS })),
        from: { kind: 'table', name: v.name, ...NO_POS },
        where: andAll(where),
        groupBy: [],
        windows: [],
        ...NO_POS,
      },
      compound: [],
      orderBy: [],
      ...NO_POS,
    },
    alias: 'smalt_mv',
    ...NO_POS,
  } as FromItem;
  const final = m.finalFrom(source);
  // Output names come from the query as written (the analysis saw lower-cased names).
  const oc = (query.core as SelectStmt['core'] & { kind: 'select' }).columns;
  const fc = final.core as SelectStmt['core'] & { kind: 'select' };
  fc.columns = fc.columns.map((rc, i) => {
    const o = oc[i];
    if (rc.kind !== 'expr' || o.kind !== 'expr') return rc;
    return { ...rc, alias: o.alias ?? (o.expr.kind === 'column' ? o.expr.name : text.slice(o.expr.pos, o.expr.end)) };
  });
  return final;
}

function project(nq: SelectStmt, query: SelectStmt, v: MatviewCandidate, nv: SelectStmt['core'] & { kind: 'select' }, extra: Expr[]): SelectStmt | null {
  if (nv.groupBy.length > 0) return null;
  // View columns: `*` keeps every table column under its own name; otherwise plain column refs.
  const map = new Map<string, string>();
  for (let i = 0; i < nv.columns.length; i++) {
    const rc = nv.columns[i];
    if (rc.kind === 'star') {
      for (const c of v.columns) map.set(exprKey({ kind: 'column', name: c.toLowerCase(), ...NO_POS }), c);
      continue;
    }
    if (rc.kind !== 'expr' || rc.expr.kind !== 'column') return null;
    map.set(exprKey(rc.expr), v.columns[i]);
  }
  const qc = nq.core as SelectStmt['core'] & { kind: 'select' };
  const original = query.core as SelectStmt['core'] & { kind: 'select' };
  const columns = [];
  for (let i = 0; i < qc.columns.length; i++) {
    const rc = qc.columns[i];
    if (rc.kind !== 'expr') {
      // `*` over the view is the table's columns only if the view has all of them in order.
      if (!(nv.columns.length === 1 && nv.columns[0].kind === 'star')) return null;
      columns.push(rc);
      continue;
    }
    const r = remap(rc.expr, map);
    if (r === null) return null;
    const orig = original.columns[i] as { expr: Expr; alias?: string };
    // Keep the query's output names.
    const name = rc.alias ?? (orig.expr.kind === 'column' ? orig.expr.name : undefined);
    columns.push({ ...rc, expr: { ...r, pos: orig.expr.pos, end: orig.expr.end }, alias: name });
  }
  const where: Expr[] = [];
  for (const c of extra) {
    const r = remap(c, map);
    if (r === null) return null;
    where.push(r);
  }
  const orderBy = [];
  for (const o of nq.orderBy) {
    if (o.expr.kind === 'literal') {
      orderBy.push(o);
      continue;
    }
    const aliasRef = o.expr.kind === 'column' && qc.columns.some((c) => c.kind === 'expr' && c.alias?.toLowerCase() === (o.expr as ColumnExpr).name);
    const r = aliasRef ? o.expr : remap(o.expr, map);
    if (r === null) return null;
    orderBy.push({ ...o, expr: r });
  }
  return {
    ...nq,
    core: { ...qc, columns, from: { kind: 'table', name: v.name, ...NO_POS }, where: andAll(where) },
    orderBy,
  };
}
