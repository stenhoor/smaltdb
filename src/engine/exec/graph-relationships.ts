/**
 * A property graph's relationships as a relation (ADR 0040, section 2.2): the rows of a `relationships` operation.
 * A row is a relationship at one of its ends: the node it is at (`node`), the node at its other end (`other`), its
 * type's name, its rowid in its type's table, whether `node` is its start, and its catch-all properties.
 *
 * The scan reads every relationship, or those at one node (a condition on `node`, or on `other`: the relation reads
 * from either end), or those between two nodes (a condition on both). At a node it reads the graph's index in memory
 * (exec/graph-index.ts): the node's list by start for the relationships that leave it, its list by end for those that
 * reach it. Whether the graph is indexed is asked once per execution; without an index (a reader, a graph the index
 * can't hold) each type's rows come from its table's endpoint indexes, which give them in the order the lists do. So
 * a prepared statement stays valid when the index comes or goes, and returns the same rows in the same order.
 *
 * Rows come by reading (outgoing, then incoming), then by type in the graph's order, then by the node at the far end
 * and rowid; a scan of every relationship gives each type's rows by rowid. A relationship from a node to itself is
 * given once when both ends are read, as outgoing. Properties are read from the relationship's row, and only when the
 * plan reads the `props` column.
 */
import { SmaltError } from '../errors.js';
import type { BTreeCursor } from '../storage/btree.js';
import { ROWID_KEY_SIZE, writeRowidKey } from '../storage/key-codec.js';
import { type SqlValue, compareValues } from '../values.js';
import type { Fn } from './expr.js';
import { type GraphLists, ListCursor } from './graph-lists.js';
import { type GraphProps, holdable } from './graph-props.js';
import type { ExecState, Operator, TableAccess } from './operators.js';

/** The largest node id a graph's index holds. */
const MAX_ID = 2147483647;

/** One relationship type a scan reads: its table, read with and without the graph's index. */
export interface RelationshipType {
  /** Its name: the `type` column's value. */
  readonly name: string;
  /** Its table's position among the graph's edge tables: its type in the graph's index. */
  readonly position: number;
  /**
   * Its table read without the graph's index. Each of these leaves a row's start, end and rowid in the registers
   * `start`, `end` and `rowid`, and its props in `props` once `readProps` was called: `whole`, every row by rowid;
   * `byStart`, the rows whose start is the node the scan is at (and whose end is its far node, when it has one), in
   * the order of the index on (start, end); `byEnd`, likewise from the index on (end, start). The last two are null
   * for a scan of every relationship, and where the table has no such index (`whole` is then read and sorted).
   */
  readonly whole: Operator;
  readonly byStart: Operator | null;
  readonly byEnd: Operator | null;
  readonly start: number;
  readonly end: number;
  readonly rowid: number;
  /** The register the table's scans leave a row's props in; -1 when the table has no props column. */
  readonly props: number;
  /** Makes the table's scans read props too. Called before any of them first opens. */
  readonly readProps: () => void;
  /** The table by rowid, giving a row's props to the scan's own `props` register; null when the table has none. */
  readonly fetch: TableAccess | null;
  /**
   * The table's property maps in the graph's index (ADR 0041), or null when the index holds none. A row they know
   * is read from them; any other is fetched, and they then know it. Asked once per execution, and only by a scan
   * that reads props through the index.
   */
  readonly held: () => GraphProps | null;
}

/** The lists of a graph's index: by start node and by end node. */
export interface RelationshipLists {
  readonly out: GraphLists;
  readonly in: GraphLists;
}

/** A node the scan is given: the expression that gives it, and how the comparison with the column converts it. */
export interface RelationshipKey {
  readonly value: Fn;
  readonly convert: (v: SqlValue) => SqlValue;
}

/** The columns of the relation, as positions in `regs` and `reads`. */
const NODE = 0;
const OTHER = 1;
const TYPE = 2;
const ID = 3;
const OUTGOING = 4;
const PROPS = 5;

export class RelationshipsScan implements Operator {
  readonly children: Operator[] = [];

