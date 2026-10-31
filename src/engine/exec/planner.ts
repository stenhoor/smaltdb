import { SmaltError } from '../errors.js';
import { type TableSchema, findColumn } from '../catalog/schema.js';
import type {
  CallExpr,
  ColumnExpr,
  Expr,
  FromItem,
  JoinType,
  OrderingTerm,
  ResultColumn,
  SelectCore,
  SelectStmt,
  WithClause,
} from '../sql/ast.js';
import type { BTree } from '../storage/btree.js';
import { RecordReader } from '../storage/record.js';
import { Collation, type SqlValue } from '../values.js';
import { type Affinity, type StaticType, affinityOfStorage, hashKey, staticTypeOfStorage, truthy } from './convert.js';
import {
  CollSrc,
  type ColumnBinding,
  type CompileScope,
  type Compiled,
  type Fn,
  compileExpr,
  comparisonCollation,
  comparisonConverters,
  conjuncts,
} from './expr.js';
import { type FunctionContext, aggregateFunctions } from './functions.js';
import {
  type AggSpec,
  Compound,
  Distinct,
  type ExecState,
  Filter,
  HashAggregate,
  HashJoin,
  IndexScan,
  Limit,
  Materialize,
  NestedLoopJoin,
  type Operator,
  Project,
  RowidLookup,
  SingleRow,
  Sort,
  type SortKey,
  TableAccess,
  TableScan,
  Values,
} from './operators.js';

export interface PlannerEnv {
  getTable(name: string): TableSchema | undefined;
  openTree(rootPage: number): BTree;
  funcCtx: FunctionContext;
  state: ExecState;
}

export class Registers {
  constructor(public count: number) {}
  alloc(n = 1): number {
    const r = this.count;
    this.count += n;
    return r;
  }
}

export interface ResultColumnInfo {
  name: string;
  type: StaticType;
  /** Declared column type when the result is a direct column reference. */
  declType?: string;
  collation: Collation;
}

export interface QueryPlan {
  root: Operator;
  outRegs: number[];
  columns: ResultColumnInfo[];
  /** References columns of an enclosing query (must be re-run per outer row). */
  correlated: boolean;
}

interface SourceColumn {
  name: string;
  reg: number;
  type: StaticType;
  collation: Collation;
  affinity: Affinity;
  declType: string;
  /** Column index in the table (table sources). */
  index: number;
}

interface Source {
  /** Name used to qualify columns (alias, else table name). */
  name: string;
  table?: TableSchema;
  access?: TableAccess;
  cols: SourceColumn[];
  rowidReg: number;
  sub?: QueryPlan;
  joinType: JoinType;
  on: Expr[];
  /** Lower-cased column names merged by USING/NATURAL (hidden from unqualified lookup and *). */
  hidden: Set<string>;
  position: number;
}

const ROWID_NAMES = new Set(['rowid', 'oid', '_rowid_']);

class Scope {
  sources: Source[] = [];
  correlated = false;
  /** Select-list aliases usable as a fallback in WHERE/GROUP BY/HAVING/ORDER BY. */
  aliases: Map<string, Expr> | null = null;
  ctes = new Map<string, { select: SelectStmt; columns?: string[] }>();
  constructor(readonly parent: Scope | null) {}

  findCte(name: string): { select: SelectStmt; columns?: string[] } | undefined {
    const lower = name.toLowerCase();
    for (let s: Scope | null = this; s; s = s.parent) {
      const c = s.ctes.get(lower);
      if (c) return c;
    }
    return undefined;
  }
}

function sameName(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}

/** Structural AST equality ignoring source positions. */
export function exprEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    if (typeof a === 'string' && typeof b === 'string') return a === b;
    return false;
  }
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array && a.length === b.length && a.every((x, i) => x === b[i]);
  }
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => exprEquals(x, b[i]));
  const ka = Object.keys(a).filter((k) => k !== 'pos' && k !== 'end' && (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter((k) => k !== 'pos' && k !== 'end' && (b as Record<string, unknown>)[k] !== undefined);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const va = (a as Record<string, unknown>)[k];
    const vb = (b as Record<string, unknown>)[k];
    // Identifiers compare case-insensitively.
    if ((k === 'name' || k === 'table') && typeof va === 'string' && typeof vb === 'string') {
      if (!sameName(va, vb)) return false;
    } else if (!exprEquals(va, vb)) return false;
  }
  return true;
}

/** Visit an expression tree; `visit` returns false to skip children. Does not enter subqueries. */
function walk(e: Expr, visit: (e: Expr) => boolean | void): void {
  if (visit(e) === false) return;
  switch (e.kind) {
    case 'unary':
      walk(e.operand, visit);
      break;
    case 'binary':
      walk(e.left, visit);
      walk(e.right, visit);
      break;
    case 'between':
      walk(e.expr, visit);
      walk(e.low, visit);
      walk(e.high, visit);
      break;
    case 'inList':
      walk(e.expr, visit);
      e.list.forEach((x) => walk(x, visit));
      break;
    case 'inSelect':
      walk(e.expr, visit);
      break;
    case 'like':
      walk(e.expr, visit);
      walk(e.pattern, visit);
      if (e.escape) walk(e.escape, visit);
      break;
    case 'isNull':
    case 'collate':
    case 'cast':
      walk(e.expr, visit);
      break;
    case 'case':
      if (e.base) walk(e.base, visit);
      for (const w of e.whens) {
        walk(w.when, visit);
        walk(w.then, visit);
      }
      if (e.else) walk(e.else, visit);
      break;
    case 'call':
      e.args.forEach((x) => walk(x, visit));
      if (e.filter) walk(e.filter, visit);
      break;
    default:
      break;
  }
}

function hasSubquery(e: Expr): boolean {
  let found = false;
  walk(e, (x) => {
    if (x.kind === 'subquery' || x.kind === 'exists' || x.kind === 'inSelect') found = true;
  });
  return found;
}

function isAggregateCall(e: Expr): e is CallExpr {
  return e.kind === 'call' && aggregateFunctions.has(e.name) && !((e.name === 'min' || e.name === 'max') && e.args.length > 1) && e.over === undefined;
}

