/**
 * The SQL front end (ADR 0014, step 5): turns a parsed SELECT into a plan (plan/ops.ts) whose expressions reference
 * columns by position. It does the name-resolution half of what exec/planner.ts does today, in the same order and
 * with the same errors, and leaves costing, access paths and operators to the physical planner (step 6).
 *
 * Until step 6 the plans are not executed: `SMALT_PLAN=shadow` (exec/plan-shadow.ts) builds one beside every
 * compiled SELECT and checks its result columns (names, types, collations, declared types, affinities) and its
 * errors against the current planner's. Shapes the front end does not handle yet make `toPlan` return null:
 * window functions, recursive CTEs, table-valued functions and virtual tables, external tables, USING / NATURAL,
 * RIGHT / FULL JOIN.
 */
import type { TableSchema } from '../../catalog/schema.js';
import { SmaltError } from '../../errors.js';
import { type Affinity, type StaticType, affinityOfStorage, staticTypeOfStorage } from '../../exec/convert.js';
import { CollSrc, type ColumnBinding, type CompileScope, bindExpr, boundMetadata, conjuncts, withCompiledMeta } from '../../exec/expr.js';
import { type FunctionContext, aggregateFunctions } from '../../exec/functions.js';
import { containsAggregate, containsWindow, exprEquals, firstAggregateCall, sameName, selectReferences } from '../../exec/planner.js';
import type { PlanExpr } from '../../plan/expr.js';
import type { AggCall, JoinKind, PlanOp, SortKey } from '../../plan/ops.js';
import type { CollationName } from '../../plan/types.js';
import { Collation } from '../../values.js';
import type { CallExpr, ColumnExpr, Expr, FromItem, JoinType, OrderingTerm, ResultColumn, SelectCore, SelectStmt, WithClause } from '../ast.js';

/** What the front end needs of the catalog. */
export interface FrontEndCatalog {
  getTable(name: string, schema?: string): TableSchema | undefined;
  getView?(name: string, schema?: string): { name: string; sql: string; columns?: string[]; select: SelectStmt } | undefined;
  /** True for an external table (not handled by the front end yet). */
  isExternal?(name: string): boolean;
  funcCtx: FunctionContext;
}

/** A result column, with the metadata SQL keeps beside the plan. */
export interface FrontEndColumn {
  name: string;
  type: StaticType;
  declType?: string;
  collation: Collation;
  affinity: Affinity;
}

export interface FrontEndResult {
  plan: PlanOp;
  columns: FrontEndColumn[];
}

/** A shape the front end does not handle yet. */
class Unsupported extends Error {}

/**
 * Plan a SELECT. `text` is the statement's SQL text (result columns are named from it). Returns null for shapes the
 * front end does not handle yet; throws the error the current planner would raise.
 */
export function toPlan(stmt: SelectStmt, text: string, catalog: FrontEndCatalog): FrontEndResult | null {
  try {
    const fe = new FrontEnd(catalog, text);
    const r = fe.select(stmt, null);
    return { plan: fe.resolveRefs(r.plan), columns: r.columns };
  } catch (e) {
    if (e instanceof Unsupported) return null;
    throw e;
  }
}

const ROWID_NAMES = new Set(['rowid', 'oid', '_rowid_']);
const TEMP_CATALOG = new Set(['sqlite_temp_schema', 'sqlite_temp_master']);
const COLLATION_NAMES: readonly CollationName[] = ['binary', 'nocase', 'rtrim'];
const collationName = (c: Collation): CollationName => COLLATION_NAMES[c];

interface FeColumn {
  name: string;
  type: StaticType;
  collation: Collation;
  affinity: Affinity;
  declType: string;
}

interface FeSource {
  name: string;
  cols: FeColumn[];
  /** Position of the source's first column in the FROM row. */
  offset: number;
  /** FROM-row position of the rowid (tables), or null. */
  rowid: number | null;
  /** FROM position (join input order). */
  position: number;
  /** Width in the FROM row (columns, and the rowid of a table). */
  width: number;
}

class FeScope {
  sources: FeSource[] = [];
  width = 0;
  aliases: Map<string, Expr> | null = null;
  aliasScope: CompileScope | null = null;
  ctes = new Map<string, { select: SelectStmt; columns?: string[] }>();
  /** After aggregation: FROM-row position of a bare column -> its aggregate output position. */
  carry: ((rowIndex: number, type: StaticType, collation: Collation) => () => number) | null = null;
  /** While binding the ON condition of the join that adds source `onSource`. */
  onSource = -1;
  constructor(readonly parent: FeScope | null) {}

