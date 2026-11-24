/**
 * Plans that write a property graph, run in stages (ADR 0042, section 1).
 *
 * A plan that holds a graph write (`graphCreate`, `graphSet`, `graphDelete`, `graphMerge`) is not one physical plan.
 * Its rows go through its operations stage by stage, so that a write handles its rows in order, each before the next
 * is read, and what reads the graph above a write reads it as it is then:
 *
 * - **A part that writes nothing is one query,** all its rows read before anything above it runs, unless operations
 *   at its top that pass rows on as they come read the graph for each row (a nested plan in a `filter`, `project`,
 *   `explode` or `unpivot`; `paths`): those run for each row when its turn comes, over the one query below them, so
 *   they read what the writes above them wrote for earlier rows. Under an `eager` it is one query whatever it reads.
 *   Either way no scan is open on a table while it is written.
 * - **A write** takes its input's rows one at a time and passes each on once it is written.
 * - **An operation above a write that passes rows on as they come** (`filter`, `project`, `explode`, `unpivot`,
 *   `paths`, a `join` whose left input is the one that writes) is run for each row, as a plan over that row: those
 *   one above the other as one plan.
 * - **An operation that needs all its rows** (`eager`, `sort`, `aggregate`, `distinct`, `window`, `sample`, `pivot`)
 *   reads them all first, then runs once over them.
 * - **`limit`** passes rows on until it has its count and then stops what feeds it: a write below it writes no more.
 *
 * **All a write's rows at once.** That order is what a plan means, not always how it is run. Where no row could tell
 * (`quiet`: nothing above the write, up to an operation that reads all its rows, reads the graph, writes or stops
 * early; and what the write computes reads only its row), a write's rows are written together, a pass over each
 * table, and the steps above it that read only their rows run once over all of them. The rows and the graph are the
 * same; a statement that would fail for more than one reason may report another of them.
 *
 * The writes are appends and updates of the graph's tables, run inside the statement as the engine's own plans are
 * (a foreign key's actions, the graph's rules), and deletes of rows by their rowids (`GraphWriteHost.deleteRows`):
 * each goes through its table's writer, so the graph's rules, history, foreign keys and the graph's index are kept
 * as for any write.
 *
 * **Into the index first.** Where the graph's writes land in its index (`GraphWriteHost.direct`: ADR 0042, section
 * 2), each of these is a change of the index instead, with the graph's rules kept against it, and the tables are
 * written behind. A row the index can't take goes through its table as above, which brings the tables up to date
 * first.
 */
import { SmaltError } from '../errors.js';
import { append, filter, join, limit as limitOf, project, remove, scan, update, values } from '../plan/build.js';
import { call, col, lit, param, type PlanExpr, typeOf } from '../plan/expr.js';
import { GRAPH_WRITE_OPS, type GraphDeleteTarget, type GraphEnd, type GraphNewNode, type GraphNewRelationship, type GraphNewTable, type GraphSetItem, type GraphWriteCounts, type PlanOp } from '../plan/ops.js';
import type { PlanType } from '../plan/types.js';
import { decodeKey, encodeKey, skipComponent } from '../storage/key-codec.js';
import type { SqlValue } from '../values.js';
import { compareCodePoints, parseNested } from '../../shared/nested.js';
import { type DirectGraph, PASS } from './graph-pending.js';
import { setMapKey, toAny } from './nested-ops.js';

type Row = SqlValue[];
type Sink = (row: Row) => boolean;
type Op<K extends PlanOp['op']> = Extract<PlanOp, { op: K }>;

/** A property graph's tables as its writes need them. */
export interface GraphLayout {
  readonly name: string;
  /** Where new nodes go: the node table that names a `props` column. `label` is that table's own label. */
  readonly nodes: { readonly table: string; readonly id: number; readonly props: number; readonly label: string };
  /** The label index. */
  readonly labels: { readonly table: string; readonly node: number; readonly label: number };
  /** Every node table, and every relationship table: ids are counted across them. */
  readonly nodeTables: readonly string[];
  readonly edgeTables: readonly string[];
  /** A label as the graph spells it, or undefined when the graph has no such label. */
  label(name: string): string | undefined;
  /** A relationship type's table (`props`: -1 when it has no such column), or undefined when the graph has no such type. */
  edge(type: string): { readonly table: string; readonly start: number; readonly end: number; readonly props: number } | undefined;
  /** Whether the graph's tables keep history. */
  readonly history: boolean;
}

/** What the database gives a plan that writes a graph. */
export interface GraphWriteHost {
  /** The graph's tables, or an error when the graph can't be written this way. */
  layout(graph: string): GraphLayout;
  schemaVersion(): number;
  /** A plan's output types; `more` gives the column types of tables the database has not yet. */
  types(plan: PlanOp, more?: (table: string) => readonly PlanType[] | undefined): PlanType[];
  /** Runs a plan inside the running statement: a query's rows, or null for a write (`changes` tells its count). */
  run(plan: PlanOp, params: readonly SqlValue[]): SqlValue[][] | null;
  /** How many rows the write last run changed. */
  changes(): number;
  /**
   * Deletes the rows of a table with these rowids, through the table's writer as a delete of them does (the graph's
   * rules, foreign keys, history and the graph's index as for any delete): how many were there.
   */
  deleteRows(table: string, rowids: readonly SqlValue[]): number;
  /**
   * The graph's next ids: `node`, the id its next new node takes, and `relationship`, the rowid its next new
   * relationship takes. Each is one more than the largest the graph has had as far as this connection knows: in its
   * tables, in their past versions where they keep history, and given by a statement of this connection, whether
   * that statement ended, failed or was rolled back. Asked for one of the two, it is brought up to the tables as they
   * are now; the write moves it on as it makes nodes and relationships.
   */
  ids(graph: string, of: 'node' | 'relationship'): GraphIds;
  /** Adds a label or a relationship type to the graph; `table` names the table made for it, which must not exist. */
  addLabel(graph: string, label: string, table?: string): void;
  addType(graph: string, type: string, table?: string): void;
  /**
   * The graph's writes into its index, where they land there first and its tables are written behind (ADR 0042,
   * section 2; exec/graph-pending.ts); null where they go to its tables as the statement runs. Asked for each write.
   */
  direct?(graph: string): DirectGraph | null;
}

/** A graph's next node id and relationship rowid (`GraphWriteHost.ids`). */
export interface GraphIds {
  node: number;
  relationship: number;
}

/** One run of the statement. */
interface Ctx {
  readonly params: readonly SqlValue[];
  readonly counts: GraphWriteCounts;
  /** The graphs' next ids, asked for when a node or a relationship is first made: by kind and graph. */
  readonly ids: Map<string, GraphIds>;
  /** The writes whose labels and types the graph has, or was given in this run. */
  readonly ready: Set<object>;
}

/** A stage's rows: `rows` gives them all at once where the stage is one query. */
interface Stream {
  readonly types: readonly PlanType[];
  readonly rows?: (ctx: Ctx) => Row[];
  run(ctx: Ctx, sink: Sink): boolean;
}

const INT = (i: number): PlanExpr => col(0, i, 'int');
const eq = (a: PlanExpr, b: PlanExpr): PlanExpr => call('cmp_eq', [a, b], 'bool');
const noCounts = (): GraphWriteCounts => ({ nodesCreated: 0, nodesDeleted: 0, relationshipsCreated: 0, relationshipsDeleted: 0, propertiesSet: 0, labelsAdded: 0, labelsRemoved: 0 });
const refuse = (what: string): never => {
  throw new SmaltError('SMALT_UNSUPPORTED', `a plan that writes a graph: ${what} is not supported`);
};

/** The plans an operation holds as inputs (not those in its expressions). */
function inputsOf(op: PlanOp): PlanOp[] {
  const o = op as unknown as { input?: PlanOp | null; inputs?: readonly PlanOp[]; init?: PlanOp; steps?: readonly PlanOp[] };
  return [...(o.input ? [o.input] : []), ...(o.inputs ?? []), ...(o.init ? [o.init] : []), ...(o.steps ?? [])];
}

/** Whether a plan holds a graph write among its operations (not in the plans of its expressions). */
export function writesGraph(op: PlanOp): boolean {
  return GRAPH_WRITE_OPS.has(op.op) || inputsOf(op).some(writesGraph);
}

/** Whether `x` (an expression, or anything that holds expressions) holds a nested plan. */
function holdsPlan(x: unknown): boolean {
  if (x === null || typeof x !== 'object' || ArrayBuffer.isView(x)) return false;
  if (Array.isArray(x)) return x.some(holdsPlan);
  const o = x as Record<string, unknown>;
  if (o.k === 'subquery' || o.k === 'inSubquery') return true;
  return Object.values(o).some(holdsPlan);
}

/** The highest column of the operation's own row that `e` reads outside nested plans, or -1. */
function highestColumn(e: unknown): number {
  if (e === null || typeof e !== 'object' || ArrayBuffer.isView(e)) return -1;
  if (Array.isArray(e)) return e.reduce((m: number, x) => Math.max(m, highestColumn(x)), -1);
  const o = e as Record<string, unknown>;
  if (o.k === 'col') return o.depth === 0 ? (o.index as number) : -1;
  if (o.k === 'subquery' || o.k === 'inSubquery') return o.k === 'inSubquery' ? highestColumn(o.probe) : -1;
  return Object.values(o).reduce((m: number, x) => Math.max(m, highestColumn(x)), -1);
}

/** A map's entries without its NULL values: its bytes (the same where none is NULL), its keys, and those dropped. */
function settable(m: Uint8Array): { map: Uint8Array; keys: string[]; nulls: string[] } {
  const flat = decodeKey(m);
  const keys: string[] = [];
  const nulls: string[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) (flat[i + 1] === null ? nulls : keys).push(flat[i] as string);
  if (nulls.length === 0) return { map: m, keys, nulls };
  const kept: SqlValue[] = [];
  for (let i = 0; i + 1 < flat.length; i += 2) if (flat[i + 1] !== null) kept.push(flat[i]!, flat[i + 1]!);
  return { map: encodeKey(kept), keys, nulls };
}

const EMPTY_MAP = encodeKey([]);

/** The one byte a NULL is as a component: a map's value that begins with it is NULL. */
const NULL_BYTE = encodeKey([null])[0]!;

/**
 * How many entries a map's bytes hold, read off the bytes with nothing decoded, or -1 where one of its values is
 * NULL (`settable` then says which keys are set). A map is its entries' components, key then value.
 */
