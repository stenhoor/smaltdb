/**
 * A property graph's writes that land in its index first (ADR 0042, section 2).
 *
 * In a database in memory, for a graph whose index is held and whose tables are the plain ones a graph has (see
 * `Database.directGraph`), a plan that writes the graph (exec/graph-write.ts) changes the index and not the tables:
 * a node's properties in the property maps, its labels in the label sets, a relationship in the lists of its two
 * ends. The graph's rules are kept then, against the index, with the errors the tables' writers give. Each change
 * also goes in a log (`GraphPending`), in the order the changes were made, with its values: the rows the index holds
 * that their tables have not yet.
 *
 * **The tables are written behind.** A table with rows in the log has its B+trees guarded (`BTree.guard`): a search
 * of one throws `PENDING_READ`. The database catches it where a statement can start again, writes the log to the
 * tables (`settle`: the log's net effect, through the tables' writers, with the index and the rules not told) and
 * runs the statement again. So a graph that is only read and written through its index never writes a B+tree, and
 * anything else reads tables that are up to date.
 *
 * **An index of a property, searched for a value** (`DirectGraph.keyClear`). A node table's index on a key of
 * props has an entry for every row. While every node in the log has under that key what its table's row has (no
 * new node has the key, no change gave a node another value for it, no node of the table went), the index's
 * entries for values are all there and right: a search of it for a value reads the index as it is, and nothing is
 * written for it. A row it finds is given with the props the graph's index holds for it, where it holds them.
 *
 * **Transactions.** The log knows where each open statement and savepoint began, and where the last commit ended.
 * A rollback drops what was logged since. Entries written to the tables inside a transaction stay in the log until
 * it commits: a rollback undoes those table writes, and the entries are pending again.
 */
import { ConstraintError, type TableSchema } from '../catalog/schema.js';
import { SmaltError } from '../errors.js';
import type { BTree, BTreeCursor } from '../storage/btree.js';
import { ROWID_KEY_SIZE, skipComponent, writeRowidKey } from '../storage/key-codec.js';
import type { RecordReader } from '../storage/record.js';
import type { SqlValue } from '../values.js';
import type { GraphIndex } from './graph-index.js';
import { ListCursor } from './graph-lists.js';
import { type GraphProps, holdable } from './graph-props.js';
import { findMapKey } from './nested-ops.js';

/**
 * What a search of a guarded B+tree throws: the table has rows only its graph's index holds. Not an error a caller
 * sees: the database writes the tables and runs the statement again.
 */
export class PendingRead {
  readonly pendingRead = true;
  /**
   * Set by what throws it. Null: a table that is behind was read. Or the search that was stopped: one of an index
   * that, another time, may be read as it is (`DirectGraph.keyClear`); it says whether it may be, then.
   */
  search: (() => boolean) | null = null;
}
export const PENDING_READ = new PendingRead();

const stop = (): void => {
  PENDING_READ.search = null;
  throw PENDING_READ;
};

/** The largest id an index holds. */
const MAX_ID = 2 ** 31 - 1;
const isId = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= MAX_ID && Number.isInteger(v);

const NODE_ADD = 0;
const NODE_SET = 1;
const NODE_DEL = 2;
const LABEL_ADD = 3;
const LABEL_DEL = 4;
const EDGE_ADD = 5;
const EDGE_SET = 6;
const EDGE_DEL = 7;
/** A new row's entry, once the row was deleted again (`Entry.kills`). */
const DEAD = -1;

/**
 * One change the index has and the tables have not.
 *
 * A class, with every field set in its constructor and in one order, and not an object written out where it is
 * logged: entries written out came to have two hidden classes in V8 once a database had made many kinds of them, and
 * what reads a list of entries (`makerOf`, `sweep`) then took many times longer for the same list.
 */