  findCte(name: string): { select: SelectStmt; columns?: string[] } | undefined {
    const lower = name.toLowerCase();
    for (let s: FeScope | null = this; s; s = s.parent) {
      const c = s.ctes.get(lower);
      if (c) return c;
    }
    return undefined;
  }
}

/** A column reference made while binding: the slot's register is its index in `FrontEnd.refs`. */
interface Ref {
  depth: number;
  input: number;
  index: () => number;
  type: StaticType;
  collation: Collation;
}

interface CoreResult {
  plan: PlanOp;
  columns: FrontEndColumn[];
}

class FrontEnd {
  readonly refs: Ref[] = [];
  private readonly expandingViews = new Set<string>();
  private readonly expandingAliases = new Set<string>();

  constructor(
    private readonly catalog: FrontEndCatalog,
    private text: string,
  ) {}

  // ---------------------------------------------------------------- statements

  select(stmt: SelectStmt, parent: FeScope | null): CoreResult {
    const withScope = new FeScope(parent);
    if (stmt.with) this.registerCtes(stmt.with, withScope);
    const base = stmt.with ? withScope : parent;
    if (stmt.compound.length === 0) {
      const r = this.core(stmt.core, base, stmt, undefined);
      return { plan: this.limit(r.plan, stmt, base), columns: r.columns };
    }
    const first = this.core(stmt.core, base, null, undefined);
    let plan = first.plan;
    for (const c of stmt.compound) {
      const next = this.core(c.core, base, null, first.columns.length);
      if (next.columns.length !== first.columns.length) {
        throw new SmaltError('SMALT_ERROR', `SELECTs to the left and right of ${c.op} do not have the same number of result columns`);
      }
      const kind = c.op === 'UNION ALL' ? 'unionAll' : c.op === 'UNION' ? 'union' : c.op === 'INTERSECT' ? 'intersect' : 'except';
      plan = { op: 'setop', kind, inputs: [plan, next.plan], collations: first.columns.map((x) => collationName(x.collation)) };
    }
    if (stmt.orderBy.length) {
      const keys: SortKey[] = stmt.orderBy.map((t) => {
        const idx = this.compoundOrderIndex(t, first.columns, stmt.core);
        const col = first.columns[idx];
        return { expr: { k: 'col', input: 0, index: idx, depth: 0, type: col.type, collation: collationName(col.collation) }, desc: t.desc, nullsFirst: t.nulls ? t.nulls === 'FIRST' : !t.desc, collation: collationName(col.collation) };
      });
      plan = { op: 'sort', input: plan, keys };
    }
    return { plan: this.limit(plan, stmt, base), columns: first.columns };
  }

  private registerCtes(w: WithClause, scope: FeScope): void {
    for (const c of w.ctes) {
      if (w.recursive && selectReferences(c.select, c.name)) throw new Unsupported('recursive CTE');
      scope.ctes.set(c.name.toLowerCase(), { select: c.select, columns: c.columns });
    }
  }

  private limit(plan: PlanOp, stmt: SelectStmt, scope: FeScope | null): PlanOp {
    if (!stmt.limit) {
      if (stmt.offset) throw new SmaltError('SMALT_ERROR', 'OFFSET without LIMIT');
      return plan;
    }
    const cs = this.compileScope(new FeScope(scope));
    const count = bindExpr(stmt.limit, cs);
    const offset = stmt.offset ? bindExpr(stmt.offset, cs) : undefined;
    return offset ? { op: 'limit', input: plan, count, offset } : { op: 'limit', input: plan, count };
  }

  private compoundOrderIndex(t: OrderingTerm, cols: FrontEndColumn[], core: SelectCore): number {
    const e = t.expr;
    if (e.kind === 'literal' && typeof e.value === 'number' && Number.isInteger(e.value)) {
      if (e.value < 1 || e.value > cols.length) throw new SmaltError('SMALT_ERROR', `ORDER BY term out of range - should be between 1 and ${cols.length}`);
      return e.value - 1;
    }
    if (e.kind === 'column' && !e.table) {
      const i = cols.findIndex((c) => sameName(c.name, e.name));
      if (i >= 0) return i;
    }
    if (core.kind === 'select') {
      const i = core.columns.findIndex((rc) => rc.kind === 'expr' && exprEquals(rc.expr, e));
      if (i >= 0) return i;
    }
    throw new SmaltError('SMALT_ERROR', 'ORDER BY term does not match any column in the result set');
  }

  // ---------------------------------------------------------------- one SELECT core

