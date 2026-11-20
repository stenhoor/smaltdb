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
import { type GraphLists, ListCursor } from './graph-lists.js';
import type { ExecState, IndexScan, Operator, TableAccess } from './operators.js';

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