  private r!: SqlValue[];
  private lists: RelationshipLists | null = null;
  private epoch = -1;
  private ready = false;
  private done = true;
  /** The readings in order: true for outgoing. */
  private readonly phases: readonly boolean[];
  /**
   * Where the scan is anchored: the end whose node it is given. `near`: that node's key (none: every relationship);
   * `far`: the key of the node at the other end, when both are given; `flipped`: the anchor is the `other` column.
   */
  private readonly near: RelationshipKey | undefined;
  private readonly far: RelationshipKey | undefined;
  private readonly flipped: boolean;
  /** With the index, a node's whole list is one read: every type is wanted and no far node is given. */
  private readonly wholeList: boolean;
  /** Types by their position in the graph (the index's type numbers). */
  private readonly byPosition: (RelationshipType | undefined)[] = [];
  /** Registers of the columns read; -1 for one that isn't. */
  private nodeReg = -1;
  private otherReg = -1;
  private typeReg = -1;
  private idReg = -1;
  private outgoingReg = -1;
  private propsReg = -1;

  /** Where the scan is: the reading and type it reads now, counted together. */
  private segment = -1;
  private outgoing = true;
  private type: RelationshipType | null = null;

  // With the index.
  private readonly cursor = new ListCursor();
  private current: GraphLists | null = null;
  private version = 0;
  /** The anchor node and the far node, as ids. */
  private here = -1;
  private there = -1;
  /** The type the segment reads (-1: any), and the last entry it gave (-1: none yet). */
  private segmentType = -1;
  private lastType = 0;
  private lastOther = 0;
  private lastRowid = -1;
  private readonly tabs: (BTreeCursor | undefined)[] = [];
  private readonly keyBuf = new Uint8Array(ROWID_KEY_SIZE);
  /** By a type's position: its property maps in the index, for this execution (null: none, every row is fetched). */
  private readonly maps: (GraphProps | null)[] = [];

  // Without it.
  private sub: Operator | null = null;
  /** Rows of a table without an endpoint index, sorted as the index would give them: [far, rowid, props, anchor]. */
  private sorted: SqlValue[][] | null = null;
  private at = 0;

  constructor(
    readonly graph: string,
    readonly direction: 'out' | 'in' | 'both',
    /** The types read, in the graph's order. */
    readonly types: readonly RelationshipType[],
    /** Whether they are all of the graph's types. */
    readonly everyType: boolean,
    /** The registers of node, other, type, id, outgoing and props. */
    readonly regs: readonly number[],
    /** Which of them the plan reads: set as expressions over them are compiled, so read when the scan first opens. */
    readonly reads: readonly boolean[],
    /** The graph's lists, or null when it isn't indexed. Asked once per execution, and only by a scan at a node. */
    readonly source: () => RelationshipLists | null,
    readonly state: ExecState,
    /** The node the plan gives for the `node` column, and for the `other` column. Neither: every relationship. */
    readonly node?: RelationshipKey,
    readonly other?: RelationshipKey,
  ) {
    this.phases = direction === 'both' ? [true, false] : [direction === 'out'];
    this.flipped = node === undefined && other !== undefined;
    this.near = node ?? other;
    this.far = node !== undefined ? other : undefined;
    this.wholeList = everyType && this.far === undefined;
    for (const t of types) this.byPosition[t.position] = t;
  }

  get detail(): string {
    const what = `RELATIONSHIPS OF ${this.graph}`;
    if (!this.near) return `SCAN ${what}`;
    return `SEARCH ${what} (${[this.node ? 'node=?' : '', this.other ? 'other=?' : ''].filter((x) => x).join(' AND ')})`;
  }

  /** Once, when the scan first opens: which columns the plan reads is known by then. */
  private prepare(): void {
    this.ready = true;
    const reg = (i: number): number => (this.reads[i] ? this.regs[i]! : -1);
    this.nodeReg = reg(NODE);
    this.otherReg = reg(OTHER);
    this.typeReg = reg(TYPE);
    this.idReg = reg(ID);
    this.outgoingReg = reg(OUTGOING);
    this.propsReg = reg(PROPS);
    if (this.propsReg >= 0) for (const t of this.types) t.readProps();
  }

  /** A key as a node id the index can hold, or -1. */
  private static id(v: SqlValue): number {
    if (typeof v === 'bigint') return v >= 0n && v <= 2147483647n ? Number(v) : -1;
    return typeof v === 'number' && v >= 0 && v <= MAX_ID && Number.isInteger(v) ? v : -1;
  }