function entriesSet(m: Uint8Array): number {
  let n = 0;
  for (let pos = 0; pos < m.length; n++) {
    pos = skipComponent(m, pos);
    if (m[pos] === NULL_BYTE) return -1;
    pos = skipComponent(m, pos);
  }
  return n;
}

/** A map's bytes from entries by key, in key order. */
function mapOf(entries: Map<string, SqlValue>): Uint8Array {
  const flat: SqlValue[] = [];
  for (const k of [...entries.keys()].sort(compareCodePoints)) flat.push(k, entries.get(k)!);
  return encodeKey(flat);
}

function entriesOf(m: Uint8Array): Map<string, SqlValue> {
  const flat = decodeKey(m);
  const out = new Map<string, SqlValue>();
  for (let i = 0; i + 1 < flat.length; i += 2) out.set(flat[i] as string, flat[i + 1]!);
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** A props value as a map's bytes: NULL is no properties; anything but a map is an error. */
function asMap(v: SqlValue, graph: string): Uint8Array {
  if (v === null) return EMPTY_MAP;
  if (v instanceof Uint8Array) return v;
  throw new SmaltError('SMALT_MISMATCH', `property graph ${graph}: properties are given as a map, not ${typeof v === 'string' ? 'text' : typeof v === 'object' ? 'a value of another kind' : `a ${typeof v}`}`);
}

const isMapType = (t: PlanType): boolean => t === 'null' || t.startsWith('map<');

/**
 * What a map of static type `t` becomes as properties, a map of values of any kind: a map of bools, lists or maps has
 * each value typed (ADR 0039), where its own bytes hold them bare. Null where the bytes are properties as they are.
 */
function asProps(t: PlanType): ((m: Uint8Array) => Uint8Array) | null {
  const n = t.startsWith('map<') ? parseNested(t) : null;
  const typed = n !== null && n.kind === 'map' ? toAny(n.of) : null;
  if (typed === null) return null;
  return (m) => {
    const flat = decodeKey(m);
    for (let i = 1; i < flat.length; i += 2) flat[i] = typed(flat[i]!);
    return encodeKey(flat);
  };
}

/**
 * A statement's plan that writes a graph, compiled into stages when it first runs and again when the schema has
 * changed since (the stages' own plans are compiled and kept by the database, as its other internal plans are).
 */
export class GraphWrite {
  private compiled: { version: number; root: Stream } | null = null;
  /** The rows the stages' plans read through `smalt_stage_rows_<k>` (see `stageSource`). */
  private readonly stages: { types: readonly PlanType[]; rows: Row[] }[] = [];
  private readonly plans = new Map<string, PlanOp>();
  /** The plans over rows held here (`over`): where each one's rows are held, and the plan. */
  private readonly heldRows = new Map<string, { source: { op: PlanOp; give: (rows: Row[]) => void }; plan: PlanOp }>();
  /** The tables the plan's writes name for the labels and types they add, by name in lower case: their column types. */
  private readonly named = new Map<string, readonly PlanType[]>();
  private layouts: { version: number; of: Map<string, GraphLayout> } | null = null;

  constructor(
    private readonly plan: PlanOp,
    /** The statement's parameters: a stage's own parameters come after them. */
    private readonly paramCount: number,
    private readonly host: GraphWriteHost,
  ) {
    const collect = (op: PlanOp): void => {
      inputsOf(op).forEach(collect);
      if (op.op === 'graphMerge') collect(op.match);
      if (op.op !== 'graphCreate' && op.op !== 'graphSet' && op.op !== 'graphMerge') return;
      // As the engine makes them: a label's `id` and `props`; a type's `start`, `end` and `props`.
      for (const t of op.tables ?? []) this.named.set(t.table.toLowerCase(), 'label' in t ? ['int', 'map<text, any>'] : ['int', 'int', 'map<text, any>']);
    };
    collect(plan);
  }

  /** Runs the statement: its rows, and what it wrote. */
  run(params: readonly SqlValue[]): { rows: Row[]; counts: GraphWriteCounts } {
    if (this.compiled === null || this.compiled.version !== this.host.schemaVersion()) {
      this.stages.length = 0;
      this.plans.clear();
      this.heldRows.clear();
      this.compiled = { version: this.host.schemaVersion(), root: this.stream(this.plan, true) };
    }
    const ctx: Ctx = { params: this.paramCount === params.length ? params : params.slice(0, this.paramCount), counts: noCounts(), ids: new Map(), ready: new Set() };
    const rows: Row[] = [];
    try {
      this.compiled.root.run(ctx, (row) => (rows.push(row), true));
    } finally {
      for (const s of this.stages) s.rows = [];
    }
    return { rows, counts: ctx.counts };
  }

  /** The rows of stage `k`, and their types: what the database's `smalt_stage_rows_<k>` reads. */
  stage(k: number): { readonly types: readonly PlanType[]; readonly rows: Row[] } | undefined {
    return this.stages[k];
  }

  // ---------------------------------------------------------------- the graph

  /** A graph's tables as they are now: a label or a type added while the statement runs makes them others. */
  private layoutOf(graph: string): GraphLayout {
    const version = this.host.schemaVersion();
    if (this.layouts === null || this.layouts.version !== version) this.layouts = { version, of: new Map() };
    let g = this.layouts.of.get(graph);
    if (g === undefined) this.layouts.of.set(graph, (g = this.host.layout(graph)));
    return g;
  }

  /** A plan's output types, the tables its writes are still to make among them. */
  private typesOf(plan: PlanOp): PlanType[] {
    return this.named.size === 0 ? this.host.types(plan) : this.host.types(plan, (table) => this.named.get(table.toLowerCase()));
  }

  /**
   * The label as the graph spells it, added to the graph when it has it not: when a row first needs it, so a
   * statement no row of which reaches the write adds nothing.
   */
  private labelOf(op: { graph: string; tables?: readonly GraphNewTable[] }, l: string): string {
    const known = this.layoutOf(op.graph).label(l);
    if (known !== undefined) return known;
    this.host.addLabel(op.graph, l, op.tables?.find((t) => 'label' in t && t.label === l)?.table);
    return this.layoutOf(op.graph).label(l) ?? l;
  }

  /** The labels and relationship types a write's new nodes and relationships have, added to the graph where it has them not: once a run, when its first row is made. */
  private ready(ctx: Ctx, op: { graph: string; tables?: readonly GraphNewTable[] }, nodes: readonly GraphNewNode[], rels: readonly GraphNewRelationship[]): void {
    if (ctx.ready.has(op)) return;
    ctx.ready.add(op);
    for (const n of nodes) for (const l of n.labels) this.labelOf(op, l);
    for (const r of rels) if (this.layoutOf(op.graph).edge(r.type) === undefined) this.host.addType(op.graph, r.type, op.tables?.find((t) => 'type' in t && t.type === r.type)?.table);
  }

  // ---------------------------------------------------------------- stages

  /**
   * An operation's rows. `quiet`: nothing above it, up to an operation that reads all its rows first, reads the
   * graph, writes or stops early, so a write here may write all its rows at once.
   */
  private stream(op: PlanOp, quiet: boolean): Stream {
    if (holdsWrite(op)) refuse('a write in a nested plan of an expression');
    if (!writesGraph(op)) return this.reads(op);
    if (op.op === 'project') {
      const picks = picksOf(op.exprs);
      if (picks !== null) return this.picking(op, picks, this.stream(op.input, quiet));
    }
    switch (op.op) {
      case 'graphCreate':
        return this.create(op, this.stream(op.input, false), quiet);
      case 'graphSet':
        return this.set(op, this.stream(op.input, false), quiet);
      case 'graphDelete':
        return this.delete(op, this.stream(op.input, false), quiet);
      case 'graphMerge':
        return this.merge(op, this.stream(op.input, false), quiet);
      case 'eager': {
        const input = this.stream(op.input, true);
        return { types: input.types, rows: (ctx) => all(input, ctx), run: (ctx, sink) => all(input, ctx).every(sink) };
      }
      case 'limit':
        return this.limit(op, this.stream(op.input, false));
      case 'filter':
      case 'project':
      case 'explode':
      case 'unpivot':
      case 'paths':
      case 'join': {
        // These and the ones like them below, down to the first that is not, are one plan over a row.
        const steps: Step[] = [];
        for (let s = step(op); s !== null; s = step(s.input)) steps.push(s);
        const bottom = steps[steps.length - 1]!.input;
        const calm = steps.every((s) => s.calm);
        const below = this.stream(bottom, quiet && calm);
        const over = (leaf: PlanOp): PlanOp => steps.reduceRight((under, s) => s.over(under), leaf);
        // Steps that read only their rows, with nothing above that could tell one row at a time from all of them:
        // one run over all the rows, where a run for each row would cost more than the steps.
        return quiet && calm ? this.allRows(op, below, over) : this.perRow(op, below, over);
      }
      case 'sort':
      case 'aggregate':
      case 'distinct':
      case 'window':
      case 'sample':
      case 'pivot':
        return this.allRows(op, this.stream(op.input, true), (leaf) => ({ ...op, input: leaf }));
      default:
        return refuse(`${op.op} over rows that were written`);
    }
  }

  /**
   * A part that writes nothing. One query, unless operations at its top that pass rows on as they come read the graph
   * for each row: from the lowest of those up they are a plan run for each row of the query below them.
   */
  private reads(op: PlanOp): Stream {
    const steps: Step[] = [];
    for (let s = op.op === 'join' ? null : step(op); s !== null; s = s.input.op === 'join' ? null : step(s.input)) steps.push(s);
    let lowest = steps.length - 1;
    while (lowest >= 0 && steps[lowest]!.calm) lowest--;
    if (lowest < 0) return this.query(op);
    return this.perRow(op, this.query(steps[lowest]!.input), (leaf) => steps.slice(0, lowest + 1).reduceRight((below, s) => s.over(below), leaf));
  }

  /** One query, all its rows read when they are first wanted. */
  private query(op: PlanOp): Stream {
    const rows = (ctx: Ctx): Row[] => this.host.run(op, ctx.params)!;
    return { types: this.typesOf(op), rows, run: (ctx, sink) => rows(ctx).every(sink) };
  }

  /** A row as a relation, its values the plan's parameters after the statement's. */
  private rowLeaf(types: readonly PlanType[]): PlanOp {
    return values([types.map((t, i) => param(this.paramCount + i, t === 'null' ? 'any' : t))], types.map((t) => (t === 'null' ? 'any' : t)));
  }

  /** The parameters of a plan over a row: the statement's, then the row's values. */
  private withRow(ctx: Ctx, row: Row): SqlValue[] {
    const out = new Array<SqlValue>(this.paramCount + row.length);
    for (let i = 0; i < this.paramCount; i++) out[i] = ctx.params[i] ?? null;
    for (let i = 0; i < row.length; i++) out[this.paramCount + i] = row[i]!;
    return out;
  }

  /** Rows held here as a relation: the plan operation that reads them, and where to put them before it runs. */
  private stageSource(types: readonly PlanType[]): { op: PlanOp; give: (rows: Row[]) => void } {
    const k = this.stages.length;
    // A relation has a column: rows of none are given one.
    const held = types.length === 0 ? (['int'] as PlanType[]) : types.map((t) => (t === 'null' ? 'any' : t));
    const stage = { types: held, rows: [] as Row[] };
    this.stages.push(stage);
    const source: PlanOp = { op: 'source', kind: 'function', name: `${STAGE_ROWS}${k}`, args: [], types: held };
    return {
      op: types.length === 0 ? project(source, []) : source,
      give: (rows) => void (stage.rows = types.length === 0 ? rows.map(() => [0]) : rows),
    };
  }

  /**
   * A projection that only picks (`pickOf`): each row's values are taken from it as it comes, with no plan run for
   * them, whether the input gives its rows one at a time or all at once.
   */
  private picking(op: PlanOp, picks: readonly number[], input: Stream): Stream {
    const rows = input.rows;
    return {
      types: this.typesOf(op),
      ...(rows ? { rows: (ctx: Ctx): Row[] => rows(ctx).map((row) => picked(picks, row, ctx.params)) } : {}),
      run: (ctx, sink) => input.run(ctx, (row) => sink(picked(picks, row, ctx.params))),
    };
  }

  /** An operation that passes rows on as they come: run for each row of its input, its rows passed on before the next row is read. */
  private perRow(op: PlanOp, input: Stream, over: (leaf: PlanOp) => PlanOp): Stream {
    const plan = over(this.rowLeaf(input.types));
    return {
      types: this.typesOf(op),
      run: (ctx, sink) => input.run(ctx, (row) => this.host.run(plan, this.withRow(ctx, row))!.every(sink)),
    };
  }

  /** An operation that needs all its rows: its input read to the end, then one run over them. */
  private allRows(op: PlanOp, input: Stream, over: (leaf: PlanOp) => PlanOp): Stream {
    const source = this.stageSource(input.types);
    const plan = over(source.op);
    return {
      types: this.typesOf(op),
      run: (ctx, sink) => {
        source.give(all(input, ctx));
        return this.host.run(plan, ctx.params)!.every(sink);
      },
    };
  }

  /** `limit` over rows that were written: it passes rows on until it has its count, then stops what feeds it. */
  private limit(op: Op<'limit'>, input: Stream): Stream {
    if (op.fromEnd) refuse('a limit counted from the end over rows that were written');
    const bounds = project(values([[]], []), [op.count, op.offset ?? lit(0)]);
    return {
      types: input.types,
      run: (ctx, sink) => {
        const [count, offset] = this.host.run(bounds, ctx.params)![0]!;
        const skip = typeof offset === 'number' && offset > 0 ? offset : 0;
        // As a limit anywhere: a negative count, or none, is no limit.
        const take = typeof count === 'number' && count >= 0 ? count : Infinity;
        if (take === 0) return true;
        let seen = 0;
        let stopped = false;
        input.run(ctx, (row) => {
          if (seen++ < skip) return true;
          if (!sink(row)) return ((stopped = true), false);
          return seen - skip < take;
        });
        return !stopped;
      },
    };
  }

  // ---------------------------------------------------------------- what the writes read

  /** A plan kept for `key`: the database compiles it once and keeps it by the plan itself. */
  private kept(key: string, make: () => PlanOp): PlanOp {
    let p = this.plans.get(key);
    if (p === undefined) this.plans.set(key, (p = make()));
    return p;
  }

  /**
   * How a write evaluates expressions over its row. Those that read only the input's columns and hold no nested plan
   * are computed together, by one plan, for a row or for all the rows at once (they read nothing a write changes).
   * The others are computed one by one, each when its turn comes, over the row as far as it is made.
   */
  private evaluator(types: readonly PlanType[], width: number): Evaluator {
    return new Evaluator(this, types, width);
  }

  /** @internal Evaluates `exprs` over one row. */
  evalRow(key: PlanExpr[], types: readonly PlanType[], ctx: Ctx, row: Row): Row {
    const plan = this.kept(`row:${this.planKey(key)}`, () => project(this.rowLeaf(types), key));
    return this.host.run(plan, this.withRow(ctx, row))![0]!;
  }

  /** @internal Evaluates `exprs` over all the rows at once: a row of values for each, in order. */
  evalRows(exprs: PlanExpr[], source: { op: PlanOp; give: (rows: Row[]) => void }, ctx: Ctx, rows: Row[]): Row[] {
    source.give(rows);
    return this.host.run(this.kept(`rows:${this.planKey(exprs)}`, () => project(source.op, exprs)), ctx.params)!;
  }

  private readonly keys = new Map<object, number>();
  /** A number for a list of expressions, by identity. */
  private planKey(x: object): number {
    let k = this.keys.get(x);
    if (k === undefined) this.keys.set(x, (k = this.keys.size));
    return k;
  }

  /** @internal */
  source(types: readonly PlanType[]): { op: PlanOp; give: (rows: Row[]) => void } {
    return this.stageSource(types);
  }

  // ---------------------------------------------------------------- ids

  /** A new node's id (or a new relationship's rowid): the graph's next, asked for once a run and moved on. */
  private newId(ctx: Ctx, g: GraphLayout, of: 'node' | 'relationship'): number {
    return this.idsOf(ctx, g, of)[of]++;
  }

  private idsOf(ctx: Ctx, g: GraphLayout, of: 'node' | 'relationship'): GraphIds {
    const key = `${of}:${g.name}`;
    let ids = ctx.ids.get(key);
    if (ids === undefined) ctx.ids.set(key, (ids = this.host.ids(g.name, of)));
    return ids;
  }

  // ---------------------------------------------------------------- the tables' writes

  private write(plan: PlanOp, params: readonly SqlValue[]): number {
    this.host.run(plan, params);
    return this.host.changes();
  }

  /** Appends rows to a table in one pass: `columns` of the table (-1: its rowid), of `types`. */
  private appendRows(table: string, columns: readonly number[], types: readonly PlanType[], rows: Row[]): void {
    if (rows.length > 0) this.runOver(`rows:${table}:${columns.join()}`, types, (held) => append(table, held, columns), rows);
  }

  /** The graph's writes into its index, or null where they go to its tables. Asked for each write: it may change with one. */
  private directOf(g: GraphLayout): DirectGraph | null {
    return this.host.direct?.(g.name) ?? null;
  }

  /** New nodes (an id and props each): into the graph's index, or appended to its node table in one pass. */
  private putNodes(g: GraphLayout, rows: Row[]): void {
    const d = this.directOf(g);
    if (d !== null) {
      let i = 0;
      while (i < rows.length && d.node(rows[i]![0] as number, rows[i]![1] as Uint8Array)) i++;
      if (i === rows.length) return;
      // The index takes no more: the rest go through the table.
      rows = rows.slice(i);
    }
    this.appendRows(g.nodes.table, [g.nodes.id, g.nodes.props], ['int', 'map<text, any>'], rows);
  }

  /** New label entries (a node and a label each, which the node has not): into the graph's index, or appended to its label index. */
  private putLabels(g: GraphLayout, rows: Row[]): void {
    const d = this.directOf(g);
    if (d !== null) {
      let i = 0;
      while (i < rows.length && d.addLabel(rows[i]![0]!, rows[i]![1] as string)) i++;
      if (i === rows.length) return;
      rows = rows.slice(i);
    }
    this.appendRows(g.labels.table, [g.labels.node, g.labels.label], ['int', 'text'], rows);
  }

  /** New relationships of one type (a rowid, a start, an end and, where its table has them, props each): into the index, or appended to the table. */
  private putEdges(g: GraphLayout, e: { readonly table: string; readonly start: number; readonly end: number; readonly props: number }, rows: Row[]): void {
    const d = this.directOf(g);
    const at = d?.at(e.table);
    if (d !== null && at !== undefined && at >= 0) {
      let i = 0;
      while (i < rows.length && d.edge(at, rows[i]![0] as number, rows[i]![1]!, rows[i]![2]!, e.props < 0 ? EMPTY_MAP : (rows[i]![3] as Uint8Array))) i++;
      if (i === rows.length) return;
      rows = rows.slice(i);
    }
    if (e.props < 0) this.appendRows(e.table, [-1, e.start, e.end], ['int', 'int', 'int'], rows);
    else this.appendRows(e.table, [-1, e.start, e.end, e.props], ['int', 'int', 'int', 'map<text, any>'], rows);
  }

  private appendNode(g: GraphLayout, id: number, props: Uint8Array): void {
    if (this.directOf(g)?.node(id, props)) return;
    const t = g.nodes;
    this.write(this.kept(`node:${t.table}`, () => append(t.table, values([[param(0, 'int'), param(1, 'map<text, any>')]], ['int', 'map<text, any>']), [t.id, t.props])), [id, props]);
  }

  private appendLabel(g: GraphLayout, id: SqlValue, label: string): void {
    if (this.directOf(g)?.addLabel(id, label)) return;
    const t = g.labels;
    this.write(this.kept(`label:${t.table}`, () => append(t.table, values([[param(0, 'int'), param(1, 'text')]], ['int', 'text']), [t.node, t.label])), [id, label]);
  }

  private hasLabel(g: GraphLayout, id: SqlValue, label: string): boolean {
    const d = this.directOf(g);
    if (d !== null) return d.hasLabel(id, label);
    const t = g.labels;
    const plan = this.kept(`has:${t.table}`, () => limitOf(project(filter(scan(t.table, [t.node, t.label]), { k: 'and', args: [eq(INT(0), param(0, 'int')), eq(col(0, 1, 'text'), param(1, 'text'))] }), [lit(1)]), 1));
    return this.host.run(plan, [id, label])!.length > 0;
  }

  private dropLabel(g: GraphLayout, id: SqlValue, label: string): number {
    const d = this.directOf(g);
    if (d !== null) return d.dropLabel(id, label);
    const t = g.labels;
    const plan = this.kept(`drop:${t.table}`, () => remove(t.table, filter(scan(t.table, [-1, t.node, t.label]), { k: 'and', args: [eq(INT(1), param(0, 'int')), eq(col(0, 2, 'text'), param(1, 'text'))] }), 0));
    return this.write(plan, [id, label]);
  }

  private appendEdge(g: GraphLayout, type: string, rowid: number, start: SqlValue, end: SqlValue, props: Uint8Array, keys: number): void {
    const e = g.edge(type)!;
    if (e.props < 0 && keys > 0) throw new SmaltError('SMALT_ERROR', `property graph ${g.name}: relationship type ${type} keeps no properties`);
    const d = this.directOf(g);
    const at = d?.at(e.table);
    if (d !== null && at !== undefined && at >= 0 && d.edge(at, rowid, start, end, props)) return;
    if (e.props < 0) {
      this.write(this.kept(`edge:${e.table}`, () => append(e.table, values([[param(0, 'int'), param(1, 'int'), param(2, 'int')]], ['int', 'int', 'int']), [-1, e.start, e.end])), [rowid, start, end]);
      return;
    }
    const types: PlanType[] = ['int', 'int', 'int', 'map<text, any>'];
    this.write(this.kept(`edge:${e.table}`, () => append(e.table, values([types.map((t, i) => param(i, t))], types), [-1, e.start, e.end, e.props])), [rowid, start, end, props]);
  }

  /** The properties of a node or a relationship, by its table and rowid: undefined when it is not there. */
  private propsOf(g: GraphLayout, table: string, propsColumn: number, rowid: SqlValue): Uint8Array | undefined {
    const d = this.directOf(g);
    const at = d?.at(table);
    if (d !== null && at !== undefined) {
      const held = d.props(at, rowid);
      if (held !== PASS) return held === null ? EMPTY_MAP : held;
    }
    const plan = this.kept(`props:${table}`, () => project(filter(scan(table, [-1, propsColumn]), eq(INT(0), param(0, 'int'))), [col(0, 1, 'map<text, any>')]));
    const row = this.host.run(plan, [rowid])![0];
    return row === undefined ? undefined : row[0] === null ? EMPTY_MAP : (row[0] as Uint8Array);
  }

  /** New props for a row that is there; `before`: the props it has, where the caller read them (`propsOf`). */
  private setProps(g: GraphLayout, table: string, propsColumn: number, rowid: SqlValue, props: Uint8Array, before: Uint8Array | null = null): void {
    const d = this.directOf(g);
    const at = d?.at(table);
    if (d !== null && at !== undefined && d.setProps(at, rowid, props, before)) return;
    this.write(this.kept(`set:${table}`, () => update(table, filter(scan(table, [-1]), eq(INT(0), param(0, 'int'))), 0, [{ column: propsColumn, value: param(1, 'map<text, any>') }])), [rowid, props]);
  }

  /**
   * Deletes the rows of one of the graph's tables with these rowids: nodes and relationships from the graph's index
   * where its writes land there, else through the table's writer. How many were there.
   */
  private deleteRows(g: GraphLayout, table: string, rowids: readonly SqlValue[]): number {
    const d = this.directOf(g);
    const at = d?.at(table);
    if (d === null || at === undefined) return this.host.deleteRows(table, rowids);
    let n = 0;
    let rest: SqlValue[] | undefined;
    for (const rowid of rowids) {
      const there = at < 0 ? d.deleteNode(rowid) : d.deleteEdge(at, rowid);
      if (there === PASS) (rest ??= []).push(rowid);
      else n += there;
    }
    return rest === undefined ? n : n + this.host.deleteRows(table, rest);
  }

  // ---------------------------------------------------------------- graphCreate

  private create(op: Op<'graphCreate'>, input: Stream, quiet: boolean): Stream {
    const w = input.types.length;
    const outTypes: PlanType[] = [...input.types, ...op.nodes.map((): PlanType => 'int'), ...op.relationships.map((): PlanType => 'int')];
    const make = this.maker(op, op.nodes, op.relationships, input.types);
    return {
      types: outTypes,
      run: (ctx, sink) => {
        // One query below: what reads only its rows is computed for all of them at once.
        if (input.rows) {
          const rows = input.rows(ctx);
          // And where nothing could tell (nothing above reads the graph or stops between two rows, and what the rows
          // make reads only them), all of them are written at once: a pass over each table.
          if (quiet && make.settled && rows.length > 1) {
            const made = make.rows(ctx, rows, w);
            if (made !== null) return made.every(sink);
          }
          const early = make.early(ctx, rows);
          return rows.every((row, i) => sink(make.row(ctx, row, early?.[i], w)));
        }
        return input.run(ctx, (row) => sink(make.row(ctx, row, undefined, w)));
      },
    };
  }

  /**
   * What makes a row's nodes and relationships (`graphCreate`, and `graphMerge` when nothing matches): `row` gives
   * the row with their ids after its own columns.
   */
  private maker(op: { graph: string; tables?: readonly GraphNewTable[] }, nodes: readonly GraphNewNode[], rels: readonly GraphNewRelationship[], types: readonly PlanType[]): Maker {
    const w = types.length;
    const rowTypes: PlanType[] = [...types, ...nodes.map((): PlanType => 'int'), ...rels.map((): PlanType => 'int')];
    const ev = this.evaluator(rowTypes, w);
    const nodeProps = nodes.map((n, k) => {
      if (n.props && !isMapType(typeOf(n.props))) throw new SmaltError('SMALT_PLAN', `graphCreate: a node's props is a map, not ${typeOf(n.props)}`);
      return n.props ? { ref: ev.add(n.props, w + k), typed: asProps(typeOf(n.props)) } : null;
    });
    /** A props expression's value as properties. */
    const propsOf = (p: { ref: EvalRef; typed: ((m: Uint8Array) => Uint8Array) | null } | null, vals: Values) => {
      if (p === null) return settable(EMPTY_MAP);
      const m = asMap(vals.get(p.ref), op.graph);
      return settable(p.typed ? p.typed(m) : m);
    };
    // The labels as the graph spells them, each once; the node's own table gives it its label without an entry. Read
    // again when the graph is another (a label added to it).
    let spelled: { g: GraphLayout; labels: string[][] } | null = null;
    const labelsIn = (g: GraphLayout): string[][] => {
      if (spelled === null || spelled.g !== g) spelled = { g, labels: nodes.map((n) => [...new Set(n.labels.map((l) => g.label(l) ?? l))].filter((l) => l !== g.nodes.label)) };
      return spelled.labels;
    };
    /** The ends that are nodes a row names, not ones the operation makes. */
    const named: EvalRef[] = [];
    const ends = (e: GraphEnd, at: number): { node: number } | { value: EvalRef } => {
      if ('node' in e) return { node: e.node };
      const value = ev.add(e.id, at);
      named.push(value);
      return { value };
    };
    const relParts = rels.map((r, j) => {
      if (r.props && !isMapType(typeOf(r.props))) throw new SmaltError('SMALT_PLAN', `graphCreate: a relationship's props is a map, not ${typeOf(r.props)}`);
      const at = w + nodes.length + j;
      return { type: r.type, start: ends(r.start, at), end: ends(r.end, at), props: r.props ? { ref: ev.add(r.props, at), typed: asProps(typeOf(r.props)) } : null };
    });
    const make: Maker = {
      early: (ctx, rows) => ev.early(ctx, rows),
      settled: ev.settled,
      rows: (ctx, rows, width, several = true): Row[] | null => {
        if (rows.length === 0) return [];
        // One row is written as a row is: a plan over rows held here costs more than the row.
        if (rows.length === 1 && !several) return [make.row(ctx, rows[0]!, undefined, width)];
        const early = ev.early(ctx, rows);
        this.ready(ctx, op, nodes, rels);
        const g = this.layoutOf(op.graph);
        // A node a row names for a relationship must be there when the row is written, and one that a later row of
        // these makes is not: written all at once it would be. Such rows go one by one, where the graph's rules
        // refuse it.
        if (named.length > 0 && nodes.length > 0 && early !== undefined) {
          const first = this.idsOf(ctx, g, 'node').node;
          const end = first + rows.length * nodes.length;
          for (let i = 0; i < rows.length; i++) {
            const mine = first + (i + 1) * nodes.length;
            if (named.some((ref) => ref.early && typeof early[i]![ref.at] === 'number' && (early[i]![ref.at] as number) >= mine && (early[i]![ref.at] as number) < end)) return null;
          }
        }
        const labels = labelsIn(g);
        // What each table gets, in the order row by row would write it.
        const nodeRows: Row[] = [];
        const labelRows: Row[] = [];
        const edges = relParts.map((r) => g.edge(r.type)!);
        const edgeRows = new Map<string, Row[]>();
        // The graph's next ids, asked for once for all the rows.
        const nodeIds = nodes.length > 0 ? this.idsOf(ctx, g, 'node') : null;
        const relIds = relParts.length > 0 ? this.idsOf(ctx, g, 'relationship') : null;
        const counts = ctx.counts;
        const outs = rows.map((row, i) => {
          const out: Row = new Array(width + nodes.length + rels.length).fill(null);
          for (let c = 0; c < width; c++) out[c] = row[c]!;
          const ahead = early?.[i];
          // The row's values as they are read one by one: made where a relationship reads its ends and props so, or
          // a node's props were not computed ahead.
          let vals = relParts.length > 0 ? ev.over(ctx, out, ahead) : null;
          for (let k = 0; k < nodes.length; k++) {
            const p = nodeProps[k]!;
            let map = EMPTY_MAP;
            let set = 0;
            if (p !== null) {
              // Props computed ahead are read where they lie. Their entries are counted on the bytes, and decoded
              // only where one holds NULL, which is no property.
              const given = asMap(ahead !== undefined && p.ref.early ? ahead[p.ref.at]! : (vals ??= ev.over(ctx, out, ahead)).get(p.ref), op.graph);
              map = p.typed ? p.typed(given) : given;
              set = entriesSet(map);
              if (set < 0) {
                const kept = settable(map);
                map = kept.map;
                set = kept.keys.length;
              }
            }
            const id = nodeIds!.node++;
            nodeRows.push([id, map]);
            const mine = labels[k]!;
            for (let j = 0; j < mine.length; j++) labelRows.push([id, mine[j]!]);
            out[width + k] = id;
            counts.nodesCreated++;
            counts.labelsAdded += nodes[k]!.labels.length;
            counts.propertiesSet += set;
          }
          relParts.forEach((r, j) => {
            const end = (e: { node: number } | { value: EvalRef }): SqlValue => ('node' in e ? out[width + e.node]! : vals!.get(e.value));
            const props = propsOf(r.props, vals!);
            const e = edges[j]!;
            if (e.props < 0 && props.keys.length > 0) throw new SmaltError('SMALT_ERROR', `property graph ${g.name}: relationship type ${r.type} keeps no properties`);
            const rowid = relIds!.relationship++;
            let held = edgeRows.get(e.table);
            if (held === undefined) edgeRows.set(e.table, (held = []));
            held.push(e.props < 0 ? [rowid, end(r.start), end(r.end)] : [rowid, end(r.start), end(r.end), props.map]);
            out[width + nodes.length + j] = rowid;
            ctx.counts.relationshipsCreated++;
            ctx.counts.propertiesSet += props.keys.length;
          });
          return out;
        });
        this.putNodes(g, nodeRows);
        this.putLabels(g, labelRows);
        for (const e of new Set(edges)) {
          const held = edgeRows.get(e.table);
          if (held === undefined) continue;
          this.putEdges(g, e, held);
          edgeRows.delete(e.table);
        }
        return outs;
      },
      row: (ctx, row, early, width) => {
        const out: Row = new Array(width + nodes.length + rels.length).fill(null);
        for (let i = 0; i < width; i++) out[i] = row[i]!;
        const vals = ev.over(ctx, out, early);
        // The labels and types the graph has not are added now, when a row is first made.
        this.ready(ctx, op, nodes, rels);
        const g = this.layoutOf(op.graph);
        const labels = labelsIn(g);
        nodes.forEach((n, k) => {
          const props = propsOf(nodeProps[k]!, vals);
          const id = this.newId(ctx, g, 'node');
          this.appendNode(g, id, props.map);
          for (const l of labels[k]!) this.appendLabel(g, id, l);
          out[width + k] = id;
          ctx.counts.nodesCreated++;
          ctx.counts.labelsAdded += n.labels.length;
          ctx.counts.propertiesSet += props.keys.length;
        });
        relParts.forEach((r, j) => {
          const end = (e: { node: number } | { value: EvalRef }): SqlValue => ('node' in e ? out[width + e.node]! : vals.get(e.value));
          const start = end(r.start);
          const finish = end(r.end);
          const props = propsOf(r.props, vals);
          const rowid = this.newId(ctx, g, 'relationship');
          this.appendEdge(g, r.type, rowid, start, finish, props.map, props.keys.length);
          out[width + nodes.length + j] = rowid;
          ctx.counts.relationshipsCreated++;
          ctx.counts.propertiesSet += props.keys.length;
        });
        return out;
      },
    };
    return make;
  }

  // ---------------------------------------------------------------- graphSet

  private set(op: Op<'graphSet'>, input: Stream, quiet: boolean): Stream {
    const apply = this.setter(op, op.items, input.types);
    return {
      types: input.types,
      run: (ctx, sink) => {
        if (input.rows) {
          const rows = input.rows(ctx);
          // All of them at once where nothing could tell: a pass over each table an item writes.
          if (quiet && rows.length > 1 && apply.rows(ctx, rows)) return rows.every(sink);
          const early = apply.early(ctx, rows);
          return rows.every((row, i) => (apply.row(ctx, row, early?.[i]), sink(row)));
        }
        return input.run(ctx, (row) => (apply.row(ctx, row, undefined), sink(row)));
      },
    };
  }

  /** What applies `items` to a row, item by item. */
  private setter(op: { graph: string; tables?: readonly GraphNewTable[] }, items: readonly GraphSetItem[], types: readonly PlanType[]): Setter {
    if (items.length === 0) return { early: () => undefined, row: () => undefined, rows: () => true };
    const w = types.length;
    // What reads only the row is computed ahead. The rest is computed when its item's turn comes: an item reads what
    // the items before it wrote.
    const ev = this.evaluator(types, w);
    const ahead = (e: PlanExpr): boolean => highestColumn(e) < w && !holdsPlan(e);
    /**
     * An item's value. It is not computed for a NULL node or relationship: what is computed ahead for a row is
     * computed together, so a value that could be is NULL where the item's node or relationship is, and one whose
     * node or relationship is known only when its turn comes is computed then too.
     */
    const valueOf = (it: Exclude<GraphSetItem, { kind: 'labels' }>): EvalRef => {
      const names = it.node !== undefined ? [it.node] : [it.relationship.type, it.relationship.id];
      if (!ahead(it.value)) return ev.add(it.value, w);
      if (!names.every(ahead)) return ev.late(it.value);
      const none: PlanExpr = names.length === 1 ? { k: 'isNull', arg: names[0]!, not: false } : { k: 'or', args: names.map((arg): PlanExpr => ({ k: 'isNull', arg, not: false })) };
      const type = typeOf(it.value);
      return ev.add({ k: 'case', whens: [{ when: none, then: lit(null) }], else: it.value, type: type === 'null' ? 'any' : type }, w);
    };
    const parts = items.map((it) => ({
      it,
      node: it.node !== undefined ? ev.add(it.node, w) : null,
      rel: it.relationship !== undefined ? { type: ev.add(it.relationship.type, w), id: ev.add(it.relationship.id, w) } : null,
      value: it.kind === 'labels' ? null : valueOf(it),
      // A property's value is one of any kind in the map: a boolean, a list or a map keeps its type there (ADR 0039).
      typed: it.kind === 'property' ? toAny(typeOf(it.value)) : null,
      props: it.kind === 'properties' ? asProps(typeOf(it.value)) : null,
      // A property's key as a map holds it.
      key: it.kind === 'property' ? encodeKey([it.key]) : null,
    }));
    type Part = (typeof parts)[number];
    /** A relationship of a type whose table has no column for properties is given none. */
    const noProps = (t: Target): never => {
      throw new SmaltError('SMALT_ERROR', `property graph ${op.graph}: table ${t.table} keeps no properties`);
    };
    const targetOf = (p: Part, vals: Values): Target | null =>
      this.target(this.layoutOf(op.graph), p.node === null ? null : vals.get(p.node), p.rel === null ? null : { type: vals.get(p.rel.type), id: vals.get(p.rel.id) });
    const row = (ctx: Ctx, row: Row, early: Row | undefined): void => {
      const vals = ev.over(ctx, row, early);
      for (const p of parts) {
        // The node or relationship first: for a NULL one, the value is not computed.
        const target = targetOf(p, vals);
        if (target === null) continue;
        const it = p.it;
        if (it.kind === 'labels') {
          if (p.node === null) continue;
          for (const l of it.add) {
            // A label the graph has not is added to it now, when a node first takes it.
            const label = this.labelOf(op, l);
            const g = this.layoutOf(op.graph);
            if (label === g.nodes.label || this.hasLabel(g, target.rowid, label)) continue;
            this.appendLabel(g, target.rowid, label);
            ctx.counts.labelsAdded++;
          }
          for (const l of it.remove) {
            const g = this.layoutOf(op.graph);
            const label = g.label(l);
            if (label !== undefined && label !== g.nodes.label) ctx.counts.labelsRemoved += this.dropLabel(g, target.rowid, label);
          }
          continue;
        }
        if (target.props < 0) noProps(target);
        const cur = this.propsOf(this.layoutOf(op.graph), target.table, target.props, target.rowid);
        // The value is computed for one that is gone too: an error in it is raised either way.
        const given = vals.get(p.value!);
        const value = p.typed ? p.typed(given) : given;
        if (cur === undefined) continue;
        if (it.kind === 'property') {
          // One key, set in the map's bytes: its other entries are not decoded.
          ctx.counts.propertiesSet++;
          const next = setMapKey(cur, p.key!, value === null ? null : encodeKey([value]));
          // A value set to what it is writes nothing: a table that keeps history gets no version that changes nothing.
          if (!sameBytes(cur, next)) this.setProps(this.layoutOf(op.graph), target.table, target.props, target.rowid, next, cur);
          continue;
        }
        // A map over the properties, or merged into them.
        const entries = entriesOf(cur);
        const m = asMap(value, op.graph);
        const settled = settable(p.props ? p.props(m) : m);
        const map = entriesOf(settled.map);
        if (it.merge) {
          for (const k of settled.nulls) entries.delete(k);
          for (const [k, v] of map) entries.set(k, v);
          ctx.counts.propertiesSet += settled.nulls.length + settled.keys.length;
        } else {
          let removed = 0;
          for (const k of [...entries.keys()]) {
            if (!map.has(k)) removed++;
            entries.delete(k);
          }
          for (const [k, v] of map) entries.set(k, v);
          ctx.counts.propertiesSet += removed + settled.keys.length;
        }
        const next = mapOf(entries);
        // A value set to what it is writes nothing: a table that keeps history gets no version that changes nothing.
        if (!sameBytes(cur, next)) this.setProps(this.layoutOf(op.graph), target.table, target.props, target.rowid, next, cur);
      }
    };
    // All the rows at once: every item sets one property, or labels, and reads only its row, so no row reads what
    // another writes.
    const atOnce = ev.settled && items.every((it) => it.kind !== 'properties');
    const rows = (ctx: Ctx, rows: Row[]): boolean => {
      if (!atOnce) return false;
      // Every expression was computed ahead (`atOnce`): a row's values are read where `early` has them, and nothing
      // is made for a row. With no expression, or no row, there is nothing to write.
      const early = ev.early(ctx, rows);
      if (early === undefined) return true;
      const n = early.length;
      const layout = this.layoutOf(op.graph);
      // A node's rows are the node table's, its rowid the node's id. A relationship's table is its type's.
      const relTargets = parts.map((p) => {
        const rel = p.rel;
        return rel === null ? null : early.map((r) => this.target(layout, null, { type: r[rel.type.at]!, id: r[rel.id.at]! }));
      });
      // Item by item over all the rows is not row by row over all the items where one thing is written twice: a key
      // of one node or relationship (by one item in two rows, or by two items), or the labels of one node. The
      // later write is over the earlier, and which is later differs. The rows then go one by one.
      const seen = new Map<string, Written>();
      const writtenOf = (what: string, table: string): Written => {
        const key = `${what}:${table}`;
        let w = seen.get(key);
        if (w === undefined) seen.set(key, (w = new Written()));
        return w;
      };
      for (let k = 0; k < parts.length; k++) {
        const p = parts[k]!;
        const what = p.it.kind === 'property' ? `key:${p.it.key}` : 'labels';
        const rels = relTargets[k]!;
        if (rels === null) {
          if (p.node === null) continue;
          const at = p.node.at;
          const w = writtenOf(what, layout.nodes.table);
          for (let i = 0; i < n; i++) {
            const id = early[i]![at]!;
            if (id !== null && !w.add(id)) return false;
          }
          continue;
        }
        let table: string | undefined;
        let w: Written | undefined;
        for (const t of rels) {
          if (t === null) continue;
          if (t.table !== table) w = writtenOf(what, (table = t.table));
          if (!w!.add(t.rowid)) return false;
        }
      }
      parts.forEach((p, k) => {
        const it = p.it;
        if (it.kind === 'labels') {
          if (p.node === null) return;
          const ids: SqlValue[] = [];
          for (let i = 0; i < n; i++) {
            const id = early[i]![p.node.at]!;
            if (id !== null) ids.push(id);
          }
          if (ids.length === 0) return;
          for (const l of it.add) {
            const label = this.labelOf(op, l);
            const g = this.layoutOf(op.graph);
            if (label === g.nodes.label) continue;
            const d = this.directOf(g);
            const has = new Set(d !== null ? ids.filter((id) => d.hasLabel(id, label)) : this.labelled(g, ids, label));
            const missing = ids.filter((id) => !has.has(id));
            this.putLabels(g, missing.map((id) => [id, label]));
            ctx.counts.labelsAdded += missing.length;
          }
          for (const l of it.remove) {
            const g = this.layoutOf(op.graph);
            const label = g.label(l);
            if (label !== undefined && label !== g.nodes.label) ctx.counts.labelsRemoved += this.dropLabels(g, ids, label);
          }
          return;
        }
        if (it.kind !== 'property') return;
        const value = p.value!.at;
        const rels = relTargets[k]!;
        if (rels === null) {
          // A node's key: each node's id, and the value its key gets (NULL takes the key away).
          if (p.node === null) return;
          const g = this.layoutOf(op.graph);
          const held: Row[] = [];
          for (let i = 0; i < n; i++) {
            const r = early[i]!;
            const id = r[p.node.at]!;
            if (id === null) continue;
            if (g.nodes.props < 0) noProps({ table: g.nodes.table, props: g.nodes.props, rowid: id });
            const given = r[value]!;
            held.push([id, p.typed ? p.typed(given) : given]);
          }
          if (held.length > 0) ctx.counts.propertiesSet += this.setKey(g, g.nodes.table, g.nodes.props, it.key, held);
          return;
        }
        // By table: each target's rowid, and the value its key gets.
        const byTable = new Map<string, { props: number; rows: Row[] }>();
        rels.forEach((t, i) => {
          if (t === null) return;
          if (t.props < 0) noProps(t);
          const given = early[i]![value]!;
          let held = byTable.get(t.table);
          if (held === undefined) byTable.set(t.table, (held = { props: t.props, rows: [] }));
          held.rows.push([t.rowid, p.typed ? p.typed(given) : given]);
        });
        for (const [table, held] of byTable) ctx.counts.propertiesSet += this.setKey(this.layoutOf(op.graph), table, held.props, it.key, held.rows);
      });
      return true;
    };
    return { early: (ctx, rows) => ev.early(ctx, rows), row, rows };
  }

  /** The table, props column and rowid a node id or a relationship's type and rowid name; null for a NULL one, or one of a type the graph has not. */
  private target(g: GraphLayout, node: SqlValue | null, rel: { type: SqlValue; id: SqlValue } | null): Target | null {
    if (rel === null) return node === null ? null : { table: g.nodes.table, props: g.nodes.props, rowid: node };
    if (rel.id === null || typeof rel.type !== 'string') return null;
    const e = g.edge(rel.type);
    return e === undefined ? null : { table: e.table, props: e.props, rowid: rel.id };
  }

  /** A plan over rows held here (of `types`), kept for `key`: the rows are given before it runs. */
  private over(key: string, types: readonly PlanType[], make: (rows: PlanOp) => PlanOp): { source: { op: PlanOp; give: (rows: Row[]) => void }; plan: PlanOp } {
    let held = this.heldRows.get(key);
    if (held === undefined) {
      const source = this.stageSource(types);
      this.heldRows.set(key, (held = { source, plan: make(source.op) }));
    }
    return held;
  }

  /** Runs the plan kept for `key` over `rows`: its rows for a query, null for a write. */
  private runOver(key: string, types: readonly PlanType[], make: (rows: PlanOp) => PlanOp, rows: Row[], params: readonly SqlValue[] = []): SqlValue[][] | null {
    const held = this.over(key, types, make);
    held.source.give(rows);
    try {
      return this.host.run(held.plan, params);
    } finally {
      held.source.give([]);
    }
  }

  /** Of the nodes `ids`, those that have the label. */
  private labelled(g: GraphLayout, ids: readonly SqlValue[], label: string): SqlValue[] {
    const t = g.labels;
    const found = this.runOver(
      `labelled:${t.table}`,
      ['int'],
      (rows) => project(filter(join('cross', rows, scan(t.table, [t.node, t.label])), { k: 'and', args: [eq(INT(0), INT(1)), eq(col(0, 2, 'text'), param(0, 'text'))] }), [INT(0)]),
      ids.map((id) => [id]),
      [label],
    )!;
    return found.map((r) => r[0]!);
  }

  /** Takes the label from the nodes `ids` that have it: how many had it. */
  private dropLabels(g: GraphLayout, ids: readonly SqlValue[], label: string): number {
    const d = this.directOf(g);
    if (d !== null) return ids.reduce((n: number, id) => n + d.dropLabel(id, label), 0);
    const t = g.labels;
    const entries = this.runOver(
      `entries:${t.table}`,
      ['int'],
      (rows) => project(filter(join('cross', rows, scan(t.table, [-1, t.node, t.label])), { k: 'and', args: [eq(INT(0), INT(2)), eq(col(0, 3, 'text'), param(0, 'text'))] }), [INT(1)]),
      ids.map((id) => [id]),
      [label],
    )!;
    return this.host.deleteRows(t.table, entries.map((r) => r[0]!));
  }

  /**
   * Sets `key` of the rows of `table` that `rows` name (a rowid and a value each; a NULL value takes the key away):
   * how many of them are there. In a graph that keeps history, a row the value leaves as it was is not written: it
   * would be a version that changes nothing.
   */
  private setKey(g: GraphLayout, table: string, propsColumn: number, key: string, rows: Row[]): number {
    const d = this.directOf(g);
    const at = d?.at(table);
    let there = 0;
    if (d !== null && at !== undefined) {
      // In the index: each row's props read there, and written there where the key's value is another.
      const rest: Row[] = [];
      const keyBytes = encodeKey([key]);
      let last: SqlValue | undefined;
      let value: Uint8Array | null = null;
      for (const row of rows) {
        const held = d.props(at, row[0]!);
        if (held === PASS) {
          rest.push(row);
          continue;
        }
        if (held === undefined) continue;
        there++;
        const cur = held ?? EMPTY_MAP;
        // The value's bytes are made once for rows that are given the same one.
        if (row[1] !== last) {
          last = row[1]!;
          value = last === null ? null : encodeKey([last]);
        }
        const next = setMapKey(cur, keyBytes, value);
        if (!sameBytes(cur, next)) this.setProps(g, table, propsColumn, row[0]!, next, cur);
      }
      if (rest.length === 0) return there;
      rows = rest;
    }
    const M: PlanType = 'map<text, any>';
    const cur = col(0, 1, M);
    const given = col(0, 3, 'any');
    // A row whose properties are NULL has none: a key is set into an empty map, and taking one away leaves NULL.
    const value: PlanExpr = {
      k: 'case',
      whens: [{ when: { k: 'isNull', arg: given, not: false }, then: call('map_remove', [cur, call('list_of', [lit(key)], 'list<text>')], M) }],
      else: call('map_merge', [call('coalesce', [cur, call('map_of', [], M)], M), call('map_of', [lit(key), given], M)], M),
      type: M,
    };
    const named = eq(INT(0), INT(2));
    const write = (changedOnly: boolean) => (held: PlanOp) =>
      update(table, filter(join('cross', scan(table, [-1, propsColumn]), held), changedOnly ? { k: 'and', args: [named, call('cmp_is_not', [value, cur], 'bool')] } : named), 0, [{ column: propsColumn, value }], { from: true });
    if (!g.history) {
      this.runOver(`key:${table}:${key}`, ['int', 'any'], write(false), rows);
      return there + this.host.changes();
    }
    there += this.runOver(`there:${table}`, ['int', 'any'], (held) => project(filter(join('cross', scan(table, [-1]), held), eq(INT(0), INT(1))), [lit(1)]), rows)!.length;
    this.runOver(`changed:${table}:${key}`, ['int', 'any'], write(true), rows);
    return there;
  }

  // ---------------------------------------------------------------- graphDelete

  private delete(op: Op<'graphDelete'>, input: Stream, quiet: boolean): Stream {
    const w = input.types.length;
    const ev = this.evaluator(input.types, w);
    const parts = op.targets.map((t: GraphDeleteTarget) =>
      'node' in t
        ? { node: ev.add(t.node, w) }
        : 'nodes' in t
          ? { nodes: ev.add(t.nodes, w) }
          : 'relationship' in t
            ? { rel: { type: ev.add(t.relationship.type, w), id: ev.add(t.relationship.id, w) } }
            : 'hops' in t
              ? { hops: ev.add(t.hops, w) }
              : { path: { start: ev.add(t.path.start, w), hops: ev.add(t.path.hops, w) } },
    );
    const list = (v: SqlValue): readonly SqlValue[] => (v === null ? [] : v instanceof Uint8Array ? decodeKey(v) : refuse('a delete of a value that is not a list'));
    // A list of hops: each a struct of its type's position in the graph, its rowid and its two ends.
    const hops = (v: SqlValue): { edge: SqlValue; rowid: SqlValue; to: SqlValue }[] =>
      list(v).flatMap((h) => {
        if (h === null) return [];
        const [edge, rowid, , to] = decodeKey(h as Uint8Array);
        return [{ edge: edge ?? null, rowid: rowid ?? null, to: to ?? null }];
      });
    /** What a row names, in the order it names it: a node, or a relationship by its table and rowid. */
    const named = (vals: Values, node: (id: SqlValue) => void, rel: (table: string, rowid: SqlValue) => void): void => {
      const g = this.layoutOf(op.graph);
      const hop = (h: { edge: SqlValue; rowid: SqlValue }): void => {
        const table = typeof h.edge === 'number' ? g.edgeTables[h.edge] : undefined;
        if (table !== undefined && h.rowid !== null) rel(table, h.rowid);
      };
      for (const p of parts) {
        if ('node' in p) node(vals.get(p.node!));
        else if ('nodes' in p) for (const id of list(vals.get(p.nodes!))) node(id);
        else if ('rel' in p) {
          const t = this.target(g, null, { type: vals.get(p.rel!.type), id: vals.get(p.rel!.id) });
          if (t !== null) rel(t.table, t.rowid);
        } else if ('hops' in p) for (const h of hops(vals.get(p.hops!))) hop(h);
        else {
          // A path: its relationships, then its nodes. A NULL start or list is no path.
          const start = vals.get(p.path!.start);
          const given = vals.get(p.path!.hops);
          if (start === null || given === null) continue;
          const path = hops(given);
          for (const h of path) hop(h);
          for (const id of [start, ...path.map((h) => h.to)]) node(id);
        }
      }
    };
    const deleteNode = (ctx: Ctx, id: SqlValue): void => {
      if (id === null) return;
      const g = this.layoutOf(op.graph);
      if (op.detach) {
        // Its relationships first, from either end: one from the node to itself is named once.
        const touching = new Map<string, Set<SqlValue>>();
        this.touching(g, id, touching);
        for (const [table, rowids] of touching) ctx.counts.relationshipsDeleted += this.deleteRows(g, table, [...rowids]);
      }
      ctx.counts.nodesDeleted += this.deleteRows(g, g.nodes.table, [id]);
    };
    const one = (ctx: Ctx, row: Row, early: Row | undefined): void =>
      named(
        ev.over(ctx, row, early),
        (id) => deleteNode(ctx, id),
        (table, rowid) => void (ctx.counts.relationshipsDeleted += this.deleteRows(this.layoutOf(op.graph), table, [rowid])),
      );
    // All the rows at once: what they name is read from the rows alone, and a node goes with its relationships (the
    // check that it has none left would see what later rows delete).
    const atOnce = ev.settled && op.targets.every((t) => 'relationship' in t || 'hops' in t || op.detach);
    // Where every target is a node whose id was computed ahead, all the rows' ids are read where they lie.
    const nodesAhead = parts.every((p) => 'node' in p && p.node!.early) ? parts.map((p) => p.node!.at) : null;
    const all = (ctx: Ctx, rows: Row[], early: Row[] | undefined): void => {
      const rels = new Map<string, Set<SqlValue>>();
      const nodes = new Set<SqlValue>();
      if (nodesAhead !== null && early !== undefined) {
        for (let i = 0; i < early.length; i++) {
          const vals = early[i]!;
          for (let j = 0; j < nodesAhead.length; j++) {
            const id = vals[nodesAhead[j]!]!;
            if (id !== null) nodes.add(id);
          }
        }
      } else {
        rows.forEach((row, i) =>
          named(
            ev.over(ctx, row, early?.[i]),
            (id) => void (id === null || nodes.add(id)),
            (table, rowid) => {
              const ids = rels.get(table);
              if (ids === undefined) rels.set(table, new Set([rowid]));
              else ids.add(rowid);
            },
          ),
        );
      }
      const g = this.layoutOf(op.graph);
      for (const [table, ids] of rels) ctx.counts.relationshipsDeleted += this.deleteRows(g, table, [...ids]);
      if (nodes.size === 0) return;
      const ids = [...nodes];
      // The nodes' relationships, read from either end: one that joins two of them is named at both, and deleted once.
      const touching = new Map<string, Set<SqlValue>>();
      for (const id of ids) this.touching(g, id, touching);
      for (const [table, rowids] of touching) ctx.counts.relationshipsDeleted += this.deleteRows(g, table, [...rowids]);
      ctx.counts.nodesDeleted += this.deleteRows(g, g.nodes.table, ids);
    };
    return {
      types: input.types,
      run: (ctx, sink) => {
        if (input.rows) {
          const rows = input.rows(ctx);
          const early = ev.early(ctx, rows);
          if (quiet && atOnce && rows.length > 1) {
            all(ctx, rows, early);
            return rows.every(sink);
          }
          return rows.every((row, i) => (one(ctx, row, early?.[i]), sink(row)));
        }
        return input.run(ctx, (row) => (one(ctx, row, undefined), sink(row)));
      },
    };
  }

  /**
   * Adds a node's relationships to `into`, by their tables: read at the node, each node on its own. (A plan that
   * joins many nodes with the graph's relationships may read every relationship, where its estimate of how many a
   * node has, the average over the nodes that have any, is high.)
   */
  private touching(g: GraphLayout, node: SqlValue, into: Map<string, Set<SqlValue>>): void {
    // Where the graph's writes land in its index, the node's lists give them.
    const d = this.directOf(g);
    if (
      d !== null &&
      d.touching(node, (table, rowid) => {
        const held = into.get(table);
        if (held === undefined) into.set(table, new Set([rowid]));
        else held.add(rowid);
      })
    )
      return;
    const at = this.kept(`touching:${g.name}`, () => project(filter({ op: 'relationships', graph: g.name, direction: 'both' }, eq(INT(0), param(0, 'int'))), [col(0, 2, 'text'), INT(3)]));
    for (const [type, rowid] of this.host.run(at, [node])!) {
      const e = g.edge(type as string);
      if (e === undefined) continue;
      const held = into.get(e.table);
      if (held === undefined) into.set(e.table, new Set([rowid!]));
      else held.add(rowid!);
    }
  }

  // ---------------------------------------------------------------- graphMerge

  private merge(op: Op<'graphMerge'>, input: Stream, quiet: boolean): Stream {
    const w = input.types.length;
    if (writesGraph(op.match)) refuse('a match that writes');
    // The match over one row: its `working` leaves are the row, then its number (0: it is the only one).
    const held = input.types.map((t): PlanType => (t === 'null' ? 'any' : t));
    const match = replaceWorking(op.match, op.id, values([[...held.map((t, i) => param(this.paramCount + i, t)), lit(0)]], [...held, 'int']));
    // The row's columns, then the ones the match adds after its row's number.
    const outTypes = [...input.types, ...this.typesOf(match).slice(1)];
    const m = outTypes.length - w;
    const joined = (row: Row, found: Row): Row => {
      const out: Row = new Array(w + m);
      for (let i = 0; i < w; i++) out[i] = row[i]!;
      for (let i = 0; i < m; i++) out[w + i] = found[i + 1]!;
      return out;
    };
    const make = this.maker(op, op.nodes, op.relationships, input.types);
    const madeTypes: PlanType[] = [...input.types, ...op.nodes.map((): PlanType => 'int'), ...op.relationships.map((): PlanType => 'int')];
    const created = [...op.created];
    const onMatch = this.setter(op, op.onMatch, outTypes);
    const onCreate = this.setter(op, op.onCreate, outTypes);
    const one = (ctx: Ctx, row: Row, sink: Sink): boolean => {
      // What the match reads of the labels and types it would make is there before it runs: a row of a label or
      // type the graph has not finds nothing, and makes it.
      this.ready(ctx, op, op.nodes, op.relationships);
      const found = this.host.run(match, this.withRow(ctx, row))!;
      if (found.length > 0) {
        for (const f of found) {
          const out = joined(row, f);
          onMatch.row(ctx, out, undefined);
          if (!sink(out)) return false;
        }
        return true;
      }
      const made = make.row(ctx, row, undefined, w);
      const out = m === 0 ? row.slice(0, w) : [...row.slice(0, w), ...this.evalRow(created, madeTypes, ctx, made)];
      onCreate.row(ctx, out, undefined);
      return sink(out);
    };
    // All the rows at once, where the plan says what lets them be (`key`): the key reads only the row, as what a
    // row makes does, nothing is set after a match or a make, and nothing above could tell.
    const ev = this.evaluator(input.types, w);
    const key = op.key?.map((e) => ev.add(e, w));
    const atOnce = quiet && key !== undefined && ev.settled && op.onMatch.length === 0 && op.onCreate.length === 0 && make.settled;
    let all: { source: { op: PlanOp; give: (rows: Row[]) => void }; match: PlanOp; made: { op: PlanOp; give: (rows: Row[]) => void } } | null = null;
    return {
      types: outTypes,
      run: (ctx, sink) => {
        const rows = atOnce && input.rows ? input.rows(ctx) : null;
        if (rows === null || rows.length < 2) return rows === null ? input.run(ctx, (row) => one(ctx, row, sink)) : rows.every((row) => one(ctx, row, sink));
        // Each row's key. A NULL in one says nothing of its row: the rows are then matched one by one.
        const early = ev.early(ctx, rows);
        const keys: string[] = [];
        for (let i = 0; i < rows.length; i++) {
          const vals = ev.over(ctx, rows[i]!, early?.[i]);
          const mine = key!.map((ref) => vals.get(ref));
          if (mine.includes(null)) return rows.every((row) => one(ctx, row, sink));
          keys.push(hex(encodeKey(mine)));
        }
        this.ready(ctx, op, op.nodes, op.relationships);
        if (all === null) {
          const source = this.stageSource([...input.types, 'int']);
          all = { source, match: replaceWorking(op.match, op.id, source.op), made: this.stageSource(madeTypes) };
        }
        // Every row's matches, in one query: each row numbered, so a match says whose it is.
        all.source.give(rows.map((row, i) => [...row.slice(0, w), i]));
        const found = new Map<number, Row[]>();
        for (const f of this.host.run(all.match, ctx.params)!) {
          const list = found.get(f[0] as number);
          if (list === undefined) found.set(f[0] as number, [f]);
          else list.push(f);
        }
        all.source.give([]);
        // Of the rows that match nothing, the first with each key makes; the later ones with that key find what it
        // made, as they would row by row.
        const makers = new Map<string, number>();
        const toMake: number[] = [];
        rows.forEach((_row, i) => {
          if (found.has(i) || makers.has(keys[i]!)) return;
          makers.set(keys[i]!, i);
          toMake.push(i);
        });
        const made = make.rows(ctx, toMake.map((i) => rows[i]!), w, false);
        // Nothing is written yet: the rows can still go one by one.
        if (made === null) return rows.every((row) => one(ctx, row, sink));
        let added: Row[] = made.map(() => []);
        if (m > 0 && made.length > 0) {
          all.made.give(made);
          added = this.host.run(this.kept('created', () => project(all!.made.op, created)), ctx.params)!;
          all.made.give([]);
        }
        const addedBy = new Map<number, Row>();
        toMake.forEach((i, j) => addedBy.set(i, added[j]!));
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i]!;
          const matches = found.get(i);
          if (matches !== undefined) {
            for (const f of matches) if (!sink(joined(row, f))) return false;
          } else if (!sink([...row.slice(0, w), ...addedBy.get(makers.get(keys[i]!)!)!])) return false;
        }
        return true;
      },
    };
  }
}

