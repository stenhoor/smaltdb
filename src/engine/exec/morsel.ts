/**
 * Morsel parallelism (M7.4, ADR 0010): an aggregate query over one large table, split into rowid
 * ranges that parallel reader workers aggregate independently ("partials"), merged on the owner.
 *
 *   SELECT g, avg(x), count(*) FROM t WHERE p GROUP BY g HAVING count(*) > 1 ORDER BY 2 LIMIT 5
 *
 * becomes, per range [lo, hi):
 *
 *   SELECT g, total(x), count(x), count(*) FROM t WHERE (p) AND rowid >= lo AND rowid < hi GROUP BY g
 *
 * and the merge, over the partial rows (a table-valued source `smalt_partials()`, columns k0.., a0..):
 *
 *   SELECT k0 AS g, total(a0) / sum(a1) AS "avg(x)", sum(a2) AS "count(*)" FROM smalt_partials()
 *   GROUP BY k0 HAVING sum(a2) > 1 ORDER BY 2 LIMIT 5
 *
 * Only shapes whose aggregates merge exactly qualify: count, sum, total, min, max (one argument)
 * and avg, without DISTINCT or ORDER BY inside the call; no joins, subqueries, window functions,
 * DISTINCT or compound selects; GROUP BY keys compared with BINARY collation.
 */
import type { CallExpr, ColumnExpr, Expr, FromItem, LiteralExpr, OrderingTerm, ResultColumn, SelectStmt } from '../sql/ast.js';
import { isAggregateCall } from './planner.js';
import { anyNode, exprKey } from '../sql/ast-util.js';

const MERGEABLE = new Set(['count', 'sum', 'total', 'min', 'max', 'avg']);

/** What the database tells the analysis about the source table. */
export interface MorselTableInfo {
  /** Column `name` exists in the table (case-insensitive). */
  hasColumn(name: string): boolean;
  /** Column `name` compares with BINARY collation. */
  binaryColumn(name: string): boolean;
}

/** A query that can run as partial aggregates over rowid ranges. */
export interface MorselQuery {
  table: string;
  /** The partial query for rowids in [lo, hi). */
  partial(lo: number | bigint, hi: number | bigint): SelectStmt;
  /** The merge query over `smalt_partials()`. */
  final: SelectStmt;
  /** The merge query over another source with columns k0.., a0.. (MV matching). */
  finalFrom(source: FromItem): SelectStmt;
  /** Values per partial row. */
  width: number;
  /** The partial row's expressions: GROUP BY keys first ({@link keyCount}), then aggregate inputs. */
  partialExprs: Expr[];
  keyCount: number;
}

const NO_POS = { pos: 0, end: 0 };

export { exprKey };

const col = (name: string): ColumnExpr => ({ kind: 'column', name, ...NO_POS });
const lit = (value: number | bigint): LiteralExpr => ({ kind: 'literal', value, ...NO_POS });
const call = (name: string, args: Expr[], star = false): CallExpr => ({ kind: 'call', name, args, star, distinct: false, ...NO_POS });

/** A mergeable aggregate call, or null for anything else. */
function aggregateCall(e: Expr): CallExpr | null {
  if (e.kind !== 'call' || !MERGEABLE.has(e.name) || e.over !== undefined) return null;
  if (e.name === 'count' ? e.args.length > 1 || (e.star && e.args.length > 0) : e.args.length !== 1) return null; // min(a, b) is scalar
  return e;
}

/**
 * Analyze `stmt` for morsel execution; null when it does not qualify. `text` is the statement's
 * source (output column names).
 */