class Entry {
  constructor(
    public k: number,
    /** The graph, by its name in lower case. */
    readonly g: string,
    /** For a relationship: its table's position among the graph's edge tables. */
    readonly t: number,
    /** The node's id, or the relationship's rowid. */
    readonly id: number,
    /** A relationship's start, or a label. */
    readonly a: number | string,
    /** A relationship's end. */
    readonly b: number,
    /** The row's props. A new row's are its last, once the log was made its net effect (`GraphPending.compact`). */
    public props: Uint8Array | null,
    /**
     * For the delete of a node or a relationship the tables never had: the entry that made it, which is `DEAD` from
     * then on. Nothing of such a row is written, and a rollback of the delete gives the entry its kind back.
     */
    readonly kills: Entry | null,
    /**
     * For new props of a row: the props the index held for it before. Where no entry for the row comes before this
     * one, they are what its table has: props set back to them are not written. For the delete of a node its table
     * has: the props the index held for it (an empty map for none), where it held them and a search has asked what
     * the nodes in the log have under a key (`DirectGraph.keyClear`).
     */
    readonly before: Uint8Array | null,
  ) {}
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** The props of a row that has none, as a map. */
const NO_PROPS = new Uint8Array(0);

/** Whether the map with these bytes has the key with this component (no props: no key). */
const has = (props: Uint8Array | null, key: Uint8Array): boolean => props !== null && findMapKey(props, 0, props.length, key) >= 0;

/** Whether two maps have the same value under the key with this component, or neither has the key. */
function sameUnder(a: Uint8Array | null, b: Uint8Array | null, key: Uint8Array): boolean {
  const i = a === null ? -1 : findMapKey(a, 0, a.length, key);
  const j = b === null ? -1 : findMapKey(b, 0, b.length, key);
  if (i < 0 || j < 0) return i < 0 && j < 0;
  const n = skipComponent(a!, i) - i;
  if (skipComponent(b!, j) - j !== n) return false;
  for (let k = 0; k < n; k++) if (a![i + k] !== b![j + k]) return false;
  return true;
}

/** A graph's tables as the log is written to them (`settle`). */
export interface SettleTables {
  readonly node: { add(id: number, props: Uint8Array): void; set(id: number, props: Uint8Array): void; del(id: number): void };
  readonly label: { add(node: number, label: string): void; del(node: number, label: string): void };
  edge(t: number): { add(rowid: number, start: number, end: number, props: Uint8Array | null): void; set(rowid: number, props: Uint8Array): void; del(rowid: number): void };
}

const ADD = 0;
const SET = 1;
const DEL = 2;
interface NetRow {
  k: number;
  a: number;
  b: number;
  props: Uint8Array | null;
  /** The entry that made the row, for a new one. */
  made: Entry | null;
  /** For new props of a row the table has, or its delete: the props the table has, where they are known. */
  before: Uint8Array | null;
}

/** Whether what is left of a row's entries is nothing to write: props set, and back to what the table has. */
const unchanged = (row: NetRow): boolean => row.k === SET && row.before !== null && row.props !== null && sameBytes(row.before, row.props);

/** What is left of a graph's entries: its nodes, its label entries (by label, then node: true for one to add) and its edges by table. */
interface Net {
  readonly nodes: Map<number, NetRow>;
  readonly labels: Map<string, Map<number, boolean>>;
  readonly edges: (Map<number, NetRow> | undefined)[];
}

/** What is left of a row's entries: a new row with its last props, a row the table has with new props, or one to delete. */
function net(rows: Map<number, NetRow>, e: Entry, kind: number): void {
  const cur = rows.get(e.id);
  if (kind === ADD) rows.set(e.id, { k: ADD, a: e.a as number, b: e.b, props: e.props, made: e, before: null });
  else if (kind === SET) {
    if (cur !== undefined) cur.props = e.props;
    else rows.set(e.id, { k: SET, a: 0, b: 0, props: e.props, made: null, before: e.before });
  } else if (cur !== undefined && cur.k === ADD) rows.delete(e.id);
  else rows.set(e.id, { k: DEL, a: 0, b: 0, props: null, made: null, before: cur !== undefined ? cur.before : e.before });
}


/**
 * The rows the index holds that the tables have not, for every graph of a database, and the B+trees guarded for
 * them.
 */
export class GraphPending {
  private ops: Entry[] = [];
  /** The entries before this are in the tables: written since the last commit, they stay until the next. */
  private settled = 0;
  /** The entries before this are of transactions that committed. */
  private committed = 0;
  /** Where each open statement and savepoint began, as the pager's savepoints: one for each level. */
  private readonly marks: { length: number; settled: number }[] = [];
  private guarded: BTree[] = [];
  /** How many entries are deletes of rows the tables never had (`Entry.kills`). */
  private killed = 0;
  /** How long the log was when it was last made its net effect. */
  private compacted = 0;
  /**
   * By graph, then by table (0 for its nodes, an edge table's position and one): for each row whose props a committed
   * entry sets, that entry, the first since the row's table was written. A row set again by a transaction that
   * commits gives the entry its new props and leaves no entry of its own (`fold`), so rows set over and over keep one
   * entry each: the log grew by one for every set, and was made its net effect each time it had doubled. Null until
   * a set commits to a log longer than `slack`, and again whenever committed entries leave the log or are made anew.
   * The entries of a table are a list by rowid: a graph's ids are whole numbers that mostly follow one another, and a
   * list of them is read and written many times faster than a map of them.
   */
  private holders: Map<string, ((Entry | undefined)[] | undefined)[]> | null = null;
  /**
   * The log is made its net effect once it is this much longer than twice what was left of it the last time, and a log
   * no longer than this is not read for rows set again (tests set it low).
   */
  slack = 1024;
  /** The graphs with entries not in their tables, by name in lower case. */
  private readonly open = new Map<string, DirectGraph>();
  /** By a table's root: how many more rows its graph's index holds than the table (fewer, below zero). */
  private readonly counts = new Map<number, { n: number }>();
  /**
   * Goes up whenever entries leave the log or move in it (the tables written, a commit, a rollback, the log swept
   * or made its net effect): what was worked out from entries by their place holds for one value of it.
   */
  epoch = 0;
  /** How many times the tables were brought up to date, and how many entries that wrote (tests, benchmarks). */
  settles = 0;
  written = 0;
  /** Commits that left rows in an index that their tables have not: the tables' row counts moved with no page written. */
  commits = 0;

  /** How many statement and savepoint levels are open. */
  get depth(): number {
    return this.marks.length;
  }

  /** How many more rows the graph's index holds than the table with this root. */
  ahead(root: number): number {
    return this.counts.size === 0 ? 0 : (this.counts.get(root)?.n ?? 0);
  }

  /** @internal The count of a table's rows ahead of it, for the graph that writes them. */
  counter(root: number): { n: number } {
    let c = this.counts.get(root);
    if (c === undefined) this.counts.set(root, (c = { n: 0 }));
    return c;
  }

  private level(): void {
    for (const c of this.counts.values()) c.n = 0;
  }

  /** @internal The log, and where the entries the tables have not begin in it. */
  get log(): readonly Entry[] {
    return this.ops;
  }

  get start(): number {
    return this.settled;
  }

  /** Whether the index holds a row its table has not. */
  get any(): boolean {
    return this.ops.length > this.settled;
  }

  /** How many changes the tables have not. */
  get count(): number {
    return this.ops.length - this.settled;
  }

  /** @internal A change of `d`, made in its index. */
  push(d: DirectGraph, e: Entry): void {
    this.ops.push(e);
    if (e.kills !== null) this.killed++;
    if (!this.open.has(d.key)) this.open.set(d.key, d);
  }

  /** @internal The trees are not read or written until the tables are up to date. */
  guard(trees: readonly BTree[]): void {
    for (const t of trees) {
      if (t.guard !== null) continue;
      t.guard = stop;
      this.guarded.push(t);
    }
  }

  private unguard(): void {
    for (const t of this.guarded) t.guard = null;
    this.guarded.length = 0;
  }

  /** @internal The trees are the tables' again: their table has every row the index holds of it. */
  unguarded(trees: readonly BTree[]): void {
    for (const t of trees) t.guard = null;
    this.guarded = this.guarded.filter((t) => t.guard !== null);
  }

