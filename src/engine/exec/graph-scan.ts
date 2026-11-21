/**
 * An edge table's rows with a given start (or end) node, from its graph's index (ADR 0040, section 2.1): the rows an
 * endpoint index gives for `start = x`, in the same order, without descending a B+tree. The other endpoint and the
 * rowid come from the index; a row's other columns are fetched by rowid.
 *
 * Whether the graph is indexed is asked once per execution, when the scan first opens: without an index (a reader, a
 * graph the index can't hold) the scan is the endpoint index's own scan. So a prepared statement stays valid when
 * the index comes or goes.
 */
import { SmaltError } from '../errors.js';
import type { BTreeCursor } from '../storage/btree.js';
import { ROWID_KEY_SIZE, writeRowidKey } from '../storage/key-codec.js';
import type { SqlValue } from '../values.js';
import type { Fn } from './expr.js';
import type { GraphLabels } from './graph-labels.js';
import { type GraphLists, ListCursor } from './graph-lists.js';
import { type GraphProps, holdable } from './graph-props.js';
import { type ExecState, type IndexScan, type Operator, RowidLookup, type TableAccess, rowidProbe } from './operators.js';

export class GraphIndexScan implements Operator {
  readonly children: Operator[] = [];
  private r!: SqlValue[];
  private lists: GraphLists | null = null;
  private epoch = -1;
  private readonly cursor = new ListCursor();
  private version = 0;
  private node = -1;
  private lastOther = 0;
  private lastRowid = -1;
  private done = true;
  /** Registers, found when the scan first opens (planning may add columns until then). */
  private keyReg = -2;
  private otherReg = -1;
  /** The row has columns the index doesn't: it is fetched. */
  private fetch = false;
  private tab: BTreeCursor | null = null;
  private readonly keyBuf = new Uint8Array(ROWID_KEY_SIZE);

  constructor(
    readonly access: TableAccess,
    /** The endpoint index's scan with the same probe: what runs when the graph isn't indexed. */
    readonly fallback: IndexScan,
    /** The graph's lists by this endpoint, or null when it isn't indexed. Asked once per execution. */
    readonly source: () => GraphLists | null,
    readonly state: ExecState,
    /** The table's position among the graph's edge tables. */
    readonly type: number,
    readonly key: Fn,
    readonly convert: (v: SqlValue) => SqlValue,
    readonly keyCol: number,
    readonly otherCol: number,
    readonly keyName: string,
  ) {}

  get detail(): string {
    return `SEARCH ${this.access.tableName} USING GRAPH INDEX (${this.keyName}=?)`;
  }

  open(r: SqlValue[]): void {
    this.r = r;
    if (this.epoch !== this.state.epoch) {
      this.epoch = this.state.epoch;
      this.lists = this.source();
    }
    const lists = this.lists;
    if (lists === null) {
      this.fallback.open(r);
      return;
    }
    if (this.keyReg === -2) {
      this.keyReg = -1;
      const d = this.access.decode;
      for (let i = 0; i < d.length; i += 2) {
        if (d[i] === this.keyCol) this.keyReg = d[i + 1]!;
        else if (d[i] === this.otherCol) this.otherReg = d[i + 1]!;
        else this.fetch = true;
      }
    }
    if (this.fetch && this.tab === null) this.tab = this.access.tree.cursor();
    this.lastRowid = -1;
    let v = this.convert(this.key(r));
    if (typeof v === 'bigint' && v >= 0n && v <= 2147483647n) v = Number(v);
    if (typeof v === 'number' && v >= 0 && v <= 2147483647 && Number.isInteger(v)) {
      this.node = v;
      this.done = false;
      this.version = lists.version;
      lists.seek(this.cursor, v, this.type);
    } else this.done = true;
  }