/** Bytes as text: a key for a `Map`. */
function hex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += (bytes[i]! < 16 ? '0' : '') + bytes[i]!.toString(16);
  return out;
}

/** An operation that passes rows on as they come: its input that writes, itself over another input, and whether it reads only its row. */
interface Step {
  readonly input: PlanOp;
  readonly over: (leaf: PlanOp) => PlanOp;
  readonly calm: boolean;
}

/** `op` as a step of a plan run for each row, or null when it is not one that passes rows on as they come. */
function step(op: PlanOp): Step | null {
  switch (op.op) {
    case 'filter':
    case 'project':
    case 'explode':
    case 'unpivot':
      return { input: op.input, over: (leaf) => ({ ...op, input: leaf }), calm: !holdsPlan(ownExprs(op)) };
    case 'paths':
      // It reads the graph's relationships.
      return { input: op.input, over: (leaf) => ({ ...op, input: leaf }), calm: false };
    case 'join':
      if (!writesGraph(op.inputs[0])) return refuse('a join whose right input writes');
      if (writesGraph(op.inputs[1])) return refuse('a join whose inputs both write');
      if (op.kind === 'right' || op.kind === 'full' || op.kind === 'asof') return refuse(`a ${op.kind} join over rows that were written`);
      return { input: op.inputs[0], over: (leaf) => ({ ...op, inputs: [leaf, op.inputs[1]] }), calm: false };
    default:
      return null;
  }
}