export function analyzeMorsels(stmt: SelectStmt, text: string, info: (table: string) => MorselTableInfo | undefined): MorselQuery | null {
  if (stmt.with || stmt.compound.length > 0) return null;
  const core = stmt.core;
  if (core.kind !== 'select' || core.distinct || core.windows.length > 0) return null;
  const from = core.from;
  if (!from || from.kind !== 'table' || from.indexedBy !== undefined || (from.schema && from.schema.toLowerCase() !== 'main')) return null;
  const t = info(from.name);
  if (!t) return null;
  // Subqueries, window functions, DISTINCT / ORDER BY aggregates, unknown aggregate shapes: no.
  let bad = false;
  const scan = (x: unknown): void => {
    anyNode(x, (o) => {
      if (o.kind === 'subquery' || o.kind === 'exists' || o.kind === 'inSelect' || o.kind === 'select') bad = true;
      if (o.kind === 'call') {
        const c = o as unknown as CallExpr;
        if (c.over !== undefined || c.distinct || (c as { orderBy?: unknown[] }).orderBy?.length) bad = true;
      }
      return bad;
    });
  };
  scan([core.columns, core.where, core.groupBy, core.having, stmt.orderBy, stmt.limit, stmt.offset]);
  if (bad) return null;
  if (core.columns.some((c) => c.kind !== 'expr')) return null;

  // GROUP BY keys: plain expressions over the table, compared in BINARY (partials meet by value).
  const keys = core.groupBy;
  for (const k of keys) {
    let ok = true;
    anyNode(k, (o) => {
      if (o.kind === 'collate') ok = false;
      if (o.kind === 'column') {
        const c = o as unknown as ColumnExpr;
        if (!t.hasColumn(c.name) || !t.binaryColumn(c.name)) ok = false;
      }
      if (o.kind === 'call' && aggregateCall(o as unknown as Expr)) ok = false;
      if (o.kind === 'param') ok = false;
      return !ok;
    });
    if (!ok) return null;
  }
  const keyIndex = new Map(keys.map((k, i) => [exprKey(k), i]));
  // The rowid range filter needs a rowid name no user column has taken.
  const rowidName = ['rowid', '_rowid_', 'oid'].find((n) => !t.hasColumn(n));
  if (rowidName === undefined) return null;
  /** min/max merge by BINARY comparison: an argument compared with another collation cannot be merged. */
  const binaryArg = (x: Expr): boolean => {
    if (x.kind === 'collate') return x.collation.toLowerCase() === 'binary';
    if (x.kind === 'column') return t.binaryColumn(x.name);
    return true; // expressions other than a column carry BINARY collation
  };

  const aliases = new Set(core.columns.flatMap((c) => (c.kind === 'expr' && c.alias ? [c.alias.toLowerCase()] : [])));
  // Partial columns: keys, then each distinct aggregate's inputs.
  const partialCols: Expr[] = keys.map((k) => k);
  const aggIndex = new Map<string, Expr>();
  let hasAggregate = false;

  /**
   * Rewrite an expression of the output for the merge query; null when it cannot be merged.
   * `names`: how a bare name resolves: 'select' (columns only), 'having' (a table column before an
   * output alias, as the planner resolves it) or 'order' (an output alias first).
   */
  const rewrite = (e: Expr, names: 'select' | 'having' | 'order'): Expr | null => {
    const allowAlias = names !== 'select';
    const ki = keyIndex.get(exprKey(e));
    if (ki !== undefined) return { ...col(`k${ki}`), pos: e.pos, end: e.end };
    const a = aggregateCall(e);
    if (a) {
      hasAggregate = true;
      const key = exprKey(a);
      let merged = aggIndex.get(key);
      if (merged === undefined) {
        if ((a.name === 'min' || a.name === 'max') && !binaryArg(a.args[0])) return null;
        const add = (x: Expr): ColumnExpr => {
          partialCols.push(x);
          return col(`a${partialCols.length - keys.length - 1}`);
        };
        const filtered = (c: CallExpr): CallExpr => ({ ...c, filter: a.filter });
        if (a.name === 'avg') {
          const s = add(filtered(call('total', a.args)));
          const n = add(filtered(call('count', a.args)));
          merged = { kind: 'binary', op: '/', left: call('total', [s]), right: call('sum', [n]), ...NO_POS } as Expr;
        } else if (a.name === 'count') {
          // Merged over zero partial rows (an empty MV roll-up), sum() is NULL: a count is 0.
          merged = call('coalesce', [call('sum', [add(a)]), lit(0)]);
        } else {
          merged = call(a.name, [add(a)]);
        }
        aggIndex.set(key, merged);
      }
      return { ...merged, pos: e.pos, end: e.end };
    }
    if (e.kind === 'column') {
      // An output alias (HAVING / ORDER BY may name one); any other column is a bare column.
      if (!allowAlias || e.table || !aliases.has(e.name.toLowerCase())) return null;
      return names === 'having' && t.hasColumn(e.name) ? null : e;
    }
    // Any other aggregate (group_concat, string_agg, json_group_*, …) cannot be merged from partials,
    // whatever its arguments: over constants or keys it would run once per partial row, not per row.
    if (e.kind === 'call' && isAggregateCall(e)) return null;
    // Rebuild the node with rewritten children (expressions only; no subqueries here).
    let failed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(e)) {
      if (failed) break;
      if (k === 'filter' || k === 'over') {
        out[k] = v;
        continue;
      }
      if (Array.isArray(v)) {
        out[k] = v.map((x) => {
          if (isExpr(x)) {
            const r = rewrite(x, names);
            if (r === null) failed = true;
            return r;
          }
          if (x && typeof x === 'object' && 'when' in x && 'then' in x) {
            const w = rewrite((x as { when: Expr }).when, names);
            const th = rewrite((x as { then: Expr }).then, names);
            if (w === null || th === null) failed = true;
            return { when: w, then: th };
          }
          return x;
        });
      } else if (isExpr(v)) {
        const r = rewrite(v, names);
        if (r === null) failed = true;
        out[k] = r;
      } else out[k] = v;
    }
    return failed ? null : (out as unknown as Expr);
  };

  const finalColumns: ResultColumn[] = [];
  for (const rc of core.columns) {
    if (rc.kind !== 'expr') return null;
    const r = rewrite(rc.expr, 'select');
    if (r === null) return null;
    const name = rc.alias ?? (rc.expr.kind === 'column' ? rc.expr.name : text.slice(rc.expr.pos, rc.expr.end));
    finalColumns.push({ ...rc, expr: r, alias: name });
  }
  let having: Expr | undefined;
  if (core.having) {
    const r = rewrite(core.having, 'having');
    if (r === null) return null;
    having = r;
  }
  const orderBy: OrderingTerm[] = [];
  for (const o of stmt.orderBy) {
    if (o.expr.kind === 'literal') {
      orderBy.push(o);
      continue;
    }
    const r = rewrite(o.expr, 'order');
    if (r === null) return null;
    orderBy.push({ ...o, expr: r });
  }
  if (!hasAggregate && keys.length === 0) return null;

  const width = partialCols.length;
  const partialColumns: ResultColumn[] = partialCols.map((e) => ({ kind: 'expr', expr: e, ...NO_POS }));
  const finalFrom = (source: FromItem): SelectStmt => ({
    kind: 'select',
    core: { ...core, columns: finalColumns, from: source, where: undefined, groupBy: keys.map((_, i) => col(`k${i}`)), having },
    compound: [],
    orderBy,
    limit: stmt.limit,
    offset: stmt.offset,
    ...NO_POS,
  });
  const final = finalFrom({ kind: 'function', name: 'smalt_partials', args: [], ...NO_POS });
  const partial = (lo: number | bigint, hi: number | bigint): SelectStmt => {
    const range: Expr = {
      kind: 'binary',
      op: 'AND',
      left: { kind: 'binary', op: '>=', left: col(rowidName), right: lit(lo), ...NO_POS } as Expr,
      right: { kind: 'binary', op: '<', left: col(rowidName), right: lit(hi), ...NO_POS } as Expr,
      ...NO_POS,
    } as Expr;
    const where: Expr = core.where ? ({ kind: 'binary', op: 'AND', left: core.where, right: range, ...NO_POS } as Expr) : range;
    return { kind: 'select', core: { ...core, columns: partialColumns, where, having: undefined }, compound: [], orderBy: [], ...NO_POS };
  };
  return { table: from.name, partial, final, finalFrom, width, partialExprs: partialCols, keyCount: keys.length };
}

function isExpr(x: unknown): x is Expr {
  return typeof x === 'object' && x !== null && typeof (x as { kind?: unknown }).kind === 'string' && 'pos' in x;
}
