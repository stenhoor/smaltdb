import type { TableStats } from './stats.js';
import { type FrameSpec, WINDOW_ARITY, Window, type WindowCallKind, type WindowDef } from './window.js';

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
import { type IndexEval, type IndexSchema, type TableSchema, isColumnar, storageTypeFor } from '../catalog/schema.js';
import { type BTree, BTreeCursor } from '../storage/btree.js';
import { KEY_AFTER_NULL, decodeKey, rowidSuffixStart } from '../storage/key-codec.js';
import { RecordReader } from '../storage/record.js';
import { Collation, type SqlValue } from '../values.js';
import { type Affinity, type StaticType, affinityOfStorage, hashKey, hashKeyMulti, staticTypeOfStorage, truthy } from './convert.js';
import {
  CollSrc,
  type Compiled,
  type Fn,
  boundMetadata,
  compileBoundExpr,
  compilePlanExpr,
  comparisonCollation,
  pipelineCompiler,
  planHasSubquery,
  comparisonConverters,
} from './expr.js';
import { type AggregateState, type FunctionContext, aggregateFunctions, scalarFunctions } from './functions.js';
import { type ColumnarHelpers, type FusedAggSpec, type FusedHelpers, type PipelineSource, codegenEnabled, generateFusedAggregate, generateGroupAggregate, generateScanFilter } from './codegen.js';
import { CODEGEN_HELPERS_FOR_FUSION } from './expr.js';
import { getMeta, isFlattened, isOpaque, setMeta } from './sql-meta.js';
import { type CompareOp, traitsOf, withoutComparisonConversion } from './traits.js';
import { isEngineOperation } from './sql-functions.js';
import { printExpr } from '../plan/print.js';
import type { Frame } from '../storage/pager.js';
import { PH_RIGHT } from '../storage/format.js';