  next(): boolean {
    const lists = this.lists;
    if (lists === null) return this.fallback.next();
    if (this.done) return false;
    const c = this.cursor;
    // The lists changed under the scan (the statement writes the graph): go on from after the last entry given.
    if (this.version !== lists.version) {
      this.version = lists.version;
      if (this.lastRowid < 0) lists.seek(c, this.node, this.type);
      else lists.seek(c, this.node, this.type, this.lastOther, this.lastRowid + 1);
    }
    if (c.i >= c.end && !c.more()) return (this.done = true), false;
    const a = c.a;
    const i = c.i;
    if (a[i] !== this.type) return (this.done = true), false;
    const other = a[i + 1]!;
    const rowid = a[i + 2]!;
    c.i = i + 3;
    this.lastOther = other;
    this.lastRowid = rowid;
    const r = this.r;
    const access = this.access;
    if (this.fetch) {
      writeRowidKey(this.keyBuf, 0, rowid);
      const t = this.tab!;
      if (!t.seek(this.keyBuf) || t.compareKey(this.keyBuf) !== 0) throw new SmaltError('SMALT_CORRUPT', `graph index of ${access.tableName} references missing row ${rowid}`);
      access.load(t, r);
      return true;
    }
    if (this.keyReg >= 0) r[this.keyReg] = this.node;
    if (this.otherReg >= 0) r[this.otherReg] = other;
    if (access.rowidReg >= 0) {
      r[access.rowidReg] = rowid;
      for (const x of access.extraRowidRegs) r[x] = rowid;
    }
    return true;
  }

  close(): void {
    this.fallback.close();
    this.tab?.close();
    this.tab = null;
  }
}

/**
 * A graph's label index asked whether one node has one label (ADR 0040, section 5): the row its unique index on node
 * and label gives, or none, from the graph's label sets in memory, without descending a B+tree.
 *
 * It answers from memory only when the plan reads nothing of the row but its node and label, which the conditions
 * give: its rowid and any other column are in the table. Otherwise, and when the graph isn't indexed (asked once per
 * execution), it is the unique index's own scan.
 */
export class GraphLabelScan implements Operator {
  readonly children: Operator[] = [];
  private r!: SqlValue[];
  private labels: GraphLabels | null = null;
  private epoch = -1;
  /** Decided when the scan first opens (planning may add columns until then). */
  private covered: boolean | undefined;
  private nodeReg = -1;
  private labelReg = -1;
  private node = -1;
  private label = '';
  private found = false;

  constructor(
    readonly access: TableAccess,
    /** The unique index's scan with the same probe: what runs when the sets can't answer. */
    readonly fallback: IndexScan,
    /** The graph's label sets, or null when it isn't indexed. Asked once per execution. */
    readonly source: () => GraphLabels | null,
    readonly state: ExecState,
    readonly nodeKey: { readonly value: Fn; readonly convert: (v: SqlValue) => SqlValue },
    readonly labelKey: { readonly value: Fn; readonly convert: (v: SqlValue) => SqlValue },
    readonly nodeCol: number,
    readonly labelCol: number,
    /** The index's columns, in its order, for EXPLAIN. */
    readonly names: readonly string[],
  ) {}

  get detail(): string {
    return `SEARCH ${this.access.tableName} USING GRAPH INDEX (${this.names.map((n) => `${n}=?`).join(' AND ')})`;
  }

  open(r: SqlValue[]): void {
    this.r = r;
    if (this.covered === undefined) {
      const a = this.access;
      this.covered = a.rowidReg < 0;
      for (let i = 0; i < a.decode.length; i += 2) {
        if (a.decode[i] === this.nodeCol) this.nodeReg = a.decode[i + 1]!;
        else if (a.decode[i] === this.labelCol) this.labelReg = a.decode[i + 1]!;
        else this.covered = false;
      }
    }
    if (this.covered && this.epoch !== this.state.epoch) {
      this.epoch = this.state.epoch;
      this.labels = this.source();
    }
    const labels = this.covered ? this.labels : null;
    if (labels === null) {
      this.fallback.open(r);
      return;
    }
    let node = this.nodeKey.convert(this.nodeKey.value(r));
    if (typeof node === 'bigint' && node >= 0n && node <= 2147483647n) node = Number(node);
    const label = this.labelKey.convert(this.labelKey.value(r));
    // A node that is no id the index holds, or a label that is not text, is in no entry.
    this.found = typeof node === 'number' && node >= 0 && node <= 2147483647 && Number.isInteger(node) && typeof label === 'string' && labels.has(label, node);
    if (this.found) {
      this.node = node as number;
      this.label = label as string;
    }
  }

  next(): boolean {
    if (!this.covered || this.labels === null) return this.fallback.next();
    if (!this.found) return false;
    this.found = false;
    if (this.nodeReg >= 0) this.r[this.nodeReg] = this.node;
    if (this.labelReg >= 0) this.r[this.labelReg] = this.label;
    return true;
  }

