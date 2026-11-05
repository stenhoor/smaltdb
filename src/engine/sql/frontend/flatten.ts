/**
 * Query flattening: merge simple views and FROM-clause subqueries into the referencing query, so
 * their tables take part in join ordering and outer predicates reach their indexes (SQLite's
 * "query flattener", restricted to cases that are always safe).
 *
 *   SELECT name FROM eng WHERE salary > 90           -- eng: SELECT id, name, salary FROM emp WHERE dept = 1
 *   => SELECT "eng\x01emp".name AS name FROM emp AS "eng\x01emp" WHERE "eng\x01emp".salary > 90 AND "eng\x01emp".dept = 1
 *
 * A derived source is flattened only when its SELECT is a plain projection/filter/join (no
 * aggregates, GROUP BY, HAVING, DISTINCT, window functions, ORDER BY, LIMIT, compound or WITH,
 * no subquery expressions), every table it reads resolves to a base table, every column reference
 * resolves unambiguously, and the outer query does not reference it from a nested subquery. Anything
 * else is planned as before (a sub-plan), so declining to flatten is always correct.
 */
import type { TableSchema } from '../../language-support.js';
import { findColumn } from '../../language-support.js';
import type { ColumnExpr, Expr, FromItem, JoinType, OrderingTerm, ResultColumn, SelectCoreSelect, SelectStmt, TableRef } from '../ast.js';
import { aggregateFunctions } from '../../language-support.js';
import { and, anyNode as anyNodeIn } from '../ast-util.js';

/** Whether any node of `e` satisfies `pred`, not looking inside nested SELECT statements. */
const anyNode = (e: unknown, pred: (x: Record<string, unknown>) => boolean): boolean => anyNodeIn(e, pred, false);

export interface FlattenContext {
  getTable(name: string, schema?: string): TableSchema | undefined;
  getView(name: string, schema?: string): { name: string; sql: string; columns?: string[]; select: SelectStmt } | undefined;
  /** Whether `name` is a CTE visible to this query (CTE references are not flattened). */
  isCte(name: string): boolean;
  /** SQL text the AST positions refer to (names unaliased result columns of FROM subqueries). */
  text: string;
  /** Views being expanded (circular definitions are left to the planner, which reports them). */
  expanding?: ReadonlySet<string>;
}

let flattenOff: boolean | undefined;
/** SMALT_NO_FLATTEN=1 disables query flattening (tests compare both paths). */
export function flatteningDisabled(): boolean {
  if (flattenOff === undefined) {
    const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
    flattenOff = !!g.process?.env?.SMALT_NO_FLATTEN;
  }
  return flattenOff;
}

/** Thrown internally to decline flattening a source. */
class Decline extends Error {}
const decline = (): never => {
  throw new Decline();
};

const ROWID_NAMES = new Set(['rowid', 'oid', '_rowid_']);
/** Functions whose repeated evaluation would change results if an expression were duplicated. */
const VOLATILE = new Set(['random', 'randomblob', 'changes', 'total_changes', 'last_insert_rowid']);

interface Link {
  item: FromItem;
  joinType: JoinType | 'FIRST';
  on?: Expr;
}

/** Left-deep FROM tree -> list (null for parenthesized joins, NATURAL, USING, RIGHT/FULL). */
function linearize(from: FromItem): Link[] | null {
  const out: Link[] = [];
  const go = (f: FromItem): boolean => {
    if (f.kind !== 'join') {
      out.push({ item: f, joinType: 'FIRST' });
      return true;
    }
    if (f.natural || f.using || f.joinType === 'RIGHT' || f.joinType === 'FULL' || f.right.kind === 'join') return false;
    if (!go(f.left)) return false;
    out.push({ item: f.right, joinType: f.joinType, on: f.on });
    return true;
  };
  return go(from) ? out : null;
}

function rebuild(links: Link[]): FromItem {
  let acc = links[0].item;
  for (let i = 1; i < links.length; i++) {
    const l = links[i];
    acc = { kind: 'join', joinType: l.joinType === 'FIRST' ? 'INNER' : l.joinType, natural: false, left: acc, right: l.item, on: l.on, pos: l.item.pos, end: l.item.end };
  }
  return acc;
}

const isPlainObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && Object.getPrototypeOf(x) === Object.prototype;

/**
 * Copy an expression, replacing column references via `f`. Nested SELECTs are not entered;
 * `onSelect` is called for each (and may decline).
 */