/** A pick of nothing: NULL. */
const PICK_NULL = -1;

/**
 * An expression that only picks a value that is there already, as a number: a column of its row (the column's
 * index), a NULL literal (`PICK_NULL`) or one of the statement's parameters (-2 less its index). Null for any
 * other expression: its value takes a plan. A plan would give the same for these: it reads a row's column and a
 * parameter as they are given.
 */
function pickOf(e: PlanExpr): number | null {
  if (e.k === 'col') return e.input === 0 && e.depth === 0 ? e.index : null;
  if (e.k === 'lit') return e.value === null ? PICK_NULL : null;
  if (e.k === 'param') return -2 - e.index;
  return null;
}

/** `exprs` as picks, or null where one of them does more than pick. */
function picksOf(exprs: readonly PlanExpr[]): number[] | null {
  const out: number[] = [];
  for (const e of exprs) {
    const pick = pickOf(e);
    if (pick === null) return null;
    out.push(pick);
  }
  return out;
}

/** What `picks` name of `row` and the statement's parameters: a new row. */
function picked(picks: readonly number[], row: Row, params: readonly SqlValue[]): Row {
  const n = picks.length;
  const out = new Array<SqlValue>(n);
  for (let i = 0; i < n; i++) {
    const pick = picks[i]!;
    out[i] = pick >= 0 ? (row[pick] ?? null) : pick === PICK_NULL ? null : (params[-2 - pick] ?? null);
  }
  return out;
}