  close(): void {
    this.fallback.close();
  }
}

/**
 * A node or edge table of an indexed graph asked for one row by its rowid (ADR 0041, section 2), by a plan that reads
 * its `props` and nothing else of the row but its rowid: a row the graph index's property maps know is given from
 * memory, without descending the table's B+tree.
 *
 * A row they don't know is read by the table's own rowid lookup, and they are told the props of the row it found.
 * The lookup also runs for a key the maps hold no row for (not a whole number from 0 to 2^31 - 1), and for every row
 * when the index holds no maps for the table (asked once per execution: the graph isn't indexed, or its maps didn't
 * fit).
 */
export class GraphNodeScan implements Operator {
  readonly children: Operator[] = [];
  private r!: SqlValue[];
  private maps: GraphProps | null = null;
  private epoch = -1;
  /** The register of the row's props; -1 until the scan first opens, or where the plan doesn't read them. */
  private propsReg = -1;
  private ready = false;
  /** What `next` does: nothing more, the row from memory, the lookup's row, or the lookup's row told to the maps. */
  private mode: 'none' | 'held' | 'lookup' | 'learn' = 'none';
  private rowid = -1;
  private props: SqlValue = null;
  /** The key of this opening, computed once: the lookup takes it from here. */
  private keyValue: SqlValue = null;
  /** The table's rowid lookup for the same key: what runs for a row the maps don't know. */
  readonly fallback: RowidLookup;

  constructor(
    readonly access: TableAccess,
    /** The table's property maps in its graph's index, or null when it holds none. Asked once per execution. */
    readonly source: () => GraphProps | null,
    readonly state: ExecState,
    readonly key: Fn,
    readonly propsCol: number,
  ) {
    this.fallback = new RowidLookup(access, [() => this.keyValue]);
  }

  get detail(): string {
    return `SEARCH ${this.access.tableName} USING GRAPH INDEX (rowid=?)`;
  }

  /** Once, when the scan first opens: what the plan reads of the row is known by then. */
  private prepare(): void {
    this.ready = true;
    const d = this.access.decode;
    // The planner offers this scan where the plan may read no column but the props: any other is in the table.
    let only = true;
    for (let i = 0; i < d.length; i += 2) {
      if (d[i] === this.propsCol) this.propsReg = d[i + 1]!;
      else only = false;
    }
    if (!only) this.propsReg = -1;
  }

  open(r: SqlValue[]): void {
    this.r = r;
    if (!this.ready) this.prepare();
    if (this.propsReg >= 0 && this.epoch !== this.state.epoch) {
      this.epoch = this.state.epoch;
      this.maps = this.source();
    }
    const maps = this.propsReg >= 0 ? this.maps : null;
    const key = (this.keyValue = this.key(r));
    // The key as the rowid lookup takes it. One the maps hold no row for is the lookup's.
    let k = maps === null ? null : rowidProbe(key);
    if (typeof k === 'bigint' && k >= 0n && k <= 2147483647n) k = Number(k);
    if (maps === null || typeof k !== 'number' || k < 0 || k > 2147483647 || !Number.isInteger(k)) {
      this.mode = 'lookup';
      this.fallback.open(r);
      return;
    }
    this.rowid = k;
    const props = maps.get(k);
    if (props === undefined) {
      this.mode = 'learn';
      this.fallback.open(r);
    } else {
      this.mode = 'held';
      this.props = props;
    }
  }

  next(): boolean {
    const mode = this.mode;
    if (mode === 'lookup') return this.fallback.next();
    if (mode === 'none') return false;
    const r = this.r;
    if (mode === 'learn') {
      // The lookup's one row, which the maps know from here on, or none. After it the lookup says there is no other.
      this.mode = 'lookup';
      if (!this.fallback.next()) return false;
      const props = r[this.propsReg]!;
      if (holdable(props)) this.maps!.set(this.rowid, props);
      return true;
    }
    this.mode = 'none';
    const a = this.access;
    if (a.rowidReg >= 0) {
      r[a.rowidReg] = this.rowid;
      for (const x of a.extraRowidRegs) r[x] = this.rowid;
    }
    r[this.propsReg] = this.props;
    return true;
  }

  close(): void {
    this.fallback.close();
  }
}