/** Aggregates generated pipelines can step (one argument, with step1). */
const FUSABLE_AGGS = new Set([
  'count', 'sum', 'total', 'avg', 'min', 'max',
  // statistics (stat-aggregates.ts)
  'var_samp', 'variance', 'var_pop', 'stddev_samp', 'stddev', 'stddev_pop', 'skewness', 'skewness_pop', 'kurtosis', 'kurtosis_pop', 'median',
]);
/** Two-argument aggregates generated pipelines can step (with step2). */
const FUSABLE_AGGS2 = new Set(['covar_samp', 'covar_pop', 'corr', 'percentile', 'percentile_cont', 'percentile_disc']);
import {
  type AggSpec,
  Compound,
  ColumnScan,
  CountRows,
  Distinct,
  type ExecState,
  Filter,
  FusedGroupAggregate,
  ColumnarTableScan,
  ColumnScanRun,
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
import { type ColumnStore, ROW_GROUP_ROWS, type Zone, zoneMayMatch } from '../storage/columnar.js';
import { SpillRestart, type SpillArea, rowBytes } from './spill.js';
import { type BoundExpr, type PlanExpr, lit } from '../plan/expr.js';
import type { AggCall, JoinKind, PlanOp, SortKey as PlanSortKey } from '../plan/ops.js';
import type { CollationName } from '../plan/types.js';
import type { ExternalSource } from '../external/external.js';

/**
 * The physical environment the planner plans against (ADR 0015 section 3): tables with their storage, the rows of
 * virtual tables and external sources, trees, statistics, spilling and execution state. Languages bind against the
 * logical catalog instead (plan/bind-context.ts `BindContext`).
 */
export interface PhysicalEnv {
  /** A table by name; `schema` 'main' / 'temp' picks that schema when a TEMP table shadows a main one. */
  getTable(name: string, schema?: string): TableSchema | undefined;
  /**
   * Virtual tables: `information_schema.<name>` (schema 'information_schema') and table-valued
   * functions such as `pragma_table_info(t)` (schema undefined). Rows are computed at open.
   */
  virtualTable?(schema: string | undefined, name: string): { columns: { name: string; type: StaticType }[]; rows: (args: SqlValue[]) => SqlValue[][] } | undefined;
  openTree(rootPage: number): BTree;
  /** On-demand statistics for a table without ANALYZE results (sampled; cached by the database). */
  sampledStats?(table: TableSchema): TableStats | undefined;
  /** Reader for the segments of a columnar materialized view or table. */
  columnStore?(table: TableSchema): ColumnStore;
  /** Estimated rows of a table (columnar storage counts its segments); default: the tree's shape. */
  liveRows?(table: TableSchema): number;
  /** Columnar table: rowids hidden in its segments (read per scan), null when none. */
  deletedRows?(table: TableSchema): Set<number | bigint> | null;
  funcCtx: FunctionContext;
  state: ExecState;
  /** Scratch file for sorts and hash aggregates that outgrow work_mem (M7.2). */
  spill?: SpillArea | null;
  /**
   * Materialized-view matching on plans (exec/plan-mv-match.ts), under the statement's policy: the planner applies it
   * to the plans it builds itself (a decorrelated subquery's inner side).
   */
  rewritePlan?(plan: PlanOp): PlanOp;
  /** M8: an external table by name (its columns from the catalog; its rows once loaded). */
  externalTable?(name: string): ExternalScan | undefined;
  /** M8: a table function over external data (`read_csv`, `read_json`) called with constant arguments; undefined for other functions. */
  externalFunction?(name: string, args: SqlValue[], named: Record<string, SqlValue>): ExternalScan | undefined;
}

/** Table functions that read external data (their arguments must be constants). */

/** An external source as the planner scans it. */
export interface ExternalScan {
  /** For EXPLAIN. */
  label: string;
  source: ExternalSource;
  columns: { name: string; type: StaticType; declType: string }[];
  /** The loaded rows (throws SMALT_ASYNC_REQUIRED when they were not loaded). */
  rows(): SqlValue[][];
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
  /** The join condition's conjuncts, bound from the plan. */
  onBound?: BoundConjunct[];
  position: number;
  /** Cached row-count estimate. */
  estRows?: number;
  /** External data (M8): projection and pruning are attached to its source. */
  external?: ExternalSource;
  /** An external table (not a table function): partition pruning applies. */
  externalTable?: boolean;
}

const TEMP_CATALOG = new Set(['sqlite_temp_schema', 'sqlite_temp_master']);

/** How a FROM item joins the items before it. */
type JoinType = 'INNER' | 'LEFT' | 'RIGHT' | 'FULL' | 'CROSS';

function sameName(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase();
}

class Scope {
  sources: Source[] = [];
  correlated = false;
  constructor(readonly parent: Scope | null) {}
}

/** A Filter on a pool conjunct: compiled from its bound form (bound once, when the pool was built). */
function filterOnConjunct(child: Operator, c: ConjunctInfo, ctx: FunctionContext): Filter {
  if (!c.compilable) {
    const b = c.lazy!();
    return new Filter(child, compileBoundExpr(b, ctx).fn, b);
  }
  return new Filter(child, compileBoundExpr(c.bound, ctx).fn, c.bound);
}

/** The comparison operators that can probe an index or the rowid (from a function's `compare` trait). */
const PROBE_OPS = new Set<CompareOp>(['=', '<', '<=', '>', '>=', 'IS']);

/** The operator a call can probe an index or the rowid with (its `compare` trait), if any. */
const probeOp = (fn: string): CompareOp | undefined => {
  const op = traitsOf(fn).compare;
  return op !== undefined && PROBE_OPS.has(op) ? op : undefined;
};

/** True for an equality comparison of two operands (an equi-join). */
const isEquality = (e: BoundExpr): e is Extract<BoundExpr, { k: 'call' }> => e.k === 'call' && traitsOf(e.fn).compare === '=' && !isOpaque(e);

/** The operand of a bound comparison, without the comparison-only conversion around it (SQL's affinity). */
const unconvertedOperand = <E extends BoundExpr>(x: E): E => withoutComparisonConversion(x);

/** Visit the register slots of a bound expression (not inside compiled nodes or nested plans). */
function forEachSlot(e: BoundExpr, f: (reg: number) => void): void {
  switch (e.k) {
    case 'slot':
      f(e.reg);
      return;
    case 'call':
    case 'and':
    case 'or':
      for (const a of e.args) forEachSlot(a, f);
      return;
    case 'cast':
    case 'not':
    case 'isNull':
      forEachSlot(e.arg, f);
      return;
    case 'case':
      for (const w of e.whens) {
        forEachSlot(w.when, f);
        forEachSlot(w.then, f);
      }
      forEachSlot(e.else, f);
      return;
    case 'inSubquery':
      forEachSlot(e.probe, f);
      return;
    default:
      return;
  }
}

interface ConjunctInfo {
  /**
   * The conjunct bound to a plan expression, which the access-path and cost analysis read (ADR 0014, step 6a). A
   * conjunct with a subquery is bound for analysis only: its subqueries are placeholders, and `lazy` binds it with its
   * subqueries planned when it is placed.
   */
  bound: BoundExpr;
  compilable: boolean;
  /** Positions of current-scope sources referenced; null = depends on everything (subqueries). */
  deps: Set<number> | null;
  placed: boolean;
  /** RIGHT/FULL JOIN: earliest step (FROM position) at which this WHERE conjunct may be applied. */
  minStep?: number;
  /** Not compilable and bound from a plan: binds it with its subqueries planned (the physical planner). */
  lazy?: () => BoundExpr;
}

/** FROM items, join conditions and WHERE conjuncts the physical planner bound from a plan (see planFrom). */
interface BoundFrom {
  items: { item: PlanLeaf; joinType: JoinType }[];
  /** A table function's arguments (item `p`), bound to the earlier items' registers. */
  args(p: number): BoundExpr[] | undefined;
  /** An external table function's named arguments (item `p`), bound. */
  named?(p: number): Record<string, BoundExpr> | undefined;
  /** Item `p` planned (a nested plan), or undefined: registered from its FROM item. `working`: a recursive step's rows. */
  source(p: number): { plan: QueryPlan; working?: boolean } | undefined;
  /** Item `p` was registered: its registers are known. */
  added(p: number): void;
  /** Item `p`'s join condition, split into conjuncts. */
  on(p: number): BoundConjunct[];
  where(): BoundConjunct[];
}

/**
 * A conjunct bound from a plan. With a subquery, `bound` is for analysis only (its subqueries are placeholders) and
 * `compile` binds it with its subqueries planned, when it is placed.
 */
interface BoundConjunct {
  bound: BoundExpr;
  compile?: () => BoundExpr;
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
    readonly env: PhysicalEnv,
    readonly regs: Registers,
  ) {}

  // ================================================================ SELECT

  /** Resolve `OVER name` / `OVER (base ...)` against the core's WINDOW clause, like SQLite. */
  /**
   * Fuse `Filter* -> full TableScan` under an ungrouped aggregate into one generated function
   * (FusedScanAggregate). Returns null when the shape or the aggregates do not qualify.
   */
  /** Match `Filter* -> forward full TableScan`; returns the scan and the predicate ASTs (outermost last). */
  private scanChain(src: Operator): { scan: TableScan | ColumnScan | ColumnarTableScan; preds: BoundExpr[] } | null {
    if (!codegenEnabled()) return null;
    const preds: BoundExpr[] = [];
    let node: Operator = src;
    while (node instanceof Filter) {
      if (!node.expr || planHasSubquery(node.expr)) return null;
      preds.push(node.expr);
      node = node.child;
    }
    if (node instanceof ColumnScan || node instanceof ColumnarTableScan) return { scan: node, preds: preds.reverse() };
    if (!(node instanceof TableScan) || node.lo || node.hi || node.reverse) return null;
    return { scan: node, preds: preds.reverse() };
  }

  private fusedAggSpecs(aggs: AggSpec[]): FusedAggSpec[] | null {
    const specs: FusedAggSpec[] = [];
    for (const a of aggs) {
      const two = FUSABLE_AGGS2.has(a.name) && a.argExprs.length === 2;
      if (a.distinct || (!two && (!FUSABLE_AGGS.has(a.name) || a.argExprs.length > 1))) return null;
      if ([a.filterExpr, ...a.argExprs].some((x) => x !== undefined && planHasSubquery(x))) return null;
      if (a.name === 'count') specs.push(a.star ? { kind: 'countStar', filter: a.filterExpr } : { kind: 'count', arg: a.argExprs[0], filter: a.filterExpr });
      else if (two) specs.push({ kind: 'step2', arg: a.argExprs[0], arg2: a.argExprs[1], filter: a.filterExpr });
      else specs.push({ kind: 'step', arg: a.argExprs[0], filter: a.filterExpr });
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
    if (!chain || !(chain.scan instanceof TableScan)) return src;
    const { scan, preds } = chain;
    const access = scan.access;
    const ctx = this.env.funcCtx;
    const helpers = this.fusedHelpers(access);
    const table = access.table!;
    const build = (cap: number) => {
      const spec = access.loaderSpec();
      const outs: { reg: number; type: StaticType }[] = [];
      for (let i = 0; i < spec.decode.length; i += 2) {
        const t = table.columns[spec.decode[i]].type;
        outs.push({ reg: spec.decode[i + 1], type: t === 'INTEGER' ? 'int' : t === 'REAL' ? 'real' : 'any' });
      }
      for (const reg of spec.rowidRegs) outs.push({ reg, type: 'int' });
      const fill = generateScanFilter(preds, outs, cap, () => access.loaderSpec(), helpers, pipelineCompiler(ctx));
      return { fill, regs: outs.map((o) => o.reg) };
    };
    return new FusedScanFilter(access, build, helpers.first, helpers.release);
  }

  /** Scan + filter + GROUP BY + aggregates in one generated loop. */
  private tryFuseGroupAggregate(src: Operator, groupExprs: BoundExpr[], groupColls: Collation[], groupRegs: number[], aggs: AggSpec[], scope: Scope): Operator | null {
    const chain = this.scanChain(src);
    const specs = this.fusedAggSpecs(aggs);
    if (!chain || !specs || groupExprs.some(planHasSubquery)) return null;
    const access = chain.scan.access;
    const ctx = this.env.funcCtx;
    const node = chain.scan;
    const spill = this.env.spill;
    // Group memory of the current run (reset at open): past the limit the fused loop gives up.
    const budget = spill ? { used: 0, limit: Infinity, area: spill } : null;
    const helpers = {
      hashKey,
      hashKeyMulti: (values: SqlValue[], colls: number[]) => hashKeyMulti(values, colls),
      newGroup: (keys: SqlValue[]) => {
        if (budget !== null && (budget.used += 96 + 64 * aggs.length + rowBytes(keys)) > budget.limit) throw SpillRestart;
        return { keys, st: aggs.map((a) => a.def.create(a.star ? [] : a.argTypes, a.collation)) };
      },
    };
    const groupSpecs = groupExprs.map((expr, i) => ({ expr, collation: groupColls[i] }));
    const gen = (scan: TableScan | ColumnScan) =>
      generateGroupAggregate(chain.preds, groupSpecs, specs, this.pipelineSource(scan), { ...helpers, ...(scan instanceof ColumnScan ? this.columnarHelpers(scan) : this.fusedHelpers(access)) }, pipelineCompiler(ctx));
    // A columnar table: one loop over the delta store's leaves, one over the segments, same groups.
    const build =
      node instanceof ColumnarTableScan
        ? () => {
            const a = gen(node.delta);
            const b = gen(node.segments);
            return (r: SqlValue[], groups: Map<unknown, unknown>, order: unknown[]) => {
              a(r, groups, order);
              b(r, groups, order);
            };
          }
        : () => gen(node);
    return new FusedGroupAggregate(access, build, groupRegs, aggs, node instanceof TableScan ? undefined : node.fusedLabel('group aggregate'), budget);
  }

  private tryFuseAggregate(src: Operator, aggs: AggSpec[], scope: Scope): Operator | null {
    if (aggs.length === 0) return null;
    const chain = this.scanChain(src);
    const specs = this.fusedAggSpecs(aggs);
    if (!chain || !specs) return null;
    const { scan: node, preds } = chain;
    const access = node.access;
    const ctx = this.env.funcCtx;
    if (node instanceof ColumnScan) {
      const run = generateFusedAggregate(preds, specs, this.pipelineSource(node), this.columnarHelpers(node), pipelineCompiler(ctx));
      return new FusedScanAggregate(access, aggs, run as (r: SqlValue[], states: AggregateState[]) => void, node.fusedLabel('aggregate'));
    }
    if (node instanceof ColumnarTableScan) {
      // The delta store's leaves, then the segments, stepping the same aggregate states.
      const a = generateFusedAggregate(preds, specs, this.pipelineSource(node.delta), this.fusedHelpers(access), pipelineCompiler(ctx));
      const b = generateFusedAggregate(preds, specs, this.pipelineSource(node.segments), this.columnarHelpers(node.segments), pipelineCompiler(ctx));
      const run = (r: SqlValue[], states: AggregateState[]): void => {
        a(r, states);
        b(r, states);
      };
      return new FusedScanAggregate(access, aggs, run, node.fusedLabel('aggregate'));
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
    const run = generateFusedAggregate(preds, specs, { rows: () => access.loaderSpec() }, helpers, pipelineCompiler(ctx));
    return new FusedScanAggregate(access, aggs, run as (r: SqlValue[], states: AggregateState[]) => void);
  }

  /** Rows source for generated pipelines: leaf pages, or the column store of a columnar scan. */
  private pipelineSource(node: TableScan | ColumnScan): PipelineSource {
    const access = node.access;
    if (node instanceof TableScan) return { rows: () => access.loaderSpec() };
    return { columns: () => ({ decode: access.decode, rowidRegs: access.rowidReg >= 0 ? [access.rowidReg, ...access.extraRowidRegs] : [], segments: node.segments !== null }) };
  }

  /** Column-store access for generated loops over a columnar scan (zone maps evaluated per execution). */
  private columnarHelpers(node: ColumnScan): ColumnarHelpers {
    let run: ColumnScanRun;
    return {
      ...CODEGEN_HELPERS_FOR_FUSION,
      RG: ROW_GROUP_ROWS,
      open: (r) => {
        run = new ColumnScanRun(node, r);
      },
      groups: () => run.store.rowGroups,
      keep: (g) => run.keep(g),
      rows: (g) => run.store.meta(g).rows,
      chunk: (g, c) => run.store.chunk(g, c),
      ...(node.segments !== null
        ? {
            rowids: (g: number) => run.rowids(g)!,
            deleted: (g: number) => run.deletedFlags(g),
          }
        : {}),
    };
  }

  // ================================================================ physical planner (ADR 0014, step 6b)

  /**
   * Operators for a plan of the SQL front end (smaltql's frontend/select.ts) that reads one table or no FROM: the same
   * operators, registers and fusion as `planCore` builds for the statement. Null for shapes it does not handle yet
   * (joins, nested plans, windows, compounds, VALUES, other sources); the caller then plans the statement's AST.
   * Plans are checked before anything is allocated, so a null leaves the planner as it was.
   */
  planPlan(op: PlanOp, columns: ResultColumnInfo[]): QueryPlan | null {
    if (!supportedPlan(op, 0)) return null;
    return this.physicalAny(op, columns, null);
  }

  /**
   * A `delete` plan's target rows (ADR 0014, step 8a), as `Database.planTarget` plans them: the scan with its WHERE,
   * reading the rowid; then registers for the deleted row and its RETURNING, as `Database.compileReturning`
   * compiles it. Null for plans it does not handle.
   */
  planDelete(op: Extract<PlanOp, { op: 'delete' }>): { root: Operator; rowidReg: number; oldBase: number; oldRowid: number; returning: Fn[] | undefined } | null {
    let n = op.input;
    let where: BoundExpr | undefined;
    if (n.op === 'filter') {
      where = n.pred;
      n = n.input;
    }
    if (n.op !== 'scan') return null;
    if ((where && !readsRows(where, 0)) || !(op.returning ?? []).every((e) => readsRows(e, 0))) return null;
    const table = this.env.getTable(n.table, n.db);
    if (!table) return null;
    const scope = new Scope(null);
    const b = this.bindings(scope, null);
    const root = this.planFromShape([{ op: n, join: null }], where, scope, null, b);
    // The writer reads each row by its rowid.
    const rowid = b.fromRow[op.rowid];
    b.useOf(rowid)();
    const ncols = table.columns.length;
    const oldBase = this.regs.alloc(ncols);
    const oldRowid = this.regs.alloc();
    const returning = op.returning && this.compileRowExprs(op.returning, ncols, oldBase, oldRowid);
    return { root, rowidReg: rowid.reg, oldBase, oldRowid, returning };
  }

  /**
   * An `update` plan's target rows and SET values (ADR 0014, step 8b), as `Database.compileUpdate` plans them: the
   * target (joined with the FROM sources) with its WHERE, reading the rowid; the registers of the target's columns
   * (the writer loads each old row there before the SET values read it); then the SET values over the FROM row.
   * Null for plans it does not handle.
   */
  planUpdate(op: Extract<PlanOp, { op: 'update' }>): { root: Operator; rowidReg: number; colRegs: number[]; sets: { column: number; c: Compiled }[] } | null {
    let n = op.input;
    let where: BoundExpr | undefined;
    if (n.op === 'filter') {
      where = n.pred;
      n = n.input;
    }
    const from = fromLeaves(n);
    if (!from || from[0].op.op !== 'scan' || !from.every((l, i) => i === 0 || supportedLeaf(l.op, 0))) return null;
    const exprs = [where, ...from.map((l) => l.on), ...op.sets.map((x) => x.value), ...(op.returning ?? [])];
    if (!exprs.every((e) => e === undefined || readsRows(e, 0))) return null;
    const table = this.env.getTable(from[0].op.table, from[0].op.db);
    if (!table) return null;
    const scope = new Scope(null);
    const b = this.bindings(scope, null);
    const root = this.planFromShape(from, where, scope, null, b);
    const rowid = b.fromRow[op.rowid];
    b.useOf(rowid)();
    const colRegs = table.columns.map((_c, i) => b.fromRow[i].reg);
    // Target rowids are collected and sorted before any change: scan order is not observable.
    if (!op.from) markUnordered(root);
    const sets = op.sets.map((x) => ({ column: x.column, c: compileBoundExpr(b.bind(x.value, b.fromSlot), this.env.funcCtx) }));
    return { root, rowidReg: rowid.reg, colRegs, sets };
  }

  /**
   * Expressions over a written row held in registers (RETURNING): the table's `ncols` columns from `base`, then its
   * rowid in `rowidReg`.
   */
  compileRowExprs(exprs: readonly BoundExpr[], ncols: number, base: number, rowidReg: number): Fn[] {
    return this.compileAt(exprs, (i) => (i < ncols ? base + i : rowidReg)).map((c) => c.fn);
  }

  /** Expressions whose columns are registers: column `i` reads `regOf(i)` (for VALUES rows: none). */
  compileAt(exprs: readonly BoundExpr[], regOf: (index: number) => number, ctx: FunctionContext = this.env.funcCtx): Compiled[] {
    const b = this.bindings(new Scope(null), null);
    const row: ColMap = (c) => slotFor(c, regOf(c.index));
    return exprs.map((e) => compileBoundExpr(b.bind(e, row), ctx));
  }

  /**
   * How a plan's expressions bind to registers in `scope`: `fromRow` holds the FROM row's registers (filled by
   * `planFromShape`), `fromSlot` maps its columns, and `bind` binds an expression with its subqueries planned. Columns of
   * enclosing operations (depth > 0) go through `outer`, which marks the scope correlated.
   */
  private bindings(scope: Scope, outer: ColMap | null): Bindings {
    const up =
      (m: ColMap): ColMap =>
      (c) => {
        if (c.depth === 0) return m(c);
        scope.correlated = true;
        return outer!(shallower(c));
      };
    const sub = (n: BoundExpr, f: ColMap): BoundExpr => this.subqueryExpr(n, f);
    // `col`: the table column (-1: the rowid), or the source's column. Marking it read is the slot's `use`.
    const fromRow: FromCell[] = [];
    const useOf = (f: FromCell): (() => void) => {
      const { reg, src, col } = f;
      if (src.access) return col < 0 ? () => this.dryCompile || src.access!.useRowid(reg) : () => this.dryCompile || src.access!.use(col, reg);
      return () => this.dryCompile || src.external?.projection?.add(src.cols[col].name.toLowerCase());
    };
    return {
      bind: (e, m) => rebind(e, up(m), sub),
      analysis: (e, m) => rebind(e, up(m)),
      fromRow,
      useOf,
      fromSlot: (c) => slotFor(c, fromRow[c.index].reg, useOf(fromRow[c.index])),
    };
  }

  /**
   * FROM and WHERE of a plan: the join region over `from` (or one empty row), with the WHERE conjuncts. The FROM row's
   * registers are each source's columns, in FROM order, marked as read when an expression reading them is compiled;
   * join conditions read input 0 (the sources before) and input 1 (the source being joined).
   */
  private planFromShape(from: FromLeaf[] | null, where: BoundExpr | undefined, scope: Scope, outer: ColMap | null, b: Bindings): Operator {
    const { bind, fromSlot, fromRow, useOf } = b;
    // A WHERE / ON conjunct with a subquery is bound for analysis with placeholders, and planned where it is placed.
    const conjunct = (e: BoundExpr, m: ColMap): BoundConjunct => (hasNested(e) ? { bound: b.analysis(e, m), compile: () => bind(e, m) } : { bound: bind(e, m) });
    if (!from) {
      this.lastScan = null;
      const root = new SingleRow();
      return where ? new Filter(root, compileBoundExpr(bind(where, fromSlot), this.env.funcCtx).fn) : root;
    }
    const leaves = from;
    const offsets: number[] = [];
    leaves.reduce((at, l) => (offsets.push(at), at + planWidth(l.op)), 0);
    const onSlot =
      (p: number): ColMap =>
      (c) => {
        const f = fromRow[c.input === 1 ? offsets[p] + c.index : c.index];
        return slotFor(c, f.reg, useOf(f));
      };
    return this.planFrom(scope, {
      items: leaves.map((l, p) => ({ item: planLeaf(l.op, p), joinType: JOIN_TYPES[l.join ?? 'inner'] })),
      // Nested plans read the rows of the operation this one is evaluated in, as derived tables do.
      source: (p) => {
        const l = leaves[p].op;
        if (l.op === 'scan' || l.op === 'source') return undefined;
        if (l.op === 'working') {
          const w = this.workings.get(l.id)!;
          return { plan: { root: w.scan, outRegs: w.regs, columns: w.columns, correlated: true }, working: true };
        }
        return { plan: l.op === 'iterate' ? this.physicalIterate(l, outer) : this.physicalAny(l, null, outer) };
      },
      args: (p) => {
        const l = leaves[p].op;
        return l.op === 'source' && l.kind === 'function' ? l.args.map((a) => bind(a, fromSlot)) : undefined;
      },
      named: (p) => {
        const l = leaves[p].op;
        return l.op === 'source' && l.named ? Object.fromEntries(Object.entries(l.named).map(([k, a]) => [k, bind(a, fromSlot)])) : undefined;
      },
      added: (p) => {
        const src = scope.sources[p];
        const l = leaves[p].op;
        if (l.op === 'scan') for (const c of l.columns) fromRow.push({ reg: c < 0 ? src.rowidReg : src.cols[c].reg, src, col: c });
        else for (let i = 0; i < src.cols.length; i++) fromRow.push({ reg: src.cols[i].reg, src, col: i });
      },
      on: (p) => (leaves[p].on ? splitBoundConjuncts(leaves[p].on!).map((c) => conjunct(c, onSlot(p))) : []),
      where: () => (where ? splitBoundConjuncts(where).map((c) => conjunct(c, fromSlot)) : []),
    });
  }

  /**
   * A plan `supportedPlan` accepts: a SELECT core (`physical`), or VALUES or a compound with its ORDER BY and LIMIT,
   * as `planSelect` plans them. `outRegs`: the registers to write the results to (the cores of a compound and the
   * steps of a recursive CTE share them).
   */
  private physicalAny(op: PlanOp, given: ResultColumnInfo[] | null, outer: ColMap | null, outRegs?: number[]): QueryPlan {
    if (flatShape(op)) return this.physical(op, given, outer, outRegs);
    let n = op;
    const lim = n.op === 'limit' ? n : null;
    if (lim) n = lim.input;
    const sort = n.op === 'sort' ? n.keys : null;
    if (sort) n = (n as Extract<PlanOp, { op: 'sort' }>).input;
    let plan: QueryPlan;
    if (n.op === 'values') plan = this.physicalValues(n, given, outer, outRegs, sort);
    else {
      // A compound: every core writes the first core's registers.
      const cores: PlanOp[] = [];
      const ops: ('UNION' | 'UNION ALL' | 'INTERSECT' | 'EXCEPT')[] = [];
      let c: PlanOp = n;
      while (c.op === 'setop') {
        cores.unshift(c.inputs[1]);
        ops.unshift(SETOPS[c.kind]);
        c = c.inputs[0];
      }
      const first = this.physicalAny(c, null, outer, outRegs);
      const regs = first.outRegs;
      let root = first.root;
      let correlated = first.correlated;
      cores.forEach((core, i) => {
        const next = this.physicalAny(core, null, outer, regs);
        correlated ||= next.correlated;
        root = new Compound(root, next.root, ops[i], regs, first.columns.map((x) => x.collation));
      });
      const columns = given ?? first.columns;
      if (sort) root = new Sort(root, sort.map((k) => this.resultKey(k, regs, columns)), regs, undefined, this.env.spill ?? null);
      plan = { root, outRegs: regs, columns, correlated };
    }
    if (lim) {
      const bind = (e: BoundExpr): Fn => compileBoundExpr(rebind(e, NO_COLUMNS, (m, f) => this.subqueryExpr(m, f)), this.env.funcCtx).fn;
      plan.root = new Limit(plan.root, bind(lim.count), lim.offset ? bind(lim.offset) : undefined);
    }
    return plan;
  }

  /** A compound's (or VALUES') ORDER BY key: a result position, with the result column's collation. */
  private resultKey(k: PlanSortKey, regs: number[], columns: ResultColumnInfo[]): SortKey {
    const at = (k.expr as ColRef).index;
    return { reg: regs[at], desc: k.desc, nullsFirst: k.nullsFirst, collation: columns[at].collation };
  }

  /** VALUES (`planValues`), with its ORDER BY when it is the statement's only core. */
  private physicalValues(op: Extract<PlanOp, { op: 'values' }>, given: ResultColumnInfo[] | null, outer: ColMap | null, outRegs: number[] | undefined, sort: readonly PlanSortKey[] | null): QueryPlan {
    const scope = new Scope(null);
    const f: ColMap = (c) => {
      scope.correlated = true;
      return outer!(shallower(c));
    };
    const compiled = op.rows.map((r) => r.map((e) => compileBoundExpr(rebind(e, f, (m, g) => this.subqueryExpr(m, g)), this.env.funcCtx)));
    const regs = outRegs ?? compiled[0].map(() => this.regs.alloc());
    const columns = given ?? compiled[0].map((c, i) => ({ name: `column${i + 1}`, type: c.type, collation: Collation.Binary, affinity: 'NONE' as Affinity }));
    let root: Operator = new Values(compiled.map((r) => r.map((c) => c.fn)), regs);
    if (sort) root = new Sort(root, sort.map((k) => ({ ...this.resultKey(k, regs, columns), collation: Collation.Binary })), regs, undefined, this.env.spill ?? null);
    return { root, outRegs: regs, columns, correlated: scope.correlated };
  }

  /** The working rows of the recursive CTEs being planned, by `iterate` id. */
  private readonly workings = new Map<number, { scan: WorkingScan; regs: number[]; columns: ResultColumnInfo[] }>();

  /** A recursive CTE (`planRecursiveCte`): its initial rows, then its steps until one gives no rows. */
  private physicalIterate(op: Extract<PlanOp, { op: 'iterate' }>, outer: ColMap | null): QueryPlan {
    const initPlan = this.physicalAny(op.init, null, outer);
    const outRegs = initPlan.outRegs;
    const columns = initPlan.columns;
    const wregs = outRegs.map(() => this.regs.alloc());
    const scan = new WorkingScan(op.name, wregs);
    this.workings.set(op.id, { scan, regs: wregs, columns });
    let correlated = initPlan.correlated;
    const steps = op.steps.map((step) => {
      const p = this.physicalAny(step, null, outer, outRegs);
      correlated ||= p.correlated;
      return p.root;
    });
    const order = op.order?.length
      ? op.order.map((k) => {
          const at = (k.expr as ColRef).index;
          return { index: at, desc: k.desc, nullsFirst: k.nullsFirst, collation: columns[at].collation };
        })
      : null;
    const bind = (e: BoundExpr): Fn => compileBoundExpr(rebind(e, NO_COLUMNS, (m, f) => this.subqueryExpr(m, f)), this.env.funcCtx).fn;
    const root = new RecursiveCte(op.name, initPlan.root, steps, outRegs, scan, op.distinct, columns.map((c) => c.collation), order, op.limit ? bind(op.limit) : undefined, op.offset ? bind(op.offset) : undefined);
    return { root, outRegs, columns, correlated };
  }

  /**
   * Operators for a plan `supportedPlan` accepts. `outer` maps the columns of the enclosing operation's row for a
   * subquery's plan (its columns with depth > 0), null at the top; `given` are the result columns (computed when
   * null).
   */
  private physical(op: PlanOp, given: ResultColumnInfo[] | null, outer: ColMap | null, outRegs?: number[]): QueryPlan {
    const s = flatShape(op)!;
    const ctx = this.env.funcCtx;
    const compile = (e: BoundExpr): Compiled => compileBoundExpr(e, ctx);
    const scope = new Scope(null);
    const b = this.bindings(scope, outer);
    const { bind, fromSlot, fromRow, useOf } = b;
    const limitFns = (): [Fn, Fn | undefined] => [compile(bind(s.limit!.count, NO_COLUMNS)).fn, s.limit!.offset ? compile(bind(s.limit!.offset, NO_COLUMNS)).fn : undefined];
    const limit = (root: Operator): Operator => (s.limit ? new Limit(root, ...limitFns()) : root);

    const fast = this.countRowsOf(s, given, outRegs);
    if (fast) return { ...fast, root: limit(fast.root) };
    let root = this.planFromShape(s.from, s.where, scope, outer, b);

    // The aggregate's output row: keys, then aggregate calls (registers allocated where first read, as planCore
    // does while binding), then carried bare columns (the FROM row's registers).
    let agg: { groupFns: Fn[]; groupColls: Collation[]; groupRegs: number[]; groupExprs: BoundExpr[]; aggs: AggSpec[]; bare: Set<number> } | null = null;
    let outSlot = fromSlot;
    if (s.aggregate) {
      const a = s.aggregate;
      const keys = a.keys.map((k) => bind(k.expr, fromSlot));
      const groupFns = keys.map((k) => compile(k).fn);
      const groupRegs = keys.map(() => this.regs.alloc());
      const specs: AggSpec[] = [];
      const byCall = new Map<number, AggSpec>();
      const bare = new Set<number>();
      const g = { groupFns, groupColls: a.keys.map((k) => collationId(k.collation)), groupRegs, groupExprs: keys, aggs: specs, bare };
      agg = g;
      const spec = (i: number): AggSpec => {
        let sp = byCall.get(i);
        if (sp === undefined) {
          sp = this.aggSpec(a.aggs[i], (e) => bind(e, fromSlot));
          byCall.set(i, sp);
          specs.push(sp);
        }
        return sp;
      };
      outSlot = (c) => {
        const i = c.index;
        if (i < a.keys.length) return slotFor(c, groupRegs[i]);
        if (i < a.keys.length + a.aggs.length) return slotFor(c, spec(i - a.keys.length).outReg);
        const from = a.carry[i - a.keys.length - a.aggs.length] as ColRef;
        const f = fromRow[from.index];
        bare.add(f.reg);
        return slotFor(c, f.reg, useOf(f));
      };
    }

    // Window calls: their window is defined, and their registers allocated, where first read (as `windowRef`).
    const windowDefs: WindowDef[] = [];
    let readSlot = outSlot;
    if (s.windows.length) {
      const base = s.aggregate ? s.aggregate.keys.length + s.aggregate.aggs.length + s.aggregate.carry.length : fromRow.length;
      const defs = new Map<number, WindowDef>();
      const calls = new Map<number, number>();
      const at: { w: number; c: number }[] = s.windows.flatMap((w, wi) => w.calls.map((_c, ci) => ({ w: wi, c: ci })));
      const windowReg = (j: number): number => {
        let reg = calls.get(j);
        if (reg !== undefined) return reg;
        const w = s.windows[at[j].w];
        const call = w.calls[at[j].c];
        const args = call.args.map((x) => compile(bind(x, outSlot)));
        let def = defs.get(at[j].w);
        if (def === undefined) {
          const partition = w.partition.map((x) => compile(bind(x.expr, outSlot)).fn);
          const order = w.order.map((k) => ({ fn: compile(bind(k.expr, outSlot)).fn, desc: k.desc, nullsFirst: k.nullsFirst, collation: collationId(k.collation) }));
          const offset = (b: { offset?: BoundExpr }): Fn | undefined => (b.offset ? compile(bind(b.offset, outSlot)).fn : undefined);
          const frame: FrameSpec = {
            unit: w.frame.unit,
            start: { kind: w.frame.start.kind, offset: offset(w.frame.start) },
            end: { kind: w.frame.end.kind, offset: offset(w.frame.end) },
            exclude: w.frame.exclude,
          } as FrameSpec;
          def = { partition, partitionColls: w.partition.map((x) => collationId(x.collation)), order, frame, calls: [] };
          defs.set(at[j].w, def);
          windowDefs.push(def);
        }
        reg = this.regs.alloc();
        calls.set(j, reg);
        const aggDef = aggregateFunctions.get(call.fn);
        const builtin = WINDOW_ARITY[call.fn];
        def.calls.push({
          kind: builtin ? (call.fn as WindowCallKind) : 'aggregate',
          name: call.fn,
          args: args.map((x) => x.fn),
          filter: call.filter ? compile(bind(call.filter, outSlot)).fn : undefined,
          outReg: reg,
          agg: aggDef && !builtin ? { def: aggDef, argTypes: args.map((x) => x.type), collation: args[0]?.collSrc ? args[0].collation : Collation.Binary, star: call.star } : undefined,
        });
        return reg;
      };
      readSlot = (c) => (c.index < base ? outSlot(c) : slotFor(c, windowReg(c.index - base)));
    }

    // Result expressions, then ORDER BY expressions that are not results, then HAVING (planCore's order).
    const n = s.width;
    const compiled = s.project.slice(0, n).map((e) => compile(bind(e, readSlot)));
    const regs = outRegs ?? compiled.map(() => this.regs.alloc());
    const columns: ResultColumnInfo[] =
      given ?? compiled.map((c) => ({ name: '', type: c.type, collation: c.collSrc !== CollSrc.None ? c.collation : Collation.Binary, affinity: c.affinity }));
    const sortKeys: SortKey[] = [];
    const extraFns: Fn[] = [];
    const extraRegs: number[] = [];
    for (const k of s.sort ?? []) {
      const at = (k.expr as ColRef).index;
      let reg: number;
      if (at < n) reg = regs[at];
      else {
        extraFns.push(compile(bind(s.project[at], readSlot)).fn);
        extraRegs.push((reg = this.regs.alloc()));
      }
      sortKeys.push({ reg, desc: k.desc, nullsFirst: k.nullsFirst, collation: collationId(k.collation) });
    }
    const having = s.having ? compile(bind(s.having, outSlot)).fn : undefined;

    if (agg) {
      if (agg.groupFns.length === 0 && agg.bare.size === 0 && agg.aggs.every((x) => ORDER_INSENSITIVE_AGGS.has(x.name))) markUnordered(root);
      const fused =
        agg.bare.size > 0
          ? null
          : agg.groupFns.length === 0
            ? this.tryFuseAggregate(root, agg.aggs, scope)
            : this.tryFuseGroupAggregate(root, agg.groupExprs, agg.groupColls, agg.groupRegs, agg.aggs, scope);
      const hashAgg = new HashAggregate(root, agg.groupFns, agg.groupColls, agg.groupRegs, agg.aggs, [...agg.bare], this.env.spill ?? null);
      if (fused instanceof FusedGroupAggregate) fused.fallback = hashAgg;
      root = fused ?? hashAgg;
      if (having) root = new Filter(root, having);
    }

    // ORDER BY the rowid of a table scan: read the table in rowid order (backwards for DESC), as planCore.
    let sortNeeded = sortKeys.length > 0;
    const single = s.from?.length === 1 && s.from[0].op.op === 'scan' ? s.from[0].op : null;
    if (sortNeeded && !agg && !s.distinct && single && sortKeys.length === 1) {
      const k = s.sort![0];
      const e = s.project[(k.expr as ColRef).index];
      const src = scope.sources[0];
      const scan = this.lastScan;
      const t = src.table!;
      const rowidAt = (i: number): boolean => single.columns[i] === -1 || single.columns[i] === t.rowidAlias;
      if (scan && scan.access === src.access && e.k === 'col' && e.depth === 0 && !isOpaque(e) && rowidAt(e.index) && k.nullsFirst === !k.desc) {
        scan.reverse = k.desc;
        sortNeeded = false;
      }
    }

    if (!agg) root = this.tryFuseScanFilter(root, scope);
    if (windowDefs.length) {
      // Registers the projection reads from each input row (restored by the Window operator).
      const snap = agg
        ? [...agg.groupRegs, ...agg.aggs.map((x) => x.outReg), ...agg.bare]
        : scope.sources.flatMap((src) => [...src.cols.map((c) => c.reg), ...(src.rowidReg >= 0 ? [src.rowidReg] : [])]);
      root = new Window(root, [...new Set(snap)], windowDefs);
    }
    root = new Project(root, [...compiled.map((c) => c.fn), ...extraFns], [...regs, ...extraRegs]);
    if (s.distinct) root = new Distinct(root, regs, s.distinct.map(collationId));
    if (sortNeeded) {
      const hint = s.limit ? topN(...limitFns()) : undefined;
      root = new Sort(root, sortKeys, [...regs, ...extraRegs], hint, this.env.spill ?? null);
    }
    return { root: limit(root), outRegs: regs, columns, correlated: scope.correlated };
  }

  /**
   * A subquery of a plan (`subquery`, `inSubquery`, and NOT IN as one test), compiled as the planner compiles it:
   * decorrelated when it qualifies, else its plan re-run per outer row (or once, when uncorrelated). `f` maps the
   * columns of the operation it is evaluated in.
   */
  private subqueryExpr(n: BoundExpr, f: ColMap): BoundExpr {
    const ctx = this.env.funcCtx;
    const test = (c: Fn): BoundExpr => subqueryNative({ fn: c, type: 'int', collation: Collation.Binary, collSrc: CollSrc.None, affinity: 'NONE', constant: false });
    const inTest = (x: BoundExpr & { k: 'inSubquery' }): Fn => {
      const probe = compilePlanExpr(rebind(x.probe, f, (m, g) => this.subqueryExpr(m, g)), ctx);
      return this.inFromPlan(this.physicalAny(x.plan, null, f), probe);
    };
    if (n.k === 'not') {
      const t = inTest(n.arg as BoundExpr & { k: 'inSubquery' });
      return test((r) => {
        const v = t(r);
        return v === null ? null : v === 1 ? 0 : 1;
      });
    }
    if (n.k === 'inSubquery') return test(inTest(n));
    const q = n as BoundExpr & { k: 'subquery' };
    const dec = decorrelationDisabled() ? null : this.decorrelatePlan(q.plan, q.mode, f);
    if (q.mode === 'exists') return test(dec ? dec.fn : this.existsFromPlan(this.physicalAny(q.plan, null, f)));
    return subqueryNative(dec ?? this.scalarFromPlan(this.physicalAny(q.plan, null, f)));
  }

  /**
   * `decorrelate` for a subquery's plan, with the same rules: EXISTS or a scalar aggregate over base tables joined by
   * inner joins, whose correlated WHERE conjuncts are equalities between the subquery's columns and the enclosing
   * row's (conjuncts over the enclosing row alone are guards). Null when it does not qualify.
   */
  private decorrelatePlan(op: PlanOp, kind: 'exists' | 'scalar', f: ColMap): Compiled | null {
    const s = flatShape(op);
    // `decorrelate` reads the subquery before flattening: views and FROM subqueries there are not base tables.
    if (!s || isFlattened(op)) return null;
    const a = s.aggregate;
    if (s.limit?.offset || !s.from || !s.where || (a && a.keys.length) || s.having || s.windows.length) return null;
    if (kind === 'scalar' && (s.limit || s.sort)) return null;
    if (kind === 'exists' && s.limit && !(s.limit.count.k === 'lit' && typeof s.limit.count.value === 'number' && s.limit.count.value >= 1)) return null;
    if (kind === 'exists' && a) return null;
    for (const l of s.from) {
      if (l.op.op !== 'scan' || (l.join !== null && l.join !== 'inner' && l.join !== 'cross')) return null;
      if (l.on && !['inner', 'none'].includes(sideOf(l.on))) return null;
    }
    const pairs: { inner: PlanExpr; outer: PlanExpr; innerLeft: boolean }[] = [];
    const guards: PlanExpr[] = [];
    const rest: PlanExpr[] = [];
    for (const c of andParts(s.where)) {
      const sd = sideOf(c);
      if (sd === 'inner' || sd === 'none') rest.push(c);
      else if (sd === 'outer') guards.push(c);
      else if (sd === 'mixed' && isEquality(c)) {
        const [x, y] = c.args.map(unconvertedOperand);
        const l = sideOf(x);
        const r = sideOf(y);
        if (l === 'inner' && r === 'outer') pairs.push({ inner: x, outer: y, innerLeft: true });
        else if (l === 'outer' && r === 'inner') pairs.push({ inner: y, outer: x, innerLeft: false });
        else return null;
      } else return null;
    }
    if (pairs.length === 0) return null;
    // The scalar form's result: aggregates of the inner rows (no bare columns, nothing from the enclosing row).
    let value: PlanExpr | undefined;
    if (kind === 'scalar') {
      if (!a || s.width !== 1 || s.distinct) return null;
      value = s.project[0];
      const reads: number[] = [];
      let outerRef = false;
      rebind(value, (c) => (c.depth === 0 ? reads.push(c.index) : (outerRef = true), c));
      if (outerRef || hasNested(value) || reads.some((i) => i >= a.aggs.length) || !reads.length) return null;
      const used = [...new Set(reads)].map((i) => a.aggs[i]);
      if (used.some((c) => [...c.args, c.filter].some((x) => x !== undefined && sideOf(x) !== 'inner' && sideOf(x) !== 'none'))) return null;
    }
    // The inner side: its key expressions (grouped for a scalar, DISTINCT for EXISTS) over the uncorrelated WHERE.
    const from = s.from.slice(1).reduce<PlanOp>((left, l) => ({ op: 'join', kind: l.join!, inputs: [left, l.op], ...(l.on ? { on: l.on } : {}) }), s.from[0].op);
    const where = rest.length ? rest.reduce((x, y) => ({ k: 'and', args: [x, y] }) as PlanExpr) : undefined;
    const filtered: PlanOp = where ? { op: 'filter', input: from, pred: where } : from;
    const meta = pairs.map((p) => {
      const m = boundMetadata(rebind(p.inner, (c) => slotFor(c, 0)), this.env.funcCtx);
      return { type: m.type, collation: m.collSrc !== CollSrc.None ? m.collation : Collation.Binary, affinity: m.affinity };
    });
    let inner: PlanOp;
    if (kind === 'exists') {
      inner = { op: 'distinct', input: { op: 'project', input: filtered, exprs: pairs.map((p) => p.inner) }, collations: meta.map((m) => COLLATION_NAMES[m.collation]) };
    } else {
      const keyCol = (i: number): PlanExpr => {
        const c: PlanExpr = { k: 'col', input: 0, index: i, depth: 0, type: meta[i].type, collation: COLLATION_NAMES[meta[i].collation] };
        setMeta(c, { collation: meta[i].collation, collSrc: meta[i].collation ? CollSrc.Column : CollSrc.None, affinity: meta[i].affinity });
        return c;
      };
      const shifted = rebind(value!, (c) => ({ ...c, index: c.index + pairs.length }));
      inner = {
        op: 'project',
        input: { op: 'aggregate', input: filtered, keys: pairs.map((p, i) => ({ expr: p.inner, collation: COLLATION_NAMES[meta[i].collation] })), aggs: a!.aggs, carry: [] },
        exprs: [...pairs.map((_p, i) => keyCol(i)), shifted],
      };
    }
    // Materialized-view matching may answer the inner side, as any plan.
    const rewrite = this.env.rewritePlan;
    let plan: QueryPlan;
    try {
      plan = this.physical(rewrite ? rewrite(inner) : inner, null, null);
    } catch {
      return null;
    }
    if (plan.correlated) return null;
    const outerOf = (e: PlanExpr): Compiled => compilePlanExpr(rebind(e, (c) => f(shallower(c)), (m, g) => this.subqueryExpr(m, g)), this.env.funcCtx);
    const keyFns: { outer: Fn; convOuter: ((v: SqlValue) => SqlValue) | null; convInner: ((v: SqlValue) => SqlValue) | null; coll: Collation }[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const col = plan.columns[i];
      const p = pairs[i];
      const innerIsColumn = p.inner.k === 'col' && !isOpaque(p.inner);
      const innerC: Compiled = { fn: () => null, type: col.type, collation: col.collation, collSrc: innerIsColumn || col.collation ? CollSrc.Column : CollSrc.None, affinity: col.affinity, constant: false };
      const outerC = outerOf(p.outer);
      const [l, r] = p.innerLeft ? [innerC, outerC] : [outerC, innerC];
      const coll = comparisonCollation(l, r);
      if (kind === 'scalar' && coll !== col.collation) return null;
      if (isOpaque(p.inner) && getMeta(p.inner)?.collSrc === CollSrc.Explicit) return null;
      const [cl, cr] = comparisonConverters(l, r);
      keyFns.push({ outer: outerC.fn, coll, convInner: p.innerLeft ? cl : cr, convOuter: p.innerLeft ? cr : cl });
    }
    this.recordSubplan(kind === 'exists' ? 'EXISTS (decorrelated: hash semi-join)' : 'SCALAR SUBQUERY (decorrelated: grouped lookup)', plan.root);
    const guardFns = guards.map((g) => outerOf(g).fn);
    let emptyPlan: QueryPlan | null = null;
    if (kind === 'scalar') {
      const empty: PlanOp = { op: 'project', input: { op: 'aggregate', input: { op: 'filter', input: from, pred: lit(0, 'int') }, keys: [], aggs: a!.aggs, carry: [] }, exprs: [value!] };
      emptyPlan = this.physical(empty, null, null);
    }
    return this.decorrelatedFn(kind, plan, keyFns, guardFns, emptyPlan);
  }

  /** An aggregate call of a plan, with its arguments bound to the FROM row's registers by `bind`. */
  private aggSpec(a: AggCall, bind: (e: BoundExpr) => BoundExpr): AggSpec {
    const def = aggregateFunctions.get(a.fn)!;
    const argExprs = a.args.map(bind);
    const args = argExprs.map((x) => compileBoundExpr(x, this.env.funcCtx));
    const filterExpr = a.filter ? bind(a.filter) : undefined;
    return {
      def,
      args: args.map((x) => x.fn),
      argTypes: args.map((x) => x.type),
      distinct: a.distinct,
      filter: filterExpr ? compileBoundExpr(filterExpr, this.env.funcCtx).fn : undefined,
      outReg: this.regs.alloc(),
      collation: args[0]?.collSrc ? args[0].collation : Collation.Binary,
      star: a.star,
      isMinMax: a.fn === 'min' || a.fn === 'max',
      name: a.fn,
      argExprs,
      filterExpr,
    };
  }

  /** `SELECT count(*) FROM table` with nothing else: count leaf cells (planCountStar for plans). */
  private countRowsOf(s: FlatShape, given: ResultColumnInfo[] | null, outRegs: number[] | undefined): QueryPlan | null {
    const a = s.aggregate;
    const scan = s.from?.length === 1 && s.from[0].op.op === 'scan' ? s.from[0].op : null;
    if (!scan || !a || s.where || s.having || s.distinct || scan.indexedBy !== undefined || s.width !== 1) return null;
    if (a.keys.length !== 0 || a.aggs.length !== 1) return null;
    const c = a.aggs[0];
    const e = s.project[0];
    if (c.fn !== 'count' || !c.star || c.filter || e.k !== 'col' || e.index !== 0 || isOpaque(e)) return null;
    const table = this.env.getTable(scan.table, scan.db);
    if (!table || isColumnar(table)) return null;
    if (s.windows.length) return null;
    const reg = outRegs ? outRegs[0] : this.regs.alloc();
    const columns = given ?? [{ name: '', type: 'int' as StaticType, collation: Collation.Binary, affinity: 'NONE' as Affinity }];
    return { root: new CountRows(this.env.openTree(table.rootPage), table.name, reg), outRegs: [reg], columns, correlated: false };
  }

  /** Source SQL text, used to name result columns. Set by the caller before planning. */
  sqlText = '';

  // ================================================================ FROM / WHERE

  /** The full scan chosen for the first source (for ORDER BY elimination); reset per FROM. */
  private lastScan: TableScan | null = null;

  /**
   * Plan FROM + WHERE into an operator tree; registers sources in `scope`. `bound` (the physical planner) gives the
   * FROM items and their join conditions and the WHERE conjuncts already bound, in place of `from` and `where`.
   */
  /**
   * The join region of a plan: its leaves (`bound.items`), join conditions and WHERE conjuncts, all bound from the plan
   * (the front end resolved USING / NATURAL into conditions).
   */
  private planFrom(scope: Scope, bound: BoundFrom): Operator {
    this.lastScan = null;
    const items = bound.items;
    items.forEach((it, p) => {
      const planned = bound.source(p);
      if (planned) this.addPlannedSource(planned.plan, it.joinType, scope, it.item.alias, planned.working === true);
      else this.addSource(it.item, it.joinType, scope, bound.args(p) ?? [], bound.named?.(p));
      bound.added(p);
    });
    items.forEach((_it, p) => {
      scope.sources[p].onBound = bound.on(p);
    });

    // RIGHT / FULL JOIN make every earlier source NULL-extendable: WHERE conjuncts reading those
    // sources must not be pushed below the join (FROM order is kept; see OuterJoin).
    const outerAt: number[] = [];
    scope.sources.forEach((s, i) => {
      if (s.joinType === 'RIGHT' || s.joinType === 'FULL') outerAt.push(i);
    });
    const hasOuter = outerAt.length > 0;
    const pool: ConjunctInfo[] = [];
    for (const b of bound.where()) pool.push(this.boundConjunct(b, scope));
    if (hasOuter) {
      for (const c of pool) {
        let m = -1;
        for (const d of c.deps ?? scope.sources.map((s) => s.position)) for (const k of outerAt) if (d < k || (d === k && scope.sources[k].joinType === 'FULL')) m = Math.max(m, k);
        c.minStep = m;
      }
    }
    for (const src of scope.sources) {
      if (src.joinType !== 'INNER' && src.joinType !== 'CROSS') continue;
      for (const b of src.onBound ?? []) pool.push(this.boundConjunct(b, scope));
    }
    if (!hasOuter) this.prunePartitions(scope, pool);

    const ctx = this.env.funcCtx;
    const order = hasOuter ? scope.sources.map((_, i) => i) : this.joinOrder(scope, pool, ctx);
    const multi = scope.sources.length > 1;
    const placed = new Set<number>();
    let outerRows = 1;
    let root: Operator | null = null;
    for (const p of order) {
      const src = scope.sources[p];
      if (src.joinType === 'RIGHT' || src.joinType === 'FULL') {
        // The inner side is read whole (its rows must survive even without a match).
        let leaf = this.bestStandalone(this.accessOptions(src, p, [], scope, ctx)).build().leaf;
        if (!src.sub) leaf = this.tryFuseScanFilter(leaf, scope);
        const on = this.leftOnInfos(src, scope);
        const hash = this.hashKeys(on.filter((c) => c.deps !== null && c.deps.size > 1 && c.deps.has(p)), p, scope, ctx);
        const residual = on.filter((c) => !hash?.used.includes(c));
        const before = [...placed];
        root = new OuterJoin(
          root!,
          leaf,
          () => this.sourceRegs(src),
          () => before.flatMap((q) => this.sourceRegs(scope.sources[q])),
          src.joinType === 'FULL',
          this.andAll(residual, ctx),
          hash?.build,
          hash?.probe,
          hash?.colls,
        );
        placed.add(p);
        outerRows = Math.max(outerRows, this.tableRows(src));
        for (const c of pool) {
          if (c.placed || c.deps === null || c.deps.size === 0 || (c.minStep ?? -1) > p || ![...c.deps].every((d) => placed.has(d))) continue;
          root = filterOnConjunct(root, c, ctx);
          c.placed = true;
        }
        continue;
      }
      const isLeft = src.joinType === 'LEFT';
      const onInfos: ConjunctInfo[] = isLeft ? this.leftOnInfos(src, scope) : [];
      const allowed = hasOuter ? pool.filter((c) => (c.minStep ?? -1) <= p) : pool;
      const step = this.joinStep(src, placed, outerRows, isLeft ? onInfos : allowed, scope, ctx);
      const candidates = step.candidates;
      const access = step.option.build();
      if (!multi && access.scan) this.lastScan = access.scan;

      // Conditions the index enforces exactly need no filter (their columns then need not be decoded).
      for (const c of access.consumed ?? []) c.placed = true;
      // Filters local to this source (depend only on it and outer scopes).
      let leaf = access.leaf;
      const local = candidates.filter((c) => c.deps!.size === 1 && !c.placed);
      for (const c of local) {
        leaf = filterOnConjunct(leaf, c, ctx);
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
          root = new NestedLoopJoin(root, leaf, isLeft, innerRegs, this.andAll(rest, ctx));
          rest.forEach((c) => (c.placed = true));
        } else {
          const eqs = candidates.filter((c) => !c.placed && c.deps!.size > 1);
          const hash = method === 'hash' ? this.hashKeys(eqs, p, scope, ctx) : null;
          if (hash) {
            hash.used.forEach((c) => (c.placed = true));
            const residual = isLeft ? rest.filter((c) => !c.placed) : [];
            residual.forEach((c) => (c.placed = true));
            const correlated = scope.correlated;
            root = new HashJoin(root, leaf, hash.build, hash.probe, hash.colls, innerRegs, isLeft, this.env.state, correlated, this.andAll(residual, ctx));
          } else {
            // Nested loop: materialize an uncorrelated inner side once instead of re-reading it per outer row.
            const inner = (src.sub && !src.sub.correlated) || (!src.sub && !scope.correlated) ? new Materialize(leaf, innerRegs, this.env.state, false) : leaf;
            root = new NestedLoopJoin(root, inner, isLeft, innerRegs, this.andAll(rest, ctx));
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
        root = filterOnConjunct(root, c, ctx);
        c.placed = true;
      }
    }
    // Constant / correlated-only / subquery conjuncts.
    for (const c of pool) {
      if (c.placed) continue;
      root = filterOnConjunct(root!, c, ctx);
      c.placed = true;
    }
    return root!;
  }

  private andAll(conjs: ConjunctInfo[], ctx: FunctionContext): Fn | undefined {
    if (conjs.length === 0) return undefined;
    const fns = conjs.map((c) => compileBoundExpr(c.lazy ? c.lazy() : c.bound, ctx).fn);
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

  /** Register a leaf of a plan as a source of `scope`. `planArgs`: a table function's arguments, bound. */
  private addSource(item: PlanLeaf, joinType: JoinType, scope: Scope, planArgs: BoundExpr[], planNamed?: Record<string, BoundExpr>): void {
    const position = scope.sources.length;
    const ext = this.externalScan(item, scope, planArgs, planNamed);
    if (ext) {
      // External data (M8): rows loaded before the statement runs, scanned like a virtual table.
      this.externals.push(ext.source);
      const regs = ext.columns.map(() => this.regs.alloc());
      const root = new VirtualScan(`EXTERNAL ${ext.label}`, () => ext.rows(), regs);
      const columns: ResultColumnInfo[] = ext.columns.map((c) => ({ name: c.name, type: c.type, declType: c.declType, collation: Collation.Binary, affinity: affinityOfStorage(storageTypeFor(c.declType)) }));
      const sub: QueryPlan = { root, outRegs: regs, columns, correlated: false };
      const cols: SourceColumn[] = columns.map((c, i) => ({ name: c.name, reg: regs[i], type: c.type, collation: c.collation, affinity: c.affinity, declType: c.declType ?? '', index: i }));
      // Formats with pushdown (Parquet) read only the columns the statement uses (recorded as they resolve).
      if (ext.source.pushdown) ext.source.projection ??= new Set();
      scope.sources.push({ name: (item as { alias?: string }).alias ?? (item as { name: string }).name, cols, rowidReg: -1, sub, lateral: false, joinType, position, external: ext.source, externalTable: item.kind === 'table' });
      return;
    }
    const isInfoSchema = item.kind === 'table' && item.schema?.toLowerCase() === 'information_schema';
    // The TEMP catalog: temp.sqlite_schema / temp.sqlite_master, also named sqlite_temp_schema / sqlite_temp_master.
    const tempCatalog =
      item.kind === 'table' && (item.schema === undefined ? TEMP_CATALOG.has(item.name.toLowerCase()) : item.schema.toLowerCase() === 'temp' && (TEMP_CATALOG.has(item.name.toLowerCase()) || ['sqlite_schema', 'sqlite_master'].includes(item.name.toLowerCase())));
    if (tempCatalog) {
      const vt = this.env.virtualTable?.('temp', 'sqlite_schema');
      if (vt) {
        const regs = vt.columns.map(() => this.regs.alloc());
        const root = new VirtualScan('temp.sqlite_schema', () => vt.rows([]), regs);
        const columns: ResultColumnInfo[] = vt.columns.map((c) => ({ name: c.name, type: c.type, collation: Collation.Binary, affinity: 'NONE' }));
        const cols: SourceColumn[] = columns.map((c, i) => ({ name: c.name, reg: regs[i], type: c.type, collation: c.collation, affinity: c.affinity, declType: '', index: i }));
        scope.sources.push({ name: (item as { alias?: string }).alias ?? item.name, cols, rowidReg: -1, sub: { root, outRegs: regs, columns, correlated: false }, lateral: false, joinType, position });
        return;
      }
    }
    if (item.kind === 'function' || isInfoSchema) {
      const vt = this.env.virtualTable?.(isInfoSchema ? 'information_schema' : undefined, item.name);
      if (!vt) {
        if (isInfoSchema) throw new SmaltError('SMALT_ERROR', `no such table: information_schema.${item.name}`);
        throw new SmaltError('SMALT_ERROR', `no such table-valued function: ${item.name}`);
      }
      const argFns = planArgs.map((a) => compileBoundExpr(a, this.env.funcCtx).fn);
      // Arguments that read earlier sources of this FROM make the source lateral; a subquery or a column of an enclosing
      // query makes it correlated.
      let lateral = false;
      let correlated = false;
      for (const a of planArgs) {
        if (planHasSubquery(a)) correlated = true;
        else forEachSlot(a, (reg) => (this.slotSource(reg, scope) ? (lateral = true) : (correlated = true)));
      }
      const regs = vt.columns.map(() => this.regs.alloc());
      const alias = item.alias ?? item.name;
      const root = new VirtualScan(isInfoSchema ? `information_schema.${item.name}` : `${item.name}()`, (r) => vt.rows(argFns.map((f) => f(r))), regs);
      const columns: ResultColumnInfo[] = vt.columns.map((c) => ({ name: c.name, type: c.type, collation: Collation.Binary, affinity: 'NONE' }));
      const sub: QueryPlan = { root, outRegs: regs, columns, correlated: correlated || lateral };
      if (correlated) scope.correlated = true;
      const cols: SourceColumn[] = columns.map((c, i) => ({ name: c.name, reg: regs[i], type: c.type, collation: c.collation, affinity: c.affinity, declType: '', index: i }));
      scope.sources.push({ name: alias, cols, rowidReg: -1, sub, lateral, joinType, position });
      return;
    }
    if (item.kind === 'nested') throw new SmaltError('SMALT_INTERNAL', 'nested plans are planned as sources');
    if (item.schema && !['main', 'temp'].includes(item.schema.toLowerCase())) throw new SmaltError('SMALT_ERROR', `unknown database ${item.schema}`);
    const table = this.env.getTable(item.name, item.schema);
    if (!table) throw new SmaltError('SMALT_ERROR', `no such table: ${item.schema ? `${item.schema}.` : ''}${item.name}`);
    const base = this.regs.alloc(table.columns.length + 1);
    const access = new TableAccess(this.env.openTree(table.rootPage), new RecordReader(table.layout, table.recordDefaults), table.name, table.rowidAlias);
    access.table = table;
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

  /** A FROM item the physical planner planned: as `addSource` registers a derived table (or a recursive step's rows). */
  private addPlannedSource(sub: QueryPlan, joinType: JoinType, scope: Scope, name: string, working: boolean): void {
    if (sub.correlated && !working) scope.correlated = true;
    const cols: SourceColumn[] = sub.columns.map((c, i) => ({ name: c.name, reg: sub.outRegs[i], type: c.type, collation: c.collation, affinity: c.affinity, declType: c.declType ?? '', index: i }));
    scope.sources.push({ name, cols, rowidReg: -1, sub, joinType, position: scope.sources.length });
  }

  private sourceRegs(src: Source): number[] {
    if (src.access) return src.access.registers();
    return src.cols.map((c) => c.reg);
  }

  /** The source and column a bound slot reads, among `scope`'s sources. */
  private slotSource(reg: number, scope: Scope): { src: Source; col: number | 'rowid' | null } | null {
    for (const src of scope.sources) {
      if (src.table && src.rowidReg === reg) return { src, col: 'rowid' };
      const i = src.cols.findIndex((c) => c.reg === reg);
      if (i >= 0) return { src, col: src.table ? i : null };
    }
    return null;
  }

  /** `columnOf` on a bound operand: a plain column (or the rowid) of table source `src`. */
  private columnOfBound(e: BoundExpr, src: Source, scope: Scope): number | 'rowid' | null {
    if (e.k !== 'slot' || isOpaque(e) || !src.table) return null;
    const s = this.slotSource(e.reg, scope);
    return s && s.src === src ? s.col : null;
  }

  /**
   * A bound expression's shape for matching against index definitions: `src`'s columns by position, other
   * registers as such (expression indexes and partial-index predicates are bound against `src` alone).
   */
  private shapeKey(e: BoundExpr, src: Source, scope: Scope): string {
    return JSON.stringify(e, (k, v) => {
      if (v && typeof v === 'object' && (v as { k?: string }).k === 'slot') {
        const s = this.slotSource((v as { reg: number }).reg, scope);
        return s && s.src === src ? `col:${String(s.col)}` : `reg:${(v as { reg: number }).reg}`;
      }
      if (k === 'compiled' || k === 'use') return undefined;
      return typeof v === 'bigint' ? `${v}n` : v instanceof Uint8Array ? [...v] : v;
    });
  }

  /** An index's expressions as plan expressions over its table's row (bound when the index was loaded). */
  private indexPlan(idx: IndexSchema): IndexEval['plan'] {
    if (!idx.eval) throw new SmaltError('SMALT_INTERNAL', `index ${idx.name} has no bound expressions`);
    return idx.eval.plan;
  }

  /**
   * An index's expression or WHERE conjunct (over its table's row) bound to `src`'s registers (cached per source), for
   * matching and costing only: it is never compiled, so it marks no column as read (an index-only scan stays possible).
   */
  private indexBound(src: Source, e: PlanExpr): BoundExpr {
    let m = this.indexBounds.get(src);
    if (!m) this.indexBounds.set(src, (m = new Map()));
    let b = m.get(e);
    if (b === undefined) {
      const n = src.table!.columns.length;
      b = rebind(e, (c) => {
        if (c.index === n) return slotFor(c, src.rowidReg);
        const sc = src.cols.find((x) => x.index === c.index);
        if (!sc) throw new SmaltError('SMALT_INTERNAL', `index column ${c.index} is not a column of ${src.name}`);
        return slotFor(c, sc.reg);
      });
      m.set(e, b);
    }
    return b;
  }

  private readonly indexBounds = new WeakMap<Source, Map<PlanExpr, BoundExpr>>();

  /** Positions of the current-scope sources a bound expression reads. */
  private depsOf(b: BoundExpr, scope: Scope): Set<number> {
    const out = new Set<number>();
    forEachSlot(b, (reg) => {
      const s = this.slotSource(reg, scope);
      if (s) out.add(s.src.position);
    });
    return out;
  }

  /** `colRef` on a bound operand: a column of a table source (also under COLLATE, not under unary +). */
  private colRefOf(e: BoundExpr, scope: Scope): { src: Source; col: number | 'rowid' } | null {
    const x = unconvertedOperand(e);
    if (x.k !== 'slot') return null;
    if (isOpaque(x) && getMeta(x)?.collSrc !== CollSrc.Explicit) return null;
    const s = this.slotSource(x.reg, scope);
    return s && s.col !== null ? { src: s.src, col: s.col } : null;
  }

  /** `selectivity` on a bound conjunct: the same estimates, read from SQL's operators as `sql.*` calls. */
  private selectivityOf(e: BoundExpr, scope: Scope): number {
    // BETWEEN, NOT BETWEEN, COLLATE and unary + keep their own estimates (they were not comparisons in the AST).
    if (isOpaque(e)) {
      if (e.k === 'and') return 0.25;
      if (e.k === 'not') return e.arg.k === 'and' && isOpaque(e.arg) ? 0.75 : 1 - this.selectivityOf(e.arg, scope);
      return 0.33;
    }
    switch (e.k) {
      case 'and':
        return this.selectivityOf(e.args[0], scope) * this.selectivityOf(e.args[1], scope);
      case 'or': {
        const a = this.selectivityOf(e.args[0], scope);
        const b = this.selectivityOf(e.args[1], scope);
        return a + b - a * b;
      }
      case 'not':
        return 1 - this.selectivityOf(e.arg, scope);
      case 'isNull': {
        const c = this.colRefOf(e.arg, scope);
        let s = 0.05;
        const st = c && c.col !== 'rowid' ? this.statsOf(c.src) : undefined;
        if (c && c.col !== 'rowid' && st) s = st.nulls[c.col] / Math.max(1, st.rows);
        else if (c?.col === 'rowid') s = 0;
        return e.not ? 1 - s : s;
      }
      case 'call': {
        const t = traitsOf(e.fn);
        if (t.compare === '=' || t.compare === 'IS') {
          const l = this.colRefOf(e.args[0], scope);
          const r = this.colRefOf(e.args[1], scope);
          if (l && r && l.src !== r.src) return 1 / Math.max(this.ndv(l.src, l.col), this.ndv(r.src, r.col));
          const c = l ?? r;
          return c ? 1 / this.ndv(c.src, c.col) : 0.33;
        }
        if (t.compare === '!=' || t.compare === 'IS NOT') return 0.9;
        if (t.inList) {
          const c = this.colRefOf(e.args[0], scope);
          return c ? Math.min(1, (e.args.length - 1) / this.ndv(c.src, c.col)) : 0.33;
        }
        if (t.pattern) return 0.25;
        return 0.33;
      }
      default:
        return 0.33;
    }
  }

  // ---------------------------------------------------------------- access paths

  /** Enumerate ways to read `src` using the given candidate conjuncts, with estimated costs. */
  private accessOptions(src: Source, p: number, candidates: ConjunctInfo[], scope: Scope, ctx: FunctionContext): AccessOption[] {
    if (src.sub) {
      const sub = src.sub;
      return [{ label: 'subquery', cost: SUBQUERY_ROWS * COST.scanRow, rows: SUBQUERY_ROWS, dependsOnOuter: sub.correlated, build: () => ({ leaf: sub.root, dependsOnOuter: sub.correlated }) }];
    }
    const N = this.tableRows(src);
    const table = src.table!;
    const access = src.access!;
    type Probe = { op: string; other: BoundExpr; deps: Set<number>; col: number | 'rowid'; colExpr: BoundExpr; conj: ConjunctInfo; list?: BoundExpr[]; exprKey?: string };
    // Expression indexes: comparisons whose one side is an expression over this source alone.
    const exprIndexes = table.indexes.some((i) => i.columns.some((c) => c.expr));
    const probes: Probe[] = [];
    for (const c of candidates) {
      // A conjunct with a subquery never gives a probe: the subquery side depends on everything.
      if (!c.compilable) continue;
      const e = c.bound;
      if (e.k !== 'call' || isOpaque(e)) continue;
      if (traitsOf(e.fn).inList) {
        const col = this.columnOfBound(e.args[0], src, scope);
        const list = e.args.slice(1);
        if (col === 'rowid' && list.length > 0) {
          const listDeps = new Set<number>();
          let ok = true;
          for (const x of list) {
            const d = this.depsOf(x, scope);
            if (d.has(p)) ok = false;
            else d.forEach((v) => listDeps.add(v));
          }
          if (ok) probes.push({ op: 'in', other: list[0], deps: listDeps, col, colExpr: e.args[0], conj: c, list });
        }
        continue;
      }
      const sqlOp = probeOp(e.fn);
      if (sqlOp === undefined) continue;
      for (const flip of [false, true]) {
        const colSide = unconvertedOperand(e.args[flip ? 1 : 0]);
        const otherSide = unconvertedOperand(e.args[flip ? 0 : 1]);
        const col = this.columnOfBound(colSide, src, scope);
        let exprKey: string | undefined;
        if (col === null) {
          if (!exprIndexes) continue;
          const sd = this.depsOf(colSide, scope);
          if (sd.size !== 1 || !sd.has(p)) continue;
          exprKey = this.shapeKey(colSide, src, scope);
        }
        const d = this.depsOf(otherSide, scope);
        if (d.has(p)) continue;
        const op = sqlOp === 'IS' ? 'IS' : flip ? flipOp(sqlOp) : sqlOp;
        probes.push({ op, other: otherSide, deps: d, col: col ?? -1, colExpr: colSide, conj: c, exprKey });
        break;
      }
    }

    const outerDep = (list: Probe[]): boolean => list.some((x) => x.deps.size > 0);
    if (isColumnar(table)) return this.columnarOptions(src, table, access, probes, ctx, N);
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

    // Rowid equality / IN / range. The lookups and range bounds apply the comparison's numeric affinity exactly as
    // the condition does (`rowidProbe`), so the conditions they use need no filter. A seek reads no more pages than
    // a scan, so on tiny tables it costs at most the scan (which would also generate a pipeline).
    const seek = (k: number): number => Math.min(k * COST.probe, N * COST.scanRow * 0.9);
    for (const pr of probes) {
      if (pr.col !== 'rowid') continue;
      if (pr.op === '=') {
        consider('rowid=', seek(1), 1, pr.deps.size > 0, () => {
          const leaf = new RowidLookup(access, [compileBoundExpr(pr.other, ctx).fn]);
          return { leaf, dependsOnOuter: pr.deps.size > 0, consumed: [pr.conj] };
        });
      } else if (pr.op === 'in') {
        const k = pr.list!.length;
        consider('rowid in', seek(k), k, pr.deps.size > 0, () => ({ leaf: new RowidLookup(access, pr.list!.map((x) => compileBoundExpr(x, ctx).fn)), dependsOnOuter: pr.deps.size > 0, consumed: [pr.conj] }));
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
          lo ? { fn: compileBoundExpr(lo.other, ctx).fn, inclusive: lo.op === '>=' } : undefined,
          hi ? { fn: compileBoundExpr(hi.other, ctx).fn, inclusive: hi.op === '<=' } : undefined,
        );
        return { leaf: scan, dependsOnOuter: outerDep([lo, hi].filter((x): x is Probe => !!x)), scan, consumed: [lo, hi].filter((x): x is Probe => !!x).map((x) => x.conj) };
      });
    }

    // Secondary indexes.
    for (const idx of table.indexes) {
      if (idx.where) {
        // A partial index holds only rows matching its WHERE: usable when the query implies it.
        const have = new Set(candidates.map((c) => this.shapeKey(c.bound, src, scope)));
        if (!andParts(this.indexPlan(idx).where!).every((w) => have.has(this.shapeKey(this.indexBound(src, w), src, scope)))) continue;
      }
      const eqs: Probe[] = [];
      const converters: ((v: SqlValue) => SqlValue)[] = [];
      const usable = (pr: Probe, ic: IndexSchema['columns'][number]): ((v: SqlValue) => SqlValue) | null => {
        // Costing only: compiling the probe must not make the scan decode its columns.
        this.dryCompile++;
        try {
          return usableInner(pr, ic);
        } finally {
          this.dryCompile--;
        }
      };
      const usableInner = (pr: Probe, ic: IndexSchema['columns'][number]): ((v: SqlValue) => SqlValue) | null => {
        if (ic.column < 0) {
          if (pr.exprKey === undefined || pr.exprKey !== this.shapeKey(this.indexBound(src, this.indexPlan(idx).cols[idx.columns.indexOf(ic)]!), src, scope)) return null;
        } else if (pr.col !== ic.column) return null;
        // The index's operand order (column, then value): collation and conversions as SQL derives them.
        const colC = boundMetadata(pr.colExpr, ctx);
        const otherC = boundMetadata(pr.other, ctx);
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
      if (idx.where) for (const w of andParts(this.indexPlan(idx).where!)) matches *= this.selectivityOf(this.indexBound(src, w), scope);
      matches = Math.max(1, matches);
      const deps = outerDep([...eqs, ...(lo ? [lo] : []), ...(hi ? [hi] : [])]);
      consider(`index ${idx.name}`, COST.probe + matches * COST.fetch, matches, deps, () => {
        const spec = {
          indexName: idx.name,
          tree: this.env.openTree(idx.rootPage),
          columns: idx.columns.map((c) => ({ desc: c.desc, collation: c.collation })),
          eq: eqs.map((x) => compileBoundExpr(x.other, ctx).fn),
          lo: lo ? { fn: compileBoundExpr(lo.other, ctx).fn, inclusive: lo.op === '>=' } : undefined,
          hi: hi ? { fn: compileBoundExpr(hi.other, ctx).fn, inclusive: hi.op === '<=' } : undefined,
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
      const live = this.env.liveRows ? this.env.liveRows(t) : src.access!.tree.estimateCount();
      src.estRows = Math.max(1, src.table!.stats?.rows ?? live);
      // Remember what the plan assumed, so the statement can re-plan if the table grows or shrinks a lot.
      // (Columnar views change only on refresh, which re-plans anyway.)
      if (!isColumnar(t)) this.rowAssumptions.set(t.rootPage, live);
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
    probes: { op: string; other: BoundExpr; deps: Set<number>; col: number | 'rowid'; colExpr: BoundExpr }[],
    ctx: FunctionContext,
    N: number,
  ): AccessOption[] {
    if (typeof src.indexedBy === 'string') throw new SmaltError('SMALT_ERROR', `no such index: ${src.indexedBy}`);
    const zones: ZonePredicate[] = [];
    // A columnar table stores rowids in a final column, with zone maps like any other; a columnar
    // view's rowids are implicit (row group base + position): zone column -1 (see zoneOf).
    const rowidCol = table.columnar ? table.columns.length : -1;
    for (const pr of probes) {
      if (pr.deps.size > 0 || !['=', '<', '<=', '>', '>='].includes(pr.op)) continue;
      const col = pr.col === 'rowid' || pr.col === table.rowidAlias ? rowidCol : pr.col;
      if (typeof col !== 'number' || (col < 0 && !(col === -1 && pr.col === 'rowid'))) continue;
      this.dryCompile++;
      try {
        const colC = boundMetadata(pr.colExpr, ctx);
        const otherC = compileBoundExpr(pr.other, ctx);
        zones.push({
          col,
          op: pr.op,
          value: otherC.fn,
          binaryText: comparisonCollation(colC, otherC) === Collation.Binary,
          label: `${col === rowidCol || col < 0 ? 'rowid' : table.columns[col].name} ${pr.op} ?`,
        });
      } finally {
        this.dryCompile--;
      }
    }
    const store = (): ColumnStore => this.env.columnStore!(table);
    if (table.columnar) {
      const segments = { rowidCol, deleted: () => this.env.deletedRows!(table) };
      return [
        {
          label: 'columnar table scan',
          cost: N * COST.scanRow * 0.5,
          rows: N,
          dependsOnOuter: false,
          build: () => ({ leaf: new ColumnarTableScan(new TableScan(access), new ColumnScan(access, store, zones, segments)), dependsOnOuter: false }),
        },
      ];
    }
    // Decoding typed column chunks is cheaper per row than record decoding.
    return [{ label: 'columnar scan', cost: N * COST.scanRow * 0.5, rows: N, dependsOnOuter: false, build: () => ({ leaf: new ColumnScan(access, store, zones), dependsOnOuter: false }) }];
  }

  /** >0 while compiling expressions only to inspect them (column use is not recorded). */
  private dryCompile = 0;

  /** Planner row estimates per operator (per loop for inner sides), shown by EXPLAIN ANALYZE. */
  readonly estimates = new WeakMap<Operator, number>();

  /**
   * Plans run from inside expressions (subqueries), which operator trees don't reach, in planning order.
   * For tests that compare plan shapes (test/plan-shapes.test.ts); trial compiles don't record.
   */
  readonly subplans: { label: string; root: Operator }[] = [];

  private recordSubplan(label: string, root: Operator): void {
    if (!this.dryCompile) this.subplans.push({ label, root });
  }

  /** Root page -> row estimate (from the tree shape) each costed table had when this plan was made. */
  readonly rowAssumptions = new Map<number, number>();
  /** External sources the statement reads (M8): loaded before it runs. */
  readonly externals: ExternalSource[] = [];

  /**
   * Partition pruning (M8.2): a condition that reads only one external table's columns, constants
   * and deterministic functions can be evaluated per file on its `key=value` directories; files for
   * which it is false or NULL are not fetched (their rows could not pass it). Not for LEFT-joined
   * tables, whose missing rows would turn into NULL-extended ones, nor with RIGHT / FULL joins.
   */
  private prunePartitions(scope: Scope, pool: ConjunctInfo[]): void {
    for (const src of scope.sources) {
      const ext = src.external;
      if (!ext || src.joinType === 'LEFT') continue;
      const keys: string[] = [];
      for (const c of pool) {
        if (c.deps === null || c.deps.size !== 1 || !c.deps.has(src.position)) continue;
        const e = c.bound;
        if (ext.pushdown) {
          const zone = this.rowGroupCheck(e, src, scope);
          if (zone) {
            (ext.rowGroupPrune ??= []).push(zone);
            keys.push('rg:' + this.shapeKey(e, src, scope));
          }
        }
        if (!src.externalTable) continue;
        // Partition pruning: the conjunct reads only this source's columns, through deterministic functions.
        const used = new Set<number>();
        let ok = true;
        const visit = (x: BoundExpr): void => {
          if (!ok) return;
          switch (x.k) {
            case 'lit':
              return;
            case 'slot': {
              const s = this.slotSource(x.reg, scope);
              const i = s && s.src === src ? src.cols.findIndex((col) => col.reg === x.reg) : -1;
              if (i < 0) ok = false;
              else used.add(i);
              return;
            }
            case 'call': {
              const f = isEngineOperation(x.fn) ? undefined : scalarFunctions.get(x.fn);
              if (!isEngineOperation(x.fn) && (!f || !f.deterministic)) ok = false;
              else x.args.forEach(visit);
              return;
            }
            case 'and':
            case 'or':
              x.args.forEach(visit);
              return;
            case 'not':
            case 'isNull':
            case 'cast':
              visit(x.arg);
              return;
            case 'case':
              for (const w of x.whens) {
                visit(w.when);
                visit(w.then);
              }
              visit(x.else);
              return;
            default:
              ok = false; // parameters, subqueries, aggregates
          }
        };
        if (!c.compilable) continue;
        visit(e);
        if (!ok) continue;
        const cols = src.cols.filter((_col, i) => used.has(i));
        const fn = compileBoundExpr(e, this.env.funcCtx).fn;
        (ext.prune ??= []).push((values) => {
          const r: SqlValue[] = [];
          for (const col of cols) {
            const v = values.get(col.name.toLowerCase());
            if (v === undefined) return undefined; // not a partition column of this file
            r[col.reg] = v;
          }
          return truthy(fn(r)) === true; // false or NULL: no row of the file can pass
        });
        keys.push(this.shapeKey(e, src, scope));
      }
      // A pruned read differs from a full one: it gets its own fetch.
      if (keys.length) ext.key += `|prune:${keys.join('&')}`;
    }
  }

  /**
   * Row-group pruning (M8.3): `column op constant` (=, <, <=, >, >=, either side), `column BETWEEN
   * a AND b` (split into two conjuncts) and `column IN (constants)` on a Parquet source, tested against
   * each row group's statistics (zone maps): false when no row of the group can satisfy it.
   */
  private rowGroupCheck(e: BoundExpr, src: Source, scope: Scope): ((zones: Map<string, Zone>, rows: number) => boolean | undefined) | null {
    const colName = (x: BoundExpr): string | null => {
      if (x.k !== 'slot' || isOpaque(x)) return null;
      const s = this.slotSource(x.reg, scope);
      if (!s || s.src !== src) return null;
      const c = src.cols.find((col) => col.reg === x.reg);
      return c ? c.name.toLowerCase() : null;
    };
    const constant = (x: BoundExpr): SqlValue | undefined => {
      if (x.k !== 'lit' || isOpaque(x)) return undefined;
      const v = x.value;
      if (typeof v === 'bigint') return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : undefined;
      return typeof v === 'number' || typeof v === 'string' ? v : undefined;
    };
    const flip: Record<string, string> = { '=': '=', '<': '>', '<=': '>=', '>': '<', '>=': '<=' };
    const tests: { col: string; op: string; value: SqlValue }[][] = []; // AND of ORs
    const zoneOp = e.k === 'call' && !isOpaque(e) ? probeOp(e.fn) : undefined;
    if (e.k === 'call' && zoneOp !== undefined && zoneOp in flip) {
      const op: string = zoneOp;
      // The operands as written: zone maps compare the constant itself.
      const left = unconvertedOperand(e.args[0]);
      const right = unconvertedOperand(e.args[1]);
      const l = colName(left);
      const r = colName(right);
      if (l && constant(right) !== undefined) tests.push([{ col: l, op, value: constant(right)! }]);
      else if (r && constant(left) !== undefined) tests.push([{ col: r, op: flip[op], value: constant(left)! }]);
    } else if (e.k === 'call' && !isOpaque(e) && traitsOf(e.fn).inList) {
      const col = colName(e.args[0]);
      const values = e.args.slice(1).map(constant);
      if (col && values.length > 0 && values.every((v) => v !== undefined)) tests.push(values.map((v) => ({ col, op: '=', value: v! })));
    }
    if (tests.length === 0) return null;
    return (zones, rows) => {
      for (const any of tests) {
        let possible = false;
        for (const t of any) {
          const z = zones.get(t.col);
          if (!z || zoneMayMatch(z, rows, t.op, t.value, true)) {
            possible = true;
            break;
          }
        }
        if (!possible) return false;
      }
      return undefined;
    };
  }

  /**
   * External sources of the statement, with keys final (M8.3): a Parquet read of some columns
   * differs from one of others, so the projection is part of the fetch key.
   */
  finishExternals(): ExternalSource[] {
    for (const s of this.externals) {
      if (s.projection && !s.key.includes('|cols:')) s.key += `|cols:${[...s.projection].sort().join(',')}`;
    }
    return this.externals;
  }

  /**
   * `item` as an external table or a `read_csv` / `read_json` call, if it is one. A call from a plan has its arguments
   * bound (`planArgs`, `planNamed`; the front end checked that they are constant).
   */
  private externalScan(item: PlanLeaf, scope: Scope, planArgs: BoundExpr[], planNamed?: Record<string, BoundExpr>): ExternalScan | undefined {
    if (item.kind === 'function') {
      if (!this.env.externalFunction) return undefined;
      const v = (b: BoundExpr): SqlValue => compileBoundExpr(b, this.env.funcCtx).fn([]);
      const named: Record<string, SqlValue> = {};
      for (const [k, b] of Object.entries(planNamed ?? {})) named[k] = v(b);
      return this.env.externalFunction(item.name, planArgs.map(v), named);
    }
    if (item.kind !== 'table' || !this.env.externalTable) return undefined;
    if (item.schema && item.schema.toLowerCase() !== 'main') return undefined;
    if (this.env.getTable(item.name)) return undefined; // a TEMP table of the same name shadows it
    return this.env.externalTable(item.name);
  }

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
  private rangeFraction(idx: TableSchema['indexes'][number], lo: { other: BoundExpr; op: string } | undefined, hi: { other: BoundExpr; op: string } | undefined): number | undefined {
    const num = (e: BoundExpr): number | undefined => (e.k === 'lit' && !isOpaque(e) && typeof e.value === 'number' ? e.value : undefined);
    const linear = (e: BoundExpr): { base: string; off: number } | undefined => {
      if (e.k === 'lit' && !isOpaque(e)) return typeof e.value === 'number' ? { base: '', off: e.value } : undefined;
      if (e.k === 'call' && !isOpaque(e) && traitsOf(e.fn).negation && num(e.args[0]) !== undefined) return { base: '', off: -num(e.args[0])! };
      const sign = e.k === 'call' && !isOpaque(e) ? traitsOf(e.fn).offset : undefined;
      if (e.k === 'call' && sign !== undefined && num(e.args[1]) !== undefined) {
        const inner = linear(e.args[0]);
        const d = sign * num(e.args[1])!;
        return inner ? { base: inner.base, off: inner.off + d } : { base: printExpr(e.args[0]), off: d };
      }
      return { base: printExpr(e), off: 0 };
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
    ctx: FunctionContext,
  ): { cost: number; rows: number; filtered: number; method: 'first' | 'inl' | 'hash' | 'nl'; option: AccessOption; candidates: ConjunctInfo[] } {
    const p = t.position;
    const avail = (c: ConjunctInfo): boolean => c.deps !== null && c.deps.has(p) && [...c.deps].every((d) => d === p || placed.has(d));
    const candidates = pool.filter((c) => !c.placed && avail(c));
    const local = candidates.filter((c) => c.deps!.size === 1);
    const joins = candidates.filter((c) => c.deps!.size > 1);
    let filtered = this.tableRows(t);
    for (const c of local) filtered *= this.selectivityOf(c.bound, scope);
    let joinSel = 1;
    for (const c of joins) joinSel *= this.selectivityOf(c.bound, scope);
    const opts = this.accessOptions(t, p, candidates, scope, ctx);
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
    const hasEquiJoin = joins.some((c) => isEquality(c.bound));
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
  private joinOrder(scope: Scope, pool: ConjunctInfo[], ctx: FunctionContext): number[] {
    const n = scope.sources.length;
    if (n <= 1) return n === 1 ? [0] : [];
    const order: number[] = [];
    const placed = new Set<number>();
    let rows = 1;
    let segment: number[] = [];
    const flush = (): void => {
      if (segment.length === 0) return;
      const best = segment.length <= 8 ? this.orderSegmentDP(segment, placed, rows, pool, scope, ctx) : this.orderSegmentGreedy(segment, placed, rows, pool, scope, ctx);
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
        const step = this.joinStep(src, placed, rows, src.joinType === 'LEFT' ? this.leftOnInfos(src, scope) : pool, scope, ctx);
        rows = src.joinType === 'LEFT' ? Math.max(rows, step.rows) : step.rows; // a left join never drops outer rows
        order.push(p);
        placed.add(p);
      } else segment.push(p);
    }
    flush();
    return order;
  }

  private leftOnInfos(src: Source, scope: Scope): ConjunctInfo[] {
    // (The front end rejects an outer join's condition that reads a later source, as SQLite does.)
    return (src.onBound ?? []).map((b) => this.boundConjunct(b, scope));
  }

  /** A conjunct the physical planner bound from a plan. */
  private boundConjunct(b: BoundConjunct, scope: Scope): ConjunctInfo {
    // In `conjunct`'s property order.
    if (b.compile) return { bound: b.bound, compilable: false, deps: null, placed: false, lazy: b.compile };
    return { bound: b.bound, compilable: true, deps: this.depsOf(b.bound, scope), placed: false, lazy: undefined };
  }

  private orderSegmentDP(segment: number[], prefix: Set<number>, prefixRows: number, pool: ConjunctInfo[], scope: Scope, ctx: FunctionContext): { order: number[]; rows: number } {
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
        const step = this.joinStep(scope.sources[segment[j]], placed, cur.rows, pool, scope, ctx);
        // Avoid cross products while a connected choice exists: penalize joins without any join conjunct.
        const connected = placed.size === 0 || step.candidates.some((c) => c.deps!.size > 1);
        const cost = cur.cost + step.cost * (connected ? 1 : 4);
        const next = mask | (1 << j);
        if (!best[next] || cost < best[next]!.cost) best[next] = { cost, rows: step.rows, order: [...cur.order, segment[j]] };
      }
    }
    return best[(1 << m) - 1]!;
  }

  private orderSegmentGreedy(segment: number[], prefix: Set<number>, prefixRows: number, pool: ConjunctInfo[], scope: Scope, ctx: FunctionContext): { order: number[]; rows: number } {
    const left = new Set(segment);
    const placed = new Set(prefix);
    const order: number[] = [];
    let rows = prefixRows;
    while (left.size > 0) {
      let pick = -1;
      let pickStep: ReturnType<Planner['joinStep']> | null = null;
      for (const p of left) {
        const step = this.joinStep(scope.sources[p], placed, rows, pool, scope, ctx);
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


  private hashKeys(
    eqs: ConjunctInfo[],
    p: number,
    scope: Scope,
    ctx: FunctionContext,
  ): { build: Fn[]; probe: Fn[]; colls: Collation[]; used: ConjunctInfo[] } | null {
    const build: Fn[] = [];
    const probe: Fn[] = [];
    const colls: Collation[] = [];
    const used: ConjunctInfo[] = [];
    for (const c of eqs) {
      const e = c.bound;
      if (!c.compilable || e.k !== 'call' || !isEquality(e)) continue;
      // The operands themselves; the comparison's affinity conversions apply to the hash keys below.
      const left = unconvertedOperand(e.args[0]);
      const right = unconvertedOperand(e.args[1]);
      const dl = this.depsOf(left, scope);
      const dr = this.depsOf(right, scope);
      let inner: BoundExpr;
      let outer: BoundExpr;
      if (dl.size === 1 && dl.has(p) && !dr.has(p) && dr.size > 0) {
        inner = left;
        outer = right;
      } else if (dr.size === 1 && dr.has(p) && !dl.has(p) && dl.size > 0) {
        inner = right;
        outer = left;
      } else continue;
      const ic = compileBoundExpr(inner, ctx);
      const oc = compileBoundExpr(outer, ctx);
      // Use the comparison's own affinity/collation rules on both sides.
      const leftC = inner === left ? ic : oc;
      const rightC = inner === left ? oc : ic;
      const [convL, convR] = comparisonConverters(leftC, rightC);
      const convI = inner === left ? convL : convR;
      const convO = inner === left ? convR : convL;
      const fi = ic.fn;
      const fo = oc.fn;
      build.push(convI ? (r) => convI(fi(r)) : fi);
      probe.push(convO ? (r) => convO(fo(r)) : fo);
      colls.push(comparisonCollation(leftC, rightC));
      used.push(c);
    }
    return used.length ? { build, probe, colls, used } : null;
  }

  // ---------------------------------------------------------------- subqueries

  /** A scalar subquery's value from its plan: the first column of its first row (cached unless correlated). */
  private scalarFromPlan(plan: QueryPlan): Compiled {
    this.recordSubplan(plan.correlated ? 'CORRELATED SCALAR SUBQUERY' : 'SCALAR SUBQUERY', plan.root);
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
   * The value of a decorrelated subquery: `plan` (the inner side: its key columns, then for a scalar the value) is
   * read once per statement into a hash table, probed per outer row with `keyFns`; `guardFns` read the outer row only.
   */
  private decorrelatedFn(
    kind: 'exists' | 'scalar',
    plan: QueryPlan,
    keyFns: { outer: Fn; convOuter: ((v: SqlValue) => SqlValue) | null; convInner: ((v: SqlValue) => SqlValue) | null; coll: Collation }[],
    guardFns: Fn[],
    emptyPlan: QueryPlan | null,
  ): Compiled {
    let emptyValue: SqlValue = kind === 'exists' ? 0 : null;
    const state = this.env.state;
    let epoch = -1;
    let table = new Map<unknown, SqlValue>();
    const n = keyFns.length;
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

  /** EXISTS from its plan: whether it has a row (cached unless correlated). */
  private existsFromPlan(plan: QueryPlan): Fn {
    this.recordSubplan(plan.correlated ? 'CORRELATED EXISTS' : 'EXISTS', plan.root);
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

  /** `probe IN (subquery)` from the subquery's plan: 1, 0 or NULL (its rows are read once unless correlated). */
  private inFromPlan(plan: QueryPlan, probe: Compiled): Fn {
    this.recordSubplan(plan.correlated ? 'CORRELATED IN SUBQUERY' : 'IN SUBQUERY', plan.root);
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

/** The LIMIT (plus OFFSET) a Sort may stop at, or -1 for all rows. */
function topN(lim: Fn, off: Fn | undefined): (r: SqlValue[]) => number {
  return (r) => {
    const l = Limit.evalCount(lim, r, -1);
    if (l < 0) return -1;
    return l + Math.max(0, Limit.evalCount(off, r, 0));
  };
}

// ------------------------------------------------------------------ physical planner helpers (ADR 0014, step 6b)

type ColRef = BoundExpr & { k: 'col' };
type AggregateOp = Extract<PlanOp, { op: 'aggregate' }>;

type WindowOp = Extract<PlanOp, { op: 'window' }>;
/** A FROM item: a table, a source, or a nested plan (a derived table, view, CTE or the working rows of one). */
type FromLeaf = { op: PlanOp; join: JoinKind | null; on?: PlanExpr };

/**
 * One SELECT core of a plan: limit? / sort? / distinct? / project / window* / having? / aggregate? / where? / FROM,
 * where FROM is a left-deep tree of joins over its items, or no FROM (one empty row).
 */
interface FlatShape {
  limit?: { count: PlanExpr; offset?: PlanExpr };
  sort?: readonly PlanSortKey[];
  distinct?: readonly CollationName[];
  /** The result expressions, then the ORDER BY expressions computed beside them. */
  project: readonly PlanExpr[];
  /** The number of result expressions. */
  width: number;
  /** Window operations, innermost (first defined) first. */
  windows: WindowOp[];
  having?: PlanExpr;
  aggregate?: AggregateOp;
  where?: PlanExpr;
  /** The FROM items in order (the first has no join), or null: no FROM. */
  from: FromLeaf[] | null;
}

/** The FROM items of a left-deep join tree, or null. */
function fromLeaves(op: PlanOp, out: FromLeaf[] = []): FromLeaf[] | null {
  if (op.op !== 'join') {
    out.push({ op, join: null });
    return out;
  }
  if (op.kind === 'semi' || op.kind === 'anti') return null;
  const right = op.inputs[1];
  if (right.op === 'join' || !fromLeaves(op.inputs[0], out)) return null;
  out.push({ op: right, join: op.kind, ...(op.on ? { on: op.on } : {}) });
  return out;
}

/** The number of columns a plan outputs. */
export function planWidth(op: PlanOp): number {
  switch (op.op) {
    case 'scan':
      return op.columns.length;
    case 'source':
    case 'working':
    case 'values':
      return op.types.length;
    case 'project':
      return op.exprs.length;
    case 'filter':
    case 'sort':
    case 'limit':
    case 'distinct':
      return planWidth(op.input);
    case 'aggregate':
      return op.keys.length + op.aggs.length + op.carry.length;
    case 'window':
      return planWidth(op.input) + op.calls.length;
    case 'setop':
      return planWidth(op.inputs[0]);
    case 'iterate':
      return planWidth(op.init);
    case 'join':
      return op.kind === 'semi' || op.kind === 'anti' ? planWidth(op.inputs[0]) : planWidth(op.inputs[0]) + planWidth(op.inputs[1]);
    case 'delete':
    case 'update':
    case 'append':
      return op.returning?.length ?? 0;
  }
}

const JOIN_TYPES: Readonly<Record<JoinKind, JoinType>> = { inner: 'INNER', cross: 'INNER', left: 'LEFT', right: 'RIGHT', full: 'FULL', semi: 'INNER', anti: 'INNER' };

/** The FROM item the planner registers for a plan's table or source (named by position: names are resolved). */
/**
 * A FROM leaf of a plan, as the join planner registers it: a table, a table function or virtual table, or a nested
 * plan (planned separately: see BoundFrom.source). `alias` is the leaf's position (`#p`).
 */
type PlanLeaf =
  | { readonly kind: 'table'; readonly name: string; readonly schema?: string; readonly alias: string; readonly indexedBy?: string | null }
  | { readonly kind: 'function'; readonly name: string; readonly alias: string }
  | { readonly kind: 'nested'; readonly alias: string };

function planLeaf(op: PlanOp, p: number): PlanLeaf {
  const alias = `#${p}`;
  if (op.op === 'scan') return { kind: 'table', schema: op.db, name: op.table, alias, indexedBy: op.indexedBy };
  if (op.op !== 'source') return { kind: 'nested', alias };
  if (op.kind === 'function') return { kind: 'function', name: op.name, alias };
  return { kind: 'table', schema: op.schema, name: op.name, alias };
}

/** A plan operation's shape, kept on it: the planner asks for one several times (checks, planning, decorrelation). */
const SHAPE: unique symbol = Symbol('shape');

/** Match a SELECT core, or null. */
function flatShape(op: PlanOp): FlatShape | null {
  const o = op as { [SHAPE]?: FlatShape | null };
  let s = o[SHAPE];
  if (s === undefined) o[SHAPE] = s = matchShape(op);
  return s;
}

function matchShape(op: PlanOp): FlatShape | null {
  let n = op;
  let limit: FlatShape['limit'];
  let width = -1;
  let sort: FlatShape['sort'];
  let distinct: FlatShape['distinct'];
  if (n.op === 'limit') {
    limit = { count: n.count, offset: n.offset };
    n = n.input;
  }
  // The projection that drops ORDER BY expressions which are not results.
  if (n.op === 'project' && n.input.op === 'sort' && n.exprs.every((e, i) => e.k === 'col' && e.depth === 0 && e.index === i)) {
    width = n.exprs.length;
    n = n.input;
  }
  if (n.op === 'sort') {
    sort = n.keys;
    n = n.input;
  }
  if (n.op === 'distinct') {
    distinct = n.collations;
    n = n.input;
  }
  if (n.op !== 'project') return null;
  const project = n.exprs;
  if (width < 0) width = project.length;
  n = n.input;
  const windows: WindowOp[] = [];
  while (n.op === 'window') {
    windows.unshift(n);
    n = n.input;
  }
  let having: PlanExpr | undefined;
  let aggregate: AggregateOp | undefined;
  let where: PlanExpr | undefined;
  if (n.op === 'filter' && n.input.op === 'aggregate') {
    having = n.pred;
    n = n.input;
  }
  if (n.op === 'aggregate') {
    aggregate = n;
    n = n.input;
  }
  if (n.op === 'filter') {
    where = n.pred;
    n = n.input;
  }
  const from = n.op === 'values' && n.rows.length === 1 && n.rows[0].length === 0 ? null : fromLeaves(n);
  if (from === null && n.op !== 'values') return null;
  // One object shape for every plan (the planner reads these often).
  return { limit, sort, distinct, project, width, windows, having, aggregate, where, from };
}

/** Whether `f` holds for every expression of a flat shape but LIMIT / OFFSET (results, keys, conditions, arguments). */
function everyExpr(s: FlatShape, f: (e: BoundExpr) => boolean): boolean {
  const ok = (e: BoundExpr | undefined): boolean => e === undefined || f(e);
  const a = s.aggregate;
  if (!s.project.every(ok) || !ok(s.having) || !ok(s.where)) return false;
  if (s.sort && !s.sort.every((k) => ok(k.expr))) return false;
  if (a && !(a.keys.every((k) => ok(k.expr)) && a.aggs.every((c) => c.args.every(ok) && ok(c.filter)) && a.carry.every(ok))) return false;
  for (const w of s.windows) {
    if (!w.partition.every((x) => ok(x.expr)) || !w.order.every((k) => ok(k.expr)) || !ok(w.frame.start.offset) || !ok(w.frame.end.offset)) return false;
    if (!w.calls.every((c) => c.args.every(ok) && ok(c.filter))) return false;
  }
  return (s.from ?? []).every((l) => ok(l.on) && (l.op.op !== 'source' || l.op.args.every(ok)));
}

/**
 * Whether the physical planner handles `op` (step 6c), `level` evaluations deep (a subquery's plan is one deeper than
 * the operation it is evaluated in): a SELECT core, VALUES or a compound, possibly with ORDER BY and LIMIT, whose
 * expressions read its own row or the rows of the operations it is evaluated in, and whose subqueries and FROM items
 * it handles too. LIMIT and OFFSET read no rows.
 */
function supportedPlan(op: PlanOp, level: number): boolean {
  const s = flatShape(op);
  if (s) {
    if (!everyExpr(s, (e) => readsRows(e, level)) || (s.limit && (!readsRows(s.limit.count, -1) || (s.limit.offset && !readsRows(s.limit.offset, -1))))) return false;
    return (s.from ?? []).every((l) => supportedLeaf(l.op, level));
  }
  let n = op;
  if (n.op === 'limit') {
    if (!readsRows(n.count, -1) || (n.offset && !readsRows(n.offset, -1))) return false;
    n = n.input;
  }
  if (n.op === 'sort') n = n.input;
  if (n.op === 'values') return n.rows.every((r) => r.every((e) => readsRows(e, level)));
  return n.op === 'setop' && supportedPlan(n.inputs[0], level) && supportedPlan(n.inputs[1], level);
}

/**
 * A FROM item the physical planner handles: a table, a source, a recursive CTE, its working rows, or a nested plan
 * (the front end has already merged the views and FROM subqueries that flattening merges: exec/flatten.ts).
 */
function supportedLeaf(op: PlanOp, level: number): boolean {
  switch (op.op) {
    case 'scan':
    case 'source':
    case 'working':
      return true;
    case 'iterate':
      return supportedPlan(op.init, level) && op.steps.every((x) => supportedPlan(x, level)) && [op.limit, op.offset].every((e) => e === undefined || readsRows(e, -1));
    default:
      return supportedPlan(op, level);
  }
}

/** True when `e`'s columns are at most `level` evaluations out (-1: none), and its subqueries are supported. */
function readsRows(e: BoundExpr, level: number): boolean {
  switch (e.k) {
    case 'col':
      return e.depth <= level;
    case 'lit':
    case 'param':
      return true;
    case 'native':
      return e.subquery !== true;
    case 'call':
    case 'and':
    case 'or':
      return e.args.every((x) => readsRows(x, level));
    case 'cast':
    case 'not':
    case 'isNull':
      return readsRows(e.arg, level);
    case 'case':
      return e.whens.every((w) => readsRows(w.when, level) && readsRows(w.then, level)) && readsRows(e.else, level);
    case 'subquery':
      return level >= 0 && supportedPlan(e.plan, level + 1);
    case 'inSubquery':
      return level >= 0 && readsRows(e.probe, level) && supportedPlan(e.plan, level + 1);
    default:
      return false;
  }
}

/** Column `c` read from the operation one evaluation out. */
function shallower(c: ColRef): ColRef {
  const d: BoundExpr = { ...c, depth: c.depth - 1 };
  return d as ColRef;
}

const SETOPS = { union: 'UNION', unionAll: 'UNION ALL', intersect: 'INTERSECT', except: 'EXCEPT' } as const;

/** Maps a column of an operation's row to the register slot that holds it. */
type ColMap = (c: ColRef) => BoundExpr;

/** A FROM row cell: its register, its source and the source's column (-1: a table's rowid). */
type FromCell = { reg: number; src: Source; col: number };

/** See `Planner.bindings`. */
interface Bindings {
  bind: (e: BoundExpr, m: ColMap) => BoundExpr;
  /** Bound for analysis: subqueries are placeholders. */
  analysis: (e: BoundExpr, m: ColMap) => BoundExpr;
  fromRow: FromCell[];
  useOf: (f: FromCell) => () => void;
  fromSlot: ColMap;
}

/** For LIMIT / OFFSET, which read no row. */
const NO_COLUMNS: ColMap = () => {
  throw new SmaltError('SMALT_INTERNAL', 'LIMIT reads no columns');
};

/** True when `e` has a subquery (not counting compiled nodes). */
function hasNested(e: BoundExpr): boolean {
  switch (e.k) {
    case 'subquery':
    case 'inSubquery':
      return true;
    case 'call':
    case 'and':
    case 'or':
      return e.args.some(hasNested);
    case 'cast':
    case 'not':
    case 'isNull':
      return hasNested(e.arg);
    case 'case':
      return e.whens.some((w) => hasNested(w.when) || hasNested(w.then)) || hasNested(e.else);
    default:
      return false;
  }
}

/** Which rows a subquery's expression reads: its own (`inner`), the enclosing ones (`outer`), both, or neither. */
function sideOf(e: BoundExpr): 'inner' | 'outer' | 'mixed' | 'none' | 'bad' {
  if (hasNested(e)) return 'bad';
  let i = false;
  let o = false;
  rebind(e, (c) => ((c.depth === 0 ? (i = true) : (o = true)), c));
  return i && o ? 'mixed' : i ? 'inner' : o ? 'outer' : 'none';
}

/** The AND-ed parts of a predicate, as `conjuncts` splits its AST (BETWEEN stays whole). */
function andParts<E extends BoundExpr>(e: E, out: E[] = []): E[] {
  if (e.k === 'and' && !getMeta(e)?.opaque) for (const x of e.args) andParts(x as E, out);
  else out.push(e);
  return out;
}

const COLLATION_NAMES: readonly CollationName[] = ['binary', 'nocase', 'rtrim'];

/** A compiled subquery, as the binder makes one. */
const subqueryNative = (c: Compiled): BoundExpr => ({ k: 'native', compiled: c, type: c.type, subquery: true });

/** An empty plan in place of a subquery's, in a conjunct bound for analysis (as `conjunct` does). */
const PLACEHOLDER: PlanOp = { op: 'values', rows: [], types: [] };

/**
 * A copy of `e` with each column replaced by `f(column)`, keeping every node's SQL metadata. `sub` compiles its
 * subqueries (and NOT IN as one test); without it they become placeholders, as for analysis.
 */
function rebind(e: PlanExpr, f: (c: ColRef) => PlanExpr): PlanExpr;
function rebind(e: BoundExpr, f: (c: ColRef) => BoundExpr, sub?: (n: BoundExpr, f: (c: ColRef) => BoundExpr) => BoundExpr): BoundExpr;
function rebind(e: BoundExpr, f: (c: ColRef) => BoundExpr, sub?: (n: BoundExpr, f: (c: ColRef) => BoundExpr) => BoundExpr): BoundExpr {
  const r = (x: BoundExpr): BoundExpr => rebind(x, f, sub);
  switch (e.k) {
    case 'col':
      return f(e);
    case 'call':
    case 'and':
    case 'or':
      return { ...e, args: e.args.map(r) };
    case 'not':
      if (sub && e.arg.k === 'inSubquery') return sub(e, f);
      return { ...e, arg: r(e.arg) };
    case 'cast':
    case 'isNull':
      return { ...e, arg: r(e.arg) } as BoundExpr;
    case 'case':
      return { ...e, whens: e.whens.map((w) => ({ when: r(w.when), then: r(w.then) })), else: r(e.else) };
    case 'subquery':
      if (sub) return sub(e, f);
      return { k: 'subquery', mode: e.mode, plan: PLACEHOLDER, type: e.mode === 'exists' ? 'int' : 'any', collation: 'binary' };
    case 'inSubquery':
      if (sub) return sub(e, f);
      return { k: 'inSubquery', probe: r(e.probe), plan: PLACEHOLDER, collation: 'binary' };
    default:
      return e;
  }
}

/** The register slot for column `c`, with its SQL metadata; `use` marks the column as read when compiled. */
function slotFor(c: ColRef, reg: number, use?: () => void): BoundExpr {
  const slot: BoundExpr = use ? { k: 'slot', reg, type: c.type, use } : { k: 'slot', reg, type: c.type };
  const m = getMeta(c);
  if (m) setMeta(slot, m);
  return slot;
}

/**
 * The conjuncts of a bound WHERE predicate, as `conjuncts` and `splitBetween` split its AST: AND (not one a COLLATE
 * copied), and the two comparisons of a BETWEEN.
 */
function splitBoundConjuncts(e: BoundExpr, out: BoundExpr[] = []): BoundExpr[] {
  if (e.k === 'and') {
    const m = getMeta(e);
    if (!m?.opaque) {
      for (const x of e.args) splitBoundConjuncts(x, out);
      return out;
    }
    if (m.collSrc !== CollSrc.Explicit) {
      out.push(...e.args);
      return out;
    }
  }
  out.push(e);
  return out;
}

const COLLATION_IDS: Readonly<Record<CollationName, Collation>> = { binary: Collation.Binary, nocase: Collation.NoCase, rtrim: Collation.RTrim };
const collationId = (n: CollationName): Collation => COLLATION_IDS[n];

export type { Scope };

/** Aggregates whose result does not depend on input order (sum/avg of REAL up to rounding). */
const ORDER_INSENSITIVE_AGGS = new Set([
  'count', 'sum', 'total', 'avg', 'min', 'max',
  // statistics (stat-aggregates.ts): the percentiles exactly, the moments up to rounding like sum/avg
  'median', 'percentile', 'percentile_cont', 'percentile_disc',
  'var_samp', 'variance', 'var_pop', 'stddev_samp', 'stddev', 'stddev_pop',
  'skewness', 'skewness_pop', 'kurtosis', 'kurtosis_pop', 'covar_samp', 'covar_pop', 'corr',
]);

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

