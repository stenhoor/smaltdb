/**
 * Plans that write a property graph, run in stages (ADR 0042, section 1).
 *
 * A plan that holds a graph write (`graphCreate`, `graphSet`, `graphDelete`, `graphMerge`) is not one physical plan.
 * Its rows go through its operations stage by stage, so that a write handles its rows in order, each before the next
 * is read, and what reads the graph above a write reads it as it is then:
 *
 * - **A part that writes nothing is one query.** All its rows are read before anything above it runs, so no scan is
 *   open on a table while it is written.
 * - **A write** takes its input's rows one at a time and passes each on once it is written.
 * - **An operation above a write that passes rows on as they come** (`filter`, `project`, `explode`, `unpivot`,
 *   `paths`, a `join` whose left input is the one that writes) is run for each row, as a plan over that row.
 * - **An operation that needs all its rows** (`eager`, `sort`, `aggregate`, `distinct`, `window`, `sample`, `pivot`)
 *   reads them all first, then runs once over them.
 * - **`limit`** passes rows on until it has its count and then stops what feeds it: a write below it writes no more.
 *
 * The writes are appends, updates and deletes of the graph's tables, run inside the statement as the engine's own
 * plans are (a foreign key's actions, the graph's rules): each goes through its table's writer, so the graph's
 * rules, history, foreign keys and the graph's index are kept as for any write.
 */
import { SmaltError } from '../errors.js';
import { append, filter, limit as limitOf, project, remove, scan, update, values } from '../plan/build.js';
import { call, col, lit, param, type PlanExpr, typeOf } from '../plan/expr.js';
import { GRAPH_WRITE_OPS, type GraphDeleteTarget, type GraphEnd, type GraphNewNode, type GraphNewRelationship, type GraphRelationshipRef, type GraphSetItem, type GraphWriteCounts, type PlanOp } from '../plan/ops.js';
import type { PlanType } from '../plan/types.js';
import { decodeKey, encodeKey } from '../storage/key-codec.js';
import type { SqlValue } from '../values.js';
import { compareCodePoints } from '../../shared/nested.js';

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
  /** A relationship table's endpoint columns. */
  edgeColumns(table: string): { readonly start: number; readonly end: number } | undefined;
}

/** What the database gives a plan that writes a graph. */
export interface GraphWriteHost {
  /** The graph's tables, or an error when the graph can't be written this way. */
  layout(graph: string): GraphLayout;
  schemaVersion(): number;
  /** A plan's output types. */
  types(plan: PlanOp): PlanType[];
  /** Runs a plan inside the running statement: a query's rows, or null for a write (`changes` tells its count). */
  run(plan: PlanOp, params: readonly SqlValue[]): SqlValue[][] | null;
  /** How many rows the write last run changed. */
  changes(): number;
  /** One more than the largest rowid `table` has had, its past versions' too where it keeps history; 0 for none. */
  nextId(table: string): number;
  addLabel(graph: string, label: string): void;
  addType(graph: string, type: string): void;
}