function containsAggregate(e: Expr | undefined): boolean {
  if (!e) return false;
  let found = false;
  walk(e, (x) => {
    if (isAggregateCall(x)) {
      found = true;
      return false;
    }
  });
  return found;
}

interface ConjunctInfo {
  expr: Expr;
  /** Positions of current-scope sources referenced; null = depends on everything (subqueries). */
  deps: Set<number> | null;
  placed: boolean;
}

interface AccessChoice {
  leaf: Operator;
  /** Leaf probes depend on earlier sources (must be re-opened per outer row). */
  dependsOnOuter: boolean;
  /** Supports ORDER BY rowid elimination. */
  scan?: TableScan;
}

export class Planner {
  constructor(
    readonly env: PlannerEnv,
    readonly regs: Registers,
  ) {}

  // ================================================================ SELECT

  planSelect(stmt: SelectStmt, parent: Scope | null, outRegs?: number[]): QueryPlan {
    const withScope = new Scope(parent);
    if (stmt.with) this.registerCtes(stmt.with, withScope);
    const base = stmt.with ? withScope : parent;

    if (stmt.compound.length === 0) return this.planCoreWithOrder(stmt.core, stmt, base, outRegs);

    // Compound: every core writes the same registers.
    const first = this.planCore(stmt.core, base, outRegs, null);
    const regs = first.outRegs;
    let root: Operator = first.root;
    let correlated = first.correlated;
    for (const c of stmt.compound) {
      const next = this.planCore(c.core, base, regs, null);
      if (next.outRegs.length !== regs.length) {
        throw new SmaltError('SMALT_ERROR', `SELECTs to the left and right of ${c.op} do not have the same number of result columns`);
      }
      correlated ||= next.correlated;
      root = new Compound(root, next.root, c.op, regs, first.columns.map((x) => x.collation));
    }
    if (stmt.orderBy.length) {
      const keys: SortKey[] = stmt.orderBy.map((t) => {
        const idx = this.compoundOrderIndex(t, first.columns, stmt.core);
        return { reg: regs[idx], desc: t.desc, nullsFirst: t.nulls ? t.nulls === 'FIRST' : !t.desc, collation: first.columns[idx].collation };
      });
      root = new Sort(root, keys, regs);
    }
    root = this.applyLimit(root, stmt, base);
    return { root, outRegs: regs, columns: first.columns, correlated };
  }

  private registerCtes(w: WithClause, scope: Scope): void {
    if (w.recursive) throw new SmaltError('SMALT_UNSUPPORTED', 'WITH RECURSIVE is not supported yet');
    for (const c of w.ctes) scope.ctes.set(c.name.toLowerCase(), { select: c.select, columns: c.columns });
  }

