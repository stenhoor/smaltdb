import type { TableStats } from './stats.js';
import { flattenCore } from './flatten.js';
import { type FrameSpec, NAVIGATION, RANKING, WINDOW_ARITY, Window, type WindowCallKind, type WindowDef } from './window.js';

let flattenOff: boolean | undefined;
/** SMALT_NO_FLATTEN=1 disables query flattening (tests compare both paths). */
function flattenDisabledCheck(): boolean {
  if (flattenOff === undefined) {
    const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
    flattenOff = !!g.process?.env?.SMALT_NO_FLATTEN;
  }
  return flattenOff;
}
const flatteningDisabled = flattenDisabledCheck;
let decorrelateOff: boolean | undefined;
/** SMALT_NO_DECORRELATE=1 disables subquery decorrelation (tests compare both paths). */
function decorrelationDisabled(): boolean {
  if (decorrelateOff === undefined) {
    const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
    decorrelateOff = !!g.process?.env?.SMALT_NO_DECORRELATE;
  }
  return decorrelateOff;
}
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
  SelectCoreSelect,
  SelectStmt,
  WindowSpec,
  WithClause,
} from '../sql/ast.js';
import { type BTree, BTreeCursor } from '../storage/btree.js';
import { KEY_AFTER_NULL, decodeKey, rowidSuffixStart } from '../storage/key-codec.js';
import { RecordReader } from '../storage/record.js';
import { Collation, type SqlValue } from '../values.js';
import { type Affinity, type StaticType, affinityOfStorage, hashKey, hashKeyMulti, staticTypeOfStorage, truthy } from './convert.js';
import {
  CollSrc,
  type ColumnBinding,
  type CompileScope,
  type Compiled,
  type Fn,
  compileExpr,
  compileNode,
  comparisonCollation,
  comparisonConverters,
  conjuncts,
} from './expr.js';
import { type AggregateState, type FunctionContext, aggregateFunctions, scalarFunctions } from './functions.js';
import { type ColumnarHelpers, type FusedAggSpec, type FusedHelpers, type PipelineSource, codegenEnabled, generateFusedAggregate, generateGroupAggregate, generateScanFilter } from './codegen.js';
import { CODEGEN_HELPERS_FOR_FUSION } from './expr.js';
import type { Frame } from '../storage/pager.js';
import { PH_RIGHT } from '../storage/format.js';

const FUSABLE_AGGS = new Set(['count', 'sum', 'total', 'avg', 'min', 'max']);
import {
  type AggSpec,
  Compound,
  ColumnScan,
  CountRows,
  Distinct,
  type ExecState,
  Filter,
  FusedGroupAggregate,
  FusedScanAggregate,
  FusedScanFilter,
  HashAggregate,
  HashJoin,
  IndexScan,
  Limit,
  Materialize,
  NestedLoopJoin,
  OuterJoin,
  type Operator,
  Project,
  RowidLookup,
  SingleRow,
  Sort,
  type SortKey,
  TableAccess,
  TableScan,
  Values,
  RecursiveCte,
  VirtualScan,
  WorkingScan,
  type ZonePredicate,
} from './operators.js';
import { type ColumnStore, ROW_GROUP_ROWS, zoneMayMatch } from '../storage/columnar.js';

export interface PlannerEnv {
  getTable(name: string): TableSchema | undefined;
  /**
   * Virtual tables: `information_schema.<name>` (schema 'information_schema') and table-valued
   * functions such as `pragma_table_info(t)` (schema undefined). Rows are computed at open.
   */
  virtualTable?(schema: string | undefined, name: string): { columns: { name: string; type: StaticType }[]; rows: (args: SqlValue[]) => SqlValue[][] } | undefined;
  /** A view's definition, expanded where the view is referenced. */
  getView?(name: string): { name: string; sql: string; columns?: string[]; select: SelectStmt } | undefined;
  openTree(rootPage: number): BTree;
  /** On-demand statistics for a table without ANALYZE results (sampled; cached by the database). */
  sampledStats?(table: TableSchema): TableStats | undefined;
  /** Reader for a columnar materialized view's segments. */
  columnStore?(table: TableSchema): ColumnStore;
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
  /** Affinity carried by derived-table columns (SQLite propagates column affinity). */
  affinity: Affinity;
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
  /** Table-valued function whose arguments read earlier sources of the same FROM (re-run per row). */
  lateral?: boolean;
  /** `INDEXED BY name` (string) / `NOT INDEXED` (null). */
  indexedBy?: string | null;
  joinType: JoinType;
  on: Expr[];
  /** Lower-cased column names merged by USING/NATURAL (hidden from unqualified lookup and *). */
  hidden: Set<string>;
  position: number;
  /** Cached row-count estimate. */
  estRows?: number;
}

/** A CTE visible in a scope. `working` marks the self-reference inside a recursive step. */
interface CteEntry {
  select: SelectStmt;
  columns?: string[];
  recursive?: boolean;
  working?: { scan: WorkingScan; regs: number[]; columns: ResultColumnInfo[] };
}

const ROWID_NAMES = new Set(['rowid', 'oid', '_rowid_']);

class Scope {
  sources: Source[] = [];
  correlated = false;
  /** Select-list aliases usable as a fallback in WHERE/GROUP BY/HAVING/ORDER BY. */
  aliases: Map<string, Expr> | null = null;
  ctes = new Map<string, CteEntry>();
  constructor(readonly parent: Scope | null) {}

  findCte(name: string): CteEntry | undefined {
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
  /** RIGHT/FULL JOIN: earliest step (FROM position) at which this WHERE conjunct may be applied. */
  minStep?: number;
}

interface AccessChoice {
  leaf: Operator;
  /** Leaf probes depend on earlier sources (must be re-opened per outer row). */
  dependsOnOuter: boolean;
  /** Supports ORDER BY rowid elimination. */
  scan?: TableScan;
  /** Conjuncts the access path enforces exactly (an index probe's equalities and range bounds): not re-checked. */
  consumed?: ConjunctInfo[];
}

/** One way to read a source, with estimated cost per open and rows produced per open (before local filters). */
interface AccessOption {
  label: string;
  cost: number;
  rows: number;
  dependsOnOuter: boolean;
  build: () => AccessChoice;
}

/**
 * Cost model constants, in approximate nanoseconds on the reference container (calibrated against
 * bench/micro/joins.ts). Only their ratios matter.
 */
const COST = {
  /** Sequential scan, per row (fused decode + filter). */
  scanRow: 30,
  /** One B+tree descent (rowid lookup or index seek). */
  probe: 1500,
  /** Per index entry: advance plus table row fetch by rowid. */
  fetch: 1200,
  /** Hash join: per build row, per probe row. */
  hashBuild: 80,
  hashProbe: 60,
  /** Nested loop over a materialized inner side, per inner row visited. */
  nlRow: 20,
  /** Per output row of a join. */
  outRow: 10,
};

/** Default rows for derived tables (unknown cardinality). */
const SUBQUERY_ROWS = 1000;

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

    if (stmt.compound.length === 0) {
      const f = this.flatten(stmt.core, stmt.orderBy, base);
      return this.planCoreWithOrder(f.core, f.changed ? { ...stmt, core: f.core, orderBy: f.orderBy } : stmt, base, outRegs);
    }