  private core(core: SelectCore, parent: FeScope | null, stmt: SelectStmt | null, width: number | undefined): CoreResult {
    if (core.kind === 'values') return this.values(core.rows, parent, stmt);
    if (core.columns.some((c) => c.kind === 'expr' && containsWindow(c.expr)) || stmt?.orderBy.some((t) => containsWindow(t.expr)) || core.windows?.length) {
      throw new Unsupported('window functions');
    }
    const scope = new FeScope(parent);
    let root = this.from(core.from, core.where, scope);
    const resultCols = this.expandResultColumns(core.columns, scope);
    scope.aliases = new Map();
    for (const rc of resultCols) if (rc.alias) scope.aliases.set(rc.alias.toLowerCase(), rc.expr);

    const isAgg =
      core.groupBy.length > 0 || core.having !== undefined || resultCols.some((c) => containsAggregate(c.expr)) || (stmt?.orderBy.some((t) => containsAggregate(t.expr)) ?? false);

    const baseCs = this.compileScope(scope);
    let exprScope = baseCs;
    let agg: { keys: { expr: PlanExpr; collation: CollationName }[]; aggs: AggCall[]; carry: PlanExpr[] } | null = null;
    if (isAgg) {
      const groups = core.groupBy.map((g) => {
        const ast = this.resolveGroupAst(g, resultCols);
        if (containsAggregate(ast)) throw new SmaltError('SMALT_ERROR', 'aggregate functions are not allowed in the GROUP BY clause');
        const bound = bindExpr(ast, baseCs);
        const c = boundMetadata(bound, this.catalog.funcCtx);
        return { ast, bound, type: c.type, collation: c.collSrc !== CollSrc.None ? c.collation : Collation.Binary, affinity: c.affinity };
      });
      const keys = groups.map((g) => ({ expr: g.bound, collation: collationName(g.collation) }));
      const aggs: AggCall[] = [];
      const aggAsts: CallExpr[] = [];
      const aggTypes: { argTypes: StaticType[]; collation: Collation }[] = [];
      const carry: PlanExpr[] = [];
      const carried = new Map<number, number>();
      const a = { keys, aggs, carry };
      agg = a;
      const keyCount = keys.length;
      // Bare columns: the aggregate carries them (keys, then aggregates, then carried columns).
      // Registered when bound; the output position is known once every aggregate call has been seen.
      const carryOf = (rowIndex: number, type: StaticType, collation: Collation): (() => number) => {
        let i = carried.get(rowIndex);
        if (i === undefined) {
          i = carry.length;
          carried.set(rowIndex, i);
          carry.push({ k: 'col', input: 0, index: rowIndex, depth: 0, type, collation: collationName(collation) });
        }
        const at = i;
        return () => keyCount + aggs.length + at;
      };
      const outRef = (index: () => number, type: StaticType, collation: Collation): number => this.ref({ depth: 0, input: 0, index, type, collation });
      exprScope = {
        ...baseCs,
        groupRef: (e) => {
          const i = groups.findIndex((g) => exprEquals(g.ast, e));
          if (i < 0) return undefined;
          const g = groups[i];
          return { reg: outRef(() => i, g.type, g.collation), type: g.type, collation: g.collation, affinity: g.affinity };
        },
        aggregateRef: (call) => {
          const existing = aggAsts.findIndex((x) => exprEquals(x, call));
          const def = aggregateFunctions.get(call.name)!;
          if (existing >= 0) {
            const t = aggTypes[existing];
            const type = def.resultType(t.argTypes);
            return { reg: outRef(() => keyCount + existing, type, t.collation), type, collation: t.collation, affinity: 'NONE' };
          }
          if (call.star && call.name !== 'count') throw new SmaltError('SMALT_ERROR', `wrong number of arguments to function ${call.name}()`);
          const n = call.args.length;
          if (!call.star && (n < def.minArgs || n > def.maxArgs || (call.name === 'count' && n === 0))) {
            throw new SmaltError('SMALT_ERROR', `wrong number of arguments to function ${call.name}()`);
          }
          const inner = call.args.map(firstAggregateCall).find((x) => x !== undefined);
          if (inner) throw new SmaltError('SMALT_ERROR', `misuse of aggregate function ${inner.name}()`);
          if (call.orderBy?.length) throw new SmaltError('SMALT_UNSUPPORTED', 'ORDER BY inside aggregate functions is not supported yet');
          if (call.distinct && n !== 1) throw new SmaltError('SMALT_ERROR', 'DISTINCT aggregates must have exactly one argument');
          // Arguments read the FROM row, not the aggregate's output.
          const saved = scope.carry;
          scope.carry = null;
          let args: PlanExpr[];
          let filter: PlanExpr | undefined;
          try {
            args = call.args.map((x) => bindExpr(x, baseCs));
            filter = call.filter ? bindExpr(call.filter, baseCs) : undefined;
          } finally {
            scope.carry = saved;
          }
          const compiled = args.map((x) => boundMetadata(x, this.catalog.funcCtx));
          const argTypes = compiled.map((c) => c.type);
          const collation = compiled[0]?.collSrc ? compiled[0].collation : Collation.Binary;
          const type = def.resultType(argTypes);
          const at = aggs.length;
          aggs.push({ fn: call.name, args, star: call.star, distinct: call.distinct, ...(filter ? { filter } : {}), collation: collationName(collation), type });
          aggAsts.push(call);
          aggTypes.push({ argTypes, collation });
          return { reg: outRef(() => keyCount + at, type, collation), type, collation, affinity: 'NONE' };
        },
      };
      scope.aliasScope = exprScope;
      scope.carry = carryOf;
    }

    // Result expressions.
    const bound = resultCols.map((c) => bindExpr(c.expr, exprScope));
    const compiled = bound.map((b) => boundMetadata(b, this.catalog.funcCtx));
    if (width !== undefined && width !== bound.length) {
      throw new SmaltError('SMALT_ERROR', `SELECTs to the left and right of a compound operator do not have the same number of result columns`);
    }
    const columns: FrontEndColumn[] = resultCols.map((c, i) => ({
      name: c.name,
      type: compiled[i].type,
      ...(c.declType !== undefined ? { declType: c.declType } : {}),
      collation: compiled[i].collSrc !== CollSrc.None ? compiled[i].collation : Collation.Binary,
      affinity: compiled[i].affinity,
    }));

    // ORDER BY (single core only): result positions, or extra expressions computed beside the result.
    const keys: SortKey[] = [];
    const extras: PlanExpr[] = [];
    if (stmt && stmt.compound.length === 0) {
      for (const t of stmt.orderBy) {
        const idx = this.orderByResultIndex(t.expr, resultCols);
        let pos: number;
        let coll: Collation;
        let type: StaticType;
        if (idx >= 0) {
          pos = idx;
          coll = t.expr.kind === 'collate' ? boundMetadata(bindExpr(t.expr, exprScope), this.catalog.funcCtx).collation : columns[idx].collation;
          type = columns[idx].type;
        } else {
          const b = bindExpr(t.expr, exprScope);
          const c = boundMetadata(b, this.catalog.funcCtx);
          pos = bound.length + extras.length;
          extras.push(b);
          coll = c.collSrc !== CollSrc.None ? c.collation : Collation.Binary;
          type = c.type;
        }
        keys.push({ expr: { k: 'col', input: 0, index: pos, depth: 0, type, collation: collationName(coll) }, desc: t.desc, nullsFirst: t.nulls ? t.nulls === 'FIRST' : !t.desc, collation: collationName(coll) });
      }
    }

    let having: PlanExpr | undefined;
    if (core.having) {
      if (!agg) throw new SmaltError('SMALT_ERROR', 'a GROUP BY clause is required before HAVING');
      having = bindExpr(core.having, exprScope);
    }

    if (agg) root = { op: 'aggregate', input: root, keys: agg.keys, aggs: agg.aggs, carry: agg.carry };
    if (having) root = { op: 'filter', input: root, pred: having };
    root = { op: 'project', input: root, exprs: [...bound, ...extras] };
    if (core.distinct) root = { op: 'distinct', input: root, collations: columns.map((c) => collationName(c.collation)) };
    if (keys.length) root = { op: 'sort', input: root, keys };
    if (extras.length) root = { op: 'project', input: root, exprs: columns.map((c, i) => ({ k: 'col', input: 0, index: i, depth: 0, type: c.type, collation: collationName(c.collation) })) };
    return { plan: root, columns };
  }