  private compoundOrderIndex(t: OrderingTerm, cols: ResultColumnInfo[], core: SelectCore): number {
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

  private applyLimit(root: Operator, stmt: SelectStmt, scope: Scope | null): Operator {
    if (!stmt.limit) {
      if (stmt.offset) throw new SmaltError('SMALT_ERROR', 'OFFSET without LIMIT');
      return root;
    }
    const s = this.compileScope(new Scope(scope));
    const lim = compileExpr(stmt.limit, s).fn;
    const off = stmt.offset ? compileExpr(stmt.offset, s).fn : undefined;
    return new Limit(root, lim, off);
  }

  /** Plan a single SELECT core including ORDER BY / LIMIT of the enclosing statement. */
  private planCoreWithOrder(core: SelectCore, stmt: SelectStmt, parent: Scope | null, outRegs?: number[]): QueryPlan {
    const plan = this.planCore(core, parent, outRegs, stmt);
    plan.root = this.applyLimit(plan.root, stmt, parent);
    return plan;
  }

  /**
   * Plan one SELECT core. When `stmt` is given, its ORDER BY is planned too (it may reference
   * source columns that are not in the result).
   */
  private planCore(core: SelectCore, parent: Scope | null, outRegs: number[] | undefined, stmt: SelectStmt | null): QueryPlan {
    if (core.kind === 'values') return this.planValues(core.rows, parent, outRegs, stmt);
    const scope = new Scope(parent);
    let root = this.planFrom(core.from, core.where, scope);

    const resultCols = this.expandResultColumns(core.columns, scope);
    // Select-list aliases are visible (as a fallback) to WHERE-less clauses below.
    scope.aliases = new Map();
    for (const rc of resultCols) if (rc.alias) scope.aliases.set(rc.alias.toLowerCase(), rc.expr);

    const isAgg =
      core.groupBy.length > 0 ||
      core.having !== undefined ||
      resultCols.some((c) => containsAggregate(c.expr)) ||
      (stmt?.orderBy.some((t) => containsAggregate(t.expr)) ?? false);

    let exprScope: CompileScope;
    let agg: { groupFns: Fn[]; groupColls: Collation[]; groupRegs: number[]; aggs: AggSpec[]; bare: Set<number> } | null = null;
    if (isAgg) {
      const baseCompile = this.compileScope(scope);
      const groupCompiled = core.groupBy.map((g) => this.compileGroupTerm(g, scope, resultCols, baseCompile));
      const groupRegs = groupCompiled.map(() => this.regs.alloc());
      const aggs: AggSpec[] = [];
      const aggAsts: CallExpr[] = [];
      const bare = new Set<number>();
      agg = { groupFns: groupCompiled.map((g) => g.fn), groupColls: groupCompiled.map((g) => g.collation), groupRegs, aggs, bare };
      const groupAsts = core.groupBy.map((g) => this.resolveGroupAst(g, resultCols));
      exprScope = {
        ...baseCompile,
        resolveColumn: (e) => {
          const b = baseCompile.resolveColumn(e);
          bare.add(b.reg);
          return b;
        },
        groupRef: (e) => {
          const i = groupAsts.findIndex((g) => exprEquals(g, e));
          if (i < 0) return undefined;
          const c = groupCompiled[i];
          return { reg: groupRegs[i], type: c.type, collation: c.collation, affinity: c.affinity };
        },
        aggregateRef: (call) => {
          const existing = aggAsts.findIndex((a) => exprEquals(a, call));
          if (existing >= 0) return { reg: aggs[existing].outReg, type: 'any', collation: aggs[existing].collation, affinity: 'NONE' };
          const def = aggregateFunctions.get(call.name)!;
          if (call.star && call.name !== 'count') throw new SmaltError('SMALT_ERROR', `wrong number of arguments to function ${call.name}()`);
          const n = call.args.length;
          if (!call.star && (n < def.minArgs || n > def.maxArgs || (call.name === 'count' && n === 0))) {
            throw new SmaltError('SMALT_ERROR', `wrong number of arguments to function ${call.name}()`);
          }
          if (call.args.some(containsAggregate)) throw new SmaltError('SMALT_ERROR', `misuse of aggregate function ${call.name}()`);
          if (call.orderBy?.length) throw new SmaltError('SMALT_UNSUPPORTED', 'ORDER BY inside aggregate functions is not supported yet');
          if (call.distinct && n !== 1) throw new SmaltError('SMALT_ERROR', 'DISTINCT aggregates must have exactly one argument');
          const args = call.args.map((a) => compileExpr(a, baseCompile));
          const argTypes = args.map((a) => a.type);
          const spec: AggSpec = {
            def,
            args: args.map((a) => a.fn),
            argTypes,
            distinct: call.distinct,
            filter: call.filter ? compileExpr(call.filter, baseCompile).fn : undefined,
            outReg: this.regs.alloc(),
            collation: args[0]?.collSrc ? args[0].collation : Collation.Binary,
            star: call.star,
            isMinMax: call.name === 'min' || call.name === 'max',
          };
          aggs.push(spec);
          aggAsts.push(call);
          return { reg: spec.outReg, type: def.resultType(argTypes), collation: spec.collation, affinity: 'NONE' };
        },
      };
    } else {
      exprScope = this.compileScope(scope);
    }

    // Result expressions.
    const compiled = resultCols.map((c) => compileExpr(c.expr, exprScope));
    const regs = outRegs ?? compiled.map(() => this.regs.alloc());
    if (regs.length !== compiled.length) {
      throw new SmaltError('SMALT_ERROR', `SELECTs to the left and right of a compound operator do not have the same number of result columns`);
    }
    const columns: ResultColumnInfo[] = resultCols.map((c, i) => ({
      name: c.name,
      type: compiled[i].type,
      declType: c.declType,
      collation: compiled[i].collSrc !== CollSrc.None ? compiled[i].collation : Collation.Binary,
    }));

    // ORDER BY keys (single core only).
    const sortKeys: SortKey[] = [];
    const extraFns: Fn[] = [];
    const extraRegs: number[] = [];
    if (stmt && stmt.compound.length === 0) {
      for (const t of stmt.orderBy) {
        const idx = this.orderByResultIndex(t.expr, resultCols);
        let reg: number;
        let coll: Collation;
        if (idx >= 0) {
          reg = regs[idx];
          coll = t.expr.kind === 'collate' ? compileExpr(t.expr, exprScope).collation : columns[idx].collation;
        } else {
          const c = compileExpr(t.expr, exprScope);
          reg = this.regs.alloc();
          extraFns.push(c.fn);
          extraRegs.push(reg);
          coll = c.collSrc !== CollSrc.None ? c.collation : Collation.Binary;
        }
        sortKeys.push({ reg, desc: t.desc, nullsFirst: t.nulls ? t.nulls === 'FIRST' : !t.desc, collation: coll });
      }
    }

    let having: Fn | undefined;
    if (core.having) {
      if (!agg) throw new SmaltError('SMALT_ERROR', 'a GROUP BY clause is required before HAVING');
      having = compileExpr(core.having, exprScope).fn;
    }

    if (agg) {
      root = new HashAggregate(root, agg.groupFns, agg.groupColls, agg.groupRegs, agg.aggs, [...agg.bare]);
      if (having) root = new Filter(root, having);
    }

    // ORDER BY rowid elimination for simple scans.
    let sortNeeded = sortKeys.length > 0;
    if (sortNeeded && !agg && !core.distinct && scope.sources.length === 1 && stmt?.orderBy.length === 1) {
      const src = scope.sources[0];
      const term = stmt.orderBy[0];
      const scan = this.lastScan;
      if (scan && src.table && scan.access === src.access && this.rowidRegOf(term.expr, scope) >= 0) {
        if (!term.nulls) {
          scan.reverse = term.desc;
          sortNeeded = false;
        }
      }
    }

    root = new Project(root, [...compiled.map((c) => c.fn), ...extraFns], [...regs, ...extraRegs]);
    if (core.distinct) root = new Distinct(root, regs, columns.map((c) => c.collation));
    if (sortNeeded) {
      const limitHint = stmt?.limit ? this.topNHint(stmt, parent) : undefined;
      root = new Sort(root, sortKeys, [...regs, ...extraRegs], limitHint);
    }
    return { root, outRegs: regs, columns, correlated: scope.correlated };
  }

  /** Register of the rowid if `e` names the rowid of the single source, else -1. */
  private rowidRegOf(e: Expr, scope: Scope): number {
    if (e.kind !== 'column') return -1;
    const src = scope.sources[0];
    if (e.table && !sameName(e.table, src.name)) return -1;
    const t = src.table!;
    const ci = findColumn(t, e.name);
    if (ci >= 0) return ci === t.rowidAlias ? src.rowidReg : -1;
    return ROWID_NAMES.has(e.name.toLowerCase()) ? src.rowidReg : -1;
  }

  private topNHint(stmt: SelectStmt, parent: Scope | null): ((r: SqlValue[]) => number) | undefined {
    const s = this.compileScope(new Scope(parent));
    const lim = compileExpr(stmt.limit!, s).fn;
    const off = stmt.offset ? compileExpr(stmt.offset, s).fn : undefined;
    return (r) => {
      const l = Limit.evalCount(lim, r, -1);
      if (l < 0) return -1;
      return l + Math.max(0, Limit.evalCount(off, r, 0));
    };
  }

  private orderByResultIndex(e: Expr, cols: { alias?: string; expr: Expr; name: string }[]): number {
    let inner = e;
    if (inner.kind === 'collate') inner = inner.expr;
    if (inner.kind === 'literal' && typeof inner.value === 'number' && Number.isInteger(inner.value)) {
      if (inner.value < 1 || inner.value > cols.length) throw new SmaltError('SMALT_ERROR', `ORDER BY term out of range - should be between 1 and ${cols.length}`);
      return inner.value - 1;
    }
    if (inner.kind === 'column' && !inner.table) {
      const i = cols.findIndex((c) => c.alias !== undefined && sameName(c.alias, (inner as ColumnExpr).name));
      if (i >= 0) return i;
    }
    return cols.findIndex((c) => exprEquals(c.expr, inner));
  }

  /** GROUP BY term: integer literal or alias refers to a result column. */
  private resolveGroupAst(g: Expr, cols: { alias?: string; expr: Expr }[]): Expr {
    if (g.kind === 'literal' && typeof g.value === 'number' && Number.isInteger(g.value)) {
      if (g.value < 1 || g.value > cols.length) throw new SmaltError('SMALT_ERROR', `GROUP BY term out of range - should be between 1 and ${cols.length}`);
      return cols[g.value - 1].expr;
    }
    return g;
  }

  private compileGroupTerm(g: Expr, scope: Scope, cols: { alias?: string; expr: Expr }[], cs: CompileScope): Compiled {
    const ast = this.resolveGroupAst(g, cols);
    if (containsAggregate(ast)) throw new SmaltError('SMALT_ERROR', 'aggregate functions are not allowed in the GROUP BY clause');
    void scope;
    const c = compileExpr(ast, cs);
    return { ...c, collation: c.collSrc !== CollSrc.None ? c.collation : Collation.Binary };
  }

  private planValues(rows: Expr[][], parent: Scope | null, outRegs: number[] | undefined, stmt: SelectStmt | null): QueryPlan {
    const width = rows[0].length;
    for (const r of rows) if (r.length !== width) throw new SmaltError('SMALT_ERROR', 'all VALUES must have the same number of terms');
    const scope = new Scope(parent);
    const cs = this.compileScope(scope);
    const compiled = rows.map((r) => r.map((e) => compileExpr(e, cs)));
    const regs = outRegs ?? compiled[0].map(() => this.regs.alloc());
    const columns: ResultColumnInfo[] = compiled[0].map((c, i) => ({ name: `column${i + 1}`, type: c.type, collation: Collation.Binary }));
    let root: Operator = new Values(compiled.map((r) => r.map((c) => c.fn)), regs);
    if (stmt && stmt.compound.length === 0 && stmt.orderBy.length) {
      const keys = stmt.orderBy.map((t) => {
        const idx = this.compoundOrderIndex(t, columns, { kind: 'values', rows, pos: 0, end: 0 } as SelectCore);
        return { reg: regs[idx], desc: t.desc, nullsFirst: t.nulls ? t.nulls === 'FIRST' : !t.desc, collation: Collation.Binary };
      });
      root = new Sort(root, keys, regs);
    }
    return { root, outRegs: regs, columns, correlated: scope.correlated };
  }

  private expandResultColumns(cols: ResultColumn[], scope: Scope): { expr: Expr; name: string; alias?: string; declType?: string }[] {
    const out: { expr: Expr; name: string; alias?: string; declType?: string }[] = [];
    for (const rc of cols) {
      if (rc.kind === 'star' || rc.kind === 'tableStar') {
        if (scope.sources.length === 0) throw new SmaltError('SMALT_ERROR', 'no tables specified');
        let found = false;
        for (const src of scope.sources) {
          if (rc.kind === 'tableStar' && !sameName(src.name, rc.table)) continue;
          found = true;
          for (const c of src.cols) {
            if (rc.kind === 'star' && src.hidden.has(c.name.toLowerCase())) continue;
            out.push({
              expr: { kind: 'column', table: src.name, name: c.name, pos: rc.pos, end: rc.end },
              name: c.name,
              declType: c.declType || undefined,
            });
          }
        }
        if (!found) throw new SmaltError('SMALT_ERROR', `no such table: ${(rc as { table: string }).table}`);
      } else {
        const e = rc.expr;
        let name = rc.alias;
        let declType: string | undefined;
        if (e.kind === 'column') {
          name ??= e.name;
          const b = this.peekColumn(e, scope);
          declType = b?.declType || undefined;
        }
        name ??= this.sqlText.slice(e.pos, e.end);
        out.push({ expr: e, name, alias: rc.alias, declType });
      }
    }
    return out;
  }

  /** Source SQL text, used to name result columns. Set by the caller before planning. */
  sqlText = '';

  private peekColumn(e: ColumnExpr, scope: Scope): SourceColumn | undefined {
    for (const s of scope.sources) {
      if (e.table && !sameName(e.table, s.name)) continue;
      const c = s.cols.find((c) => sameName(c.name, e.name));
      if (c) return c;
    }
    return undefined;
  }

  // ================================================================ FROM / WHERE

  /** The full scan chosen for the first source (for ORDER BY elimination); reset per FROM. */
  private lastScan: TableScan | null = null;

  /** Plan FROM + WHERE into an operator tree; registers sources in `scope`. */
  planFrom(from: FromItem | undefined, where: Expr | undefined, scope: Scope): Operator {
    this.lastScan = null;
    if (!from) {
      let root: Operator = new SingleRow();
      if (where) root = new Filter(root, compileExpr(where, this.compileScope(scope)).fn);
      return root;
    }
    const items: { item: FromItem; joinType: JoinType; on?: Expr; using?: string[]; natural: boolean }[] = [];
    this.flattenFrom(from, 'INNER', undefined, undefined, false, items);
    for (const it of items) this.addSource(it.item, it.joinType, scope);

    // USING / NATURAL become equality conjuncts in the ON clause.
    items.forEach((it, p) => {
      const src = scope.sources[p];
      if (it.on) src.on.push(...conjuncts(it.on));
      let using = it.using;
      if (it.natural) {
        using = src.cols
          .filter((c) => scope.sources.slice(0, p).some((s) => s.cols.some((x) => sameName(x.name, c.name) && !s.hidden.has(x.name.toLowerCase()))))
          .map((c) => c.name);
      }
      for (const name of using ?? []) {
        const left = scope.sources.slice(0, p).find((s) => s.cols.some((c) => sameName(c.name, name)) && !s.hidden.has(name.toLowerCase()));
        if (!left || !src.cols.some((c) => sameName(c.name, name))) {
          throw new SmaltError('SMALT_ERROR', `cannot join using column ${name} - column not present in both tables`);
        }
        src.hidden.add(name.toLowerCase());
        src.on.push({
          kind: 'binary',
          op: '=',
          left: { kind: 'column', table: left.name, name, pos: 0, end: 0 },
          right: { kind: 'column', table: src.name, name, pos: 0, end: 0 },
          pos: 0,
          end: 0,
        });
      }
    });

    const pool: ConjunctInfo[] = [];
    const addPool = (e: Expr): void => {
      for (const c of splitBetween(e)) pool.push({ expr: c, deps: this.deps(c, scope), placed: false });
    };
    for (const c of conjuncts(where)) addPool(c);
    for (const src of scope.sources) if (src.joinType !== 'LEFT') for (const c of src.on) addPool(c);

    const cs = this.compileScope(scope);
    let root: Operator | null = null;
    for (let p = 0; p < scope.sources.length; p++) {
      const src = scope.sources[p];
      const isLeft = src.joinType === 'LEFT';
      const onInfos: ConjunctInfo[] = isLeft ? src.on.flatMap((e) => splitBetween(e)).map((e) => ({ expr: e, deps: this.deps(e, scope), placed: false })) : [];
      const candidates = (isLeft ? onInfos : pool).filter((c) => !c.placed && c.deps !== null && c.deps.has(p) && maxDep(c.deps) === p);
      const access = this.chooseAccess(src, p, candidates, scope, cs);
      if (p === 0 && access.scan) this.lastScan = access.scan;

      // Filters local to this source (depend only on it and outer scopes).
      let leaf = access.leaf;
      const local = candidates.filter((c) => c.deps!.size === 1);
      for (const c of local) {
        leaf = new Filter(leaf, compileExpr(c.expr, cs).fn);
        c.placed = true;
      }

      if (root === null) {
        root = leaf;
      } else {
        const innerRegs = (): number[] => this.sourceRegs(src);
        const rest = isLeft ? onInfos.filter((c) => !c.placed) : [];
        if (access.dependsOnOuter) {
          root = new NestedLoopJoin(root, leaf, isLeft, innerRegs, this.andAll(rest, cs));
          rest.forEach((c) => (c.placed = true));
        } else {
          const eqs = (isLeft ? onInfos : pool).filter((c) => !c.placed && c.deps !== null && c.deps.has(p) && maxDep(c.deps) === p && c.deps.size > 1);
          const hash = this.hashKeys(eqs, p, scope, cs);
          if (hash) {
            hash.used.forEach((c) => (c.placed = true));
            const residual = isLeft ? rest.filter((c) => !c.placed) : [];
            residual.forEach((c) => (c.placed = true));
            const correlated = scope.correlated;
            root = new HashJoin(root, leaf, hash.build, hash.probe, hash.colls, innerRegs, isLeft, this.env.state, correlated, this.andAll(residual, cs));
          } else {
            // Re-running an uncorrelated derived table per outer row is wasteful: cache its rows.
            const inner = src.sub && !src.sub.correlated ? new Materialize(leaf, innerRegs, this.env.state, false) : leaf;
            root = new NestedLoopJoin(root, inner, isLeft, innerRegs, this.andAll(rest, cs));
            rest.forEach((c) => (c.placed = true));
          }
        }
      }
      // Remaining WHERE / inner-ON conjuncts whose dependencies are now all available.
      for (const c of pool) {
        if (c.placed || c.deps === null || c.deps.size === 0 || maxDep(c.deps) !== p) continue;
        root = new Filter(root, compileExpr(c.expr, cs).fn);
        c.placed = true;
      }
    }
    // Constant / correlated-only / subquery conjuncts.
    for (const c of pool) {
      if (c.placed) continue;
      root = new Filter(root!, compileExpr(c.expr, cs).fn);
      c.placed = true;
    }
    return root!;
  }

  private andAll(cs: ConjunctInfo[], scope: CompileScope): Fn | undefined {
    if (cs.length === 0) return undefined;
    const fns = cs.map((c) => compileExpr(c.expr, scope).fn);
    if (fns.length === 1) return fns[0];
    return (r) => {
      let sawNull = false;
      for (const f of fns) {
        const t = truthy(f(r));
        if (t === false) return 0;
        if (t === null) sawNull = true;
      }
      return sawNull ? null : 1;
    };
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
      if (item.joinType === 'RIGHT' || item.joinType === 'FULL') throw new SmaltError('SMALT_UNSUPPORTED', `${item.joinType} JOIN is not supported yet`);
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

  private addSource(item: FromItem, joinType: JoinType, scope: Scope): void {
    const position = scope.sources.length;
    if (item.kind === 'function') throw new SmaltError('SMALT_UNSUPPORTED', `table-valued function ${item.name}() is not supported yet`);
    if (item.kind === 'subquery' || (item.kind === 'table' && !item.schema && scope.findCte(item.name))) {
      let select: SelectStmt;
      let names: string[] | undefined;
      let alias: string | undefined;
      if (item.kind === 'subquery') {
        select = item.select;
        alias = item.alias;
      } else {
        const cte = scope.findCte(item.name)!;
        select = cte.select;
        names = cte.columns;
        alias = item.alias ?? item.name;
      }
      const sub = this.planSelect(select, scope.parent, undefined);
      if (sub.correlated) scope.correlated = true;
      if (names && names.length !== sub.columns.length) {
        throw new SmaltError('SMALT_ERROR', `table ${alias} has ${sub.columns.length} values for ${names.length} columns`);
      }
      const cols: SourceColumn[] = sub.columns.map((c, i) => ({
        name: names ? names[i] : c.name,
        reg: sub.outRegs[i],
        type: c.type,
        collation: c.collation,
        affinity: 'NONE',
        declType: c.declType ?? '',
        index: i,
      }));
      scope.sources.push({ name: alias ?? `(subquery-${position + 1})`, cols, rowidReg: -1, sub, joinType, on: [], hidden: new Set(), position });
      return;
    }
    if (item.kind === 'join') throw new SmaltError('SMALT_ERROR', 'unexpected join');
    if (item.schema && !['main', 'temp'].includes(item.schema.toLowerCase())) throw new SmaltError('SMALT_ERROR', `unknown database ${item.schema}`);
    const table = this.env.getTable(item.name);
    if (!table) throw new SmaltError('SMALT_ERROR', `no such table: ${item.name}`);
    const base = this.regs.alloc(table.columns.length + 1);
    const access = new TableAccess(this.env.openTree(table.rootPage), new RecordReader(table.layout, table.recordDefaults), table.name, table.rowidAlias);
    const cols: SourceColumn[] = table.columns.map((c, i) => ({
      name: c.name,
      reg: base + i,
      type: c.rowidAlias ? 'int' : staticTypeOfStorage(c.type),
      collation: c.collation,
      affinity: affinityOfStorage(c.type),
      declType: c.declaredType,
      index: i,
    }));
    const src: Source = {
      name: item.alias ?? table.name,
      table,
      access,
      cols,
      rowidReg: table.rowidAlias >= 0 ? base + table.rowidAlias : base + table.columns.length,
      joinType,
      on: [],
      hidden: new Set(),
      position,
    };
    for (const s of scope.sources) {
      if (sameName(s.name, src.name)) throw new SmaltError('SMALT_ERROR', `ambiguous table name: ${src.name}`);
    }
    scope.sources.push(src);
  }

  private sourceRegs(src: Source): number[] {
    if (src.access) return src.access.registers();
    return src.cols.map((c) => c.reg);
  }

  /** Current-scope sources referenced by an expression (null when it contains a subquery). */
  private deps(e: Expr, scope: Scope): Set<number> | null {
    if (hasSubquery(e)) return null;
    const out = new Set<number>();
    walk(e, (x) => {
      if (x.kind === 'column') {
        const p = this.findSourcePosition(x, scope);
        if (p >= 0) out.add(p);
      }
    });
    return out;
  }

  private findSourcePosition(e: ColumnExpr, scope: Scope): number {
    if (e.table) {
      const s = scope.sources.find((s) => sameName(s.name, e.table!));
      return s ? s.position : -1;
    }
    const matches = scope.sources.filter((s) => !s.hidden.has(e.name.toLowerCase()) && s.cols.some((c) => sameName(c.name, e.name)));
    if (matches.length >= 1) return matches[0].position;
    if (ROWID_NAMES.has(e.name.toLowerCase())) {
      const t = scope.sources.filter((s) => s.table);
      if (t.length === 1) return t[0].position;
    }
    return -1;
  }

  // ---------------------------------------------------------------- access paths

  private chooseAccess(src: Source, p: number, candidates: ConjunctInfo[], scope: Scope, cs: CompileScope): AccessChoice {
    if (src.sub) {
      return { leaf: src.sub.root, dependsOnOuter: src.sub.correlated };
    }
    const table = src.table!;
    const access = src.access!;
    type Probe = { op: string; other: Expr; deps: Set<number>; col: number | 'rowid'; colExpr: Expr; conj: ConjunctInfo; list?: Expr[] };
    const probes: Probe[] = [];
    for (const c of candidates) {
      const e = c.expr;
      if (e.kind === 'inList' && !e.not) {
        const col = this.columnOf(e.expr, src, scope);
        if (col === 'rowid' && e.list.length > 0) {
          const listDeps = new Set<number>();
          let ok = true;
          for (const x of e.list) {
            const d = this.deps(x, scope);
            if (d === null || d.has(p)) ok = false;
            else d.forEach((v) => listDeps.add(v));
          }
          if (ok) probes.push({ op: 'in', other: e.list[0], deps: listDeps, col, colExpr: e.expr, conj: c, list: e.list });
        }
        continue;
      }
      if (e.kind !== 'binary' || !['=', '<', '<=', '>', '>=', 'IS'].includes(e.op)) continue;
      for (const [colSide, otherSide, flip] of [
        [e.left, e.right, false],
        [e.right, e.left, true],
      ] as const) {
        const col = this.columnOf(colSide, src, scope);
        if (col === null) continue;
        const d = this.deps(otherSide, scope);
        if (d === null || d.has(p)) continue;
        const op = e.op === 'IS' ? 'IS' : flip ? flipOp(e.op) : e.op;
        probes.push({ op, other: otherSide, deps: d, col, colExpr: colSide, conj: c });
        break;
      }
    }

    const outerDep = (list: Probe[]): boolean => list.some((x) => x.deps.size > 0);
    let best: { score: number; build: () => AccessChoice } = {
      score: 0,
      build: () => {
        const scan = new TableScan(access);
        return { leaf: scan, dependsOnOuter: false, scan };
      },
    };
    const consider = (score: number, build: () => AccessChoice): void => {
      if (score > best.score) best = { score, build };
    };

    // Rowid equality / IN / range.
    for (const pr of probes) {
      if (pr.col !== 'rowid') continue;
      if (pr.op === '=') {
        consider(100, () => {
          const leaf = new RowidLookup(access, [compileExpr(pr.other, cs).fn]);
          return { leaf, dependsOnOuter: pr.deps.size > 0 };
        });
      } else if (pr.op === 'in') {
        consider(95, () => ({ leaf: new RowidLookup(access, pr.list!.map((x) => compileExpr(x, cs).fn)), dependsOnOuter: pr.deps.size > 0 }));
      }
    }
    const rowidRange = probes.filter((x) => x.col === 'rowid' && ['<', '<=', '>', '>='].includes(x.op));
    if (rowidRange.length) {
      const lo = rowidRange.find((x) => x.op === '>' || x.op === '>=');
      const hi = rowidRange.find((x) => x.op === '<' || x.op === '<=');
      consider(40, () => {
        const scan = new TableScan(
          access,
          lo ? { fn: compileExpr(lo.other, cs).fn, inclusive: lo.op === '>=' } : undefined,
          hi ? { fn: compileExpr(hi.other, cs).fn, inclusive: hi.op === '<=' } : undefined,
        );
        return { leaf: scan, dependsOnOuter: outerDep([lo, hi].filter((x): x is Probe => !!x)), scan };
      });
    }

    // Secondary indexes.
    for (const idx of table.indexes) {
      if (idx.where) continue; // partial indexes: not used by the M1 planner
      const eqs: Probe[] = [];
      const converters: ((v: SqlValue) => SqlValue)[] = [];
      const usable = (pr: Probe, ic: { column: number; collation: Collation }): ((v: SqlValue) => SqlValue) | null => {
        if (pr.col !== ic.column) return null;
        const colC = compileExpr(pr.colExpr, cs);
        const otherC = compileExpr(pr.other, cs);
        if (comparisonCollation(colC, otherC) !== ic.collation) return null;
        const [convCol, convOther] = comparisonConverters(colC, otherC);
        if (convCol) return null;
        return convOther ?? ((v) => v);
      };
      let k = 0;
      for (; k < idx.columns.length; k++) {
        const ic = idx.columns[k];
        let found = false;
        for (const pr of probes) {
          if (pr.op !== '=') continue;
          const conv = usable(pr, ic);
          if (conv) {
            eqs.push(pr);
            converters.push(conv);
            found = true;
            break;
          }
        }
        if (!found) break;
      }
      let lo: Probe | undefined;
      let hi: Probe | undefined;
      let rangeConv: ((v: SqlValue) => SqlValue) | undefined;
      if (k < idx.columns.length && !idx.columns[k].desc) {
        const ic = idx.columns[k];
        for (const pr of probes) {
          if (!['<', '<=', '>', '>='].includes(pr.op)) continue;
          const conv = usable(pr, ic);
          if (!conv) continue;
          if ((pr.op === '>' || pr.op === '>=') && !lo) {
            lo = pr;
            rangeConv = conv;
          } else if ((pr.op === '<' || pr.op === '<=') && !hi) {
            hi = pr;
            rangeConv = conv;
          }
        }
      }
      if (k === 0 && !lo && !hi) continue;
      const unique = idx.unique && k === idx.columns.length;
      const score = unique ? 90 : k > 0 ? 50 + k * 5 + (lo || hi ? 2 : 0) : 30;
      consider(score, () => {
        const spec = {
          indexName: idx.name,
          tree: this.env.openTree(idx.rootPage),
          columns: idx.columns.map((c) => ({ desc: c.desc, collation: c.collation })),
          eq: eqs.map((x) => compileExpr(x.other, cs).fn),
          lo: lo ? { fn: compileExpr(lo.other, cs).fn, inclusive: lo.op === '>=' } : undefined,
          hi: hi ? { fn: compileExpr(hi.other, cs).fn, inclusive: hi.op === '<=' } : undefined,
          convert: [...converters, ...(rangeConv ? [rangeConv] : [])],
        };
        return { leaf: new IndexScan(access, spec), dependsOnOuter: outerDep([...eqs, ...(lo ? [lo] : []), ...(hi ? [hi] : [])]) };
      });
    }
    return best.build();
  }

  /** If `e` is a plain reference to a column of `src`, return its column index or 'rowid'. */
  private columnOf(e: Expr, src: Source, scope: Scope): number | 'rowid' | null {
    if (e.kind !== 'column' || !src.table) return null;
    if (this.findSourcePosition(e, scope) !== src.position) return null;
    const ci = findColumn(src.table, e.name);
    if (ci >= 0) return ci === src.table.rowidAlias ? 'rowid' : ci;
    return ROWID_NAMES.has(e.name.toLowerCase()) ? 'rowid' : null;
  }

  private hashKeys(
    eqs: ConjunctInfo[],
    p: number,
    scope: Scope,
    cs: CompileScope,
  ): { build: Fn[]; probe: Fn[]; colls: Collation[]; used: ConjunctInfo[] } | null {
    const build: Fn[] = [];
    const probe: Fn[] = [];
    const colls: Collation[] = [];
    const used: ConjunctInfo[] = [];
    for (const c of eqs) {
      const e = c.expr;
      if (e.kind !== 'binary' || e.op !== '=') continue;
      const dl = this.deps(e.left, scope);
      const dr = this.deps(e.right, scope);
      if (!dl || !dr) continue;
      let inner: Expr;
      let outer: Expr;
      if (dl.size === 1 && dl.has(p) && !dr.has(p) && dr.size > 0) {
        inner = e.left;
        outer = e.right;
      } else if (dr.size === 1 && dr.has(p) && !dl.has(p) && dl.size > 0) {
        inner = e.right;
        outer = e.left;
      } else continue;
      const ic = compileExpr(inner, cs);
      const oc = compileExpr(outer, cs);
      // Use the comparison's own affinity/collation rules on both sides.
      const leftC = inner === e.left ? ic : oc;
      const rightC = inner === e.left ? oc : ic;
      const [convL, convR] = comparisonConverters(leftC, rightC);
      const convI = inner === e.left ? convL : convR;
      const convO = inner === e.left ? convR : convL;
      const fi = ic.fn;
      const fo = oc.fn;
      build.push(convI ? (r) => convI(fi(r)) : fi);
      probe.push(convO ? (r) => convO(fo(r)) : fo);
      colls.push(comparisonCollation(leftC, rightC));
      used.push(c);
    }
    return used.length ? { build, probe, colls, used } : null;
  }

  // ================================================================ expression scope

  compileScope(scope: Scope): CompileScope {
    return {
      resolveColumn: (e) => this.resolveColumn(e, scope),
      scalarSubquery: (select) => this.scalarSubquery(select, scope),
      existsSubquery: (select) => this.existsSubquery(select, scope),
      inSubquery: (select, probe) => this.inSubquery(select, probe, scope),
      funcCtx: this.env.funcCtx,
    };
  }

  /** Create a fresh top-level scope (for DML and utility statements). */
  newScope(parent: Scope | null = null): Scope {
    return new Scope(parent);
  }

  private resolveColumn(e: ColumnExpr, scope: Scope): ColumnBinding {
    let depth = 0;
    for (let s: Scope | null = scope; s; s = s.parent, depth++) {
      const b = this.resolveIn(e, s);
      if (b) {
        if (depth > 0) for (let t: Scope | null = scope; t && t !== s; t = t.parent) t.correlated = true;
        return b;
      }
    }
    // Fallback: a select-list alias (SQLite allows aliases in WHERE/GROUP BY/HAVING).
    if (!e.table) {
      const key = e.name.toLowerCase();
      for (let s: Scope | null = scope; s; s = s.parent) {
        const aliased = s.aliases?.get(key);
        if (aliased && !this.expandingAliases.has(key)) {
          this.expandingAliases.add(key);
          try {
            const c = compileExpr(aliased, this.compileScope(s));
            return { reg: -1, type: c.type, collation: c.collation, affinity: c.affinity, compiled: c };
          } finally {
            this.expandingAliases.delete(key);
          }
        }
      }
    }
    const name = e.table ? `${e.table}.${e.name}` : e.name;
    throw new SmaltError('SMALT_ERROR', `no such column: ${name}`);
  }

  private readonly expandingAliases = new Set<string>();

  private resolveIn(e: ColumnExpr, scope: Scope): ColumnBinding | undefined {
    const bind = (src: Source, c: SourceColumn): ColumnBinding => {
      if (src.access) src.access.use(c.index, c.reg);
      return { reg: c.reg, type: c.type, collation: c.collation, affinity: c.affinity };
    };
    const rowidOf = (src: Source): ColumnBinding => {
      src.access!.useRowid(src.rowidReg);
      return { reg: src.rowidReg, type: 'int', collation: Collation.Binary, affinity: 'INTEGER' };
    };
    if (e.table) {
      const src = scope.sources.find((s) => sameName(s.name, e.table!));
      if (!src) return undefined;
      const c = src.cols.find((c) => sameName(c.name, e.name));
      if (c) return bind(src, c);
      if (src.table && ROWID_NAMES.has(e.name.toLowerCase())) return rowidOf(src);
      throw new SmaltError('SMALT_ERROR', `no such column: ${e.table}.${e.name}`);
    }
    let found: { src: Source; c: SourceColumn } | undefined;
    for (const src of scope.sources) {
      if (src.hidden.has(e.name.toLowerCase())) continue;
      const c = src.cols.find((c) => sameName(c.name, e.name));
      if (!c) continue;
      if (found) throw new SmaltError('SMALT_ERROR', `ambiguous column name: ${e.name}`);
      found = { src, c };
    }
    if (found) return bind(found.src, found.c);
    if (ROWID_NAMES.has(e.name.toLowerCase())) {
      const tables = scope.sources.filter((s) => s.table);
      if (tables.length === 1) return rowidOf(tables[0]);
      if (tables.length > 1) throw new SmaltError('SMALT_ERROR', `ambiguous column name: ${e.name}`);
    }
    return undefined;
  }

  // ---------------------------------------------------------------- subqueries

  private scalarSubquery(select: SelectStmt, scope: Scope): Compiled {
    const plan = this.planSelect(select, scope);
    if (plan.outRegs.length !== 1) throw new SmaltError('SMALT_ERROR', `sub-select returns ${plan.outRegs.length} columns - expected 1`);
    if (plan.correlated) scope.correlated = scope.correlated || this.isCorrelatedBeyond(scope);
    const out = plan.outRegs[0];
    const state = this.env.state;
    let epoch = -1;
    let cached: SqlValue = null;
    const root = plan.root;
    const correlated = plan.correlated;
    const fn: Fn = (r) => {
      if (!correlated && epoch === state.epoch) return cached;
      root.open(r);
      const v = root.next() ? r[out] : null;
      root.close();
      if (!correlated) {
        cached = v;
        epoch = state.epoch;
      }
      return v;
    };
    const col = plan.columns[0];
    return { fn, type: col.type, collation: col.collation, collSrc: col.collation ? CollSrc.Column : CollSrc.None, affinity: 'NONE', constant: false };
  }

  /** True if any parent scope of `scope` exists (correlation can propagate through it). */
  private isCorrelatedBeyond(scope: Scope): boolean {
    return scope.correlated;
  }

  private existsSubquery(select: SelectStmt, scope: Scope): Fn {
    const plan = this.planSelect(select, scope);
    const state = this.env.state;
    let epoch = -1;
    let cached: SqlValue = 0;
    const root = plan.root;
    const correlated = plan.correlated;
    return (r) => {
      if (!correlated && epoch === state.epoch) return cached;
      root.open(r);
      const v = root.next() ? 1 : 0;
      root.close();
      if (!correlated) {
        cached = v;
        epoch = state.epoch;
      }
      return v;
    };
  }

  private inSubquery(select: SelectStmt, probe: Compiled, scope: Scope): Fn {
    const plan = this.planSelect(select, scope);
    if (plan.outRegs.length !== 1) throw new SmaltError('SMALT_ERROR', `sub-select returns ${plan.outRegs.length} columns - expected 1`);
    const out = plan.outRegs[0];
    const col = plan.columns[0];
    const colC: Compiled = { fn: () => null, type: col.type, collation: col.collation, collSrc: col.collation ? CollSrc.Column : CollSrc.None, affinity: 'NONE', constant: false };
    const coll = comparisonCollation(probe, colC);
    const [convProbe, convCol] = comparisonConverters(probe, colC);
    const state = this.env.state;
    let epoch = -1;
    let set = new Set<unknown>();
    let hasNull = false;
    const root = plan.root;
    const correlated = plan.correlated;
    const pf = probe.fn;
    return (r) => {
      if (correlated || epoch !== state.epoch) {
        set = new Set();
        hasNull = false;
        root.open(r);
        while (root.next()) {
          let v = r[out];
          if (v === null) {
            hasNull = true;
            continue;
          }
          if (convCol) v = convCol(v);
          set.add(hashKey(v, coll));
        }
        root.close();
        epoch = state.epoch;
      }
      let v = pf(r);
      if (v === null) return set.size === 0 && !hasNull ? 0 : null;
      if (convProbe) v = convProbe(v);
      if (set.has(hashKey(v, coll))) return 1;
      return hasNull ? null : 0;
    };
  }
}

function maxDep(d: Set<number>): number {
  let m = -1;
  for (const x of d) if (x > m) m = x;
  return m;
}

function flipOp(op: string): string {
  switch (op) {
    case '<':
      return '>';
    case '<=':
      return '>=';
    case '>':
      return '<';
    case '>=':
      return '<=';
    default:
      return op;
  }
}

/** `x BETWEEN a AND b` becomes `x >= a AND x <= b` so each bound can drive an access path. */
function splitBetween(e: Expr): Expr[] {
  if (e.kind === 'between' && !e.not) {
    return [
      { kind: 'binary', op: '>=', left: e.expr, right: e.low, pos: e.pos, end: e.end },
      { kind: 'binary', op: '<=', left: e.expr, right: e.high, pos: e.pos, end: e.end },
    ];
  }
  return [e];
}

export type { Scope };
