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
import type { BoundExpr } from '../plan/expr.js';
import type { MapCondition } from './codegen.js';
import { CODEGEN_HELPERS_FOR_FUSION, type Fn } from './expr.js';
import { type GraphLabels, type LabelNodes, LABEL_PAGE_WORD_BITS } from './graph-labels.js';
import { type GraphLists, ListCursor } from './graph-lists.js';
import { type GraphProps, type PropsCheck, holdable } from './graph-props.js';
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
 * A graph's label index asked for one label's entries: the rows its unique index on label and node gives for
 * `label = x`, in the same order (by node), from the label's set in the graph's index in memory, without reading the
 * index's B+tree.
 *
 * As {@link GraphLabelScan}, it answers from memory only when the plan reads nothing of an entry but its node and
 * its label. The planner offers it where the plan's scan names no other column; an entry's rowid is in the table,
 * so where the plan reads that, and when the graph isn't indexed (asked once per execution), it is the index's own
 * scan.
 *
 * Where the plan then finds each node's row in its node table by this node (`rows`), the nodes whose props that scan
 * says cannot pass the plan's conditions are not given: neither scan does anything more for them.
 */
export class GraphLabelEntries implements Operator {
  readonly children: Operator[] = [];
  private r!: SqlValue[];
  private labels: GraphLabels | null = null;
  private epoch = -1;
  /** Decided when the scan first opens (planning may add columns until then). */
  private covered: boolean | undefined;
  private nodeReg = -1;
  private labelReg = -1;
  private label = '';
  /** The label's set, the word the scan is at (counted from the first page's first), and the bit of it it goes on from. */
  private set: LabelNodes | undefined;
  private word = -1;
  private from = 32;
  /**
   * The scan that finds each node given here in its node table, by this node as its rowid, in an inner join of the
   * two (set by the planner): a node that scan says cannot pass the plan's conditions on its props is not given.
   */
  rows: GraphNodeScan | null = null;
  private ruledOut: ((rowid: number) => boolean) | null = null;

  constructor(
    readonly access: TableAccess,
    /** The unique index's scan with the same probe: what runs when the sets can't answer. */
    readonly fallback: IndexScan,
    /** The graph's label sets, or null when it isn't indexed. Asked once per execution. */
    readonly source: () => GraphLabels | null,
    readonly state: ExecState,
    readonly labelKey: { readonly value: Fn; readonly convert: (v: SqlValue) => SqlValue },
    readonly nodeCol: number,
    readonly labelCol: number,
    readonly labelName: string,
  ) {}

  get detail(): string {
    return `SEARCH ${this.access.tableName} USING GRAPH INDEX (${this.labelName}=?)${this.rows === null ? '' : ` CHECKING ${this.rows.access.tableName}`}`;
  }