  private values(rows: Expr[][], parent: FeScope | null, stmt: SelectStmt | null): CoreResult {
    const width = rows[0].length;
    for (const r of rows) if (r.length !== width) throw new SmaltError('SMALT_ERROR', 'all VALUES must have the same number of terms');
    const cs = this.compileScope(new FeScope(parent));
    const bound = rows.map((r) => r.map((e) => bindExpr(e, cs)));
    const types = bound[0].map((b) => boundMetadata(b, this.catalog.funcCtx).type);
    const columns: FrontEndColumn[] = types.map((type, i) => ({ name: `column${i + 1}`, type, collation: Collation.Binary, affinity: 'NONE' }));
    let plan: PlanOp = { op: 'values', rows: bound, types };
    if (stmt && stmt.compound.length === 0 && stmt.orderBy.length) {
      const keys: SortKey[] = stmt.orderBy.map((t) => {
        const idx = this.compoundOrderIndex(t, columns, { kind: 'values', rows, pos: 0, end: 0 } as SelectCore);
        return { expr: { k: 'col', input: 0, index: idx, depth: 0, type: types[idx], collation: 'binary' }, desc: t.desc, nullsFirst: t.nulls ? t.nulls === 'FIRST' : !t.desc, collation: 'binary' };
      });
      plan = { op: 'sort', input: plan, keys };
    }
    return { plan, columns };
  }