  /** What is left of the entries from `from` to `to`, by graph. */
  private nets(from: number, to: number): Map<string, Net> {
    const ops = this.ops;
    const nets = new Map<string, Net>();
    let key = '';
    let g: Net | undefined;
    for (let i = from; i < to; i++) {
      const e = ops[i]!;
      if (g === undefined || e.g !== key) {
        key = e.g;
        g = nets.get(key);
        if (g === undefined) nets.set(key, (g = { nodes: new Map(), labels: new Map(), edges: [] }));
      }
      switch (e.k) {
        case DEAD:
          break;
        case NODE_ADD:
          net(g.nodes, e, ADD);
          break;
        case NODE_SET:
          net(g.nodes, e, SET);
          break;
        case NODE_DEL:
          if (e.kills === null) net(g.nodes, e, DEL);
          else {
            // A node the table never had: nothing is left of it, nor of its label entries.
            g.nodes.delete(e.id);
            for (const of of g.labels.values()) of.delete(e.id);
          }
          break;
        case LABEL_ADD:
        case LABEL_DEL: {
          const label = e.a as string;
          let of = g.labels.get(label);
          if (of === undefined) g.labels.set(label, (of = new Map()));
          const add = e.k === LABEL_ADD;
          // An entry added and taken away again (or the other way round) is as the table has it.
          if (of.get(e.id) === !add) of.delete(e.id);
          else of.set(e.id, add);
          break;
        }
        default: {
          let rows = g.edges[e.t];
          if (rows === undefined) rows = g.edges[e.t] = new Map();
          if (e.kills !== null) rows.delete(e.id);
          else net(rows, e, e.k === EDGE_ADD ? ADD : e.k === EDGE_SET ? SET : DEL);
        }
      }
    }
    return nets;
  }

  /**
   * Takes the rows the tables never had and that are gone again out of the log, with nothing written: their entries,
   * the deletes that ended them, and what was logged for them in between. Cheaper than `compact`: no row is looked
   * up but those. Called where no statement or savepoint is open and nothing of the log is in the tables.
   */
  private sweep(): void {
    const old = this.ops;
    // By graph: the nodes and the relationships that are gone (ids are a graph's own).
    const gone = new Map<string, { nodes: Set<number>; edges: Set<number> }>();
    for (const e of old) {
      if (e.kills === null) continue;
      let of = gone.get(e.g);
      if (of === undefined) gone.set(e.g, (of = { nodes: new Set(), edges: new Set() }));
      (e.k === NODE_DEL ? of.nodes : of.edges).add(e.id);
    }
    const next: Entry[] = [];
    for (const d of this.open.values()) d.swept();
    const has = new Map<string, { nodes: boolean; labels: boolean; edges: boolean[] }>();
    let key = '';
    let of: { nodes: Set<number>; edges: Set<number> } | undefined;
    let left: { nodes: boolean; labels: boolean; edges: boolean[] } | undefined;
    for (const e of old) {
      if (e.k === DEAD || e.kills !== null) continue;
      if (left === undefined || e.g !== key) {
        key = e.g;
        of = gone.get(key);
        left = has.get(key);
        if (left === undefined) has.set(key, (left = { nodes: false, labels: false, edges: [] }));
      }
      if (e.k <= NODE_DEL) {
        if (of !== undefined && of.nodes.has(e.id)) continue;
        left.nodes = true;
        if (e.k === NODE_ADD) this.open.get(key)?.made(e);
      } else if (e.k <= LABEL_DEL) {
        if (of !== undefined && of.nodes.has(e.id)) continue;
        left.labels = true;
      } else {
        if (of !== undefined && of.edges.has(e.id)) continue;
        left.edges[e.t] = true;
      }
      next.push(e);
    }
    for (const [name, d] of this.open) {
      const l = has.get(name);
      if (!d.left(l !== undefined && l.nodes, l !== undefined && l.labels, (t) => l !== undefined && l.edges[t] === true)) this.open.delete(name);
    }
    this.ops = next;
    this.committed = next.length;
    this.killed = 0;
    this.holders = null;
    this.epoch++;
  }

  /**
   * Makes the log its net effect, with nothing written: a row made and deleted since leaves no entry, a row set
   * several times one. A table no entry is left for is not behind any more. Called where no statement or savepoint
   * is open and nothing of the log is in the tables.
   */
  private compact(): void {
    const old = this.ops;
    const nets = this.nets(0, old.length);
    const next: Entry[] = [];
    for (const d of this.open.values()) d.swept();
    const has = new Map<string, { nodes: boolean; labels: boolean; edges: boolean[] }>();
    for (const [graph, n] of nets) {
      const d = this.open.get(graph);
      const left = { nodes: false, labels: false, edges: [] as boolean[] };
      has.set(graph, left);
      for (const [id, row] of n.nodes) {
        if (unchanged(row)) continue;
        left.nodes = true;
        if (row.made !== null) (row.made.props = row.props), next.push(row.made), d?.made(row.made);
        else next.push(new Entry(row.k === SET ? NODE_SET : NODE_DEL, graph, 0, id, 0, 0, row.props, null, row.before));
      }
      for (const [label, of] of n.labels) {
        for (const [node, add] of of) {
          left.labels = true;
          next.push(new Entry(add ? LABEL_ADD : LABEL_DEL, graph, 0, node, label, 0, null, null, null));
        }
      }
      n.edges.forEach((rows, t) => {
        if (rows === undefined) return;
        for (const [rowid, row] of rows) {
          if (unchanged(row)) continue;
          left.edges[t] = true;
          if (row.made !== null) (row.made.props = row.props), next.push(row.made);
          else next.push(new Entry(row.k === SET ? EDGE_SET : EDGE_DEL, graph, t, rowid, 0, 0, row.props, null, row.before));
        }
      });
    }
    // A node that was made and is gone was never in its table: nothing is known of its row, and nothing is there.
    for (const e of old) {
      if (e.k === NODE_DEL && e.kills === null && nets.get(e.g)!.nodes.get(e.id)?.k !== DEL) this.open.get(e.g)?.nodes.maps!.forget(e.id);
    }
    for (const [key, d] of this.open) {
      const l = has.get(key);
      if (!d.left(l !== undefined && l.nodes, l !== undefined && l.labels, (t) => l !== undefined && l.edges[t] === true)) this.open.delete(key);
    }
    this.ops = next;
    this.committed = this.compacted = next.length;
    this.killed = 0;
    this.holders = null;
    this.epoch++;
  }