  open(r: SqlValue[]): void {
    this.r = r;
    if (this.covered === undefined) {
      const a = this.access;
      this.covered = a.rowidReg < 0;
      for (let i = 0; i < a.decode.length; i += 2) {
        if (a.decode[i] === this.nodeCol) this.nodeReg = a.decode[i + 1]!;
        else this.labelReg = a.decode[i + 1]!;
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
    const label = this.labelKey.convert(this.labelKey.value(r));
    // A label that is not text is in no entry.
    this.set = typeof label === 'string' ? labels.setOf(label) : undefined;
    if (this.set !== undefined) {
      this.label = label as string;
      // From the word of the label's lowest node.
      this.word = (this.set.first >> 5) - 1;
      this.from = 32;
    }
    this.ruledOut = this.rows === null ? null : this.rows.ruledOut(r);
  }

  next(): boolean {
    if (!this.covered || this.labels === null) return this.fallback.next();
    const set = this.set;
    if (set === undefined) return false;
    const pages = set.pages;
    const out = this.ruledOut;
    const inPage = (1 << LABEL_PAGE_WORD_BITS) - 1;
    let word = this.word;
    let page = pages[word >> LABEL_PAGE_WORD_BITS];
    // The word, and the word of the label's highest node, are read again each time: the statement may have written
    // the label since the last node was given.
    const end = set.last >> 5;
    let bits = page === undefined || this.from > 31 ? 0 : page[word & inPage]! & (-1 << this.from);
    for (;;) {
      while (bits === 0) {
        // The next word with a node, up to the highest node's.
        if (++word > end) return (this.set = undefined), false;
        page = pages[word >> LABEL_PAGE_WORD_BITS];
        // A page no node of the label is in: on from its last word.
        if (page === undefined) word |= inPage;
        else bits = page[word & inPage]!;
      }
      const b = 31 - Math.clz32(bits & -bits);
      bits &= bits - 1;
      const node = word * 32 + b;
      if (out !== null && out(node)) continue;
      this.word = word;
      this.from = b + 1;
      if (this.nodeReg >= 0) this.r[this.nodeReg] = node;
      if (this.labelReg >= 0) this.r[this.labelReg] = this.label;
      return true;
    }
  }

  close(): void {
    this.fallback.close();
  }
}

/**
 * A node or edge table of an indexed graph asked for one row by its rowid (ADR 0041, section 2), by a plan that reads
 * its `props` and nothing else of the row but its rowid: a row the graph index's property maps know is given from
 * memory, without descending the table's B+tree. Where nothing reads the props either (an output of a nested plan
 * that is dropped), a row they know is there, and that is all the plan asks.
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
  /** Whether the maps can answer: the plan reads nothing of the row but its rowid and, where it does, its props. */
  private inMemory = false;
  private ready = false;
  /** What `next` does: nothing more, the row from memory, the lookup's row, or the lookup's row told to the maps. */
  private mode: 'none' | 'held' | 'lookup' | 'learn' = 'none';
  private rowid = -1;
  private props: SqlValue = null;
  /** The key of this opening, computed once: the lookup takes it from here. */
  private keyValue: SqlValue = null;
  /** The table's rowid lookup for the same key: what runs for a row the maps don't know. */
  readonly fallback: RowidLookup;
  /**
   * Conditions on keys of the row's props that the plan's conjuncts on it need to be true (`mapKeyConditions`,
   * codegen.ts), set by the planner for the scan that gives this one its rowids (`GraphLabelEntries.rows`).
   */
  conditions: readonly MapCondition[] = [];

  constructor(
    readonly access: TableAccess,
    /** The table's property maps in its graph's index, or null when it holds none. Asked once per execution. */
    readonly source: () => GraphProps | null,
    readonly state: ExecState,
    readonly key: Fn,
    readonly propsCol: number,
    /** The key as the plan has it (lets the planner tell which scan gives it). */
    readonly keyExpr?: BoundExpr,
  ) {
    this.fallback = new RowidLookup(access, [() => this.keyValue]);
  }

  get detail(): string {
    return `SEARCH ${this.access.tableName} USING GRAPH INDEX (rowid=?)`;
  }

  /** Once, when the scan first opens: what the plan reads of the row is known by then. */
  private prepare(): void {
    this.ready = true;
    // The columns the plan still reads (`TableAccess.reads`): the lookup decodes those, and no others. The planner
    // offers this scan where the plan may read no column but the props: any other is in the table.
    const d = this.access.reads();
    let only = true;
    for (let i = 0; i < d.length; i += 2) {
      if (d[i] === this.propsCol) this.propsReg = d[i + 1]!;
      else only = false;
    }
    this.inMemory = only;
    if (!only) this.propsReg = -1;
  }

  /** The maps, where they can answer: asked for once per execution. */
  private held(): GraphProps | null {
    if (!this.ready) this.prepare();
    if (!this.inMemory) return null;
    if (this.epoch !== this.state.epoch) {
      this.epoch = this.state.epoch;
      this.maps = this.source();
    }
    return this.maps;
  }

  /**
   * For the scan that gives this one its rowids: what tells, of a rowid, that the row cannot pass the plan's
   * conditions on its props (`conditions`), read from the maps where the row's map lies, so that scan does not give
   * it and this one is not opened for it. A row the maps don't know is never ruled out. Null when the maps cannot
   * answer. Asked for when that scan opens: a parameter a condition compares with has its value of this execution
   * (`r`).
   */
  ruledOut(r: SqlValue[]): ((rowid: number) => boolean) | null {
    const maps = this.held();
    if (maps === null) return null;
    const checks = this.conditions.map((c): PropsCheck => ({ key: c.key, op: c.op, lit: c.param ? CODEGEN_HELPERS_FOR_FUSION.probeValue(r[c.param.index]!, c.param.numbers, c.param.text) : c.lit }));
    return (rowid) => maps.rulesOut(rowid, checks);
  }

  open(r: SqlValue[]): void {
    this.r = r;
    const maps = this.held();
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
    if (this.propsReg < 0) {
      // Nothing reads the props: a row the maps know is there, and no copy of its props is made.
      if (maps.known(k)) this.mode = 'held';
      else {
        this.mode = 'learn';
        this.fallback.open(r);
      }
      return;
    }
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
      // The props as the lookup decoded them, or read from its row where the plan reads none.
      const props = this.propsReg >= 0 ? r[this.propsReg]! : this.fallback.column(this.propsCol);
      if (holdable(props)) this.maps!.set(this.rowid, props);
      return true;
    }
    this.mode = 'none';
    const a = this.access;
    if (a.rowidReg >= 0) {
      r[a.rowidReg] = this.rowid;
      for (const x of a.extraRowidRegs) r[x] = this.rowid;
    }
    if (this.propsReg >= 0) r[this.propsReg] = this.props;
    return true;
  }

  close(): void {
    this.fallback.close();
  }
}