/** The name of the function a stage's plan reads its rows through, before the stage's number. */
export const STAGE_ROWS = 'smalt_stage_rows_';

/** A stream's rows, all of them. */
function all(s: Stream, ctx: Ctx): Row[] {
  if (s.rows) return s.rows(ctx);
  const out: Row[] = [];
  s.run(ctx, (row) => (out.push(row), true));
  return out;
}

/** An operation's own expressions and settings: everything but its input plans. */
function ownExprs(op: PlanOp): unknown[] {
  return Object.entries(op)
    .filter(([k]) => k !== 'input' && k !== 'inputs' && k !== 'init' && k !== 'steps' && k !== 'match')
    .map(([, v]) => v);
}

/** Whether a plan nested in one of the operation's expressions (or in those of the operations below it) writes a graph. */
function holdsWrite(op: PlanOp): boolean {
  const inExpr = (x: unknown): boolean => {
    if (x === null || typeof x !== 'object' || ArrayBuffer.isView(x)) return false;
    if (Array.isArray(x)) return x.some(inExpr);
    const o = x as Record<string, unknown>;
    if (typeof o.op === 'string') return writesGraph(o as unknown as PlanOp) || holdsWrite(o as unknown as PlanOp);
    return Object.values(o).some(inExpr);
  };
  return ownExprs(op).some(inExpr) || inputsOf(op).some(holdsWrite);
}