  private orderByResultIndex(e: Expr, cols: { alias?: string; expr: Expr; name: string }[]): number {
    let inner = e;
    if (inner.kind === 'collate') inner = inner.expr;
    if (inner.kind === 'literal' && typeof inner.value === 'number' && Number.isInteger(inner.value)) {
      if (inner.value < 1 || inner.value > cols.length) throw new SmaltError('SMALT_ERROR', `ORDER BY term out of range - should be between 1 and ${cols.length}`);
      return inner.value - 1;
    }
    if (inner.kind === 'column' && !inner.table) {
      const name = inner.name;
      const i = cols.findIndex((c) => c.alias !== undefined && sameName(c.alias, name));
      if (i >= 0) return i;
    }
    return cols.findIndex((c) => exprEquals(c.expr, inner));
  }

  private resolveGroupAst(g: Expr, cols: { alias?: string; expr: Expr }[]): Expr {
    if (g.kind === 'literal' && typeof g.value === 'number' && Number.isInteger(g.value)) {
      if (g.value < 1 || g.value > cols.length) throw new SmaltError('SMALT_ERROR', `GROUP BY term out of range - should be between 1 and ${cols.length}`);
      return cols[g.value - 1].expr;
    }
    return g;
  }

  private expandResultColumns(cols: ResultColumn[], scope: FeScope): { expr: Expr; name: string; alias?: string; declType?: string }[] {
    const out: { expr: Expr; name: string; alias?: string; declType?: string }[] = [];
    for (const rc of cols) {
      if (rc.kind === 'star' || rc.kind === 'tableStar') {
        if (scope.sources.length === 0) throw new SmaltError('SMALT_ERROR', 'no tables specified');
        let found = false;
        for (const src of scope.sources) {
          if (rc.kind === 'tableStar' && !sameName(src.name, rc.table)) continue;
          found = true;
          for (const c of src.cols) out.push({ expr: { kind: 'column', table: src.name, name: c.name, pos: rc.pos, end: rc.end }, name: c.name, declType: c.declType || undefined });
        }
        if (!found) throw new SmaltError('SMALT_ERROR', `no such table: ${(rc as { table: string }).table}`);
      } else {
        const e = rc.expr;
        let name = rc.alias;
        let declType: string | undefined;
        if (e.kind === 'column') {
          name ??= e.name;
          const c = this.peekColumn(e, scope);
          declType = c?.declType || undefined;
        }
        name ??= this.text.slice(e.pos, e.end);
        out.push({ expr: e, name, alias: rc.alias, declType });
      }
    }
    return out;
  }

  private peekColumn(e: ColumnExpr, scope: FeScope): FeColumn | undefined {
    for (const s of scope.sources) {
      if (e.table && !sameName(e.table, s.name)) continue;
      const c = s.cols.find((c) => sameName(c.name, e.name));
      if (c) return c;
    }
    return undefined;
  }

  // ---------------------------------------------------------------- FROM / WHERE

  private from(from: FromItem | undefined, where: Expr | undefined, scope: FeScope): PlanOp {
    if (!from) {
      let root: PlanOp = { op: 'values', rows: [[]], types: [] };
      if (where) root = { op: 'filter', input: root, pred: bindExpr(where, this.compileScope(scope)) };
      return root;
    }
    const items: { item: FromItem; joinType: JoinType; on?: Expr; using?: string[]; natural: boolean }[] = [];
    this.flattenFrom(from, 'INNER', undefined, undefined, false, items);
    const inputs = items.map((it) => this.addSource(it.item, scope));
    for (const it of items) {
      if (it.using || it.natural) throw new Unsupported('USING / NATURAL');
      if (it.joinType === 'RIGHT' || it.joinType === 'FULL') throw new Unsupported('RIGHT / FULL JOIN');
    }
    let root = inputs[0];
    for (let p = 1; p < items.length; p++) {
      const it = items[p];
      const kind: JoinKind = it.joinType === 'LEFT' ? 'left' : it.on ? 'inner' : 'cross';
      let on: PlanExpr | undefined;
      if (it.on) {
        scope.onSource = p;
        try {
          const cs = this.compileScope(scope);
          const parts = conjuncts(it.on).map((c) => bindExpr(c, cs));
          on = parts.reduce((x, y) => ({ k: 'and', args: [x, y] }));
        } finally {
          scope.onSource = -1;
        }
      }
      root = on ? { op: 'join', kind, inputs: [root, inputs[p]], on } : { op: 'join', kind, inputs: [root, inputs[p]] };
    }
    if (where) root = { op: 'filter', input: root, pred: bindExpr(where, this.compileScope(scope)) };
    return root;
  }