  // ---------------------------------------------------------------- the tables

  /**
   * Writes what the tables have not to them, through `tables` (a graph's, by its name in lower case): for each row,
   * what is left of its entries. A row made and deleted since is not written at all.
   */
  settle(tables: (graph: string) => SettleTables): void {
    const from = this.settled;
    const to = this.ops.length;
    if (from === to) return;
    this.unguard();
    this.settles++;
    this.written += to - from;
    const ops = this.ops;
    if (this.apart(from, to)) {
      // A few entries, each of a row of its own (one statement's, mostly): each is written as it is.
      for (let i = from; i < to; i++) this.one(ops[i]!, tables(ops[i]!.g));
    } else {
      const nets = this.nets(from, to);
      for (const [graph, n] of nets) {
        const t = tables(graph);
        for (const [id, row] of n.nodes) {
          if (row.k === ADD) t.node.add(id, row.props!);
          else if (row.k === DEL) t.node.del(id);
          else if (!unchanged(row)) t.node.set(id, row.props!);
        }
        for (const [label, of] of n.labels) {
          for (const [node, add] of of) {
            if (add) t.label.add(node, label);
            else t.label.del(node, label);
          }
        }
        n.edges.forEach((rows, at) => {
          if (rows === undefined) return;
          const edge = t.edge(at);
          for (const [rowid, row] of rows) {
            if (row.k === ADD) edge.add(rowid, row.a, row.b, row.props);
            else if (row.k === DEL) edge.del(rowid);
            else if (!unchanged(row)) edge.set(rowid, row.props!);
          }
        });
      }
    }
    // A node or a relationship that went is not known to be gone any more: its table has it not.
    for (let i = from; i < to; i++) {
      const e = ops[i]!;
      if (e.k === NODE_DEL) this.open.get(e.g)?.nodes.maps!.forget(e.id);
      else if (e.k === EDGE_DEL) this.open.get(e.g)?.edges[e.t]!.maps?.forget(e.id);
    }
    for (const d of this.open.values()) d.settled();
    this.open.clear();
    this.level();
    this.settled = to;
    this.epoch++;
  }

  /**
   * Whether the entries from `from` to `to` are few, alive, and each of a row (or a label entry) of its own: what is
   * left of them is then each of them, with no row's entries to put together.
   */
  private apart(from: number, to: number): boolean {
    if (to - from > 8) return false;
    const ops = this.ops;
    for (let i = from; i < to; i++) {
      const e = ops[i]!;
      if (e.k === DEAD || e.kills !== null) return false;
      for (let j = from; j < i; j++) {
        const o = ops[j]!;
        // The same kind of row (a node, a label entry, a relationship of the type), of the same graph, with the same id.
        if (o.id !== e.id || o.g !== e.g || (o.k <= NODE_DEL ? 0 : o.k <= LABEL_DEL ? 1 : 2) !== (e.k <= NODE_DEL ? 0 : e.k <= LABEL_DEL ? 1 : 2)) continue;
        if (e.k <= NODE_DEL || (e.k <= LABEL_DEL ? o.a === e.a : o.t === e.t)) return false;
      }
    }
    return true;
  }

  /** Writes one entry as it is. */
  private one(e: Entry, t: SettleTables): void {
    switch (e.k) {
      case NODE_ADD:
        t.node.add(e.id, e.props!);
        break;
      case NODE_SET:
        if (e.before === null || !sameBytes(e.before, e.props!)) t.node.set(e.id, e.props!);
        break;
      case NODE_DEL:
        t.node.del(e.id);
        break;
      case LABEL_ADD:
        t.label.add(e.id, e.a as string);
        break;
      case LABEL_DEL:
        t.label.del(e.id, e.a as string);
        break;
      case EDGE_ADD:
        t.edge(e.t).add(e.id, e.a as number, e.b, e.props);
        break;
      case EDGE_SET:
        if (e.before === null || !sameBytes(e.before, e.props!)) t.edge(e.t).set(e.id, e.props!);
        break;
      default:
        t.edge(e.t).del(e.id);
    }
  }

  // ---------------------------------------------------------------- transactions

  /** A statement or a savepoint begins (the pager's `beginSavepoint`). */
  begin(): void {
    this.marks.push({ length: this.ops.length, settled: this.settled });
  }

  /** The pager's `releaseSavepoint`: level `depth` and those inside it end, their changes kept. */
  release(depth: number): void {
    if (this.marks.length >= depth) this.marks.length = depth - 1;
  }

  /**
   * The pager's `rollbackToSavepoint`: what was logged since level `depth` began is dropped, and what was written to
   * the tables since is pending again. True when the log is another than before: the index then holds what the log
   * has not, or the tables lost rows the index took for written.
   */
  rollbackTo(depth: number, keep: boolean): boolean {
    const m = this.marks[depth - 1];
    if (m === undefined) return false;
    this.marks.length = depth - 1;
    if (keep) this.marks.push({ length: m.length, settled: m.settled });
    return this.back(m.length, m.settled);
  }