  open(r: SqlValue[]): void {
    this.r = r;
    if (!this.ready) this.prepare();
    if (this.epoch !== this.state.epoch) {
      this.epoch = this.state.epoch;
      this.lists = this.near ? this.source() : null;
      if (this.lists !== null && this.propsReg >= 0) for (const t of this.types) this.maps[t.position] = t.fetch === null ? null : t.held();
    }
    this.sub?.close();
    this.sub = null;
    this.sorted = null;
    this.segment = -1;
    this.done = this.types.length === 0;
    if (this.done || this.lists === null) return;
    // With the index: the nodes as ids. A value that is no id is at no relationship's end.
    const near = this.near!;
    this.here = RelationshipsScan.id(near.convert(near.value(r)));
    if (this.far) this.there = RelationshipsScan.id(this.far.convert(this.far.value(r)));
    if (this.here < 0 || (this.far && this.there < 0)) this.done = true;
  }

  /** Moves to the next reading and type. False when there is none. */
  private nextSegment(): boolean {
    const perPhase = this.lists !== null && this.wholeList ? 1 : this.types.length;
    const s = ++this.segment;
    if (s >= this.phases.length * perPhase) return false;
    this.outgoing = this.phases[(s / perPhase) | 0]!;
    this.type = this.types[s % perPhase]!;
    // An outgoing relationship is at its start: found by start from `node`, by end from `other`.
    const byStart = this.outgoing !== this.flipped;
    const lists = this.lists;
    if (lists !== null) {
      this.current = byStart ? lists.out : lists.in;
      this.segmentType = this.wholeList ? -1 : this.type.position;
      this.lastRowid = -1;
      this.seekSegment();
      return true;
    }
    const t = this.type;
    const sub = this.near ? (byStart ? t.byStart : t.byEnd) : t.whole;
    if (sub !== null) {
      this.sub = sub;
      sub.open(this.r);
    } else this.collect(t, byStart);
    return true;
  }

  /** Points the cursor at the segment's first entry, or after the last one given. */
  private seekSegment(): void {
    const lists = this.current!;
    this.version = lists.version;
    const c = this.cursor;
    if (this.lastRowid >= 0) lists.seek(c, this.here, this.lastType, this.lastOther, this.lastRowid + 1);
    else if (this.far) lists.seek(c, this.here, this.segmentType, this.there);
    else lists.seek(c, this.here, this.segmentType < 0 ? 0 : this.segmentType);
  }

  /**
   * A table with no index on this endpoint, read whole: its rows at the anchor node (and the far one), sorted as the
   * index would give them.
   */
  private collect(t: RelationshipType, byStart: boolean): void {
    const r = this.r;
    const near = this.near!;
    const here = near.convert(near.value(r));
    const there = this.far ? this.far.convert(this.far.value(r)) : null;
    const rows: SqlValue[][] = [];
    if (here !== null && !(this.far && there === null)) {
      const w = t.whole;
      w.open(r);
      try {
        while (w.next()) {
          const anchor = r[byStart ? t.start : t.end]!;
          const far = r[byStart ? t.end : t.start]!;
          if (anchor === null || compareValues(anchor, here) !== 0) continue;
          if (this.far && (far === null || compareValues(far, there) !== 0)) continue;
          rows.push([far, r[t.rowid]!, t.props >= 0 && this.propsReg >= 0 ? r[t.props]! : null, anchor]);
        }
      } finally {
        w.close();
      }
      rows.sort((x, y) => compareValues(x[0]!, y[0]!) || compareValues(x[1]!, y[1]!));
    }
    this.sorted = rows;
    this.at = 0;
  }

  next(): boolean {
    if (this.done) return false;
    return this.lists !== null ? this.nextListed() : this.nextStored();
  }