  private flattenFrom(
    item: FromItem,
    joinType: JoinType,
    on: Expr | undefined,
    using: string[] | undefined,
    natural: boolean,
    out: { item: FromItem; joinType: JoinType; on?: Expr; using?: string[]; natural: boolean }[],
  ): void {
    if (item.kind === 'join') {
      this.flattenFrom(item.left, joinType, on, using, natural, out);
      if (item.right.kind === 'join') {
        if (item.joinType === 'LEFT') throw new SmaltError('SMALT_UNSUPPORTED', 'LEFT JOIN with a parenthesized join on the right is not supported yet');
        this.flattenFrom(item.right, 'INNER', undefined, undefined, false, out);
        if (item.on) out[out.length - 1].on = out[out.length - 1].on ? ({ kind: 'binary', op: 'AND', left: out[out.length - 1].on!, right: item.on, pos: 0, end: 0 } as Expr) : item.on;
      } else {
        out.push({ item: item.right, joinType: item.joinType === 'CROSS' ? 'INNER' : item.joinType, on: item.on, using: item.using, natural: item.natural });
      }
      return;
    }
    out.push({ item, joinType, on, using, natural });
  }

  /** Add a FROM item's columns to the scope; returns the plan that produces its rows. */
  private addSource(item: FromItem, scope: FeScope): PlanOp {
    const position = scope.sources.length;
    if (item.kind === 'function') throw new Unsupported('table-valued function');
    if (item.kind === 'join') throw new SmaltError('SMALT_ERROR', 'unexpected join');
    if (item.kind === 'table') {
      const schema = item.schema?.toLowerCase();
      const lower = item.name.toLowerCase();
      if (schema === 'information_schema') throw new Unsupported('information_schema');
      if (schema === undefined ? !scope.findCte(item.name) && TEMP_CATALOG.has(lower) : schema === 'temp' && (TEMP_CATALOG.has(lower) || lower === 'sqlite_schema' || lower === 'sqlite_master')) {
        throw new Unsupported('TEMP catalog');
      }
      if ((schema === undefined || schema === 'main') && !(schema === undefined && scope.findCte(item.name)) && this.catalog.isExternal?.(item.name)) throw new Unsupported('external table');
    }
    const view =
      item.kind === 'table' && (!item.schema || ['main', 'temp'].includes(item.schema.toLowerCase())) && !(!item.schema && scope.findCte(item.name)) && !this.catalog.getTable(item.name, item.schema)
        ? this.catalog.getView?.(item.name, item.schema)
        : undefined;
    if (item.kind === 'subquery' || view || (item.kind === 'table' && !item.schema && scope.findCte(item.name))) {
      let names: string[] | undefined;
      let alias: string | undefined;
      let sub: CoreResult;
      if (item.kind === 'subquery') {
        alias = item.alias;
        sub = this.select(item.select, scope.parent);
      } else if (view) {
        const key = view.name.toLowerCase();
        if (this.expandingViews.has(key)) throw new SmaltError('SMALT_ERROR', `view ${view.name} is circularly defined`);
        this.expandingViews.add(key);
        // Result-column names come from the view's own SQL text.
        const outerText = this.text;
        this.text = view.sql;
        try {
          sub = this.select(view.select, null);
        } finally {
          this.text = outerText;
          this.expandingViews.delete(key);
        }
        names = view.columns;
        alias = (item as { alias?: string }).alias ?? (item as { name: string }).name;
        if (names && names.length !== sub.columns.length) {
          throw new SmaltError('SMALT_ERROR', `expected ${names.length} columns for '${view.name}' but got ${sub.columns.length}`);
        }
      } else {
        const cteName = (item as { name: string }).name;
        const cte = scope.findCte(cteName)!;
        names = cte.columns;
        alias = (item as { alias?: string }).alias ?? cteName;
        sub = this.select(cte.select, scope.parent);
      }
      if (names && names.length !== sub.columns.length) {
        throw new SmaltError('SMALT_ERROR', `table ${alias} has ${sub.columns.length} values for ${names.length} columns`);
      }
      const cols: FeColumn[] = sub.columns.map((c, i) => ({ name: names ? names[i] : c.name, type: c.type, collation: c.collation, affinity: c.affinity, declType: c.declType ?? '' }));
      this.push(scope, { name: alias ?? `(subquery-${position + 1})`, cols, offset: 0, rowid: null, position, width: cols.length });
      return sub.plan;
    }
    if (item.schema && !['main', 'temp'].includes(item.schema.toLowerCase())) throw new SmaltError('SMALT_ERROR', `unknown database ${item.schema}`);
    const table = this.catalog.getTable(item.name, item.schema);
    if (!table) throw new SmaltError('SMALT_ERROR', `no such table: ${item.schema ? `${item.schema}.` : ''}${item.name}`);
    if (typeof item.indexedBy === 'string' && !table.indexes.some((i) => sameName(i.name, item.indexedBy!))) throw new SmaltError('SMALT_ERROR', `no such index: ${item.indexedBy}`);
    const name = item.alias ?? table.name;
    for (const s of scope.sources) if (sameName(s.name, name)) throw new SmaltError('SMALT_ERROR', `ambiguous table name: ${name}`);
    const cols: FeColumn[] = table.columns.map((c) => ({
      name: c.name,
      type: c.rowidAlias ? 'int' : staticTypeOfStorage(c.type),
      collation: c.collation,
      affinity: affinityOfStorage(c.type),
      declType: c.declaredType,
    }));
    const n = table.columns.length;
    const hasAlias = table.rowidAlias >= 0;
    this.push(scope, { name, cols, offset: 0, rowid: hasAlias ? table.rowidAlias : n, position, width: hasAlias ? n : n + 1 });
    const columns = table.columns.map((_c, i) => i);
    const db = table.temp ? 'temp' : undefined;
    return { op: 'scan', table: table.name, ...(db ? { db } : {}), columns: hasAlias ? columns : [...columns, -1] };
  }