  /** The transaction committed: what is in the tables leaves the log. */
  commit(): void {
    this.marks.length = 0;
    if (this.ops.length > this.committed && this.ops.length > this.settled) this.commits++;
    // Where this transaction's entries begin in what is left: at the log's start once any of it was written to the
    // tables, which wrote every entry of the transactions before it.
    let from = this.committed;
    if (this.settled > 0) {
      this.epoch++;
      this.holders = null;
      from = 0;
    }
    if (this.settled === this.ops.length) this.ops.length = 0;
    else if (this.settled > 0) this.ops.splice(0, this.settled);
    this.settled = 0;
    const back = this.ops.length > from && this.fold(from);
    this.committed = this.ops.length;
    // Rows made and deleted again, or set again and again, would make the log longer for ever. The first are swept
    // away once they are a good part of it; then, when it has still grown to twice what its net effect last was,
    // it is made its net effect.
    if (this.killed > 0 && this.killed * 4 >= this.committed) this.sweep();
    // Rows set back to what their tables have leave entries that say nothing: once they are half the log, it is made
    // its net effect, which takes them out and leaves a table with no entry not behind.
    if (back || this.committed > 2 * this.compacted + this.slack) this.compact();
  }

  /**
   * The entries from `from` on are a transaction's that committed. A set of a row that a committed entry before it
   * sets already gives that entry its props and leaves the log: what is left of the two is the same (`nets`), and the
   * first one's `before` is what the table has. A delete ends what is held for its row. Nothing is held until a set
   * comes to a log longer than `slack`: then every committed entry is read once. A shorter log is left as it is:
   * reading a commit's entries when none of their rows was set before took 3% of a statement that sets 1,000 rows
   * (ADR 0042, "After step 4"), and a log that short costs nothing to keep.
   *
   * True when the rows this set back to what their tables have are half of the log or more: their entries say
   * nothing now, and `commit` has the log made its net effect.
   */
  private fold(from: number): boolean {
    const ops = this.ops;
    let holders = this.holders;
    if (holders === null) {
      if (ops.length <= this.slack) return false;
      let sets = false;
      for (let i = from; i < ops.length && !sets; i++) sets = ops[i]!.k === NODE_SET || ops[i]!.k === EDGE_SET;
      if (!sets) return false;
      holders = this.holders = new Map();
      from = 0;
    }
    let to = from;
    let back = 0;
    let key = '';
    let tables: ((Entry | undefined)[] | undefined)[] | undefined;
    for (let i = from; i < ops.length; i++) {
      const e = ops[i]!;
      const k = e.k;
      if (k === NODE_SET || k === EDGE_SET || k === NODE_DEL || k === EDGE_DEL) {
        if (tables === undefined || e.g !== key) {
          key = e.g;
          tables = holders.get(key);
          if (tables === undefined) holders.set(key, (tables = []));
        }
        const at = k <= NODE_DEL ? 0 : e.t + 1;
        let rows = tables[at];
        const id = e.id;
        if (k === NODE_DEL || k === EDGE_DEL) {
          if (rows !== undefined && id < rows.length) rows[id] = undefined;
        } else {
          if (rows === undefined) rows = tables[at] = [];
          const held = id < rows.length ? rows[id] : undefined;
          if (held !== undefined) {
            held.props = e.props;
            if (held.before !== null && e.props !== null && sameBytes(held.before, e.props)) back++;
            continue;
          }
          rows[id] = e;
        }
      }
      if (to !== i) ops[to] = e;
      to++;
    }
    if (to === ops.length) return false;
    ops.length = to;
    this.epoch++;
    return back > 0 && back * 2 >= to;
  }

  /** The transaction was rolled back: as `rollbackTo`, to its start. */
  rollback(): boolean {
    this.marks.length = 0;
    return this.back(this.committed, 0);
  }

  private back(length: number, settled: number): boolean {
    if (this.ops.length === length && this.settled === settled) return false;
    for (let i = length; i < this.ops.length; i++) {
      const e = this.ops[i]!;
      if (e.kills === null) continue;
      e.kills.k = e.k === NODE_DEL ? NODE_ADD : EDGE_ADD;
      this.killed--;
    }
    this.ops.length = length;
    this.settled = settled;
    this.holders = null;
    this.epoch++;
    // What the index holds is not what the log says any more: nothing of it is trusted (`Database` drops the
    // indexes once the entries left are in the tables), and no tree is guarded for it.
    this.unguard();
    for (const d of this.open.values()) d.settled();
    this.open.clear();
    this.level();
    return true;
  }
}

/** One of a graph's tables whose rows its index may hold before the table does. */
export interface DirectTable {
  readonly table: TableSchema;
  /** The table's tree, then its indexes': guarded while the index holds rows of the table that it has not. */
  readonly trees: readonly BTree[];
  readonly reader: RecordReader;
  /** The props column and its maps in the graph's index: -1 and null for an edge table that has none. */
  readonly props: number;
  readonly maps: GraphProps | null;
  /** The longest props a row may have for every key of the table's indexes to fit. */
  readonly maxProps: number;
}

export interface DirectEdge extends DirectTable {
  readonly start: number;
  readonly end: number;
}

/** A graph's label index table. */
export interface DirectLabels {
  readonly table: TableSchema;
  readonly trees: readonly BTree[];
  readonly node: number;
  /** The longest label an entry may have for every key of the table's indexes to fit. */
  readonly maxLabel: number;
}

/** What `DirectGraph` answers when a write is not its to make: the caller writes the table, as the statement runs. */
export const PASS = -1;

/**
 * One graph's writes into its index. A method that writes returns false (or `PASS`) for a row it can't take: a value
 * the tables' writers convert or refuse, an id or a key the index can't hold. Nothing is changed then, and the
 * caller writes the row through its table, which brings the tables up to date first.
 */
export class DirectGraph {
  private readonly cursor = new ListCursor();
  private readonly keyBuf = new Uint8Array(ROWID_KEY_SIZE);
  /** By edge table: the relationships made since the tables were last up to date, and those of the table deleted since. */
  private readonly added: Map<number, Entry>[];
  private readonly deleted: Set<number>[];
  /** The entries of the nodes made since the tables were last up to date, by id (ids go up). */
  private nodesMade: Entry[] = [];
  private readonly tabs: (BTreeCursor | undefined)[] = [];
  private guardedNodes = false;
  private guardedLabels = false;
  private readonly guardedEdges: boolean[];
  /** How many rows the index is ahead of each table by. */
  private readonly nodesAhead: { n: number };
  private readonly labelsAhead: { n: number };
  private readonly edgesAhead: { n: number }[];