/** `plan` with each `working` of `id` replaced by `leaf`, wherever it is. */
function replaceWorking(plan: PlanOp, id: number, leaf: PlanOp): PlanOp {
  const walk = (x: unknown): unknown => {
    if (x === null || typeof x !== 'object' || ArrayBuffer.isView(x)) return x;
    if (Array.isArray(x)) return x.map(walk);
    const o = x as Record<string, unknown>;
    if (o.op === 'working' && o.id === id) return leaf;
    const out: Record<string, unknown> = {};
    for (const k in o) out[k] = walk(o[k]);
    return out;
  };
  return walk(plan) as PlanOp;
}

/** A node or a relationship a write names: its table, that table's props column (-1: none) and its rowid. */
interface Target {
  readonly table: string;
  readonly props: number;
  readonly rowid: SqlValue;
}

/** What applies a `graphSet`'s items (`GraphWrite.setter`). */
interface Setter {
  /** What reads only the input's rows, computed for all of them at once (undefined: nothing does). */
  early(ctx: Ctx, rows: Row[]): Row[] | undefined;
  /** Applies the items to a row, one after the other. */
  row(ctx: Ctx, row: Row, early: Row | undefined): void;
  /** Applies the items to all the rows at once. False, and nothing done, where that would not give what row by row gives. */
  rows(ctx: Ctx, rows: Row[]): boolean;
}