function mapColumns(e: Expr, f: (c: ColumnExpr) => Expr, onSelect: (s: SelectStmt) => void): Expr {
  const go = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(go);
    if (!isPlainObject(x)) return x;
    if (x.kind === 'column' && typeof x.name === 'string') return f(x as unknown as ColumnExpr);
    if (x.kind === 'select' && 'core' in x) {
      onSelect(x as unknown as SelectStmt);
      return x;
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x)) out[k] = go(x[k]);
    return out;
  };
  return go(e) as Expr;
}

/** Visit every expression node (not entering nested SELECTs). */
/** All identifiers (column names and qualifiers, FROM names) mentioned anywhere inside `s`, lower-cased. */
function identifiersIn(s: SelectStmt): Set<string> {
  const out = new Set<string>();
  const go = (x: unknown): void => {
    if (Array.isArray(x)) return x.forEach(go);
    if (!isPlainObject(x)) return;
    if (x.kind === 'column') {
      out.add(String(x.name).toLowerCase());
      if (x.table) out.add(String(x.table).toLowerCase());
    }
    if (x.kind === 'table' && typeof x.name === 'string') out.add(x.name.toLowerCase());
    if (x.kind === 'tableStar') out.add(String(x.table).toLowerCase());
    for (const k of Object.keys(x)) go(x[k]);
  };
  go(s);
  return out;
}

const hasSubquery = (e: Expr | undefined): boolean => anyNode(e, (x) => (x.kind === 'subquery' || x.kind === 'exists' || x.kind === 'inSelect') && 'select' in x);
const hasAggregateOrWindow = (e: Expr | undefined): boolean =>
  anyNode(e, (x) => x.kind === 'call' && (x.over !== undefined || (aggregateFunctions.has(String(x.name)) && !((x.name === 'min' || x.name === 'max') && (x.args as unknown[]).length > 1))));
const hasVolatile = (e: Expr | undefined): boolean => anyNode(e, (x) => x.kind === 'call' && VOLATILE.has(String(x.name)));

/** A derived source reduced to base tables: what replaces it in the outer FROM. */
interface Expansion {
  links: Link[];
  where?: Expr;
  /** Output columns in order: name (lower-case key) -> expression over the renamed tables. */
  cols: { name: string; expr: Expr }[];
}

let aliasCounter = 0;

/**
 * Try to reduce `select` (the body of a view or FROM subquery referenced as `refName`) to base
 * tables, renaming its table aliases to names that cannot clash with the outer query.
 */
function expand(select: SelectStmt, columnNames: string[] | undefined, refName: string, ctx: FlattenContext): Expansion {
  if (select.with || select.compound.length || select.orderBy.length || select.limit || select.offset) decline();
  let core = select.core;
  if (core.kind !== 'select' || core.distinct || core.groupBy.length || core.having || core.windows.length || !core.from) decline();
  // Flatten the body's own derived sources first.
  core = flattenCore(core as SelectCoreSelect, [], ctx).core;
  const c = core as SelectCoreSelect;
  if (hasSubquery(c.where)) decline();
  const links = linearize(c.from!) ?? decline();
  // Every source must be a base table now.
  const tag = `${refName}\u0001${++aliasCounter}`;
  const leaves = links.map((l) => {
    if (l.item.kind !== 'table') decline();
    const t = l.item as TableRef;
    if (t.schema && t.schema.toLowerCase() !== 'main') decline();
    if (!t.schema && ctx.isCte(t.name)) decline();
    const table = ctx.getTable(t.name) ?? decline();
    if (table.system) decline();
    const ref = (t.alias ?? t.name).toLowerCase();
    return { table, ref, alias: `${tag}\u0001${t.alias ?? t.name}`, item: t };
  });
  if (new Set(leaves.map((l) => l.ref)).size !== leaves.length) decline();
  const qualify = (col: ColumnExpr): Expr => {
    if (col.schema) decline();
    const isRowid = ROWID_NAMES.has(col.name.toLowerCase());
    let leaf;
    if (col.table) {
      leaf = leaves.find((l) => l.ref === col.table!.toLowerCase()) ?? decline();
      if (findColumn(leaf.table, col.name) < 0 && !isRowid) decline();
    } else {
      const hits = leaves.filter((l) => findColumn(l.table, col.name) >= 0);
      if (hits.length === 1) leaf = hits[0];
      else if (hits.length === 0 && isRowid && leaves.length === 1) leaf = leaves[0];
      else decline();
    }
    return { ...col, table: leaf!.alias };
  };
  const rename = (e: Expr | undefined): Expr | undefined => (e ? mapColumns(e, qualify, () => decline()) : undefined);
  const outLinks: Link[] = links.map((l, i) => {
    if (hasSubquery(l.on)) decline();
    // Qualified (an outer CTE of the same name must not capture it) with the schema of the table the
    // view resolved to: a TEMP table and a main table may share the name.
    const item: TableRef = { kind: 'table', schema: leaves[i].table.temp ? 'temp' : 'main', name: leaves[i].table.name, alias: leaves[i].alias, pos: l.item.pos, end: l.item.end };
    return { item, joinType: l.joinType, on: rename(l.on) };
  });
  // Output columns (expanding * and t.*).
  const cols: { name: string; expr: Expr }[] = [];
  const pushTable = (leaf: (typeof leaves)[number], pos: number, end: number): void => {
    for (const col of leaf.table.columns) cols.push({ name: col.name, expr: { kind: 'column', table: leaf.alias, name: col.name, pos, end } });
  };
  for (const rc of c.columns as ResultColumn[]) {
    if (rc.kind === 'star') leaves.forEach((l) => pushTable(l, rc.pos, rc.end));
    else if (rc.kind === 'tableStar') pushTable(leaves.find((l) => l.ref === rc.table.toLowerCase()) ?? decline(), rc.pos, rc.end);
    else {
      if (hasSubquery(rc.expr) || hasAggregateOrWindow(rc.expr) || hasVolatile(rc.expr)) decline();
      const name = rc.alias ?? (rc.expr.kind === 'column' ? rc.expr.name : ctx.text.slice(rc.expr.pos, rc.expr.end));
      cols.push({ name, expr: rename(rc.expr)! });
    }
  }
  if (columnNames) {
    if (columnNames.length !== cols.length) decline(); // the normal path reports the error
    columnNames.forEach((n, i) => (cols[i].name = n));
  }
  return { links: outLinks, where: rename(c.where), cols };
}