  constructor(
    /** The graph's name in lower case, and as it was defined. */
    readonly key: string,
    readonly name: string,
    readonly index: GraphIndex,
    readonly nodes: DirectTable,
    readonly labels: DirectLabels,
    /** The graph's edge tables, in its order: a relationship type's position is its type in the index. */
    readonly edges: readonly DirectEdge[],
    private readonly pending: GraphPending,
  ) {
    this.added = edges.map(() => new Map());
    this.deleted = edges.map(() => new Set());
    this.guardedEdges = edges.map(() => false);
    this.places = new Map<string, number>([[nodes.table.name, -1], ...edges.map((e, i): [string, number] => [e.table.name, i])]);
    this.nodesAhead = pending.counter(nodes.table.rootPage);
    this.labelsAhead = pending.counter(labels.table.rootPage);
    this.edgesAhead = edges.map((e) => pending.counter(e.table.rootPage));
  }

  private readonly places: Map<string, number>;

  /** Where a table of the graph is written: -1 for its node table, an edge table's position; undefined for any other. */
  at(table: string): number | undefined {
    return this.places.get(table);
  }

  /** Whether the index is as it was when this was made: built, with its label sets and the tables' property maps. */
  get valid(): boolean {
    const ix = this.index;
    return ix.out !== null && ix.off === null && !ix.propsOff && !this.nodes.maps!.closed;
  }

  /** @internal The tables are up to date: nothing is guarded for this graph, and it holds no row of its own. */
  settled(): void {
    this.nodesMade = [];
    for (const m of this.added) m.clear();
    for (const s of this.deleted) s.clear();
    this.guardedNodes = this.guardedLabels = false;
    this.guardedEdges.fill(false);
    this.index.pinned = false;
  }

  /**
   * @internal The log was made its net effect: the tables no entry is left for (its nodes', its labels', each edge
   * table's) are not behind any more. False when none is: the index holds no row of its own.
   */
  left(nodes: boolean, labels: boolean, edges: (t: number) => boolean): boolean {
    let any = nodes || labels;
    if (!nodes && this.guardedNodes) (this.guardedNodes = false), this.pending.unguarded(this.nodes.trees);
    if (!labels && this.guardedLabels) (this.guardedLabels = false), this.pending.unguarded(this.labels.trees);
    for (let t = 0; t < this.edges.length; t++) {
      if (edges(t)) any = true;
      else if (this.guardedEdges[t]) (this.guardedEdges[t] = false), this.pending.unguarded(this.edges[t]!.trees);
    }
    if (!any) this.index.pinned = false;
    return any;
  }

  /** @internal The log is being rewritten: the nodes made are told again (`made`), in its order. */
  swept(): void {
    this.nodesMade = [];
  }

  /** @internal A node this graph made is still in the log. */
  made(e: Entry): void {
    this.nodesMade.push(e);
  }

  /** By a props key's component: the log's state it was read in, how far, and whether a node read had the key. */
  private readonly keysSeen = new Map<string, { key: Uint8Array; epoch: number; upTo: number; found: boolean }>();

  /**
   * Whether every node the index holds ahead of the node table has, under a props key, what its row in the table
   * has: `key` is the key's component in a map's bytes, `name` the key. So: no new node has the key, no change of a
   * node's props gave it another value under the key (or took it, or gave it one), and no node of the table that
   * had the key was deleted (one whose props the log does not hold counts as having had it). An index of the table
   * on that key alone then has every entry for a value that it would have with the tables written, and no other:
   * only its entries for rows without the key are missing, or left over. A search of that index for a value needs no
   * table written; the rows it finds may have other props than their table's rows, which the property maps hold.
   * The log is read once: each call reads the entries logged since the last.
   */
  keyClear(name: string, key: Uint8Array): boolean {
    const pending = this.pending;
    let seen = this.keysSeen.get(name);
    if (seen === undefined) this.keysSeen.set(name, (seen = { key, epoch: -1, upTo: 0, found: false }));
    if (seen.epoch !== pending.epoch) {
      seen.epoch = pending.epoch;
      seen.upTo = pending.start;
      seen.found = false;
    }
    if (seen.found) return false;
    const log = pending.log;
    let i = Math.max(seen.upTo, pending.start);
    for (; i < log.length; i++) {
      const e = log[i]!;
      if (e.k > NODE_DEL || e.k === DEAD || e.g !== this.key) continue;
      // A node the table never had, gone again: nothing of it is in the index. One of the table: its entry is left.
      if (e.k === NODE_DEL ? e.kills === null && (e.before === null || has(e.before, key)) : e.k === NODE_ADD ? has(e.props, key) : e.before === null || !sameUnder(e.before, e.props, key)) {
        seen.found = true;
        break;
      }
    }
    seen.upTo = i;
    return !seen.found;
  }

  /** The entry that made node `id`, when the table has not got the node yet and it is not gone. */
  private makerOf(id: number): Entry | undefined {
    const made = this.nodesMade;
    let lo = 0;
    let hi = made.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const at = made[mid]!.id;
      if (at === id) return made[mid]!.k === NODE_ADD ? made[mid] : undefined;
      if (at < id) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  }

  private log(k: number, t: number, id: number, a: number | string, b: number, props: Uint8Array | null, kills: Entry | null = null, before: Uint8Array | null = null): Entry {
    const ix = this.index;
    ix.dirty = true;
    ix.propsDirty = true;
    ix.pinned = true;
    const e = new Entry(k, this.key, t, id, a, b, props, kills, before);
    this.pending.push(this, e);
    if (k <= NODE_DEL) {
      if (!this.guardedNodes) (this.guardedNodes = true), this.pending.guard(this.nodes.trees);
      if (k !== NODE_SET) this.nodesAhead.n += k === NODE_ADD ? 1 : -1;
    } else if (k <= LABEL_DEL) {
      if (!this.guardedLabels) (this.guardedLabels = true), this.pending.guard(this.labels.trees);
      this.labelsAhead.n += k === LABEL_ADD ? 1 : -1;
    } else {
      if (!this.guardedEdges[t]) (this.guardedEdges[t] = true), this.pending.guard(this.edges[t]!.trees);
      if (k !== EDGE_SET) this.edgesAhead[t]!.n += k === EDGE_ADD ? 1 : -1;
    }
    return e;
  }