/** What makes a write's nodes and relationships (`GraphWrite.maker`). */
interface Maker {
  /** What reads only the input's rows, computed for all of them at once (undefined: nothing does). */
  early(ctx: Ctx, rows: Row[]): Row[] | undefined;
  /** Whether everything a row makes reads only the row: its rows can then be made all at once. */
  readonly settled: boolean;
  /** Makes a row's nodes, then its relationships: the row with their ids after its `w` columns. */
  row(ctx: Ctx, row: Row, early: Row | undefined, w: number): Row;
  /**
   * `row` for all the rows, each table written in one pass (`several` false: a single row as `row` writes it). Null,
   * and nothing written, where that would not give what row by row gives.
   */
  rows(ctx: Ctx, rows: Row[], w: number, several?: boolean): Row[] | null;
}

/**
 * The rows of one table that an all-rows write has written one thing of (`GraphWrite`'s SET): `add` says whether a
 * rowid is new. Rowids that come in rising order, as a scan gives them, are only compared with the last; a set is
 * made when one does not.
 */
class Written {
  private last = -Infinity;
  private readonly list: SqlValue[] = [];
  private set: Set<SqlValue> | null = null;

  add(rowid: SqlValue): boolean {
    if (this.set === null) {
      if (typeof rowid === 'number' && rowid > this.last) {
        this.last = rowid;
        this.list.push(rowid);
        return true;
      }
      this.set = new Set(this.list);
    }
    if (this.set.has(rowid)) return false;
    this.set.add(rowid);
    return true;
  }
}