  /** The next relationship from the graph's index. */
  private nextListed(): boolean {
    const c = this.cursor;
    const r = this.r;
    const here = this.here;
    const pair = this.far !== undefined;
    const skipLoops = this.direction === 'both';
    for (;;) {
      if (this.segment < 0 && !this.nextSegment()) return (this.done = true), false;
      // The lists changed under the scan (the statement writes the graph): go on from after the last entry given.
      if (this.version !== this.current!.version) this.seekSegment();
      if (c.i >= c.end && !c.more()) {
        if (!this.nextSegment()) return (this.done = true), false;
        continue;
      }
      const a = c.a;
      const i = c.i;
      const type = a[i]!;
      const there = a[i + 1]!;
      if ((this.segmentType >= 0 && type !== this.segmentType) || (pair && there !== this.there)) {
        if (!this.nextSegment()) return (this.done = true), false;
        continue;
      }
      const rowid = a[i + 2]!;
      c.i = i + 3;
      this.lastType = type;
      this.lastOther = there;
      this.lastRowid = rowid;
      // Read at both ends, a relationship from a node to itself is given once, as outgoing.
      if (skipLoops && !this.outgoing && there === here) continue;
      if (this.nodeReg >= 0) r[this.nodeReg] = this.flipped ? there : here;
      if (this.otherReg >= 0) r[this.otherReg] = this.flipped ? here : there;
      if (this.idReg >= 0) r[this.idReg] = rowid;
      if (this.outgoingReg >= 0) r[this.outgoingReg] = this.outgoing ? 1 : 0;
      if (this.typeReg >= 0 || this.propsReg >= 0) {
        const t = this.byPosition[type]!;
        if (this.typeReg >= 0) r[this.typeReg] = t.name;
        if (this.propsReg >= 0) this.fetchProps(t, rowid);
      }
      return true;
    }
  }

  /**
   * A relationship's props: from the index's property maps where they know the row, else from its row, which they
   * know from then on.
   */
  private fetchProps(t: RelationshipType, rowid: number): void {
    const access = t.fetch;
    if (access === null) {
      this.r[this.propsReg] = null;
      return;
    }
    const maps = this.maps[t.position];
    if (maps) {
      const props = maps.get(rowid);
      if (props !== undefined) {
        this.r[this.propsReg] = props;
        return;
      }
    }
    let tab = this.tabs[t.position];
    if (tab === undefined) tab = this.tabs[t.position] = access.tree.cursor();
    // With the maps, a row they don't know is in the table as it is: they know every row the index holds ahead of it.
    tab.trusted = !!maps;
    writeRowidKey(this.keyBuf, 0, rowid);
    if (!tab.seek(this.keyBuf) || tab.compareKey(this.keyBuf) !== 0) throw new SmaltError('SMALT_CORRUPT', `graph index of ${access.tableName} references missing row ${rowid}`);
    access.load(tab, this.r);
    if (maps) {
      const read = this.r[this.propsReg]!;
      if (holdable(read)) maps.set(rowid, read);
    }
  }

  /** The next relationship from the types' tables and their endpoint indexes. */
  private nextStored(): boolean {
    const r = this.r;
    const skipLoops = this.direction === 'both';
    for (;;) {
      if (this.segment < 0 && !this.nextSegment()) return (this.done = true), false;
      const t = this.type!;
      const out = this.outgoing;
      let node: SqlValue;
      let other: SqlValue;
      let rowid: SqlValue;
      let props: SqlValue = null;
      const sub = this.sub;
      if (sub !== null) {
        if (!sub.next()) {
          sub.close();
          this.sub = null;
          if (!this.nextSegment()) return (this.done = true), false;
          continue;
        }
        node = r[out ? t.start : t.end]!;
        other = r[out ? t.end : t.start]!;
        rowid = r[t.rowid]!;
        if (this.propsReg >= 0 && t.props >= 0) props = r[t.props]!;
      } else {
        const rows = this.sorted!;
        if (this.at >= rows.length) {
          this.sorted = null;
          if (!this.nextSegment()) return (this.done = true), false;
          continue;
        }
        const row = rows[this.at++]!;
        node = this.flipped ? row[0]! : row[3]!;
        other = this.flipped ? row[3]! : row[0]!;
        rowid = row[1]!;
        props = row[2]!;
      }
      if (skipLoops && !out && node !== null && other !== null && compareValues(node, other) === 0) continue;
      if (this.nodeReg >= 0) r[this.nodeReg] = node;
      if (this.otherReg >= 0) r[this.otherReg] = other;
      if (this.typeReg >= 0) r[this.typeReg] = t.name;
      if (this.idReg >= 0) r[this.idReg] = rowid;
      if (this.outgoingReg >= 0) r[this.outgoingReg] = out ? 1 : 0;
      if (this.propsReg >= 0) r[this.propsReg] = props;
      return true;
    }
  }

  close(): void {
    this.sub?.close();
    this.sub = null;
    this.sorted = null;
    for (const t of this.types) {
      t.whole.close();
      t.byStart?.close();
      t.byEnd?.close();
    }
    for (let i = 0; i < this.tabs.length; i++) {
      this.tabs[i]?.close();
      this.tabs[i] = undefined;
    }
  }
}