  // ---------------------------------------------------------------- reads of the tables, past their guards

  /** The table's cursor at `rowid`, or null when the table has no such row. The row has no entry in the log. */
  private seek(t: DirectTable, at: number, rowid: number | bigint): BTreeCursor | null {
    let c = this.tabs[at];
    if (c === undefined) {
      c = this.tabs[at] = t.trees[0]!.cursor();
      c.trusted = true;
    }
    writeRowidKey(this.keyBuf, 0, rowid);
    const found = c.seek(this.keyBuf) && c.compareKey(this.keyBuf) === 0;
    if (!found) c.close();
    return found ? c : null;
  }

  /** Column `column` of the table's row `rowid`; undefined when it has no such row. */
  private read(t: DirectTable, at: number, rowid: number | bigint, column: number, other = -1): SqlValue | undefined {
    const c = this.seek(t, at, rowid);
    if (c === null) return undefined;
    c.loadValue();
    t.reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
    const v = t.reader.column(column);
    if (other >= 0) this.otherValue = t.reader.column(other);
    // No page stays pinned: the statement goes on to write.
    c.close();
    return v;
  }
  private otherValue: SqlValue = null;

  // ---------------------------------------------------------------- nodes

  /** Whether `id` is a node of the graph: one the index holds, or a row of the node table that is not gone. */
  isNode(id: number | bigint): boolean {
    if (isId(id)) {
      const maps = this.nodes.maps!;
      if (maps.gone(id)) return false;
      // A node the maps know, or one with a label: an entry of the label index is a node's, and goes with it.
      if (maps.known(id) || this.index.labels!.any(id)) return true;
    }
    return this.seek(this.nodes, 0, id) !== null && (this.tabs[0]!.close(), true);
  }

  /** A new node. */
  node(id: number, props: Uint8Array): boolean {
    if (id > MAX_ID || props.length > this.nodes.maxProps) return false;
    this.nodes.maps!.put(id, props);
    this.nodesMade.push(this.log(NODE_ADD, 0, id, 0, 0, props));
    return true;
  }

  /** Deletes a node: 1, 0 when there is none, or `PASS`. A node with relationships is refused, as its table's writer refuses it. */
  deleteNode(id: SqlValue): number {
    if (typeof id === 'bigint') return PASS;
    if (typeof id !== 'number' || !Number.isInteger(id)) return 0;
    if (!isId(id)) return PASS;
    if (!this.isNode(id)) return 0;
    if (this.connected(id)) this.refuseConnected(id);
    // Its labels go with it.
    const labels = this.index.labels!;
    const made = this.makerOf(id);
    if (made !== undefined) {
      // A node its table never had: its entry is dead, and with it what was logged for the node. Nothing is known
      // of the row any more, and the table has none.
      let had = 0;
      for (const label of labels.labelsOf(id)) had += labels.remove(label, id) ? 1 : 0;
      this.labelsAhead.n -= had;
      made.k = DEAD;
      this.nodes.maps!.forget(id);
      this.log(NODE_DEL, 0, id, 0, 0, null, made);
      return 1;
    }
    for (const label of labels.labelsOf(id)) {
      labels.remove(label, id);
      this.log(LABEL_DEL, 0, id, label, 0, null);
    }
    // What the node had, once a search has asked what the nodes in the log have under a key (`keyClear`).
    const maps = this.nodes.maps!;
    const held = this.keysSeen.size > 0 ? maps.get(id) : undefined;
    maps.setGone(id);
    this.log(NODE_DEL, 0, id, 0, 0, null, null, held === undefined ? null : (held ?? NO_PROPS));
    return 1;
  }

  /** Whether a node has a relationship, of any type, from either end. */
  private connected(id: number): boolean {
    const c = this.cursor;
    this.index.out!.seek(c, id, 0);
    if (c.i < c.end || c.more()) return true;
    this.index.in!.seek(c, id, 0);
    return c.i < c.end || c.more();
  }

  /** The error for the delete of a node with relationships: it names the first of the graph's edge tables that has one, by its start before its end. */
  private refuseConnected(id: number): never {
    const c = this.cursor;
    for (let t = 0; t < this.edges.length; t++) {
      for (let side = 0; side < 2; side++) {
        (side === 0 ? this.index.out! : this.index.in!).seek(c, id, t);
        if (!((c.i < c.end || c.more()) && c.a[c.i] === t)) continue;
        const e = this.edges[t]!;
        const column = e.table.columns[side === 0 ? e.start : e.end]!.name;
        throw new ConstraintError('SMALT_CONSTRAINT_FOREIGNKEY', `property graph ${this.name}: can't delete node ${id} of ${this.nodes.table.name}: relationships in ${e.table.name}.${column} refer to it (delete them first)`, {
          table: e.table.name,
          columns: [column],
          name: this.name,
        });
      }
    }
    throw new SmaltError('SMALT_INTERNAL', `graph index of ${this.name}: node ${id} has a relationship of no type`);
  }

  // ---------------------------------------------------------------- labels

  hasLabel(id: SqlValue, label: string): boolean {
    return isId(id) && this.index.labels!.has(label, id);
  }

  /** A label for a node made by this statement: one it has not. */
  label(id: number, label: string): boolean {
    if (label.length > this.labels.maxLabel) return false;
    if (this.index.labels!.add(label, id)) this.log(LABEL_ADD, 0, id, label, 0, null);
    return true;
  }