/** An expression a write computes: where its value is found (`Values.get`). */
interface EvalRef {
  readonly early: boolean;
  readonly at: number;
}

/** The values of a write's expressions for one row. */
interface Values {
  get(ref: EvalRef): SqlValue;
}

/**
 * A write's expressions over its row (see `GraphWrite.evaluator`): `add` takes one that may be computed ahead when it
 * reads only the input's columns and no nested plan; `late` one that is computed when it is asked for.
 */
class Evaluator {
  private readonly earlyExprs: PlanExpr[] = [];
  private readonly lateExprs: { expr: PlanExpr[]; width: number }[] = [];
  private source: { op: PlanOp; give: (rows: Row[]) => void } | undefined;

  constructor(
    private readonly owner: GraphWrite,
    /** The row's types as far as it can be made, and how many of its columns are the input's. */
    private readonly types: readonly PlanType[],
    private readonly width: number,
  ) {}

  /** An expression over the row as it is when `made` columns of it are there. */
  add(e: PlanExpr, made: number): EvalRef {
    if (highestColumn(e) < this.width && !holdsPlan(e)) return { early: true, at: this.earlyExprs.push(e) - 1 };
    return { early: false, at: this.lateExprs.push({ expr: [e], width: made }) - 1 };
  }

  late(e: PlanExpr): EvalRef {
    return { early: false, at: this.lateExprs.push({ expr: [e], width: this.types.length }) - 1 };
  }

  /** Whether every expression given so far reads only the input's row: none is computed when its turn comes. */
  get settled(): boolean {
    return this.lateExprs.length === 0;
  }

  /** The early expressions as picks (`pickOf`) where every one only picks, else null: looked at once, when first run. */
  private picks: readonly number[] | null | undefined;

  private picking(): readonly number[] | null {
    if (this.picks === undefined) this.picks = picksOf(this.earlyExprs);
    return this.picks;
  }

  /** The early expressions for all the rows at once, or undefined when there are none. */
  early(ctx: Ctx, rows: Row[]): Row[] | undefined {
    if (this.earlyExprs.length === 0 || rows.length === 0) return undefined;
    // Where they only pick, there is nothing to compute: no plan is run for them.
    const picks = this.picking();
    if (picks !== null) return rows.map((row) => picked(picks, row, ctx.params));
    this.source ??= this.owner.source(this.types.slice(0, this.width));
    return this.owner.evalRows(this.earlyExprs, this.source, ctx, rows);
  }

  /** The early expressions for one row. */
  private earlyOf(ctx: Ctx, row: Row): Row {
    const picks = this.picking();
    if (picks !== null) return picked(picks, row, ctx.params);
    return this.owner.evalRow(this.earlyExprs, this.types.slice(0, this.width), ctx, row.slice(0, this.width));
  }

  /** The values for `row` (which a write fills in as it goes): `early` when they were computed ahead. */
  over(ctx: Ctx, row: Row, early: Row | undefined): Values {
    let ahead = early;
    return {
      get: (ref) => {
        if (ref.early) {
          ahead ??= this.earlyOf(ctx, row);
          return ahead[ref.at]!;
        }
        const l = this.lateExprs[ref.at]!;
        return this.owner.evalRow(l.expr, this.types.slice(0, l.width), ctx, row.slice(0, l.width))[0]!;
      },
    };
  }
}