/**
 * Flatten the eligible derived sources of one SELECT core. Returns the (possibly unchanged) core
 * and ORDER BY terms.
 */
export function flattenCore(core: SelectCoreSelect, orderBy: OrderingTerm[], ctx: FlattenContext): { core: SelectCoreSelect; orderBy: OrderingTerm[]; changed: boolean } {
  const unchanged = { core, orderBy, changed: false };
  if (!core.from) return unchanged;
  const links = linearize(core.from);
  if (!links) return unchanged;
  // Most SELECTs read only tables: nothing to flatten, so skip the walks below.
  const isView = (it: FromItem): boolean =>
    it.kind === 'table' && (!it.schema || ['main', 'temp'].includes(it.schema.toLowerCase())) && !(!it.schema && ctx.isCte(it.name)) && !ctx.getTable(it.name, it.schema) && ctx.getView(it.name, it.schema) !== undefined;
  if (!links.some((l) => (l.item.kind === 'subquery' && l.item.alias) || isView(l.item))) return unchanged;
  // Identifiers mentioned inside nested SELECTs of the outer query (possible correlated references).
  const nested = new Set<string>();
  const noteNested = (e: Expr | undefined): void => {
    if (!e) return;
    anyNode(e, (x) => {
      if (x.kind === 'select' && 'core' in x) for (const id of identifiersIn(x as unknown as SelectStmt)) nested.add(id);
      return false;
    });
  };
  for (const rc of core.columns) if (rc.kind === 'expr') noteNested(rc.expr);
  [core.where, core.having, ...core.groupBy, ...orderBy.map((t) => t.expr), ...links.map((l) => l.on)].forEach(noteNested);
  if (core.windows.length) return unchanged;

  // Expand each eligible derived source.
  const derived = new Map<number, { ref: string; exp: Expansion }>();
  links.forEach((l, i) => {
    const it = l.item;
    let select: SelectStmt | undefined;
    let names: string[] | undefined;
    let ref: string;
    let sub: FlattenContext = ctx;
    if (it.kind === 'subquery') {
      if (!it.alias) return; // anonymous: rare, leave as a sub-plan
      select = it.select;
      ref = it.alias;
    } else if (it.kind === 'table' && (!it.schema || ['main', 'temp'].includes(it.schema.toLowerCase())) && !(!it.schema && ctx.isCte(it.name)) && !ctx.getTable(it.name, it.schema)) {
      const v = ctx.getView(it.name, it.schema);
      if (!v || ctx.expanding?.has(v.name.toLowerCase())) return;
      select = v.select;
      names = v.columns;
      ref = it.alias ?? it.name;
      // A view body resolves names in the schema only, and its positions refer to its own SQL.
      sub = { ...ctx, isCte: () => false, text: v.sql, expanding: new Set([...(ctx.expanding ?? []), v.name.toLowerCase()]) };
    } else return;
    if (nested.has(ref.toLowerCase())) return;
    try {
      const exp = expand(select, names, ref, sub);
      // LEFT JOIN: only a single-table body can be merged (its WHERE moves into the ON clause).
      if (l.joinType === 'LEFT' && exp.links.length !== 1) return;
      if (exp.cols.some((c) => nested.has(c.name.toLowerCase()))) return;
      derived.set(i, { ref: ref.toLowerCase(), exp });
    } catch (e) {
      if (!(e instanceof Decline)) throw e;
    }
  });
  if (derived.size === 0) return unchanged;

  // Names visible to unqualified references: base-table columns of other sources; unknown sources
  // (CTEs, non-flattened subqueries, table-valued functions) make any match ambiguous.
  let unknownSource = false;
  const otherColumns = new Set<string>();
  links.forEach((l, i) => {
    if (derived.has(i)) return;
    const it = l.item;
    if (it.kind === 'table' && !(!it.schema && ctx.isCte(it.name))) {
      const t = ctx.getTable(it.name);
      if (t) t.columns.forEach((c) => otherColumns.add(c.name.toLowerCase()));
      else unknownSource = true;
    } else unknownSource = true;
  });
  const byRef = new Map([...derived.values()].map((d) => [d.ref, d.exp]));
  const outputAliases = new Set(core.columns.flatMap((rc) => (rc.kind === 'expr' && rc.alias ? [rc.alias.toLowerCase()] : [])));

  try {
    const resolve = (col: ColumnExpr, inOrderBy: boolean): Expr => {
      if (col.schema) return col;
      if (col.table) {
        const exp = byRef.get(col.table.toLowerCase());
        if (!exp) return col;
        const hit = exp.cols.find((c) => c.name.toLowerCase() === col.name.toLowerCase());
        return hit ? hit.expr : decline();
      }
      const lower = col.name.toLowerCase();
      if (inOrderBy && outputAliases.has(lower)) return col; // ORDER BY prefers result aliases
      const hits: Expr[] = [];
      for (const exp of byRef.values()) for (const c of exp.cols) if (c.name.toLowerCase() === lower) hits.push(c.expr);
      if (hits.length === 0) return col;
      if (hits.length > 1 || otherColumns.has(lower) || unknownSource) decline();
      return hits[0];
    };
    const rw = (e: Expr | undefined, inOrderBy = false): Expr | undefined => (e ? mapColumns(e, (c) => resolve(c, inOrderBy), () => {}) : undefined);

    // Result columns: expand stars over derived sources, and keep the names references would have had.
    const columns: ResultColumn[] = [];
    for (const rc of core.columns) {
      if (rc.kind === 'star') {
        links.forEach((l, i) => {
          const d = derived.get(i);
          if (d) for (const c of d.exp.cols) columns.push({ kind: 'expr', expr: c.expr, alias: c.name, pos: rc.pos, end: rc.end });
          else {
            const it = l.item;
            const name = it.kind === 'table' ? (it.alias ?? it.name) : it.kind === 'subquery' || it.kind === 'function' ? it.alias : undefined;
            if (!name) decline();
            columns.push({ kind: 'tableStar', table: name!, pos: rc.pos, end: rc.end });
          }
        });
      } else if (rc.kind === 'tableStar') {
        const exp = byRef.get(rc.table.toLowerCase());
        if (exp) for (const c of exp.cols) columns.push({ kind: 'expr', expr: c.expr, alias: c.name, pos: rc.pos, end: rc.end });
        else columns.push(rc);
      } else {
        const expr = rw(rc.expr)!;
        const alias = rc.alias ?? (rc.expr.kind === 'column' && expr !== rc.expr ? rc.expr.name : undefined);
        columns.push({ ...rc, expr, alias });
      }
    }

    // FROM: splice each expansion in place; INNER sources' conditions move to WHERE.
    const outLinks: Link[] = [];
    let where = rw(core.where);
    links.forEach((l, i) => {
      const d = derived.get(i);
      const on = rw(l.on);
      if (!d) {
        outLinks.push({ ...l, on });
        return;
      }
      if (l.joinType === 'LEFT') {
        outLinks.push({ item: d.exp.links[0].item, joinType: 'LEFT', on: and(on, d.exp.where) });
        return;
      }
      where = and(where, on);
      d.exp.links.forEach((x, j) => outLinks.push(j === 0 ? { item: x.item, joinType: outLinks.length ? 'INNER' : 'FIRST' } : x));
      where = and(where, d.exp.where);
    });

    const out: SelectCoreSelect = {
      ...core,
      columns,
      from: rebuild(outLinks),
      where,
      groupBy: core.groupBy.map((g) => rw(g)!),
      having: rw(core.having),
    };
    return { core: out, orderBy: orderBy.map((t) => ({ ...t, expr: rw(t.expr, true)! })), changed: true };
  } catch (e) {
    if (e instanceof Decline) return unchanged;
    throw e;
  }
}