/** One run of the statement. */
interface Ctx {
  readonly params: readonly SqlValue[];
  readonly counts: GraphWriteCounts;
  /** The next node id and relationship rowid, read when first needed (-1 until then). */
  nextNode: number;
  nextRel: number;
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
 * A statement's plan that writes a graph, compiled into stages when it first runs and again when the schema has
 * changed since (the stages' own plans are compiled and kept by the database, as its other internal plans are).
 */
export class GraphWrite {
  private compiled: { version: number; root: Stream } | null = null;
  /** The rows the stages' plans read through `smalt_stage_rows_<k>` (see `stageSource`). */
  private readonly stages: { types: readonly PlanType[]; rows: Row[] }[] = [];
  private readonly plans = new Map<string, PlanOp>();

  constructor(
    private readonly plan: PlanOp,
    /** The statement's parameters: a stage's own parameters come after them. */
    private readonly paramCount: number,
    private readonly host: GraphWriteHost,
  ) {}

  /** Runs the statement: its rows, and what it wrote. */
  run(params: readonly SqlValue[]): { rows: Row[]; counts: GraphWriteCounts } {
    if (this.compiled === null || this.compiled.version !== this.host.schemaVersion()) {
      this.ensure(this.plan);
      this.stages.length = 0;
      this.plans.clear();
      // The labels and types are there now: the version is the schema's after they were added.
      this.compiled = { version: this.host.schemaVersion(), root: this.stream(this.plan, true) };
    }
    const ctx: Ctx = { params: this.paramCount === params.length ? params : params.slice(0, this.paramCount), counts: noCounts(), nextNode: -1, nextRel: -1 };
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

  // ---------------------------------------------------------------- before the stages

  /** Adds the labels and relationship types the plan's writes name that their graph has not. */
  private ensure(op: PlanOp): void {
    for (const i of inputsOf(op)) this.ensure(i);
    if (!GRAPH_WRITE_OPS.has(op.op)) return;
    const w = op as Op<'graphCreate'> | Op<'graphSet'> | Op<'graphDelete'> | Op<'graphMerge'>;
    const label = (l: string): void => {
      if (this.host.layout(w.graph).label(l) === undefined) this.host.addLabel(w.graph, l);
    };
    const made = (nodes: readonly GraphNewNode[], rels: readonly GraphNewRelationship[]): void => {
      for (const n of nodes) n.labels.forEach(label);
      for (const r of rels) if (this.host.layout(w.graph).edge(r.type) === undefined) this.host.addType(w.graph, r.type);
    };
    const items = (list: readonly GraphSetItem[]): void => {
      for (const it of list) if (it.kind === 'labels') it.add.forEach(label);
    };
    if (w.op === 'graphCreate') made(w.nodes, w.relationships);
    else if (w.op === 'graphSet') items(w.items);
    else if (w.op === 'graphMerge') {
      made(w.nodes, w.relationships);
      items(w.onMatch);
      items(w.onCreate);
    }
  }

  // ---------------------------------------------------------------- stages

  /**
   * An operation's rows. `quiet`: nothing above it, up to an operation that reads all its rows first, reads the
   * graph, writes or stops early, so a write here may write all its rows at once.
   */
  private stream(op: PlanOp, quiet: boolean): Stream {
    if (!writesGraph(op)) return this.query(op);
    if (holdsWrite(op)) refuse('a write in a nested plan of an expression');
    switch (op.op) {
      case 'graphCreate':
        return this.create(op, this.stream(op.input, false), quiet);
      case 'graphSet':
        return this.set(op, this.stream(op.input, false));
      case 'graphDelete':
        return this.delete(op, this.stream(op.input, false));
      case 'graphMerge':
        return this.merge(op, this.stream(op.input, false));
      case 'eager': {
        const input = this.stream(op.input, true);
        return { types: input.types, run: (ctx, sink) => all(input, ctx).every(sink) };
      }
      case 'limit':
        return this.limit(op, this.stream(op.input, false));
      case 'filter':
      case 'project':
      case 'explode':
      case 'unpivot':
      case 'paths':
        return this.perRow(op, this.stream(op.input, quiet && !holdsPlan(ownExprs(op))), (leaf) => ({ ...op, input: leaf }));
      case 'join': {
        if (writesGraph(op.inputs[1])) refuse('a join whose right input writes');
        if (op.kind === 'right' || op.kind === 'full' || op.kind === 'asof') refuse(`a ${op.kind} join over rows that were written`);
        return this.perRow(op, this.stream(op.inputs[0], false), (leaf) => ({ ...op, inputs: [leaf, op.inputs[1]] }));
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

  /** A part that writes nothing: one query, all its rows read when they are first wanted. */
  private query(op: PlanOp): Stream {
    const rows = (ctx: Ctx): Row[] => this.host.run(op, ctx.params)!;
    return { types: this.host.types(op), rows, run: (ctx, sink) => rows(ctx).every(sink) };
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

  /** An operation that passes rows on as they come: run for each row of its input, its rows passed on before the next row is read. */
  private perRow(op: PlanOp, input: Stream, over: (leaf: PlanOp) => PlanOp): Stream {
    const plan = over(this.rowLeaf(input.types));
    return {
      types: this.host.types(op),
      run: (ctx, sink) => input.run(ctx, (row) => this.host.run(plan, this.withRow(ctx, row))!.every(sink)),
    };
  }

  /** An operation that needs all its rows: its input read to the end, then one run over them. */
  private allRows(op: PlanOp, input: Stream, over: (leaf: PlanOp) => PlanOp): Stream {
    const source = this.stageSource(input.types);
    const plan = over(source.op);
    return {
      types: this.host.types(op),
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

  private nodeId(ctx: Ctx, g: GraphLayout): number {
    if (ctx.nextNode < 0) ctx.nextNode = g.nodeTables.reduce((m, t) => Math.max(m, this.host.nextId(t)), 0);
    return ctx.nextNode++;
  }

  private relId(ctx: Ctx, g: GraphLayout): number {
    if (ctx.nextRel < 0) ctx.nextRel = g.edgeTables.reduce((m, t) => Math.max(m, this.host.nextId(t)), 0);
    return ctx.nextRel++;
  }

  // ---------------------------------------------------------------- the tables' writes

  private write(plan: PlanOp, params: readonly SqlValue[]): number {
    this.host.run(plan, params);
    return this.host.changes();
  }

  private appendNode(g: GraphLayout, id: number, props: Uint8Array): void {
    const t = g.nodes;
    this.write(this.kept(`node:${t.table}`, () => append(t.table, values([[param(0, 'int'), param(1, 'map<text, any>')]], ['int', 'map<text, any>']), [t.id, t.props])), [id, props]);
  }

  private appendLabel(g: GraphLayout, id: SqlValue, label: string): void {
    const t = g.labels;
    this.write(this.kept(`label:${t.table}`, () => append(t.table, values([[param(0, 'int'), param(1, 'text')]], ['int', 'text']), [t.node, t.label])), [id, label]);
  }

  private hasLabel(g: GraphLayout, id: SqlValue, label: string): boolean {
    const t = g.labels;
    const plan = this.kept(`has:${t.table}`, () => limitOf(project(filter(scan(t.table, [t.node, t.label]), { k: 'and', args: [eq(INT(0), param(0, 'int')), eq(col(0, 1, 'text'), param(1, 'text'))] }), [lit(1)]), 1));
    return this.host.run(plan, [id, label])!.length > 0;
  }

  private dropLabel(g: GraphLayout, id: SqlValue, label: string): number {
    const t = g.labels;
    const plan = this.kept(`drop:${t.table}`, () => remove(t.table, filter(scan(t.table, [-1, t.node, t.label]), { k: 'and', args: [eq(INT(1), param(0, 'int')), eq(col(0, 2, 'text'), param(1, 'text'))] }), 0));
    return this.write(plan, [id, label]);
  }

  private appendEdge(g: GraphLayout, type: string, rowid: number, start: SqlValue, end: SqlValue, props: Uint8Array, keys: number): void {
    const e = g.edge(type)!;
    if (e.props < 0) {
      if (keys > 0) throw new SmaltError('SMALT_ERROR', `property graph ${g.name}: relationship type ${type} keeps no properties`);
      this.write(this.kept(`edge:${e.table}`, () => append(e.table, values([[param(0, 'int'), param(1, 'int'), param(2, 'int')]], ['int', 'int', 'int']), [-1, e.start, e.end])), [rowid, start, end]);
      return;
    }
    const types: PlanType[] = ['int', 'int', 'int', 'map<text, any>'];
    this.write(this.kept(`edge:${e.table}`, () => append(e.table, values([types.map((t, i) => param(i, t))], types), [-1, e.start, e.end, e.props])), [rowid, start, end, props]);
  }

  /** The properties of a node or a relationship, by its table and rowid: undefined when it is not there. */
  private propsOf(table: string, propsColumn: number, rowid: SqlValue): Uint8Array | undefined {
    const plan = this.kept(`props:${table}`, () => project(filter(scan(table, [-1, propsColumn]), eq(INT(0), param(0, 'int'))), [col(0, 1, 'map<text, any>')]));
    const row = this.host.run(plan, [rowid])![0];
    return row === undefined ? undefined : row[0] === null ? EMPTY_MAP : (row[0] as Uint8Array);
  }

  private setProps(table: string, propsColumn: number, rowid: SqlValue, props: Uint8Array): void {
    this.write(this.kept(`set:${table}`, () => update(table, filter(scan(table, [-1]), eq(INT(0), param(0, 'int'))), 0, [{ column: propsColumn, value: param(1, 'map<text, any>') }])), [rowid, props]);
  }

  private deleteRow(table: string, rowid: SqlValue): number {
    return this.write(this.kept(`delete:${table}`, () => remove(table, filter(scan(table, [-1]), eq(INT(0), param(0, 'int'))), 0)), [rowid]);
  }

  /** Deletes the relationships of `table` that start (or end) at the node. */
  private deleteAt(table: string, endColumn: number, node: SqlValue): number {
    return this.write(this.kept(`at:${table}:${endColumn}`, () => remove(table, filter(scan(table, [-1, endColumn]), eq(INT(1), param(0, 'int'))), 0)), [node]);
  }

  // ---------------------------------------------------------------- graphCreate

  private create(op: Op<'graphCreate'>, input: Stream, quiet: boolean): Stream {
    const g = this.host.layout(op.graph);
    const w = input.types.length;
    const outTypes: PlanType[] = [...input.types, ...op.nodes.map((): PlanType => 'int'), ...op.relationships.map((): PlanType => 'int')];
    const make = this.maker(g, op.nodes, op.relationships, input.types);
    void quiet;
    return {
      types: outTypes,
      run: (ctx, sink) => {
        // One query below: what reads only its rows is computed for all of them at once.
        if (input.rows) {
          const rows = input.rows(ctx);
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
  private maker(g: GraphLayout, nodes: readonly GraphNewNode[], rels: readonly GraphNewRelationship[], types: readonly PlanType[]): { early: (ctx: Ctx, rows: Row[]) => Row[] | undefined; row: (ctx: Ctx, row: Row, early: Row | undefined, w: number) => Row } {
    const w = types.length;
    const rowTypes: PlanType[] = [...types, ...nodes.map((): PlanType => 'int'), ...rels.map((): PlanType => 'int')];
    const ev = this.evaluator(rowTypes, w);
    const nodeProps = nodes.map((n, k) => {
      if (n.props && !isMapType(typeOf(n.props))) throw new SmaltError('SMALT_PLAN', `graphCreate: a node's props is a map, not ${typeOf(n.props)}`);
      return n.props ? ev.add(n.props, w + k) : null;
    });
    // The labels as the graph spells them, each once; the node's own table gives it its label without an entry.
    const labels = nodes.map((n) => [...new Set(n.labels.map((l) => g.label(l) ?? l))].filter((l) => l !== g.nodes.label));
    const ends = (e: GraphEnd, at: number): { node: number } | { value: EvalRef } => ('node' in e ? { node: e.node } : { value: ev.add(e.id, at) });
    const relParts = rels.map((r, j) => {
      if (r.props && !isMapType(typeOf(r.props))) throw new SmaltError('SMALT_PLAN', `graphCreate: a relationship's props is a map, not ${typeOf(r.props)}`);
      const at = w + nodes.length + j;
      return { type: r.type, start: ends(r.start, at), end: ends(r.end, at), props: r.props ? ev.add(r.props, at) : null };
    });
    return {
      early: (ctx, rows) => ev.early(ctx, rows),
      row: (ctx, row, early, width) => {
        const out: Row = new Array(width + nodes.length + rels.length).fill(null);
        for (let i = 0; i < width; i++) out[i] = row[i]!;
        const vals = ev.over(ctx, out, early);
        nodes.forEach((n, k) => {
          const p = nodeProps[k];
          const props = settable(p === null ? EMPTY_MAP : asMap(vals.get(p!), g.name));
          const id = this.nodeId(ctx, g);
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
          const props = settable(r.props === null ? EMPTY_MAP : asMap(vals.get(r.props), g.name));
          const rowid = this.relId(ctx, g);
          this.appendEdge(g, r.type, rowid, start, finish, props.map, props.keys.length);
          out[width + nodes.length + j] = rowid;
          ctx.counts.relationshipsCreated++;
          ctx.counts.propertiesSet += props.keys.length;
        });
        return out;
      },
    };
  }

  // ---------------------------------------------------------------- graphSet

  private set(op: Op<'graphSet'>, input: Stream): Stream {
    const g = this.host.layout(op.graph);
    const apply = this.setter(g, op.items, input.types);
    return { types: input.types, run: (ctx, sink) => input.run(ctx, (row) => (apply(ctx, row), sink(row))) };
  }

  /** What applies `items` to a row, item by item. */
  private setter(g: GraphLayout, items: readonly GraphSetItem[], types: readonly PlanType[]): (ctx: Ctx, row: Row) => void {
    if (items.length === 0) return () => undefined;
    const w = types.length;
    // Each item's expressions are computed when its turn comes: an item reads what the items before it wrote.
    const ev = this.evaluator(types, w);
    const parts = items.map((it) => ({
      it,
      node: it.node !== undefined ? ev.late(it.node) : null,
      rel: it.relationship !== undefined ? { type: ev.late(it.relationship.type), id: ev.late(it.relationship.id) } : null,
      value: it.kind === 'labels' ? null : ev.late(it.value),
    }));
    return (ctx, row) => {
      const vals = ev.over(ctx, row, undefined);
      for (const p of parts) {
        // The node or relationship first: for a NULL one, the value is not computed.
        const target = this.target(g, p.node === null ? null : vals.get(p.node), p.rel === null ? null : { type: vals.get(p.rel.type), id: vals.get(p.rel.id) });
        if (target === null) continue;
        const it = p.it;
        if (it.kind === 'labels') {
          if (p.node === null) continue;
          for (const l of it.add) {
            const label = g.label(l) ?? l;
            if (label === g.nodes.label || this.hasLabel(g, target.rowid, label)) continue;
            this.appendLabel(g, target.rowid, label);
            ctx.counts.labelsAdded++;
          }
          for (const l of it.remove) {
            const label = g.label(l);
            if (label !== undefined && label !== g.nodes.label) ctx.counts.labelsRemoved += this.dropLabel(g, target.rowid, label);
          }
          continue;
        }
        const cur = this.propsOf(target.table, target.props, target.rowid);
        if (cur === undefined) continue;
        const value = vals.get(p.value!);
        const entries = entriesOf(cur);
        if (it.kind === 'property') {
          if (value === null) entries.delete(it.key);
          else entries.set(it.key, value);
          ctx.counts.propertiesSet++;
        } else {
          const given = settable(asMap(value, g.name));
          const map = entriesOf(given.map);
          if (it.merge) {
            for (const k of given.nulls) entries.delete(k);
            for (const [k, v] of map) entries.set(k, v);
            ctx.counts.propertiesSet += given.nulls.length + given.keys.length;
          } else {
            let removed = 0;
            for (const k of [...entries.keys()]) {
              if (!map.has(k)) removed++;
              entries.delete(k);
            }
            for (const [k, v] of map) entries.set(k, v);
            ctx.counts.propertiesSet += removed + given.keys.length;
          }
        }
        const next = mapOf(entries);
        // A value set to what it is writes nothing: a table that keeps history gets no version that changes nothing.
        if (!sameBytes(cur, next)) this.setProps(target.table, target.props, target.rowid, next);
      }
    };
  }

  /** The table, props column and rowid a node id or a relationship's type and rowid name; null for a NULL one, or one of a type the graph has not. */
  private target(g: GraphLayout, node: SqlValue | null, rel: { type: SqlValue; id: SqlValue } | null): { table: string; props: number; rowid: SqlValue } | null {
    if (rel === null) return node === null ? null : { table: g.nodes.table, props: g.nodes.props, rowid: node };
    if (rel.id === null || typeof rel.type !== 'string') return null;
    const e = g.edge(rel.type);
    return e === undefined ? null : { table: e.table, props: e.props, rowid: rel.id };
  }

  // ---------------------------------------------------------------- graphDelete

  private delete(op: Op<'graphDelete'>, input: Stream): Stream {
    const g = this.host.layout(op.graph);
    const ev = this.evaluator(input.types, input.types.length);
    const parts = op.targets.map((t: GraphDeleteTarget) =>
      'node' in t
        ? { node: ev.late(t.node) }
        : 'nodes' in t
          ? { nodes: ev.late(t.nodes) }
          : 'relationship' in t
            ? { rel: { type: ev.late(t.relationship.type), id: ev.late(t.relationship.id) } }
            : { rels: { types: ev.late(t.relationships.types), ids: ev.late(t.relationships.ids) } },
    );
    const node = (ctx: Ctx, id: SqlValue): void => {
      if (id === null) return;
      if (op.detach) for (const type of g.edgeTables) ctx.counts.relationshipsDeleted += this.detach(g, type, id);
      ctx.counts.nodesDeleted += this.deleteRow(g.nodes.table, id);
    };
    const rel = (ctx: Ctx, type: SqlValue, id: SqlValue): void => {
      const t = this.target(g, null, { type, id });
      if (t !== null) ctx.counts.relationshipsDeleted += this.deleteRow(t.table, t.rowid);
    };
    const list = (v: SqlValue): readonly SqlValue[] => (v === null ? [] : v instanceof Uint8Array ? decodeKey(v) : refuse('a delete of a value that is not a list'));
    return {
      types: input.types,
      run: (ctx, sink) =>
        input.run(ctx, (row) => {
          const vals = ev.over(ctx, row, undefined);
          for (const p of parts) {
            if ('node' in p) node(ctx, vals.get(p.node!));
            else if ('nodes' in p) for (const id of list(vals.get(p.nodes!))) node(ctx, id);
            else if ('rel' in p) rel(ctx, vals.get(p.rel!.type), vals.get(p.rel!.id));
            else {
              const types = list(vals.get(p.rels!.types));
              list(vals.get(p.rels!.ids)).forEach((id, i) => rel(ctx, types[i] ?? null, id));
            }
          }
          return sink(row);
        }),
    };
  }

  /** Deletes the relationships of one table at a node: those that start there, then those that end there (a relationship from the node to itself is gone by then). */
  private detach(g: GraphLayout, table: string, node: SqlValue): number {
    const e = this.edgeOfTable(g, table);
    return this.deleteAt(table, e.start, node) + this.deleteAt(table, e.end, node);
  }

  private edgeOfTable(g: GraphLayout, table: string): { start: number; end: number } {
    const e = g.edgeColumns(table);
    if (e === undefined) throw new SmaltError('SMALT_INTERNAL', `no relationship table ${table} in property graph ${g.name}`);
    return e;
  }

  // ---------------------------------------------------------------- graphMerge

  private merge(op: Op<'graphMerge'>, input: Stream): Stream {
    const g = this.host.layout(op.graph);
    const w = input.types.length;
    const leaf = this.rowLeaf(input.types);
    // The match over one row: its `working` leaves are the row.
    const match = replaceWorking(op.match, op.id, leaf);
    if (writesGraph(op.match)) refuse('a match that writes');
    const matchTypes = this.host.types(match);
    const m = matchTypes.length;
    const make = this.maker(g, op.nodes, op.relationships, input.types);
    const madeTypes: PlanType[] = [...input.types, ...op.nodes.map((): PlanType => 'int'), ...op.relationships.map((): PlanType => 'int')];
    const created = [...op.created];
    const outTypes = [...input.types, ...matchTypes];
    const onMatch = this.setter(g, op.onMatch, outTypes);
    const onCreate = this.setter(g, op.onCreate, outTypes);
    return {
      types: outTypes,
      run: (ctx, sink) =>
        input.run(ctx, (row) => {
          const found = this.host.run(match, this.withRow(ctx, row))!;
          if (found.length > 0) {
            for (const f of found) {
              const out = [...row, ...f];
              onMatch(ctx, out);
              if (!sink(out)) return false;
            }
            return true;
          }
          const made = make.row(ctx, row, undefined, w);
          const cols = m === 0 ? [] : this.evalRow(created, madeTypes, ctx, made);
          const out = [...row, ...cols];
          onCreate(ctx, out);
          return sink(out);
        }),
    };
  }
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

  /** The early expressions for all the rows at once, or undefined when there are none. */
  early(ctx: Ctx, rows: Row[]): Row[] | undefined {
    if (this.earlyExprs.length === 0 || rows.length === 0) return undefined;
    this.source ??= this.owner.source(this.types.slice(0, this.width));
    return this.owner.evalRows(this.earlyExprs, this.source, ctx, rows);
  }

  /** The values for `row` (which a write fills in as it goes): `early` when they were computed ahead. */
  over(ctx: Ctx, row: Row, early: Row | undefined): Values {
    let ahead = early;
    return {
      get: (ref) => {
        if (ref.early) {
          ahead ??= this.owner.evalRow(this.earlyExprs, this.types.slice(0, this.width), ctx, row.slice(0, this.width));
          return ahead[ref.at]!;
        }
        const l = this.lateExprs[ref.at]!;
        return this.owner.evalRow(l.expr, this.types.slice(0, l.width), ctx, row.slice(0, l.width))[0]!;
      },
    };
  }
}