    // Compound: every core writes the same registers.
    const first = this.planCore(this.flatten(stmt.core, [], base).core, base, outRegs, null);
    const regs = first.outRegs;
    let root: Operator = first.root;
    let correlated = first.correlated;
    for (const c of stmt.compound) {
      const next = this.planCore(this.flatten(c.core, [], base).core, base, regs, null);
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

  /** Merge simple views / FROM subqueries into the core (see flatten.ts). */
  private flatten(core: SelectCore, orderBy: OrderingTerm[], scope: Scope | null): { core: SelectCore; orderBy: OrderingTerm[]; changed: boolean } {
    if (core.kind !== 'select' || !core.from || flatteningDisabled()) return { core, orderBy, changed: false };
    return flattenCore(core, orderBy, {
      getTable: (n) => this.env.getTable(n),
      getView: (n) => this.env.getView?.(n),
      isCte: (n) => scope?.findCte(n) !== undefined,
      text: this.sqlText,
    });
  }

  private registerCtes(w: WithClause, scope: Scope): void {
    for (const c of w.ctes) {
      const recursive = w.recursive && selectReferences(c.select, c.name);
      scope.ctes.set(c.name.toLowerCase(), { select: c.select, columns: c.columns, recursive });
    }
  }

  /** Plan a WITH RECURSIVE CTE as a RecursiveCte operator (see operators.ts). */
  private planRecursiveCte(name: string, cte: CteEntry, parent: Scope | null): QueryPlan {
    const select = cte.select;
    const cores = [select.core, ...select.compound.map((c) => c.core)];
    const refs = cores.map((c) => coreReferences(c, name));
    const k = refs.indexOf(true);
    if (k <= 0) throw new SmaltError('SMALT_ERROR', `recursive reference in a subquery: ${name}`);
    for (let i = k; i < cores.length; i++) {
      if (!refs[i]) throw new SmaltError('SMALT_ERROR', `circular reference: ${name}`);
    }
    const ops = select.compound.slice(k - 1).map((c) => c.op);
    if (ops.some((op) => op !== 'UNION' && op !== 'UNION ALL')) throw new SmaltError('SMALT_ERROR', `recursive reference in a subquery: ${name}`);
    const distinct = ops.includes('UNION');
    // The initial (non-recursive) part, itself possibly a compound.
    const init: SelectStmt = { ...select, with: undefined, core: select.core, compound: select.compound.slice(0, k - 1), orderBy: [], limit: undefined, offset: undefined };
    const initPlan = this.planSelect(init, parent);
    const outRegs = initPlan.outRegs;
    if (cte.columns && cte.columns.length !== outRegs.length) {
      throw new SmaltError('SMALT_ERROR', `table ${name} has ${outRegs.length} values for ${cte.columns.length} columns`);
    }
    const columns = initPlan.columns.map((c, i) => ({ ...c, name: cte.columns?.[i] ?? c.name }));
    const wregs = outRegs.map(() => this.regs.alloc());
    const scan = new WorkingScan(name, wregs);
    let correlated = initPlan.correlated;
    const steps = cores.slice(k).map((core) => {
      const s = new Scope(parent);
      s.ctes.set(name.toLowerCase(), { select, columns: cte.columns, working: { scan, regs: wregs, columns } });
      const plan = this.planCore(core, s, outRegs, null);
      if (plan.outRegs.length !== outRegs.length) {
        throw new SmaltError('SMALT_ERROR', `SELECTs to the left and right of ${ops[0]} do not have the same number of result columns`);
      }
      correlated ||= plan.correlated;
      return plan.root;
    });
    const order = select.orderBy.length
      ? select.orderBy.map((t) => {
          const idx = this.compoundOrderIndex(t, columns, select.core);
          return { index: idx, desc: t.desc, nullsFirst: t.nulls ? t.nulls === 'FIRST' : !t.desc, collation: columns[idx].collation };
        })
      : null;
    const ls = this.compileScope(new Scope(parent));
    const limitFn = select.limit ? compileExpr(select.limit, ls).fn : undefined;
    const offsetFn = select.offset ? compileExpr(select.offset, ls).fn : undefined;
    const root = new RecursiveCte(name, initPlan.root, steps, outRegs, scan, distinct, columns.map((c) => c.collation), order, limitFn, offsetFn);
    return { root, outRegs, columns, correlated };
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
    const fast = this.planCountStar(core, outRegs);
    if (fast) return fast;
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
    let groupAstsForFusion: Expr[] = [];
    if (isAgg) {
      const baseCompile = this.compileScope(scope);
      const groupCompiled = core.groupBy.map((g) => this.compileGroupTerm(g, scope, resultCols, baseCompile));
      const groupRegs = groupCompiled.map(() => this.regs.alloc());
      const aggs: AggSpec[] = [];
      const aggAsts: CallExpr[] = [];
      const bare = new Set<number>();
      agg = { groupFns: groupCompiled.map((g) => g.fn), groupColls: groupCompiled.map((g) => g.collation), groupRegs, aggs, bare };
      const groupAsts = core.groupBy.map((g) => this.resolveGroupAst(g, resultCols));
      groupAstsForFusion = groupAsts;
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
            name: call.name,
            argAsts: call.args,
            filterAst: call.filter,
          };
          aggs.push(spec);
          aggAsts.push(call);
          return { reg: spec.outReg, type: def.resultType(argTypes), collation: spec.collation, affinity: 'NONE' };
        },
      };
    } else {
      exprScope = this.compileScope(scope);
    }

    // Window functions: result columns and ORDER BY terms may call f(...) OVER (...).
    const noWindowScope = exprScope;
    const windowDefs: WindowDef[] = [];
    const hasWindows = resultCols.some((c) => containsWindow(c.expr)) || (stmt?.orderBy.some((t) => containsWindow(t.expr)) ?? false);
    if (hasWindows) {
      const seen: { ast: CallExpr; binding: ColumnBinding }[] = [];
      exprScope = { ...exprScope, windowRef: (call) => this.windowRef(call, core as SelectCoreSelect, noWindowScope, windowDefs, seen) };
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
      affinity: compiled[i].affinity,
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
      having = compileExpr(core.having, noWindowScope).fn;
    }

    if (agg) {
      // One output row from order-insensitive aggregates: index scans below may fetch in rowid order.
      if (agg.groupFns.length === 0 && agg.bare.size === 0 && agg.aggs.every((a) => ORDER_INSENSITIVE_AGGS.has(a.name))) markUnordered(root);
      const fused =
        agg.bare.size > 0
          ? null
          : agg.groupFns.length === 0
            ? this.tryFuseAggregate(root, agg.aggs, scope)
            : this.tryFuseGroupAggregate(root, groupAstsForFusion, agg.groupColls, agg.groupRegs, agg.aggs, scope);
      root = fused ?? new HashAggregate(root, agg.groupFns, agg.groupColls, agg.groupRegs, agg.aggs, [...agg.bare]);
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

    if (!agg) root = this.tryFuseScanFilter(root, scope);
    if (windowDefs.length) {
      // Registers the projection reads from each input row (restored by the Window operator).
      const snap = agg
        ? [...agg.groupRegs, ...agg.aggs.map((a) => a.outReg), ...agg.bare]
        : scope.sources.flatMap((src) => [...src.cols.map((c) => c.reg), ...(src.rowidReg >= 0 ? [src.rowidReg] : [])]);
      root = new Window(root, [...new Set(snap)], windowDefs);
    }
    root = new Project(root, [...compiled.map((c) => c.fn), ...extraFns], [...regs, ...extraRegs]);
    if (core.distinct) root = new Distinct(root, regs, columns.map((c) => c.collation));
    if (sortNeeded) {
      const limitHint = stmt?.limit ? this.topNHint(stmt, parent) : undefined;
      root = new Sort(root, sortKeys, [...regs, ...extraRegs], limitHint);
    }
    return { root, outRegs: regs, columns, correlated: scope.correlated };
  }

  /** Resolve `OVER name` / `OVER (base ...)` against the core's WINDOW clause, like SQLite. */
  private resolveWindowSpec(over: WindowSpec | string, core: SelectCoreSelect): WindowSpec {
    const named = (name: string): WindowSpec => {
      const w = core.windows.find((x) => sameName(x.name, name));
      if (!w) throw new SmaltError('SMALT_ERROR', `no such window: ${name}`);
      return w.spec.base ? this.resolveWindowSpec(w.spec, core) : w.spec;
    };
    if (typeof over === 'string') return named(over);
    if (!over.base) return over;
    const base = named(over.base);
    if (over.partitionBy.length) throw new SmaltError('SMALT_ERROR', `cannot override PARTITION clause of window: ${over.base}`);
    if (over.orderBy.length && base.orderBy.length) throw new SmaltError('SMALT_ERROR', `cannot override ORDER BY clause of window: ${over.base}`);
    if (base.frame) throw new SmaltError('SMALT_ERROR', `cannot override frame specification of window: ${over.base}`);
    return { ...over, base: undefined, partitionBy: base.partitionBy, orderBy: over.orderBy.length ? over.orderBy : base.orderBy };
  }

  /** Register a window function call (see window.ts) and return the register holding its value. */
  private windowRef(call: CallExpr, core: SelectCoreSelect, scope: CompileScope, defs: WindowDef[], seen: { ast: CallExpr; binding: ColumnBinding }[]): ColumnBinding {
    const hit = seen.find((x) => exprEquals(x.ast, call));
    if (hit) return hit.binding;
    const name = call.name;
    const aggDef = aggregateFunctions.get(name);
    const builtin = WINDOW_ARITY[name];
    if (!builtin && !aggDef) {
      if (scalarFunctions.has(name)) throw new SmaltError('SMALT_ERROR', `${name}() may not be used as a window function`);
      throw new SmaltError('SMALT_ERROR', `no such function: ${name}`);
    }
    const n = call.args.length;
    const [minA, maxA] = builtin ?? [aggDef!.minArgs, aggDef!.maxArgs];
    if (call.star ? name !== 'count' : n < minA || n > maxA || (name === 'count' && n === 0)) {
      throw new SmaltError('SMALT_ERROR', `wrong number of arguments to function ${name}()`);
    }
    if (call.distinct) throw new SmaltError('SMALT_ERROR', 'DISTINCT is not supported for window functions');
    if (builtin && call.filter) throw new SmaltError('SMALT_ERROR', `FILTER clause may only be used with aggregate window functions`);
    for (const a of call.args) if (containsWindow(a)) throw new SmaltError('SMALT_ERROR', `misuse of window function ${name}()`);
    const spec = this.resolveWindowSpec(call.over!, core);
    const args = call.args.map((a) => compileExpr(a, scope));
    // One WindowDef per distinct (PARTITION BY, ORDER BY, frame).
    const strip = (x: unknown): string => JSON.stringify(x, (k, v) => (k === 'pos' || k === 'end' ? undefined : typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v));
    const key = strip({ p: spec.partitionBy, o: spec.orderBy, f: spec.frame });
    let defIndex = defs.findIndex((d) => (d as WindowDef & { key?: string }).key === key);
    if (defIndex < 0) {
      const part = spec.partitionBy.map((e) => compileExpr(e, scope));
      const order = spec.orderBy.map((t) => {
        const c = compileExpr(t.expr, scope);
        return { fn: c.fn, desc: t.desc, nullsFirst: t.nulls ? t.nulls === 'FIRST' : !t.desc, collation: c.collSrc !== CollSrc.None ? c.collation : Collation.Binary };
      });
      const f = spec.frame;
      const frame: FrameSpec = f
        ? {
            unit: f.unit,
            start: { kind: f.start.kind, offset: 'offset' in f.start ? compileExpr(f.start.offset, scope).fn : undefined },
            end: f.end ? { kind: f.end.kind, offset: 'offset' in f.end ? compileExpr(f.end.offset, scope).fn : undefined } : { kind: 'currentRow' },
            exclude: f.exclude ?? 'NO OTHERS',
          }
        : order.length
          ? { unit: 'RANGE', start: { kind: 'unboundedPreceding' }, end: { kind: 'currentRow' }, exclude: 'NO OTHERS' }
          : { unit: 'ROWS', start: { kind: 'unboundedPreceding' }, end: { kind: 'unboundedFollowing' }, exclude: 'NO OTHERS' };
      const rank = (k: string): number => ['unboundedPreceding', 'preceding', 'currentRow', 'following', 'unboundedFollowing'].indexOf(k);
      if (frame.start.kind === 'unboundedFollowing' || frame.end.kind === 'unboundedPreceding' || rank(frame.start.kind) > rank(frame.end.kind)) {
        throw new SmaltError('SMALT_ERROR', 'unsupported frame specification');
      }
      if (frame.unit === 'RANGE' && (frame.start.offset || frame.end.offset) && order.length !== 1) {
        throw new SmaltError('SMALT_ERROR', 'RANGE with offset PRECEDING/FOLLOWING requires one ORDER BY expression');
      }
      const def: WindowDef & { key?: string } = { partition: part.map((c) => c.fn), partitionColls: part.map((c) => (c.collSrc !== CollSrc.None ? c.collation : Collation.Binary)), order, frame, calls: [], key };
      defs.push(def);
      defIndex = defs.length - 1;
    }
    const outReg = this.regs.alloc();
    const kind: WindowCallKind = builtin ? (name as WindowCallKind) : 'aggregate';
    defs[defIndex].calls.push({
      kind,
      name,
      args: args.map((a) => a.fn),
      filter: call.filter ? compileExpr(call.filter, scope).fn : undefined,
      outReg,
      agg: aggDef && !builtin ? { def: aggDef, argTypes: args.map((a) => a.type), collation: args[0]?.collSrc ? args[0].collation : Collation.Binary, star: call.star } : undefined,
    });
    const type: StaticType =
      kind === 'aggregate'
        ? aggDef!.resultType(args.map((a) => a.type))
        : kind === 'percent_rank' || kind === 'cume_dist'
          ? 'real'
          : RANKING.has(kind)
            ? 'int'
            : (args[0]?.type ?? 'any') === 'null'
              ? 'any'
              : kind === 'lag' || kind === 'lead'
                ? args.length > 2 && args[2].type !== args[0].type
                  ? 'any'
                  : args[0].type
                : args[0].type;
    const binding: ColumnBinding = { reg: outReg, type, collation: args[0]?.collSrc && NAVIGATION.has(kind) ? args[0].collation : Collation.Binary, affinity: 'NONE' };
    seen.push({ ast: call, binding });
    return binding;
  }

  /** `SELECT count(*) FROM table` with nothing else: count leaf cells (like SQLite's OP_Count). */
  private planCountStar(core: SelectCore, outRegs: number[] | undefined): QueryPlan | null {
    if (core.kind !== 'select' || core.distinct || core.where || core.groupBy.length || core.having) return null;
    if (core.columns.length !== 1 || !core.from || core.from.kind !== 'table' || core.from.indexedBy !== undefined) return null;
    const rc = core.columns[0];
    if (rc.kind !== 'expr' || rc.expr.kind !== 'call' || rc.expr.name !== 'count' || !rc.expr.star || rc.expr.filter || rc.expr.over) return null;
    const table = this.env.getTable(core.from.name);
    if (!table || this.env.getTable(core.from.name) === undefined || table.matview?.storage === 'columnar') return null;
    const reg = outRegs ? outRegs[0] : this.regs.alloc();
    const name = rc.alias ?? this.sqlText.slice(rc.expr.pos, rc.expr.end);
    return {
      root: new CountRows(this.env.openTree(table.rootPage), table.name, reg),
      outRegs: [reg],
      columns: [{ name, type: 'int', collation: Collation.Binary, affinity: 'NONE' }],
      correlated: false,
    };
  }

  /**
   * Fuse `Filter* -> full TableScan` under an ungrouped aggregate into one generated function
   * (FusedScanAggregate). Returns null when the shape or the aggregates do not qualify.
   */
  /** Match `Filter* -> forward full TableScan`; returns the scan and the predicate ASTs (outermost last). */
  private scanChain(src: Operator): { scan: TableScan | ColumnScan; preds: Expr[] } | null {
    if (!codegenEnabled()) return null;
    const preds: Expr[] = [];
    let node: Operator = src;
    while (node instanceof Filter) {
      if (!node.ast || hasSubquery(node.ast)) return null;
      preds.push(node.ast);
      node = node.child;
    }
    if (node instanceof ColumnScan) return { scan: node, preds: preds.reverse() };
    if (!(node instanceof TableScan) || node.lo || node.hi || node.reverse) return null;
    return { scan: node, preds: preds.reverse() };
  }

  private fusedAggSpecs(aggs: AggSpec[]): FusedAggSpec[] | null {
    const specs: FusedAggSpec[] = [];
    for (const a of aggs) {
      if (a.distinct || !FUSABLE_AGGS.has(a.name) || a.argAsts.length > 1) return null;
      if ([a.filterAst, ...a.argAsts].some((x) => x !== undefined && hasSubquery(x))) return null;
      if (a.name === 'count') specs.push(a.star ? { kind: 'countStar', filter: a.filterAst } : { kind: 'count', arg: a.argAsts[0], filter: a.filterAst });
      else specs.push({ kind: 'step', arg: a.argAsts[0], filter: a.filterAst });
    }
    return specs;
  }

  /** Page iteration helpers for generated pipelines over `access`. */
  private fusedHelpers(access: TableAccess): FusedHelpers {
    const tree = access.tree;
    const pager = tree.pager;
    return {
      ...CODEGEN_HELPERS_FOR_FUSION,
      first: () => tree.descendForCursor(null, false),
      next: (page) => {
        // Fetch the next leaf before releasing this one: if the fetch throws, the caller still
        // holds (and releases) exactly one pin.
        const f = page as Frame;
        const nx = f.view.getUint32(PH_RIGHT, true);
        const g = nx === 0 ? null : pager.get(nx);
        pager.release(f);
        return g;
      },
      release: (page) => pager.release(page as Frame),
      slow: (page, off, r) => access.loadCell(page, off, r),
    };
  }

  /** Replace `Filter* -> full TableScan` with a generated scan + filter (non-aggregate queries). */
  private tryFuseScanFilter(src: Operator, scope: Scope): Operator {
    const chain = this.scanChain(src);
    if (!chain || chain.scan instanceof ColumnScan) return src;
    const { scan, preds } = chain;
    const access = scan.access;
    const cs = this.compileScope(scope);
    const helpers = this.fusedHelpers(access);
    const table = this.env.getTable(access.tableName)!;
    const build = (cap: number) => {
      const spec = access.loaderSpec();
      const outs: { reg: number; type: StaticType }[] = [];
      for (let i = 0; i < spec.decode.length; i += 2) {
        const t = table.columns[spec.decode[i]].type;
        outs.push({ reg: spec.decode[i + 1], type: t === 'INTEGER' ? 'int' : t === 'REAL' ? 'real' : 'any' });
      }
      for (const reg of spec.rowidRegs) outs.push({ reg, type: 'int' });
      const fill = generateScanFilter(preds, outs, cap, () => access.loaderSpec(), helpers, (e) => compileNode(e, cs));
      return { fill, regs: outs.map((o) => o.reg) };
    };
    return new FusedScanFilter(access, build, helpers.first, helpers.release);
  }

  /** Scan + filter + GROUP BY + aggregates in one generated loop. */
  private tryFuseGroupAggregate(src: Operator, groupAsts: Expr[], groupColls: Collation[], groupRegs: number[], aggs: AggSpec[], scope: Scope): Operator | null {
    const chain = this.scanChain(src);
    const specs = this.fusedAggSpecs(aggs);
    if (!chain || !specs || groupAsts.some(hasSubquery)) return null;
    const access = chain.scan.access;
    const cs = this.compileScope(scope);
    const node = chain.scan;
    const helpers = {
      ...(node instanceof ColumnScan ? this.columnarHelpers(node) : this.fusedHelpers(access)),
      hashKey,
      hashKeyMulti: (values: SqlValue[], colls: number[]) => hashKeyMulti(values, colls),
      newGroup: (keys: SqlValue[]) => ({ keys, st: aggs.map((a) => a.def.create(a.star ? [] : a.argTypes, a.collation)) }),
    };
    const build = () =>
      generateGroupAggregate(chain.preds, groupAsts.map((expr, i) => ({ expr, collation: groupColls[i] })), specs, this.pipelineSource(node), helpers, (e) => compileNode(e, cs));
    return new FusedGroupAggregate(access, build, groupRegs, aggs, node instanceof ColumnScan ? node.fusedLabel('group aggregate') : undefined);
  }

  private tryFuseAggregate(src: Operator, aggs: AggSpec[], scope: Scope): Operator | null {
    if (aggs.length === 0) return null;
    const chain = this.scanChain(src);
    const specs = this.fusedAggSpecs(aggs);
    if (!chain || !specs) return null;
    const { scan: node, preds } = chain;
    const access = node.access;
    const cs = this.compileScope(scope);
    if (node instanceof ColumnScan) {
      const run = generateFusedAggregate(preds, specs, this.pipelineSource(node), this.columnarHelpers(node), (e) => compileNode(e, cs));
      return new FusedScanAggregate(access, aggs, run as (r: SqlValue[], states: AggregateState[]) => void, node.fusedLabel('aggregate'));
    }
    const tree = access.tree;
    const pager = tree.pager;
    const helpers: FusedHelpers = {
      ...CODEGEN_HELPERS_FOR_FUSION,
      first: () => {
        const f = tree.descendForCursor(null, false);
        return f;
      },
      next: (page) => {
        // Fetch the next leaf before releasing this one: if the fetch throws, the caller still
        // holds (and releases) exactly one pin.
        const f = page as Frame;
        const nx = f.view.getUint32(PH_RIGHT, true);
        const g = nx === 0 ? null : pager.get(nx);
        pager.release(f);
        return g;
      },
      release: (page) => pager.release(page as Frame),
      slow: (page, off, r) => access.loadCell(page, off, r),
    };
    const run = generateFusedAggregate(preds, specs, { rows: () => access.loaderSpec() }, helpers, (e) => compileNode(e, cs));
    return new FusedScanAggregate(access, aggs, run as (r: SqlValue[], states: AggregateState[]) => void);
  }

  /** Rows source for generated pipelines: leaf pages, or the column store of a columnar scan. */
  private pipelineSource(node: TableScan | ColumnScan): PipelineSource {
    const access = node.access;
    if (node instanceof TableScan) return { rows: () => access.loaderSpec() };
    return { columns: () => ({ decode: access.decode, rowidRegs: access.rowidReg >= 0 ? [access.rowidReg, ...access.extraRowidRegs] : [] }) };
  }

  /** Column-store access for generated loops over a columnar scan (zone maps evaluated per execution). */
  private columnarHelpers(node: ColumnScan): ColumnarHelpers {
    let s: ColumnStore;
    let vals: SqlValue[] = [];
    const zones = node.zones;
    return {
      ...CODEGEN_HELPERS_FOR_FUSION,
      RG: ROW_GROUP_ROWS,
      open: (r) => {
        s = node.store();
        vals = zones.map((z) => z.value(r));
      },
      groups: () => s.rowGroups,
      keep: (g) => {
        if (zones.length === 0) return true;
        const m = s.meta(g);
        for (let k = 0; k < zones.length; k++) {
          const z = zones[k];
          if (!zoneMayMatch(m.zones[z.col], m.rows, z.op, vals[k], z.binaryText)) return false;
        }
        return true;
      },
      rows: (g) => s.meta(g).rows,
      chunk: (g, c) => s.chunk(g, c),
    };
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
    const columns: ResultColumnInfo[] = compiled[0].map((c, i) => ({ name: `column${i + 1}`, type: c.type, collation: Collation.Binary, affinity: 'NONE' as Affinity }));
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
    // RIGHT / FULL JOIN make every earlier source NULL-extendable: WHERE conjuncts reading those
    // sources must not be pushed below the join (FROM order is kept; see OuterJoin).
    const outerAt = scope.sources.flatMap((s, i) => (s.joinType === 'RIGHT' || s.joinType === 'FULL' ? [i] : []));
    const hasOuter = outerAt.length > 0;
    if (hasOuter) {
      if (items.some((it, i) => (it.using || it.natural) && (scope.sources[i].joinType === 'RIGHT' || scope.sources[i].joinType === 'FULL'))) {
        throw new SmaltError('SMALT_UNSUPPORTED', 'USING / NATURAL with RIGHT or FULL JOIN is not supported yet');
      }
      for (const c of pool) {
        let m = -1;
        for (const d of c.deps ?? scope.sources.map((s) => s.position)) for (const k of outerAt) if (d < k || (d === k && scope.sources[k].joinType === 'FULL')) m = Math.max(m, k);
        c.minStep = m;
      }
    }
    for (const src of scope.sources) if (src.joinType === 'INNER' || src.joinType === 'CROSS') for (const c of src.on) addPool(c);

    const cs = this.compileScope(scope);
    const order = hasOuter ? scope.sources.map((_, i) => i) : this.joinOrder(scope, pool, cs);
    const multi = scope.sources.length > 1;
    const placed = new Set<number>();
    let outerRows = 1;
    let root: Operator | null = null;
    for (const p of order) {
      const src = scope.sources[p];
      if (src.joinType === 'RIGHT' || src.joinType === 'FULL') {
        // The inner side is read whole (its rows must survive even without a match).
        let leaf = this.bestStandalone(this.accessOptions(src, p, [], scope, cs)).build().leaf;
        if (!src.sub) leaf = this.tryFuseScanFilter(leaf, scope);
        const on = this.leftOnInfos(src, scope);
        const hash = this.hashKeys(on.filter((c) => c.deps !== null && c.deps.size > 1 && c.deps.has(p)), p, scope, cs);
        const residual = on.filter((c) => !hash?.used.includes(c));
        const before = [...placed];
        root = new OuterJoin(
          root!,
          leaf,
          () => this.sourceRegs(src),
          () => before.flatMap((q) => this.sourceRegs(scope.sources[q])),
          src.joinType === 'FULL',
          this.andAll(residual, cs),
          hash?.build,
          hash?.probe,
          hash?.colls,
        );
        placed.add(p);
        outerRows = Math.max(outerRows, this.tableRows(src));
        for (const c of pool) {
          if (c.placed || c.deps === null || c.deps.size === 0 || (c.minStep ?? -1) > p || ![...c.deps].every((d) => placed.has(d))) continue;
          root = new Filter(root, compileExpr(c.expr, cs).fn, c.expr);
          c.placed = true;
        }
        continue;
      }
      const isLeft = src.joinType === 'LEFT';
      const onInfos: ConjunctInfo[] = isLeft ? this.leftOnInfos(src, scope) : [];
      const allowed = hasOuter ? pool.filter((c) => (c.minStep ?? -1) <= p) : pool;
      const step = this.joinStep(src, placed, outerRows, isLeft ? onInfos : allowed, scope, cs);
      const candidates = step.candidates;
      const access = step.option.build();
      if (!multi && access.scan) this.lastScan = access.scan;

      // Conditions the index enforces exactly need no filter (their columns then need not be decoded).
      for (const c of access.consumed ?? []) c.placed = true;
      // Filters local to this source (depend only on it and outer scopes).
      let leaf = access.leaf;
      const local = candidates.filter((c) => c.deps!.size === 1 && !c.placed);
      for (const c of local) {
        leaf = new Filter(leaf, compileExpr(c.expr, cs).fn, c.expr);
        c.placed = true;
      }
      // In joins, standalone full scans of this source run as generated scan + filter pipelines.
      if (multi && !access.dependsOnOuter) leaf = this.tryFuseScanFilter(leaf, scope);

      const method = access.dependsOnOuter ? 'inl' : step.method;
      // Rows the leaf yields per loop: the inner side of an index nested loop sees one outer row.
      this.estimates.set(leaf, method === 'inl' ? step.rows / Math.max(1, outerRows) : step.filtered);
      if (root === null) {
        root = leaf;
      } else {
        const innerRegs = (): number[] => this.sourceRegs(src);
        const rest = isLeft ? onInfos.filter((c) => !c.placed) : [];
        if (method === 'inl') {
          root = new NestedLoopJoin(root, leaf, isLeft, innerRegs, this.andAll(rest, cs));
          rest.forEach((c) => (c.placed = true));
        } else {
          const eqs = candidates.filter((c) => !c.placed && c.deps!.size > 1);
          const hash = method === 'hash' ? this.hashKeys(eqs, p, scope, cs) : null;
          if (hash) {
            hash.used.forEach((c) => (c.placed = true));
            const residual = isLeft ? rest.filter((c) => !c.placed) : [];
            residual.forEach((c) => (c.placed = true));
            const correlated = scope.correlated;
            root = new HashJoin(root, leaf, hash.build, hash.probe, hash.colls, innerRegs, isLeft, this.env.state, correlated, this.andAll(residual, cs));
          } else {
            // Nested loop: materialize an uncorrelated inner side once instead of re-reading it per outer row.
            const inner = (src.sub && !src.sub.correlated) || (!src.sub && !scope.correlated) ? new Materialize(leaf, innerRegs, this.env.state, false) : leaf;
            root = new NestedLoopJoin(root, inner, isLeft, innerRegs, this.andAll(rest, cs));
            rest.forEach((c) => (c.placed = true));
          }
        }
      }
      placed.add(p);
      outerRows = isLeft ? Math.max(outerRows, step.rows) : step.rows;
      if (root !== leaf) this.estimates.set(root, outerRows);
      // Remaining WHERE / inner-ON conjuncts whose dependencies are now all available.
      for (const c of pool) {
        if (c.placed || c.deps === null || c.deps.size === 0 || (c.minStep ?? -1) > p || ![...c.deps].every((d) => placed.has(d))) continue;
        root = new Filter(root, compileExpr(c.expr, cs).fn, c.expr);
        c.placed = true;
      }
    }
    // Constant / correlated-only / subquery conjuncts.
    for (const c of pool) {
      if (c.placed) continue;
      root = new Filter(root!, compileExpr(c.expr, cs).fn, c.expr);
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
    const isInfoSchema = item.kind === 'table' && item.schema?.toLowerCase() === 'information_schema';
    if (item.kind === 'function' || isInfoSchema) {
      const vt = this.env.virtualTable?.(isInfoSchema ? 'information_schema' : undefined, item.name);
      if (!vt) {
        if (isInfoSchema) throw new SmaltError('SMALT_ERROR', `no such table: information_schema.${item.name}`);
        throw new SmaltError('SMALT_ERROR', `no such table-valued function: ${item.name}`);
      }
      const args = item.kind === 'function' ? item.args : [];
      const cs = this.compileScope(scope);
      const argFns = args.map((a) => compileExpr(a, cs).fn);
      // Arguments that read earlier sources of this FROM make the source lateral.
      let lateral = false;
      let correlated = false;
      for (const a of args) {
        const d = this.deps(a, scope);
        if (d === null) correlated = true;
        else if (d.size > 0) lateral = true;
        // A column that does not resolve in this FROM belongs to an enclosing query.
        walk(a, (x) => {
          if (x.kind === 'column' && this.findSourcePosition(x, scope) < 0) correlated = true;
        });
      }
      const regs = vt.columns.map(() => this.regs.alloc());
      const alias = item.alias ?? item.name;
      const root = new VirtualScan(isInfoSchema ? `information_schema.${item.name}` : `${item.name}()`, (r) => vt.rows(argFns.map((f) => f(r))), regs);
      const columns: ResultColumnInfo[] = vt.columns.map((c) => ({ name: c.name, type: c.type, collation: Collation.Binary, affinity: 'NONE' }));
      const sub: QueryPlan = { root, outRegs: regs, columns, correlated: correlated || lateral };
      if (correlated) scope.correlated = true;
      const cols: SourceColumn[] = columns.map((c, i) => ({ name: c.name, reg: regs[i], type: c.type, collation: c.collation, affinity: c.affinity, declType: '', index: i }));
      scope.sources.push({ name: alias, cols, rowidReg: -1, sub, lateral, joinType, on: [], hidden: new Set(), position });
      return;
    }
    const view =
      item.kind === 'table' && (!item.schema || item.schema.toLowerCase() === 'main') && !(!item.schema && scope.findCte(item.name)) && !this.env.getTable(item.name)
        ? this.env.getView?.(item.name)
        : undefined;
    if (item.kind === 'subquery' || view || (item.kind === 'table' && !item.schema && scope.findCte(item.name))) {
      let select: SelectStmt;
      let names: string[] | undefined;
      let alias: string | undefined;
      let sub: QueryPlan;
      if (item.kind === 'subquery') {
        select = item.select;
        alias = item.alias;
        sub = this.planSelect(select, scope.parent, undefined);
      } else if (view) {
        // A view body sees only the schema (not the referencing query's CTEs or columns).
        const key = view.name.toLowerCase();
        if (this.expandingViews.has(key)) throw new SmaltError('SMALT_ERROR', `view ${view.name} is circularly defined`);
        this.expandingViews.add(key);
        // Result-column names come from the view's own SQL text.
        const outerText = this.sqlText;
        this.sqlText = view.sql;
        try {
          sub = this.planSelect(view.select, null, undefined);
        } finally {
          this.sqlText = outerText;
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
        select = cte.select;
        names = cte.columns;
        alias = (item as { alias?: string }).alias ?? cteName;
        if (cte.working) {
          // The recursive step's working table: one row, re-read on every step (never cached).
          const w = cte.working;
          const cols: SourceColumn[] = w.columns.map((c, i) => ({ name: c.name, reg: w.regs[i], type: c.type, collation: c.collation, affinity: c.affinity, declType: c.declType ?? '', index: i }));
          const ws: QueryPlan = { root: w.scan, outRegs: w.regs, columns: w.columns, correlated: true };
          scope.sources.push({ name: alias, cols, rowidReg: -1, sub: ws, joinType, on: [], hidden: new Set(), position });
          return;
        }
        sub = cte.recursive ? this.planRecursiveCte(cteName, cte, scope.parent) : this.planSelect(select, scope.parent, undefined);
        if (cte.recursive) names = undefined; // already applied to the plan's columns
      }
      if (sub.correlated) scope.correlated = true;
      if (names && names.length !== sub.columns.length) {
        throw new SmaltError('SMALT_ERROR', `table ${alias} has ${sub.columns.length} values for ${names.length} columns`);
      }
      const cols: SourceColumn[] = sub.columns.map((c, i) => ({
        name: names ? names[i] : c.name,
        reg: sub.outRegs[i],
        type: c.type,
        collation: c.collation,
        affinity: c.affinity,
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
      indexedBy: item.indexedBy,
    };
    if (typeof item.indexedBy === 'string' && !table.indexes.some((i) => sameName(i.name, item.indexedBy!))) {
      throw new SmaltError('SMALT_ERROR', `no such index: ${item.indexedBy}`);
    }
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

  /** Enumerate ways to read `src` using the given candidate conjuncts, with estimated costs. */
  private accessOptions(src: Source, p: number, candidates: ConjunctInfo[], scope: Scope, cs: CompileScope): AccessOption[] {
    if (src.sub) {
      const sub = src.sub;
      return [{ label: 'subquery', cost: SUBQUERY_ROWS * COST.scanRow, rows: SUBQUERY_ROWS, dependsOnOuter: sub.correlated, build: () => ({ leaf: sub.root, dependsOnOuter: sub.correlated }) }];
    }
    const N = this.tableRows(src);
    const table = src.table!;
    const access = src.access!;
    type Probe = { op: string; other: Expr; deps: Set<number>; col: number | 'rowid'; colExpr: Expr; conj: ConjunctInfo; list?: Expr[]; exprKey?: string };
    // Expression indexes: comparisons whose one side is an expression over this source alone.
    const exprIndexes = table.indexes.some((i) => i.columns.some((c) => c.expr));
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
        let exprKey: string | undefined;
        if (col === null) {
          if (!exprIndexes) continue;
          const sd = this.deps(colSide, scope);
          if (sd === null || sd.size !== 1 || !sd.has(p)) continue;
          exprKey = exprShapeKey(colSide);
        }
        const d = this.deps(otherSide, scope);
        if (d === null || d.has(p)) continue;
        const op = e.op === 'IS' ? 'IS' : flip ? flipOp(e.op) : e.op;
        probes.push({ op, other: otherSide, deps: d, col: col ?? -1, colExpr: colSide, conj: c, exprKey });
        break;
      }
    }

    const outerDep = (list: Probe[]): boolean => list.some((x) => x.deps.size > 0);
    if (table.matview?.storage === 'columnar') return this.columnarOptions(src, table, access, probes, cs, N);
    const options: AccessOption[] = [
      {
        label: 'scan',
        cost: N * COST.scanRow,
        rows: N,
        dependsOnOuter: false,
        build: () => {
          const scan = new TableScan(access);
          return { leaf: scan, dependsOnOuter: false, scan };
        },
      },
    ];
    const consider = (label: string, cost: number, rows: number, dependsOnOuter: boolean, build: () => AccessChoice): void => {
      options.push({ label, cost, rows, dependsOnOuter, build });
    };

    // Rowid equality / IN / range.
    for (const pr of probes) {
      if (pr.col !== 'rowid') continue;
      if (pr.op === '=') {
        consider('rowid=', COST.probe, 1, pr.deps.size > 0, () => {
          const leaf = new RowidLookup(access, [compileExpr(pr.other, cs).fn]);
          return { leaf, dependsOnOuter: pr.deps.size > 0 };
        });
      } else if (pr.op === 'in') {
        const k = pr.list!.length;
        consider('rowid in', k * COST.probe, k, pr.deps.size > 0, () => ({ leaf: new RowidLookup(access, pr.list!.map((x) => compileExpr(x, cs).fn)), dependsOnOuter: pr.deps.size > 0 }));
      }
    }
    const rowidRange = probes.filter((x) => x.col === 'rowid' && ['<', '<=', '>', '>='].includes(x.op));
    if (rowidRange.length) {
      const lo = rowidRange.find((x) => x.op === '>' || x.op === '>=');
      const hi = rowidRange.find((x) => x.op === '<' || x.op === '<=');
      const rangeRows = N * (lo && hi ? 0.25 : 0.33);
      consider('rowid range', COST.probe + rangeRows * COST.scanRow, rangeRows, outerDep([lo, hi].filter((x): x is Probe => !!x)), () => {
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
      if (idx.where) {
        // A partial index holds only rows matching its WHERE: usable when the query implies it.
        const have = new Set(candidates.map((c) => exprShapeKey(c.expr)));
        if (!conjuncts(idx.where).every((w) => have.has(exprShapeKey(w)))) continue;
      }
      const eqs: Probe[] = [];
      const converters: ((v: SqlValue) => SqlValue)[] = [];
      const usable = (pr: Probe, ic: { column: number; collation: Collation; expr?: Expr }): ((v: SqlValue) => SqlValue) | null => {
        // Costing only: compiling the probe must not make the scan decode its columns.
        this.dryCompile++;
        try {
          return usableInner(pr, ic);
        } finally {
          this.dryCompile--;
        }
      };
      const usableInner = (pr: Probe, ic: { column: number; collation: Collation; expr?: Expr }): ((v: SqlValue) => SqlValue) | null => {
        if (ic.column < 0) {
          if (pr.exprKey === undefined || pr.exprKey !== exprShapeKey(ic.expr!)) return null;
        } else if (pr.col !== ic.column) return null;
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
      let matches: number;
      if (unique) matches = 1;
      else if (k > 0 && idx.stats) matches = idx.stats.avg[k - 1];
      else {
        matches = N;
        // Expression columns have no statistics: assume ~10 rows per value, like SQLite without ANALYZE.
        for (let j = 0; j < k; j++) matches /= idx.columns[j].column < 0 ? Math.max(1, N / 10) : this.ndv(src, idx.columns[j].column);
      }
      if (lo || hi) matches *= (k === 0 ? this.rangeFraction(idx, lo, hi) : undefined) ?? (lo && hi ? 0.25 : 0.33);
      // A partial index only holds rows matching its WHERE.
      if (idx.where) for (const w of conjuncts(idx.where)) matches *= this.selectivity(w, scope);
      matches = Math.max(1, matches);
      const deps = outerDep([...eqs, ...(lo ? [lo] : []), ...(hi ? [hi] : [])]);
      consider(`index ${idx.name}`, COST.probe + matches * COST.fetch, matches, deps, () => {
        const spec = {
          indexName: idx.name,
          tree: this.env.openTree(idx.rootPage),
          columns: idx.columns.map((c) => ({ desc: c.desc, collation: c.collation })),
          eq: eqs.map((x) => compileExpr(x.other, cs).fn),
          lo: lo ? { fn: compileExpr(lo.other, cs).fn, inclusive: lo.op === '>=' } : undefined,
          hi: hi ? { fn: compileExpr(hi.other, cs).fn, inclusive: hi.op === '<=' } : undefined,
          convert: [...converters, ...(rangeConv ? [rangeConv] : [])],
          // Key columns usable for index-only scans: plain columns whose key form is the value itself.
          keyColumns: idx.columns.map((c) => {
            if (c.column < 0) return -1;
            const t = table.columns[c.column].type;
            const textual = t === 'TEXT' || t === 'ANY' || t === 'NUMERIC';
            return textual && c.collation !== Collation.Binary ? -1 : c.column;
          }),
        };
        return { leaf: new IndexScan(access, spec), dependsOnOuter: deps, consumed: [...eqs, ...(lo ? [lo] : []), ...(hi ? [hi] : [])].map((x) => x.conj) };
      });
    }
    // INDEXED BY / NOT INDEXED, as in SQLite.
    if (src.indexedBy === null) return options.filter((o) => !o.label.startsWith('index '));
    if (typeof src.indexedBy === 'string') {
      const forced = options.filter((o) => o.label.toLowerCase() === `index ${src.indexedBy!.toLowerCase()}`);
      // Where the index is unusable on its own (e.g. this table placed first in a join), offer an
      // infinitely expensive option: join ordering avoids it, and only a plan that needs it fails.
      if (!forced.some((o) => !o.dependsOnOuter)) {
        forced.push({
          label: 'no query solution',
          cost: Infinity,
          rows: 1,
          dependsOnOuter: false,
          build: () => {
            throw new SmaltError('SMALT_ERROR', 'no query solution');
          },
        });
      }
      return forced;
    }
    return options;
  }

  // ---------------------------------------------------------------- estimates

  /** Estimated rows of a source (ANALYZE stats, else B+tree shape). */
  private tableRows(src: Source): number {
    if (src.sub) return SUBQUERY_ROWS;
    if (src.estRows === undefined) {
      const t = src.table!;
      const live = t.matview?.storage === 'columnar' ? this.env.columnStore!(t).rows : src.access!.tree.estimateCount();
      src.estRows = Math.max(1, src.table!.stats?.rows ?? live);
      // Remember what the plan assumed, so the statement can re-plan if the table grows or shrinks a lot.
      // (Columnar views change only on refresh, which re-plans anyway.)
      if (t.matview?.storage !== 'columnar') this.rowAssumptions.set(t.rootPage, live);
    }
    return src.estRows;
  }

  /**
   * A columnar materialized view has one access path: a columnar scan. Comparisons of a column with
   * a constant or parameter become zone-map tests (the filter still applies them).
   */
  private columnarOptions(
    src: Source,
    table: TableSchema,
    access: TableAccess,
    probes: { op: string; other: Expr; deps: Set<number>; col: number | 'rowid'; colExpr: Expr }[],
    cs: CompileScope,
    N: number,
  ): AccessOption[] {
    if (typeof src.indexedBy === 'string') throw new SmaltError('SMALT_ERROR', `no such index: ${src.indexedBy}`);
    const zones: ZonePredicate[] = [];
    for (const pr of probes) {
      if (typeof pr.col !== 'number' || pr.col < 0 || pr.deps.size > 0 || !['=', '<', '<=', '>', '>='].includes(pr.op)) continue;
      this.dryCompile++;
      try {
        const colC = compileExpr(pr.colExpr, cs);
        const otherC = compileExpr(pr.other, cs);
        zones.push({
          col: pr.col,
          op: pr.op,
          value: otherC.fn,
          binaryText: comparisonCollation(colC, otherC) === Collation.Binary,
          label: `${table.columns[pr.col].name} ${pr.op} ?`,
        });
      } finally {
        this.dryCompile--;
      }
    }
    const store = (): ColumnStore => this.env.columnStore!(table);
    // Decoding typed column chunks is cheaper per row than record decoding.
    return [{ label: 'columnar scan', cost: N * COST.scanRow * 0.5, rows: N, dependsOnOuter: false, build: () => ({ leaf: new ColumnScan(access, store, zones), dependsOnOuter: false }) }];
  }

  /** >0 while compiling expressions only to inspect them (column use is not recorded). */
  private dryCompile = 0;

  /** Run `fn` without recording column use (the scan will not decode the columns it resolves). */
  untracked<T>(fn: () => T): T {
    this.dryCompile++;
    try {
      return fn();
    } finally {
      this.dryCompile--;
    }
  }

  /** Views being expanded (detects circular definitions). */
  private readonly expandingViews = new Set<string>();

  /** Planner row estimates per operator (per loop for inner sides), shown by EXPLAIN ANALYZE. */
  readonly estimates = new WeakMap<Operator, number>();

  /** Root page -> row estimate (from the tree shape) each costed table had when this plan was made. */
  readonly rowAssumptions = new Map<number, number>();

  /** Statistics for a source's table: ANALYZE results, else sampled on demand. */
  private statsOf(src: Source): TableStats | undefined {
    const t = src.table;
    if (!t) return undefined;
    return t.stats ?? this.env.sampledStats?.(t);
  }

  /** Estimated distinct values of a column (rowid/unique, ANALYZE, index stats, sample, else rows/10). */
  /**
   * Fraction of an index's first column covered by a range, from the column's current min/max (two
   * O(log n) probes). Handles constant bounds and bounds of fixed width over the same unknown
   * (`x >= ?1 AND x < ?1 + 10`). Undefined when it cannot tell (non-numeric, unknown bounds).
   */
  private rangeFraction(idx: TableSchema['indexes'][number], lo: { other: Expr; op: string } | undefined, hi: { other: Expr; op: string } | undefined): number | undefined {
    const linear = (e: Expr): { base: string; off: number } | undefined => {
      if (e.kind === 'literal') return typeof e.value === 'number' ? { base: '', off: e.value } : undefined;
      if (e.kind === 'unary' && e.op === '-' && e.operand.kind === 'literal' && typeof e.operand.value === 'number') return { base: '', off: -e.operand.value };
      if (e.kind === 'binary' && (e.op === '+' || e.op === '-') && e.right.kind === 'literal' && typeof e.right.value === 'number') {
        const inner = linear(e.left);
        const d = e.op === '+' ? e.right.value : -e.right.value;
        return inner ? { base: inner.base, off: inner.off + d } : { base: exprShapeKey(e.left), off: d };
      }
      return { base: exprShapeKey(e), off: 0 };
    };
    const l = lo && linear(lo.other);
    const h = hi && linear(hi.other);
    if ((lo && !l) || (hi && !h)) return undefined;
    const known = (x: { base: string } | undefined): boolean => !x || x.base === '';
    // Only constant bounds, or a pair sharing the same unknown.
    if (!(known(l) && known(h)) && !(l && h && l.base === h.base)) return undefined;
    const mm = this.indexMinMax(idx);
    if (!mm) return undefined;
    const span = mm.max - mm.min;
    if (span <= 0) return undefined;
    let width: number;
    if (l && h && l.base !== '') width = h.off - l.off;
    else width = (h ? Math.min(h.off, mm.max) : mm.max) - (l ? Math.max(l.off, mm.min) : mm.min);
    // Integer-valued ranges include an endpoint; never estimate below a sliver.
    return Math.min(1, Math.max(1 / (span + 1), (Math.max(0, width) + 1) / (span + 1)));
  }

  private indexMinMax(idx: TableSchema['indexes'][number]): { min: number; max: number } | undefined {
    const tree = this.env.openTree(idx.rootPage);
    const cur = new BTreeCursor(tree);
    const cols = idx.columns.map((c) => ({ desc: c.desc, collation: c.collation }));
    try {
      // The first non-NULL value, and the last value.
      const first = (k: Uint8Array): SqlValue => decodeKey(k.subarray(0, rowidSuffixStart(k, k.length)), cols)[0];
      if (!cur.seek(KEY_AFTER_NULL)) return undefined;
      const min = first(cur.key());
      if (!cur.last()) return undefined;
      const max = first(cur.key());
      if (typeof min !== 'number' || typeof max !== 'number') return undefined;
      return { min, max };
    } finally {
      cur.close();
    }
  }

  private ndv(src: Source, col: number | 'rowid'): number {
    const n = this.tableRows(src);
    const t = src.table;
    if (!t) return Math.max(1, n / 10);
    if (col === 'rowid' || col === t.rowidAlias) return n;
    for (const ix of t.indexes) if (ix.unique && ix.columns.length === 1 && ix.columns[0].column === col) return n;
    if (t.stats) return Math.max(1, t.stats.ndv[col] || 1);
    for (const ix of t.indexes) if (ix.columns[0].column === col && ix.stats) return Math.max(1, n / ix.stats.avg[0]);
    const sampled = this.statsOf(src);
    if (sampled) return Math.max(1, Math.min(n, sampled.ndv[col] || 1));
    return Math.max(1, n / 10);
  }

  /** Column reference -> (source, column) in the current scope, if `e` is one. */
  private colRef(e: Expr, scope: Scope): { src: Source; col: number | 'rowid' } | null {
    if (e.kind === 'collate') return this.colRef(e.expr, scope);
    if (e.kind !== 'column') return null;
    const p = this.findSourcePosition(e, scope);
    if (p < 0) return null;
    const src = scope.sources[p];
    const col = this.columnOf(e, src, scope);
    return col === null ? null : { src, col };
  }

  /** Estimated fraction of rows for which a conjunct is true. */
  private selectivity(e: Expr, scope: Scope): number {
    switch (e.kind) {
      case 'binary': {
        if (e.op === 'AND') return this.selectivity(e.left, scope) * this.selectivity(e.right, scope);
        if (e.op === 'OR') {
          const a = this.selectivity(e.left, scope);
          const b = this.selectivity(e.right, scope);
          return a + b - a * b;
        }
        const l = this.colRef(e.left, scope);
        const r = this.colRef(e.right, scope);
        if (e.op === '=' || e.op === 'IS') {
          if (l && r && l.src !== r.src) return 1 / Math.max(this.ndv(l.src, l.col), this.ndv(r.src, r.col));
          const c = l ?? r;
          return c ? 1 / this.ndv(c.src, c.col) : 0.33;
        }
        if (e.op === '!=' || e.op === 'IS NOT') return 0.9;
        if (['<', '<=', '>', '>='].includes(e.op)) return 0.33;
        return 0.33;
      }
      case 'inList': {
        const c = this.colRef(e.expr, scope);
        const s = c ? Math.min(1, e.list.length / this.ndv(c.src, c.col)) : 0.33;
        return e.not ? 1 - s : s;
      }
      case 'isNull': {
        const c = this.colRef(e.expr, scope);
        let s = 0.05;
        const st = c && c.col !== 'rowid' ? this.statsOf(c.src) : undefined;
        if (c && c.col !== 'rowid' && st) s = st.nulls[c.col] / Math.max(1, st.rows);
        else if (c?.col === 'rowid') s = 0;
        return e.not ? 1 - s : s;
      }
      case 'between':
        return e.not ? 0.75 : 0.25;
      case 'like':
        return e.not ? 0.75 : 0.25;
      case 'unary':
        return e.op === 'NOT' ? 1 - this.selectivity(e.operand, scope) : 0.33;
      default:
        return 0.33;
    }
  }

  /** Pick the cheapest standalone (not outer-dependent) access option. */
  private bestStandalone(opts: AccessOption[]): AccessOption {
    let best: AccessOption | undefined;
    for (const o of opts) if (!o.dependsOnOuter && (!best || o.cost < best.cost)) best = o;
    return best ?? opts[0];
  }

  /**
   * Cost of joining source `t` after `placed` sources producing `outerRows` rows. Returns the chosen
   * method and estimates; used both by join ordering and by operator construction.
   */
  private joinStep(
    t: Source,
    placed: Set<number>,
    outerRows: number,
    pool: ConjunctInfo[],
    scope: Scope,
    cs: CompileScope,
  ): { cost: number; rows: number; filtered: number; method: 'first' | 'inl' | 'hash' | 'nl'; option: AccessOption; candidates: ConjunctInfo[] } {
    const p = t.position;
    const avail = (c: ConjunctInfo): boolean => c.deps !== null && c.deps.has(p) && [...c.deps].every((d) => d === p || placed.has(d));
    const candidates = pool.filter((c) => !c.placed && avail(c));
    const local = candidates.filter((c) => c.deps!.size === 1);
    const joins = candidates.filter((c) => c.deps!.size > 1);
    let filtered = this.tableRows(t);
    for (const c of local) filtered *= this.selectivity(c.expr, scope);
    let joinSel = 1;
    for (const c of joins) joinSel *= this.selectivity(c.expr, scope);
    const opts = this.accessOptions(t, p, candidates, scope, cs);
    const standalone = this.bestStandalone(opts);
    if (placed.size === 0) {
      return { cost: standalone.cost, rows: Math.max(1, filtered), filtered: Math.max(1, filtered), method: 'first', option: standalone, candidates };
    }
    const outRows = Math.max(1, outerRows * filtered * joinSel);
    let best: { cost: number; method: 'inl' | 'hash' | 'nl'; option: AccessOption } = {
      cost: standalone.cost + outerRows * Math.max(1, filtered) * COST.nlRow,
      method: 'nl',
      option: standalone,
    };
    for (const o of opts) {
      if (!o.dependsOnOuter) continue;
      const c = outerRows * o.cost;
      if (c < best.cost) best = { cost: c, method: 'inl', option: o };
    }
    const hasEquiJoin = joins.some((c) => c.expr.kind === 'binary' && c.expr.op === '=');
    if (hasEquiJoin) {
      const c = standalone.cost + filtered * COST.hashBuild + outerRows * COST.hashProbe;
      if (c < best.cost) best = { cost: c, method: 'hash', option: standalone };
    }
    return { cost: best.cost + outRows * COST.outRow, rows: outRows, filtered: Math.max(1, filtered), method: best.method, option: best.option, candidates };
  }

  /**
   * Choose the join order. Runs of INNER-joined sources are reordered by dynamic programming over
   * subsets (greedy above 8 sources); LEFT-joined sources keep their position (and therefore
   * everything before them is joined first), which preserves outer-join semantics.
   */
  private joinOrder(scope: Scope, pool: ConjunctInfo[], cs: CompileScope): number[] {
    const n = scope.sources.length;
    if (n <= 1) return n === 1 ? [0] : [];
    const order: number[] = [];
    const placed = new Set<number>();
    let rows = 1;
    let segment: number[] = [];
    const flush = (): void => {
      if (segment.length === 0) return;
      const best = segment.length <= 8 ? this.orderSegmentDP(segment, placed, rows, pool, scope, cs) : this.orderSegmentGreedy(segment, placed, rows, pool, scope, cs);
      for (const p of best.order) {
        order.push(p);
        placed.add(p);
      }
      rows = best.rows;
      segment = [];
    };
    for (let p = 0; p < n; p++) {
      const src = scope.sources[p];
      if (src.joinType === 'LEFT' || src.lateral) {
        // Fixed position: everything before it is joined first (outer-join semantics, lateral arguments).
        flush();
        const step = this.joinStep(src, placed, rows, src.joinType === 'LEFT' ? this.leftOnInfos(src, scope) : pool, scope, cs);
        rows = src.joinType === 'LEFT' ? Math.max(rows, step.rows) : step.rows; // a left join never drops outer rows
        order.push(p);
        placed.add(p);
      } else segment.push(p);
    }
    flush();
    return order;
  }

  private leftOnInfos(src: Source, scope: Scope): ConjunctInfo[] {
    return src.on.flatMap((e) => splitBetween(e)).map((e) => ({ expr: e, deps: this.deps(e, scope), placed: false }));
  }

  private orderSegmentDP(segment: number[], prefix: Set<number>, prefixRows: number, pool: ConjunctInfo[], scope: Scope, cs: CompileScope): { order: number[]; rows: number } {
    const m = segment.length;
    type St = { cost: number; rows: number; order: number[] };
    const best = new Array<St | undefined>(1 << m);
    best[0] = { cost: 0, rows: prefixRows, order: [] };
    for (let mask = 0; mask < 1 << m; mask++) {
      const cur = best[mask];
      if (!cur) continue;
      const placed = new Set(prefix);
      for (const p of cur.order) placed.add(p);
      for (let j = 0; j < m; j++) {
        if (mask & (1 << j)) continue;
        const step = this.joinStep(scope.sources[segment[j]], placed, cur.rows, pool, scope, cs);
        // Avoid cross products while a connected choice exists: penalize joins without any join conjunct.
        const connected = placed.size === 0 || step.candidates.some((c) => c.deps!.size > 1);
        const cost = cur.cost + step.cost * (connected ? 1 : 4);
        const next = mask | (1 << j);
        if (!best[next] || cost < best[next]!.cost) best[next] = { cost, rows: step.rows, order: [...cur.order, segment[j]] };
      }
    }
    return best[(1 << m) - 1]!;
  }

  private orderSegmentGreedy(segment: number[], prefix: Set<number>, prefixRows: number, pool: ConjunctInfo[], scope: Scope, cs: CompileScope): { order: number[]; rows: number } {
    const left = new Set(segment);
    const placed = new Set(prefix);
    const order: number[] = [];
    let rows = prefixRows;
    while (left.size > 0) {
      let pick = -1;
      let pickStep: ReturnType<Planner['joinStep']> | null = null;
      for (const p of left) {
        const step = this.joinStep(scope.sources[p], placed, rows, pool, scope, cs);
        if (!pickStep || step.cost < pickStep.cost) {
          pick = p;
          pickStep = step;
        }
      }
      order.push(pick);
      placed.add(pick);
      left.delete(pick);
      rows = pickStep!.rows;
    }
    return { order, rows };
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

  /** A scope holding the CTEs of a `WITH` clause attached to INSERT / UPDATE / DELETE. */
  cteScope(w: WithClause): Scope {
    const s = new Scope(null);
    this.registerCtes(w, s);
    return s;
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
    // Like SQLite: a double-quoted name that resolves to nothing may have been meant as a string.
    const quoted = !e.table && this.sqlText[e.pos] === '"';
    throw new SmaltError('SMALT_ERROR', quoted ? `no such column: "${e.name}" - should this be a string literal in single-quotes?` : `no such column: ${name}`);
  }

  private readonly expandingAliases = new Set<string>();

  private resolveIn(e: ColumnExpr, scope: Scope): ColumnBinding | undefined {
    const bind = (src: Source, c: SourceColumn): ColumnBinding => {
      if (src.access && !this.dryCompile) src.access.use(c.index, c.reg);
      return { reg: c.reg, type: c.type, collation: c.collation, affinity: c.affinity };
    };
    const rowidOf = (src: Source): ColumnBinding => {
      if (!this.dryCompile) src.access!.useRowid(src.rowidReg);
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
    const dec = decorrelationDisabled() ? null : this.decorrelate(select, scope, 'scalar');
    if (dec) return dec;
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
      let v: SqlValue;
      try {
        root.open(r);
        v = root.next() ? r[out] : null;
      } finally {
        root.close();
      }
      if (!correlated) {
        cached = v;
        epoch = state.epoch;
      }
      return v;
    };
    const col = plan.columns[0];
    return { fn, type: col.type, collation: col.collation, collSrc: col.collation ? CollSrc.Column : CollSrc.None, affinity: 'NONE', constant: false };
  }

  /**
   * Decorrelate `EXISTS (SELECT … WHERE inner = outer AND …)` (a hash semi-join) and scalar
   * aggregates `(SELECT agg(…) FROM … WHERE inner = outer AND …)` (one GROUP BY over the inner side,
   * looked up per outer row). Applies only when every correlated conjunct is such an equality between
   * an expression over the subquery's own base tables and one over the enclosing query (conjuncts over
   * the enclosing query alone are evaluated per row as guards), and hashing with the comparison's
   * collation and affinity is exactly equivalent to `=`. Otherwise returns null (re-run per row).
   */
  private decorrelate(select: SelectStmt, scope: Scope, kind: 'exists' | 'scalar'): Compiled | null {
    if (select.with || select.compound.length || select.offset) return null;
    const core = select.core;
    if (core.kind !== 'select' || !core.where || !core.from || core.groupBy.length || core.having || core.windows.length) return null;
    if (kind === 'scalar' && (select.limit || select.orderBy.length)) return null;
    if (kind === 'exists' && select.limit && !(select.limit.kind === 'literal' && typeof select.limit.value === 'number' && select.limit.value >= 1)) return null;
    // Inner sources: base tables only (known columns).
    const inner = new Map<string, Set<string>>();
    const addFrom = (f: FromItem): boolean => {
      if (f.kind === 'join') {
        if (f.joinType !== 'INNER' && f.joinType !== 'CROSS') return false;
        if (f.on && hasSubquery(f.on)) return false;
        return addFrom(f.left) && addFrom(f.right);
      }
      if (f.kind !== 'table' || (f.schema && f.schema.toLowerCase() !== 'main') || (!f.schema && scope.findCte(f.name))) return false;
      const t = this.env.getTable(f.name);
      if (!t) return false;
      inner.set((f.alias ?? f.name).toLowerCase(), new Set([...t.columns.map((c) => c.name.toLowerCase()), 'rowid', 'oid', '_rowid_']));
      return true;
    };
    if (!addFrom(core.from)) return null;
    const side = (e: Expr): 'inner' | 'outer' | 'mixed' | 'none' | 'bad' => {
      if (hasSubquery(e)) return 'bad';
      let i = false;
      let o = false;
      walk(e, (x) => {
        if (x.kind !== 'column') return;
        const isInner = x.table ? inner.has(x.table.toLowerCase()) && inner.get(x.table.toLowerCase())!.has(x.name.toLowerCase()) : [...inner.values()].some((c) => c.has(x.name.toLowerCase()));
        if (isInner) i = true;
        else o = true;
      });
      return i && o ? 'mixed' : i ? 'inner' : o ? 'outer' : 'none';
    };
    // The ON conditions of inner joins must not read the enclosing query.
    const onOk = (f: FromItem): boolean => (f.kind === 'join' ? (!f.on || ['inner', 'none'].includes(side(f.on))) && onOk(f.left) && onOk(f.right) : true);
    if (!onOk(core.from)) return null;
    const pairs: { inner: Expr; outer: Expr; innerLeft: boolean }[] = [];
    const guards: Expr[] = [];
    const rest: Expr[] = [];
    for (const c of conjuncts(core.where)) {
      const sd = side(c);
      if (sd === 'inner' || sd === 'none') rest.push(c);
      else if (sd === 'outer') guards.push(c);
      else if (sd === 'mixed' && c.kind === 'binary' && c.op === '=') {
        const l = side(c.left);
        const r = side(c.right);
        if (l === 'inner' && r === 'outer') pairs.push({ inner: c.left, outer: c.right, innerLeft: true });
        else if (l === 'outer' && r === 'inner') pairs.push({ inner: c.right, outer: c.left, innerLeft: false });
        else return null;
      } else return null;
    }
    if (pairs.length === 0) return null;
    // Result columns of the scalar form must be aggregates of the inner rows (no bare columns).
    let resultExpr: Expr | undefined;
    if (kind === 'scalar') {
      if (core.columns.length !== 1 || core.columns[0].kind !== 'expr' || core.distinct) return null;
      resultExpr = core.columns[0].expr;
      if (!containsAggregate(resultExpr) || containsWindow(resultExpr) || side(resultExpr) === 'outer' || side(resultExpr) === 'mixed' || side(resultExpr) === 'bad') return null;
      let bare = false;
      const scan = (e: Expr): void => {
        if (isAggregateCall(e)) return;
        if (e.kind === 'column') bare = true;
        walk(e, (x) => {
          if (x === e) return;
          if (isAggregateCall(x)) return false;
          if (x.kind === 'column') bare = true;
        });
      };
      scan(resultExpr);
      if (bare) return null;
    }
    const where = rest.reduce<Expr | undefined>((acc, e) => (acc ? { kind: 'binary', op: 'AND', left: acc, right: e, pos: e.pos, end: e.end } : e), undefined);
    const keyCols: ResultColumn[] = pairs.map((p, i) => ({ kind: 'expr', expr: p.inner, alias: `k${i}`, pos: 0, end: 0 }));
    const innerCore: SelectCoreSelect = {
      ...core,
      distinct: kind === 'exists',
      columns: kind === 'scalar' ? [...keyCols, { kind: 'expr', expr: resultExpr!, alias: 'v', pos: 0, end: 0 }] : keyCols,
      where,
      groupBy: kind === 'scalar' ? pairs.map((p) => p.inner) : [],
    };
    const innerStmt: SelectStmt = { kind: 'select', core: innerCore, compound: [], orderBy: [], pos: select.pos, end: select.end };
    let plan: QueryPlan;
    try {
      plan = this.planSelect(innerStmt, null);
    } catch {
      return null;
    }
    if (plan.correlated) return null;
    const outerScope = this.compileScope(scope);
    const keyFns: { outer: Fn; convOuter: ((v: SqlValue) => SqlValue) | null; convInner: ((v: SqlValue) => SqlValue) | null; coll: Collation }[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const col = plan.columns[i];
      // A column reference supplies its collation to the comparison even when it is BINARY.
      const innerIsColumn = pairs[i].inner.kind === 'column';
      const innerC: Compiled = { fn: () => null, type: col.type, collation: col.collation, collSrc: innerIsColumn || col.collation ? CollSrc.Column : CollSrc.None, affinity: col.affinity, constant: false };
      const outerC = compileExpr(pairs[i].outer, outerScope);
      const [l, r] = pairs[i].innerLeft ? [innerC, outerC] : [outerC, innerC];
      const coll = comparisonCollation(l, r);
      // A GROUP BY key groups with the inner expression's own collation: it must be the comparison's.
      if (kind === 'scalar' && coll !== col.collation) return null;
      if (pairs[i].inner.kind === 'collate') return null;
      const [cl, cr] = comparisonConverters(l, r);
      keyFns.push({ outer: outerC.fn, coll, convInner: pairs[i].innerLeft ? cl : cr, convOuter: pairs[i].innerLeft ? cr : cl });
    }
    const guardFns = guards.map((g) => compileExpr(g, outerScope).fn);
    // Value over an empty inner set (count(*) -> 0, sum -> NULL, ...): the result expression over no rows.
    let emptyValue: SqlValue = kind === 'exists' ? 0 : null;
    let emptyPlan: QueryPlan | null = null;
    if (kind === 'scalar') {
      const emptyCore: SelectCoreSelect = { ...core, columns: [{ kind: 'expr', expr: resultExpr!, pos: 0, end: 0 }], where: { kind: 'literal', value: 0, pos: 0, end: 0 } };
      emptyPlan = this.planSelect({ kind: 'select', core: emptyCore, compound: [], orderBy: [], pos: 0, end: 0 }, null);
    }
    const state = this.env.state;
    let epoch = -1;
    let table = new Map<unknown, SqlValue>();
    const n = pairs.length;
    const keyOf = (vals: SqlValue[]): unknown => (n === 1 ? hashKey(vals[0], keyFns[0].coll) : hashKeyMulti(vals, keyFns.map((k) => k.coll)));
    const build = (r: SqlValue[]): void => {
      table = new Map();
      const root = plan.root;
      try {
        root.open(r);
        outer: while (root.next()) {
          const vals: SqlValue[] = [];
          for (let i = 0; i < n; i++) {
            let v = r[plan.outRegs[i]];
            if (v === null) continue outer; // NULL keys never match
            if (keyFns[i].convInner) v = keyFns[i].convInner!(v);
            vals.push(v);
          }
          const k = keyOf(vals);
          if (!table.has(k)) table.set(k, kind === 'exists' ? 1 : r[plan.outRegs[n]]);
        }
      } finally {
        root.close();
      }
      if (emptyPlan) {
        try {
          emptyPlan.root.open(r);
          emptyValue = emptyPlan.root.next() ? r[emptyPlan.outRegs[0]] : null;
        } finally {
          emptyPlan.root.close();
        }
      }
      epoch = state.epoch;
    };
    const probe: SqlValue[] = new Array(n);
    const fn: Fn = (r) => {
      if (epoch !== state.epoch) build(r);
      for (const g of guardFns) if (truthy(g(r)) !== true) return emptyValue;
      for (let i = 0; i < n; i++) {
        let v = keyFns[i].outer(r);
        if (v === null) return emptyValue;
        if (keyFns[i].convOuter) v = keyFns[i].convOuter!(v);
        probe[i] = v;
      }
      const hit = table.get(keyOf(probe));
      return hit === undefined ? emptyValue : hit;
    };
    const resultCol = plan.columns[plan.columns.length - 1];
    return kind === 'exists'
      ? { fn, type: 'int', collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE', constant: false }
      : { fn, type: resultCol.type, collation: resultCol.collation, collSrc: resultCol.collation ? CollSrc.Column : CollSrc.None, affinity: 'NONE', constant: false };
  }

  /** True if any parent scope of `scope` exists (correlation can propagate through it). */
  private isCorrelatedBeyond(scope: Scope): boolean {
    return scope.correlated;
  }

  private existsSubquery(select: SelectStmt, scope: Scope): Fn {
    const dec = decorrelationDisabled() ? null : this.decorrelate(select, scope, 'exists');
    if (dec) return dec.fn;
    const plan = this.planSelect(select, scope);
    const state = this.env.state;
    let epoch = -1;
    let cached: SqlValue = 0;
    const root = plan.root;
    const correlated = plan.correlated;
    return (r) => {
      if (!correlated && epoch === state.epoch) return cached;
      let v: number;
      try {
        root.open(r);
        v = root.next() ? 1 : 0;
      } finally {
        root.close();
      }
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

/** Whether a FROM tree (or a nested FROM subquery) names `name` as a table. */
function fromReferences(f: FromItem | undefined, name: string): boolean {
  if (!f) return false;
  switch (f.kind) {
    case 'table':
      return !f.schema && sameName(f.name, name);
    case 'join':
      return fromReferences(f.left, name) || fromReferences(f.right, name);
    case 'subquery':
      return selectReferences(f.select, name);
    default:
      return false;
  }
}

function coreReferences(core: SelectCore, name: string): boolean {
  return core.kind === 'select' && fromReferences(core.from, name);
}

/** Whether a SELECT reads table `name` in one of its FROM clauses (the recursion of a CTE). */
function selectReferences(s: SelectStmt, name: string): boolean {
  if (s.with?.ctes.some((c) => sameName(c.name, name))) return false; // shadowed
  return coreReferences(s.core, name) || s.compound.some((c) => coreReferences(c.core, name));
}

function containsWindow(e: Expr | undefined): boolean {
  if (!e) return false;
  let found = false;
  walk(e, (x) => {
    if (x.kind === 'call' && x.over !== undefined) {
      found = true;
      return false;
    }
  });
  return found;
}

/** Shape of an expression for matching against index definitions: no positions, no table qualifiers. */
/** Aggregates whose result does not depend on input order (sum/avg of REAL up to rounding). */
const ORDER_INSENSITIVE_AGGS = new Set(['count', 'sum', 'total', 'avg', 'min', 'max']);

/**
 * Let index scans under `op` fetch rows in rowid order: the caller guarantees the row order is not
 * observable. Only descends through operators that pass the row multiset on unchanged.
 */
export function markUnordered(op: Operator): void {
  if (op instanceof IndexScan) op.unordered = true;
  else if (op instanceof Filter || op instanceof Project || op instanceof NestedLoopJoin || op instanceof HashJoin || op instanceof OuterJoin || op instanceof Materialize) {
    for (const c of op.children) markUnordered(c);
  }
}

function exprShapeKey(e: Expr): string {
  return JSON.stringify(e, (k, v) => {
    if (k === 'pos' || k === 'end' || k === 'table' || k === 'schema') return undefined;
    if (k === 'name' && typeof v === 'string') return v.toLowerCase();
    if (typeof v === 'bigint') return `${v}n`;
    if (v instanceof Uint8Array) return [...v];
    return v;
  });
}