  private push(scope: FeScope, src: FeSource): void {
    src.offset = scope.width;
    if (src.rowid !== null) src.rowid += scope.width;
    scope.width += src.width;
    scope.sources.push(src);
  }

  // ---------------------------------------------------------------- names

  private ref(r: Ref): number {
    this.refs.push(r);
    return this.refs.length - 1;
  }

  compileScope(scope: FeScope): CompileScope {
    const refuse = (): never => {
      throw new SmaltError('SMALT_INTERNAL', 'the SQL front end plans subqueries');
    };
    return {
      resolveColumn: (e) => this.resolveColumn(e, scope),
      scalarSubquery: refuse,
      existsSubquery: refuse,
      inSubquery: refuse,
      planSubquery: (select, mode) => {
        const r = this.select(select, scope);
        if (mode !== 'exists' && r.columns.length !== 1) throw new SmaltError('SMALT_ERROR', `sub-select returns ${r.columns.length} columns - expected 1`);
        return { plan: r.plan, column: { type: r.columns[0]?.type ?? 'any', collation: r.columns[0]?.collation ?? Collation.Binary } };
      },
      funcCtx: this.catalog.funcCtx,
    };
  }

  private resolveColumn(e: ColumnExpr, scope: FeScope): ColumnBinding {
    let depth = 0;
    for (let s: FeScope | null = scope; s; s = s.parent, depth++) {
      const hit = this.resolveIn(e, s);
      if (hit) return this.binding(hit, s, depth);
    }
    // Fallback: a select-list alias.
    if (!e.table) {
      const key = e.name.toLowerCase();
      for (let s: FeScope | null = scope; s; s = s.parent) {
        const aliased = s.aliases?.get(key);
        if (aliased && !this.expandingAliases.has(key)) {
          this.expandingAliases.add(key);
          try {
            const b = bindExpr(aliased, s.aliasScope ?? this.compileScope(s));
            const c = boundMetadata(b, this.catalog.funcCtx);
            return { reg: -1, type: c.type, collation: c.collation, affinity: c.affinity, bound: withCompiledMeta(b, c) };
          } finally {
            this.expandingAliases.delete(key);
          }
        }
      }
    }
    const name = e.table ? `${e.table}.${e.name}` : e.name;
    const quoted = !e.table && this.text[e.pos] === '"';
    throw new SmaltError('SMALT_ERROR', quoted ? `no such column: "${e.name}" - should this be a string literal in single-quotes?` : `no such column: ${name}`);
  }