  /** Gives a node a label it has not. A node that is none is refused, as the label index's writer refuses it. */
  addLabel(id: SqlValue, label: string): boolean {
    if (!isId(id) || label.length > this.labels.maxLabel) return false;
    if (!this.isNode(id)) throw this.notANode(this.labels.table, this.labels.node, id);
    return this.label(id, label);
  }

  /** Takes a label from a node: 1, or 0 when it has it not. */
  dropLabel(id: SqlValue, label: string): number {
    if (!isId(id) || !this.index.labels!.remove(label, id)) return 0;
    this.log(LABEL_DEL, 0, id, label, 0, null);
    return 1;
  }

  // ---------------------------------------------------------------- relationships

  private notANode(table: TableSchema, column: number, v: SqlValue): ConstraintError {
    const name = table.columns[column]!.name;
    return new ConstraintError('SMALT_CONSTRAINT_FOREIGNKEY', `property graph ${this.name}: ${table.name}.${name} ${v === null ? 'is NULL' : `= ${String(v)} is not a node of the graph`}`, {
      table: table.name,
      columns: [name],
      name: this.name,
    });
  }

  /** A new relationship of the type at position `t`. An end that is no node is refused, as the table's writer refuses it. */
  edge(t: number, rowid: number, start: SqlValue, end: SqlValue, props: Uint8Array): boolean {
    const e = this.edges[t]!;
    if (rowid > MAX_ID || (e.props >= 0 && props.length > e.maxProps)) return false;
    // The start, then the end, as the table's writer checks them.
    for (let i = 0; i < 2; i++) {
      const v = i === 0 ? start : end;
      // Text, bytes or a number that is not whole: the table's writer converts it, or refuses it.
      if (v !== null && typeof v !== 'bigint' && !(typeof v === 'number' && Number.isInteger(v))) return false;
      if (v === null || !this.isNode(v)) throw this.notANode(e.table, i === 0 ? e.start : e.end, v);
      // A node the index can't hold.
      if (!isId(v)) return false;
    }
    const s = start as number;
    const d = end as number;
    this.index.out!.add(s, t, d, rowid);
    this.index.in!.add(d, t, s, rowid);
    if (e.props >= 0) e.maps!.put(rowid, props);
    this.added[t]!.set(rowid, this.log(EDGE_ADD, t, rowid, s, d, e.props < 0 ? null : props));
    return true;
  }

  /** Deletes a relationship of the type at position `t`: 1, 0 when there is none, or `PASS`. */
  deleteEdge(t: number, rowid: SqlValue): number {
    if (typeof rowid === 'bigint') return PASS;
    if (typeof rowid !== 'number' || !Number.isInteger(rowid)) return 0;
    if (!isId(rowid)) return PASS;
    const e = this.edges[t]!;
    const made = this.added[t]!.get(rowid);
    let s: SqlValue | undefined;
    let d: SqlValue;
    if (made !== undefined) {
      s = made.a as number;
      d = made.b;
    } else {
      if (this.deleted[t]!.has(rowid)) return 0;
      s = this.read(e, t + 1, rowid, e.start, e.end);
      if (s === undefined) return 0;
      d = this.otherValue;
    }
    // Every row of an indexed graph's edge table is in its lists.
    if (!isId(s) || !isId(d) || !this.index.out!.remove(s, t, d, rowid) || !this.index.in!.remove(d, t, s, rowid)) {
      throw new SmaltError('SMALT_INTERNAL', `graph index of ${this.name} does not have relationship ${rowid} of ${e.table.name}`);
    }
    if (made !== undefined) {
      // A relationship its table never had: its entry is dead, and nothing is known of its row any more.
      e.maps?.forget(rowid);
      this.added[t]!.delete(rowid);
      made.k = DEAD;
      this.log(EDGE_DEL, t, rowid, 0, 0, null, made);
    } else {
      // Its table still has its row: no reader of the maps is given it, or reads it from the table for them.
      e.maps?.setGone(rowid);
      this.deleted[t]!.add(rowid);
      this.log(EDGE_DEL, t, rowid, 0, 0, null);
    }
    return 1;
  }

  // ---------------------------------------------------------------- properties

  /**
   * The props of a node (`t` -1) or of a relationship of the type at position `t`: its map's bytes, null where they
   * are NULL, undefined when it is not there, or `PASS` for a rowid the index holds no row for.
   */
  props(t: number, rowid: SqlValue): Uint8Array | null | undefined | typeof PASS {
    if (!isId(rowid)) return PASS;
    const at = t < 0 ? this.nodes : this.edges[t]!;
    const maps = at.maps!;
    if (t >= 0 ? this.deleted[t]!.has(rowid) : maps.gone(rowid)) return undefined;
    const held = maps.get(rowid);
    if (held !== undefined) return held;
    const read = this.read(at, t + 1, rowid, at.props);
    if (read === undefined) return undefined;
    if (!holdable(read)) return PASS;
    maps.set(rowid, read);
    return read;
  }

  /**
   * New props for a node (`t` -1) or a relationship that is there (`props` told so, and gave `before`: the props it
   * has, an empty map for none).
   */
  setProps(t: number, rowid: SqlValue, props: Uint8Array, before: Uint8Array | null = null): boolean {
    const at = t < 0 ? this.nodes : this.edges[t]!;
    if (!isId(rowid) || props.length > at.maxProps) return false;
    at.maps!.put(rowid, props);
    this.log(t < 0 ? NODE_SET : EDGE_SET, t < 0 ? 0 : t, rowid, 0, 0, props, null, before);
    return true;
  }

  /**
   * The relationships at a node, from either end, each given with its table's name and its rowid (one from the node
   * to itself twice). False, with nothing given, for a value that is no id the index holds.
   */
  touching(node: SqlValue, each: (table: string, rowid: number) => void): boolean {
    if (!isId(node)) return false;
    const c = this.cursor;
    for (const lists of [this.index.out!, this.index.in!]) {
      lists.seek(c, node, 0);
      while (c.i < c.end || c.more()) {
        each(this.edges[c.a[c.i]!]!.table.name, c.a[c.i + 2]!);
        c.i += 3;
      }
    }
    return true;
  }
}