  private resolveIn(e: ColumnExpr, scope: FeScope): { src: FeSource; col: number | 'rowid' } | undefined {
    if (e.table) {
      const src = scope.sources.find((s) => sameName(s.name, e.table!));
      if (!src) return undefined;
      const c = src.cols.findIndex((c) => sameName(c.name, e.name));
      if (c >= 0) return { src, col: c };
      if (src.rowid !== null && ROWID_NAMES.has(e.name.toLowerCase())) return { src, col: 'rowid' };
      throw new SmaltError('SMALT_ERROR', `no such column: ${e.table}.${e.name}`);
    }
    let found: { src: FeSource; col: number } | undefined;
    for (const src of scope.sources) {
      const c = src.cols.findIndex((c) => sameName(c.name, e.name));
      if (c < 0) continue;
      if (found) throw new SmaltError('SMALT_ERROR', `ambiguous column name: ${e.name}`);
      found = { src, col: c };
    }
    if (found) return found;
    if (ROWID_NAMES.has(e.name.toLowerCase())) {
      const tables = scope.sources.filter((s) => s.rowid !== null);
      if (tables.length === 1) return { src: tables[0], col: 'rowid' };
      if (tables.length > 1) throw new SmaltError('SMALT_ERROR', `ambiguous column name: ${e.name}`);
    }
    return undefined;
  }

  private binding(hit: { src: FeSource; col: number | 'rowid' }, scope: FeScope, depth: number): ColumnBinding {
    const { src, col } = hit;
    const c = col === 'rowid' ? { type: 'int' as StaticType, collation: Collation.Binary, affinity: 'INTEGER' as Affinity } : src.cols[col];
    const rowIndex = col === 'rowid' ? src.rowid! : src.offset + col;
    let input = 0;
    let index: () => number = () => rowIndex;
    if (depth === 0 && scope.onSource >= 0) {
      // A join condition: input 0 is the left side (the sources before), input 1 the source being joined.
      if (src.position > scope.onSource) throw new Unsupported('join condition reading a later source');
      if (src.position === scope.onSource) {
        input = 1;
        const local = rowIndex - src.offset;
        index = () => local;
      }
    } else if (scope.carry) {
      index = scope.carry(rowIndex, c.type, c.collation);
    }
    return { reg: this.ref({ depth, input, index, type: c.type, collation: c.collation }), type: c.type, collation: c.collation, affinity: c.affinity };
  }

  // ---------------------------------------------------------------- positions

  /** Replace the binder's register slots with positional column references, through nested plans too. */
  resolveRefs(op: PlanOp): PlanOp {
    const ex = (e: PlanExpr): PlanExpr => this.resolveExpr(e);
    const list = (xs: readonly PlanExpr[]): PlanExpr[] => xs.map(ex);
    switch (op.op) {
      case 'scan':
        return op;
      case 'values':
        return { ...op, rows: op.rows.map(list) };
      case 'filter':
        return { ...op, input: this.resolveRefs(op.input), pred: ex(op.pred) };
      case 'project':
        return { ...op, input: this.resolveRefs(op.input), exprs: list(op.exprs) };
      case 'limit':
        return { ...op, input: this.resolveRefs(op.input), count: ex(op.count), ...(op.offset ? { offset: ex(op.offset) } : {}) };
      case 'join':
        return { ...op, inputs: [this.resolveRefs(op.inputs[0]), this.resolveRefs(op.inputs[1])], ...(op.on ? { on: ex(op.on) } : {}) };
      case 'setop':
        return { ...op, inputs: [this.resolveRefs(op.inputs[0]), this.resolveRefs(op.inputs[1])] };
      case 'sort':
        return { ...op, input: this.resolveRefs(op.input), keys: op.keys.map((k) => ({ ...k, expr: ex(k.expr) })) };
      case 'aggregate':
        return {
          ...op,
          input: this.resolveRefs(op.input),
          keys: op.keys.map((k) => ({ ...k, expr: ex(k.expr) })),
          aggs: op.aggs.map((a) => ({ ...a, args: list(a.args), ...(a.filter ? { filter: ex(a.filter) } : {}) })),
          carry: list(op.carry),
        };
      case 'distinct':
        return { ...op, input: this.resolveRefs(op.input) };
    }
  }

  private resolveExpr(e: PlanExpr): PlanExpr {
    const ex = (x: PlanExpr): PlanExpr => this.resolveExpr(x);
    switch (e.k) {
      case 'slot': {
        const r = this.refs[e.reg];
        if (!r) return e;
        return { k: 'col', input: r.input, index: r.index(), depth: r.depth, type: r.type, collation: collationName(r.collation) };
      }
      case 'call':
        return { ...e, args: e.args.map(ex) };
      case 'cast':
      case 'not':
      case 'isNull':
        return { ...e, arg: ex(e.arg) } as PlanExpr;
      case 'and':
      case 'or':
        return { ...e, args: e.args.map(ex) };
      case 'case':
        return { ...e, whens: e.whens.map((w) => ({ when: ex(w.when), then: ex(w.then) })), else: ex(e.else) };
      case 'subquery':
        return { ...e, plan: this.resolveRefs(e.plan) };
      case 'inSubquery':
        return { ...e, probe: ex(e.probe), plan: this.resolveRefs(e.plan) };
      default:
        return e;
    }
  }
}
