import { SmaltError } from '../errors.js';
import { type BTree, type BTreeCursor, leafCell } from '../storage/btree.js';
import { compareKeyAt } from '../util/bytes.js';
import { type Chunk, type ColumnStore, ROW_GROUP_ROWS, chunkValue, zoneMayMatch } from '../storage/columnar.js';
import { KeyEncoder, type KeyColumn, KEY_AFTER_NULL, ROWID_KEY_SIZE, decodeKey, readIndexRowid, readRowidKey, rowidSuffixStart, writeRowidKey } from '../storage/key-codec.js';
import { type RecordReader, decodeTagged, decodeUtf8, readInt64 } from '../storage/record.js';
import { type LoaderHelpers, type LoaderSpec, type ScanState, codegenEnabled, generateLoader } from './codegen.js';

const LOADER_HELPERS: LoaderHelpers = { readInt64, utf8: decodeUtf8, tagged: decodeTagged, rowid: readRowidKey };
import { Collation, type SqlValue, compareValues } from '../values.js';
import { applyNumericAffinity, hashKey, hashKeyMulti, toNumeric, truthy } from './convert.js';
import { type Fn, isTrue } from './expr.js';
import { type AggregateFunction, type AggregateState, MinMaxState } from './functions.js';
import { deletedBitmap, rowidsOf, zoneOf } from './columnar-table.js';
import { type Run, RunReader, RunWriter, type SpillArea, SpillRestart, partitionHash, rowBytes, valueBytes } from './spill.js';

/**
 * Pull-based physical operators. All operators of a statement share one register file `r`
 * (SqlValue[]); an operator's output is the set of registers it (or its children) wrote.
 * Operators are re-openable: a nested-loop join re-opens its inner side per outer row.
 */
export interface Operator {
  open(r: SqlValue[]): void;
  next(): boolean;
  close(): void;
  /** EXPLAIN QUERY PLAN line for this node. */
  readonly detail: string;
  readonly children: Operator[];
}

/** Per-execution state shared by a statement's operators. */
export interface ExecState {
  /** Incremented on every statement execution; cached build sides compare against it. */
  epoch: number;
}

// ------------------------------------------------------------------ table access

/** How a table's rows are decoded into registers. Mutable during planning (columns are added as referenced). */
export class TableAccess {
  /** [column index, register] pairs to decode. */
  readonly decode: number[] = [];
  private readonly decoded = new Set<number>();
  rowidReg = -1;
  /** The table scanned (a TEMP table and a main table may share `tableName`). */
  table: import('../catalog/schema.js').TableSchema | null = null;

  constructor(
    readonly tree: BTree,
    readonly reader: RecordReader,
    readonly tableName: string,
    /** Column index of the INTEGER PRIMARY KEY alias, or -1. */
    readonly rowidAlias: number,
  ) {}

  /** Ensure column `col` is decoded into register `reg`. */
  use(col: number, reg: number): void {
    if (col === this.rowidAlias) {
      this.useRowid(reg);
      return;
    }
    if (this.decoded.has(col)) return;
    this.decoded.add(col);
    this.decode.push(col, reg);
  }

  useRowid(reg: number): void {
    if (this.rowidReg === -1) this.rowidReg = reg;
    else if (this.rowidReg !== reg) this.extraRowidRegs.push(reg);
  }

  readonly extraRowidRegs: number[] = [];

  /** Generated decoder (built on first use, once the decode list is final). */
  private fast: ((c: BTreeCursor, r: SqlValue[]) => boolean) | null | undefined;

  /** Load the cursor's current row into registers. */
  load(c: BTreeCursor, r: SqlValue[]): void {
    let fast = this.fast;
    if (fast === undefined) fast = this.fast = this.buildLoader();
    if (fast !== null && fast(c, r)) return;
    this.loadGeneric(c, r);
  }

  /** Layout + decode list for generated decoders (call once the decode list is final). */
  loaderSpec(): LoaderSpec {
    const layout = this.reader.layout;
    return {
      types: layout.types,
      slots: layout.full.slot,
      fixedSize: layout.full.fixedSize,
      varCount: layout.full.varCount,
      decode: this.decode,
      rowidRegs: this.rowidReg >= 0 ? [this.rowidReg, ...this.extraRowidRegs] : [],
    };
  }

  private buildLoader(): ((c: BTreeCursor, r: SqlValue[]) => boolean) | null {
    if (!codegenEnabled()) return null;
    return generateLoader(this.loaderSpec(), LOADER_HELPERS) as unknown as (c: BTreeCursor, r: SqlValue[]) => boolean;
  }

  /** Generic decode of the cell at `off` in leaf `page` (for generated scans' slow path). */
  loadCell(page: { bytes: Uint8Array; view: DataView }, off: number, r: SqlValue[]): void {
    const d = this.decode;
    const cell = leafCell(page.bytes, off);
    const ko = cell.keyOffset;
    if (d.length > 0) {
      let bytes = page.bytes;
      let start = ko + cell.keyLength;
      let len = cell.valueLength;
      if (cell.overflow) {
        bytes = this.tree.readValue(page, off);
        start = 0;
        len = bytes.length;
      }
      const rd = this.reader;
      rd.reset(bytes, start, len);
      for (let i = 0; i < d.length; i += 2) r[d[i + 1]] = rd.column(d[i]);
    }
    if (this.rowidReg >= 0) {
      const id = readRowidKey(page.bytes, ko);
      r[this.rowidReg] = id;
      for (const x of this.extraRowidRegs) r[x] = id;
    }
  }

  /** Generic decoder (always correct; used for overflow values, short records, and without codegen). */
  loadGeneric(c: BTreeCursor, r: SqlValue[]): void {
    const d = this.decode;
    if (d.length > 0) {
      c.loadValue();
      const rd = this.reader;
      rd.reset(c.valueBytes, c.valueOffset, c.valueLength);
      for (let i = 0; i < d.length; i += 2) r[d[i + 1]] = rd.column(d[i]);
    }
    if (this.rowidReg >= 0) {
      c.loadKey();
      const id = readRowidKey(c.keyBytes, c.keyOffset);
      r[this.rowidReg] = id;
      for (const x of this.extraRowidRegs) r[x] = id;
    }
  }

  /** Registers written by load() (used to null-fill for outer joins and to save rows). */
  registers(): number[] {
    const regs: number[] = [];
    for (let i = 1; i < this.decode.length; i += 2) regs.push(this.decode[i]);
    if (this.rowidReg >= 0) regs.push(this.rowidReg, ...this.extraRowidRegs);
    return regs;
  }
}

/** Convert a probe value for a rowid comparison: number, or 'text' (sorts above all numbers), or null. */
function rowidProbe(v: SqlValue): number | bigint | 'text' | null {
  if (v === null) return null;
  const n = applyNumericAffinity(v);
  if (typeof n === 'number' || typeof n === 'bigint') return n;
  return 'text';
}

const I64_MAX_N = 9223372036854775807;

/** Full scan or rowid range scan over a table B+tree. */
export class TableScan implements Operator {
  readonly children: Operator[] = [];
  private cursor: BTreeCursor | null = null;
  private r!: SqlValue[];
  private started = false;
  private done = false;
  private hiVal: number | bigint | null = null;
  private hiIncl = true;
  private readonly keyBuf = new Uint8Array(ROWID_KEY_SIZE);

  constructor(
    readonly access: TableAccess,
    readonly lo?: { fn: Fn; inclusive: boolean },
    readonly hi?: { fn: Fn; inclusive: boolean },
    public reverse = false,
  ) {}

  get detail(): string {
    const t = this.access.tableName;
    if (this.lo || this.hi) return `SEARCH ${t} USING INTEGER PRIMARY KEY (rowid${this.lo ? '>' : ''}${this.lo && this.hi ? '? AND rowid' : ''}${this.hi ? '<' : ''}?)`;
    return `SCAN ${t}`;
  }

  open(r: SqlValue[]): void {
    this.r = r;
    this.started = false;
    this.done = false;
    if (this.cursor === null) this.cursor = this.access.tree.cursor();
  }

  next(): boolean {
    if (this.done) return false;
    const c = this.cursor!;
    let ok: boolean;
    if (!this.started) {
      this.started = true;
      ok = this.start(c);
    } else ok = this.reverse ? c.prev() : c.next();
    if (!ok) return this.finish();
    if (this.hiVal !== null && !this.reverse) {
      c.loadKey();
      const id = readRowidKey(c.keyBytes, c.keyOffset);
      if (this.hiIncl ? id > this.hiVal : id >= this.hiVal) return this.finish();
    }
    if (this.reverse && this.loVal !== null) {
      c.loadKey();
      const id = readRowidKey(c.keyBytes, c.keyOffset);
      if (this.loIncl ? id < this.loVal : id <= this.loVal) return this.finish();
    }
    this.access.load(c, this.r);
    return true;
  }

  private loVal: number | bigint | null = null;
  private loIncl = true;

  private start(c: BTreeCursor): boolean {
    this.hiVal = null;
    this.loVal = null;
    let loKey: number | bigint | null = null;
    if (this.lo) {
      const p = rowidProbe(this.lo.fn(this.r));
      if (p === null || p === 'text') return false;
      this.loVal = p;
      this.loIncl = this.lo.inclusive;
      loKey = p;
    }
    if (this.hi) {
      const p = rowidProbe(this.hi.fn(this.r));
      if (p === null) return false;
      if (p !== 'text') {
        this.hiVal = p;
        this.hiIncl = this.hi.inclusive;
      }
    }
    if (this.reverse) {
      if (this.hiVal !== null) {
        // I64_MAX_N is 2^63 as a double, past every rowid: clamp to the largest rowid instead.
        const target = typeof this.hiVal === 'number' ? (this.hiVal >= I64_MAX_N ? 9223372036854775807n : Math.floor(this.hiVal)) : this.hiVal;
        writeRowidKey(this.keyBuf, 0, target);
        const found = c.seek(this.keyBuf);
        if (!found) {
          if (!c.last()) return false;
        }
        // Step back past keys beyond the bound.
        for (;;) {
          c.loadKey();
          const id = readRowidKey(c.keyBytes, c.keyOffset);
          if (this.hiIncl ? id <= this.hiVal : id < this.hiVal) break;
          if (!c.prev()) return false;
        }
        return true;
      }
      return c.last();
    }
    if (loKey !== null) {
      // Ceil for fractional bounds; exclusive integer bounds are handled by skipping equal keys.
      let start: number | bigint = loKey;
      if (typeof start === 'number') {
        if (start >= I64_MAX_N) return false; // 2^63 or more: past every rowid
        start = Math.max(Math.ceil(start), -9223372036854775808);
      }
      writeRowidKey(this.keyBuf, 0, start);
      if (!c.seek(this.keyBuf)) return false;
      if (!this.lo!.inclusive) {
        c.loadKey();
        // eslint-disable-next-line eqeqeq
        if (readRowidKey(c.keyBytes, c.keyOffset) == loKey && !c.next()) return false;
      }
      return true;
    }
    return c.first();
  }

  private finish(): boolean {
    this.done = true;
    return false;
  }

  close(): void {
    this.cursor?.close();
    this.cursor = null;
  }
}

/** Rowid equality lookup (one or several keys). */
export class RowidLookup implements Operator {
  readonly children: Operator[] = [];
  private cursor: BTreeCursor | null = null;
  private r!: SqlValue[];
  private keys: (number | bigint)[] = [];
  private i = 0;
  private readonly keyBuf = new Uint8Array(ROWID_KEY_SIZE);

  constructor(
    readonly access: TableAccess,
    readonly keyFns: Fn[],
  ) {}

  get detail(): string {
    return `SEARCH ${this.access.tableName} USING INTEGER PRIMARY KEY (rowid=?)`;
  }

  open(r: SqlValue[]): void {
    this.r = r;
    if (this.cursor === null) this.cursor = this.access.tree.cursor();
    this.keys = [];
    for (const f of this.keyFns) {
      const p = rowidProbe(f(r));
      if (p === null || p === 'text') continue;
      // A REAL equals a rowid only when it is an integer in the int64 range (I64_MAX_N rounds to 2^63).
      if (typeof p === 'number' && (!Number.isInteger(p) || p >= I64_MAX_N || p < -I64_MAX_N)) continue;
      this.keys.push(p);
    }
    if (this.keys.length > 1) {
      this.keys.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      // eslint-disable-next-line eqeqeq
      this.keys = this.keys.filter((k, j) => j === 0 || k != this.keys[j - 1]);
    }
    this.i = 0;
  }

  next(): boolean {
    const c = this.cursor!;
    while (this.i < this.keys.length) {
      const k = this.keys[this.i++];
      writeRowidKey(this.keyBuf, 0, k);
      if (c.seek(this.keyBuf) && c.compareKey(this.keyBuf) === 0) {
        this.access.load(c, this.r);
        return true;
      }
    }
    return false;
  }

  close(): void {
    this.cursor?.close();
    this.cursor = null;
  }
}

export interface IndexScanSpec {
  indexName: string;
  tree: BTree;
  /** Key column options (desc, collation) for every index column. */
  columns: { desc: boolean; collation: Collation }[];
  /** Equality probes for a prefix of the index columns. */
  eq: Fn[];
  /** Optional range on the next column (ASC columns only). */
  lo?: { fn: Fn; inclusive: boolean };
  hi?: { fn: Fn; inclusive: boolean };
  /** Converts probe values with the indexed column's affinity. */
  convert: ((v: SqlValue) => SqlValue)[];
  /**
   * Per index column: the table column it stores, or -1 when it cannot supply the column's value
   * (an expression, or text stored in a non-BINARY collated form). Enables index-only scans.
   */
  keyColumns?: number[];
}

/** Index range/equality scan followed by a table lookup per entry. */
export class IndexScan implements Operator {
  readonly children: Operator[] = [];
  private idx: BTreeCursor | null = null;
  private tab: BTreeCursor | null = null;
  private r!: SqlValue[];
  private started = false;
  private done = false;
  private upper: Uint8Array | null = null;
  private lower: Uint8Array | null = null;
  private readonly enc = new KeyEncoder();
  private readonly keyBuf = new Uint8Array(ROWID_KEY_SIZE);

  /**
   * Set by the planner when the consumer cannot observe row order (an order-insensitive aggregate,
   * UPDATE target collection). Rows are then fetched in batches sorted by rowid, so consecutive
   * fetches walk the table forward instead of descending from the root for each row.
   */
  unordered = false;
  private batch: Float64Array | null = null;
  private batchBig: (number | bigint)[] | null = null;
  private bn = 0;
  private bi = 0;
  private idxDone = false;

  constructor(
    readonly access: TableAccess,
    readonly spec: IndexScanSpec,
  ) {}

  get detail(): string {
    const cols = this.spec.eq.length;
    const parts: string[] = [];
    for (let i = 0; i < cols; i++) parts.push('=?');
    if (this.spec.lo || this.spec.hi) parts.push('range');
    return `SEARCH ${this.access.tableName} USING ${this.covering() ? 'COVERING ' : ''}INDEX ${this.spec.indexName} (${parts.length ? parts.join(',') : 'scan'})`;
  }

  /**
   * Index-only scan plan (like SQLite's covering indexes): when every column the query reads from
   * this table is stored in the index key, values come from the key and the row is never fetched.
   * Decided once the decode list is final (first open). Null = not covering.
   */
  private cover: { keyPos: number[]; regs: number[]; keyCols: KeyColumn[] } | null | undefined;
  private covering(): boolean {
    if (this.cover === undefined) {
      const kc = this.spec.keyColumns;
      const d = this.access.decode;
      let plan: { keyPos: number[]; regs: number[]; keyCols: KeyColumn[] } | null = kc ? { keyPos: [], regs: [], keyCols: this.spec.columns } : null;
      for (let i = 0; plan && i < d.length; i += 2) {
        const pos = kc!.indexOf(d[i]);
        if (pos < 0) plan = null;
        else {
          plan.keyPos.push(pos);
          plan.regs.push(d[i + 1]);
        }
      }
      this.cover = plan;
    }
    return this.cover !== null;
  }

  open(r: SqlValue[]): void {
    this.r = r;
    this.started = false;
    this.done = false;
    this.bn = 0;
    this.bi = 0;
    this.idxDone = false;
    if (this.idx === null) this.idx = this.spec.tree.cursor();
    if (this.tab === null && !this.covering()) this.tab = this.access.tree.cursor();
  }

  /** Compute bound keys; returns false if the scan is empty. */
  private bounds(): boolean {
    const s = this.spec;
    const e = this.enc.reset();
    let i = 0;
    for (; i < s.eq.length; i++) {
      const v = s.convert[i](s.eq[i](this.r));
      if (v === null) return false;
      e.add(v, s.columns[i]);
    }
    const prefix = e.finish();
    const ff = (b: Uint8Array): Uint8Array => {
      const out = new Uint8Array(b.length + 1);
      out.set(b);
      out[b.length] = 0xff;
      return out;
    };
    this.lower = prefix;
    this.upper = ff(prefix);
    if (s.lo || s.hi) {
      const col = s.columns[i];
      // Skip NULLs (they sort first) unless a lower bound is given.
      if (s.lo) {
        const v = s.convert[i](s.lo.fn(this.r));
        if (v === null) return false;
        const withV = concat(prefix, this.enc.reset().add(v, col).finish());
        this.lower = s.lo.inclusive ? withV : ff(withV);
      } else {
        this.lower = concat(prefix, KEY_AFTER_NULL);
      }
      if (s.hi) {
        const v = s.convert[i](s.hi.fn(this.r));
        if (v === null) return false;
        const withV = concat(prefix, this.enc.reset().add(v, col).finish());
        this.upper = s.hi.inclusive ? ff(withV) : withV;
      }
    }
    return true;
  }

  next(): boolean {
    if (this.done) return false;
    if (this.unordered && !this.covering()) return this.nextSorted();
    const c = this.idx!;
    let ok: boolean;
    if (!this.started) {
      this.started = true;
      if (!this.bounds()) return (this.done = true), false;
      ok = c.seek(this.lower!);
    } else ok = c.next();
    if (!ok) return (this.done = true), false;
    c.loadKey();
    const kb = c.keyBytes;
    if (compareKeyAt(this.upper!, kb, c.keyOffset, c.keyLength) <= 0) return (this.done = true), false;
    // The rowid is the key's suffix (see key-codec).
    const end = c.keyOffset + c.keyLength;
    const rowid = readIndexRowid(kb, end);
    const cover = this.cover;
    if (cover) {
      const r = this.r;
      if (cover.regs.length) {
        const vals = decodeKey(kb.subarray(c.keyOffset, rowidSuffixStart(kb, end)), cover.keyCols);
        for (let i = 0; i < cover.regs.length; i++) r[cover.regs[i]] = vals[cover.keyPos[i]];
      }
      const a = this.access;
      if (a.rowidReg >= 0) {
        r[a.rowidReg] = rowid;
        for (const x of a.extraRowidRegs) r[x] = rowid;
      }
      return true;
    }
    writeRowidKey(this.keyBuf, 0, rowid);
    const t = this.tab!;
    if (!t.seek(this.keyBuf) || t.compareKey(this.keyBuf) !== 0) {
      throw new SmaltError('SMALT_CORRUPT', `index ${this.spec.indexName} references missing row ${rowid}`);
    }
    this.access.load(t, this.r);
    return true;
  }

  close(): void {
    this.idx?.close();
    this.tab?.close();
    this.idx = null;
    this.tab = null;
  }

  /** Unordered mode: next row from the current rowid-sorted batch. */
  private nextSorted(): boolean {
    if (this.bi >= this.bn && (this.idxDone || !this.fillBatch())) return (this.done = true), false;
    const rowid = this.batchBig !== null ? this.batchBig[this.bi] : this.batch![this.bi];
    this.bi++;
    writeRowidKey(this.keyBuf, 0, rowid);
    const t = this.tab!;
    // Rowids ascend within a batch: walk forward from the previous row's leaf.
    const ok = this.bi === 1 ? t.seek(this.keyBuf) : t.seekForward(this.keyBuf);
    if (!ok || t.compareKey(this.keyBuf) !== 0) {
      throw new SmaltError('SMALT_CORRUPT', `index ${this.spec.indexName} references missing row ${rowid}`);
    }
    this.access.load(t, this.r);
    return true;
  }

  /** Read up to SORT_BATCH matching rowids from the index and sort them; false when none remain. */
  private fillBatch(): boolean {
    const c = this.idx!;
    if (this.batch === null) this.batch = new Float64Array(SORT_BATCH);
    const batch = this.batch;
    let big: (number | bigint)[] | null = null;
    let n = 0;
    while (n < SORT_BATCH) {
      let ok: boolean;
      if (!this.started) {
        this.started = true;
        if (!this.bounds()) {
          this.idxDone = true;
          break;
        }
        ok = c.seek(this.lower!);
      } else ok = c.next();
      if (!ok) {
        this.idxDone = true;
        break;
      }
      c.loadKey();
      if (compareKeyAt(this.upper!, c.keyBytes, c.keyOffset, c.keyLength) <= 0) {
        this.idxDone = true;
        break;
      }
      const rowid = readIndexRowid(c.keyBytes, c.keyOffset + c.keyLength);
      if (big === null && typeof rowid === 'bigint') big = Array.from(batch.subarray(0, n));
      if (big !== null) big.push(rowid);
      else batch[n] = rowid as number;
      n++;
    }
    if (big !== null) big.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    else batch.subarray(0, n).sort();
    this.batchBig = big;
    this.bn = n;
    this.bi = 0;
    return n > 0;
  }
}

/** Rowids fetched per sorted batch in unordered index scans. */
const SORT_BATCH = 4096;

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// ------------------------------------------------------------------ columnar scan

/** A zone-map test pushed into a columnar scan: `column op value` (value constant per open). */
export interface ZonePredicate {
  col: number;
  op: string;
  value: Fn;
  /** TEXT comparisons use BINARY order (zone maps hold BINARY min/max). */
  binaryText: boolean;
  /** For EXPLAIN. */
  label: string;
}

/**
 * Full scan of a columnar materialized view: row groups whose zone maps rule out a pushed-down
 * comparison are skipped without reading any chunk; only the referenced columns are decoded.
 * Filters above still apply every predicate (zone maps only prune).
 */
/**
 * One execution of a column scan: its segments, zone-map comparison values and deleted rowids.
 * Shared by the interpreted {@link ColumnScan} and the generated loops (planner columnarHelpers).
 */
export class ColumnScanRun {
  readonly store: ColumnStore;
  private readonly zoneVals: SqlValue[];
  private readonly deleted: Set<number | bigint> | null;

  constructor(
    private readonly scan: ColumnScan,
    r: SqlValue[],
  ) {
    this.store = scan.store();
    this.zoneVals = scan.zones.map((z) => z.value(r));
    this.deleted = scan.segments ? scan.segments.deleted() : null;
  }

  /** False when row group `rg`'s zone maps rule it out. */
  keep(rg: number): boolean {
    const zones = this.scan.zones;
    if (zones.length === 0) return true;
    const m = this.store.meta(rg);
    for (let k = 0; k < zones.length; k++) {
      const z = zones[k];
      if (!zoneMayMatch(zoneOf(m, rg, z.col), m.rows, z.op, this.zoneVals[k], z.binaryText)) return false;
    }
    return true;
  }

  /** Columnar table: per-row deleted flags of row group `rg` (null: none deleted, or a view). */
  deletedFlags(rg: number): Uint8Array | null {
    const seg = this.scan.segments;
    return seg === null ? null : deletedBitmap(this.store, rg, seg.rowidCol, this.deleted);
  }

  /** Columnar table: the stored rowids of row group `rg` (a view's are implicit: null). */
  rowids(rg: number): ArrayLike<SqlValue> | null {
    const seg = this.scan.segments;
    return seg === null ? null : rowidsOf(this.store, rg, seg.rowidCol);
  }
}

export class ColumnScan implements Operator {
  readonly children: Operator[] = [];
  private r!: SqlValue[];
  private run!: ColumnScanRun;
  private rg = -1;
  private rgCount = 0;
  private i = 0;
  private n = 0;
  private base = 0;
  private chunks: Chunk[] = [];
  /** The current row group's deleted flags and stored rowids (columnar table). */
  private gone: Uint8Array | null = null;
  private rowids: ArrayLike<SqlValue> | null = null;

  constructor(
    readonly access: TableAccess,
    readonly store: () => ColumnStore,
    readonly zones: ZonePredicate[],
    /** Segments of a columnar table (explicit rowid column, deletions); absent for materialized views. */
    readonly segments: ColumnarSegments | null = null,
  ) {}

  get detail(): string {
    return `SCAN ${this.access.tableName} (columnar${this.zoneText()})`;
  }

  private zoneText(): string {
    return this.zones.length ? `, zone maps: ${this.zones.map((z) => z.label).join(' AND ')}` : '';
  }

  /** EXPLAIN text when this scan is fused into generated code with filters and `what`. */
  fusedLabel(what: string): string {
    return `SCAN ${this.access.tableName} (columnar, fused scan + filter + ${what}${this.zoneText()})`;
  }

  open(r: SqlValue[]): void {
    this.r = r;
    this.run = new ColumnScanRun(this, r);
    this.rg = -1;
    this.rgCount = this.run.store.rowGroups;
    this.i = this.n = 0;
    this.gone = null;
    this.rowids = null;
  }

  next(): boolean {
    const d = this.access.decode;
    const a = this.access;
    const run = this.run;
    for (;;) {
      while (this.i >= this.n) {
        if (++this.rg >= this.rgCount) return false;
        if (!run.keep(this.rg)) continue;
        const chunks = this.chunks;
        chunks.length = 0;
        for (let k = 0; k < d.length; k += 2) chunks.push(run.store.chunk(this.rg, d[k]));
        this.n = run.store.meta(this.rg).rows;
        this.i = 0;
        this.base = this.rg * ROW_GROUP_ROWS;
        this.gone = run.deletedFlags(this.rg);
        this.rowids = a.rowidReg >= 0 ? run.rowids(this.rg) : null;
      }
      const i = this.i++;
      if (this.gone !== null && this.gone[i] === 1) continue;
      const r = this.r;
      const chunks = this.chunks;
      for (let k = 0; k < d.length; k += 2) r[d[k + 1]] = chunkValue(chunks[k >>> 1], i);
      if (a.rowidReg >= 0) {
        const id = this.rowids !== null ? this.rowids[i] : this.base + i + 1;
        r[a.rowidReg] = id;
        for (const x of a.extraRowidRegs) r[x] = id;
      }
      return true;
    }
  }

  close(): void {}
}

/** A columnar table's segment layout, for scans of it. */
export interface ColumnarSegments {
  /** Column index of the stored rowids (= number of table columns). */
  rowidCol: number;
  /** Rowids hidden in the segments (read when a scan opens). */
  deleted: () => Set<number | bigint> | null;
}

/**
 * Full scan of a columnar table: the delta store's rows, then the segments' live rows (ADR 0010).
 * Not in rowid order.
 */
export class ColumnarTableScan implements Operator {
  readonly children: Operator[] = [];
  private r!: SqlValue[];
  private inSegments = false;

  constructor(
    readonly delta: TableScan,
    readonly segments: ColumnScan,
  ) {}

  get access(): TableAccess {
    return this.delta.access;
  }

  get detail(): string {
    return this.segments.detail.replace('(columnar', '(columnar table: delta + segments');
  }

  /** EXPLAIN text when fused into generated code with filters and `what`. */
  fusedLabel(what: string): string {
    return this.segments.fusedLabel(what).replace('(columnar', '(columnar table: delta + segments');
  }

  open(r: SqlValue[]): void {
    this.r = r;
    this.inSegments = false;
    this.delta.open(r);
  }

  next(): boolean {
    if (!this.inSegments) {
      if (this.delta.next()) return true;
      this.delta.close();
      this.inSegments = true;
      this.segments.open(this.r);
    }
    return this.segments.next();
  }

  close(): void {
    this.delta.close();
    this.segments.close();
  }
}

// ------------------------------------------------------------------ relational operators

export class Filter implements Operator {
  readonly children: Operator[];
  private r!: SqlValue[];
  constructor(
    readonly child: Operator,
    readonly pred: Fn,
    /** The bound predicate (lets the planner fuse scan + filter + aggregate into generated code). */
    readonly expr?: import('../plan/expr.js').BoundExpr,
  ) {
    this.children = [child];
  }
  get detail(): string {
    return '';
  }
  open(r: SqlValue[]): void {
    this.r = r;
    this.child.open(r);
  }
  next(): boolean {
    const r = this.r;
    while (this.child.next()) if (isTrue(this.pred(r))) return true;
    return false;
  }
  close(): void {
    this.child.close();
  }
}

/** `SELECT count(*) FROM t`: sums per-leaf cell counts instead of visiting rows. */
export class CountRows implements Operator {
  readonly children: Operator[] = [];
  private r!: SqlValue[];
  private done = false;
  constructor(
    readonly tree: BTree,
    readonly tableName: string,
    readonly outReg: number,
  ) {}
  get detail(): string {
    return `SCAN ${this.tableName} (count)`;
  }
  open(r: SqlValue[]): void {
    this.r = r;
    this.done = false;
  }
  next(): boolean {
    if (this.done) return false;
    this.done = true;
    this.r[this.outReg] = this.tree.count();
    return true;
  }
  close(): void {}
}

/** Emits exactly one empty row (SELECT without FROM). */
export class SingleRow implements Operator {
  readonly children: Operator[] = [];
  readonly detail = '';
  private done = false;
  open(): void {
    this.done = false;
  }
  next(): boolean {
    if (this.done) return false;
    this.done = true;
    return true;
  }
  close(): void {}
}

export class NestedLoopJoin implements Operator {
  readonly children: Operator[];
  private r!: SqlValue[];
  private needOuter = true;
  private matched = false;
  constructor(
    readonly outer: Operator,
    readonly inner: Operator,
    readonly left: boolean,
    /** Registers written by the inner side (resolved at open: planning may add columns later). */
    readonly innerRegsFn: () => number[],
    readonly on?: Fn,
  ) {
    this.children = [outer, inner];
  }
  private innerRegs: number[] = [];
  get detail(): string {
    return this.left ? 'LEFT JOIN' : '';
  }
  open(r: SqlValue[]): void {
    this.r = r;
    this.needOuter = true;
    this.innerRegs = this.innerRegsFn();
    this.outer.open(r);
  }
  next(): boolean {
    const r = this.r;
    for (;;) {
      if (this.needOuter) {
        if (!this.outer.next()) return false;
        this.inner.open(r);
        this.needOuter = false;
        this.matched = false;
      }
      while (this.inner.next()) {
        if (this.on === undefined || isTrue(this.on(r))) {
          this.matched = true;
          return true;
        }
      }
      this.needOuter = true;
      if (this.left && !this.matched) {
        for (const reg of this.innerRegs) r[reg] = null;
        return true;
      }
    }
  }
  close(): void {
    this.outer.close();
    this.inner.close();
  }
}

/** Hash join: builds a hash table over `build` (once per execution unless correlated), probes per outer row. */
export class HashJoin implements Operator {
  readonly children: Operator[];
  private r!: SqlValue[];
  private table = new Map<unknown, SqlValue[][]>();
  private builtEpoch = -1;
  private matches: SqlValue[][] | undefined;
  private mi = 0;
  private needOuter = true;
  private matched = false;
  private readonly keyBuf: SqlValue[];

  constructor(
    readonly outer: Operator,
    readonly build: Operator,
    readonly buildKeys: Fn[],
    readonly probeKeys: Fn[],
    readonly collations: Collation[],
    /** Registers written by the build side (saved per row, restored on match); resolved at open. */
    readonly buildRegsFn: () => number[],
    readonly left: boolean,
    readonly state: ExecState,
    readonly correlated: boolean,
    readonly residual?: Fn,
  ) {
    this.children = [outer, build];
    this.keyBuf = new Array(buildKeys.length).fill(null);
  }
  private buildRegs: number[] = [];

  get detail(): string {
    return this.left ? 'LEFT HASH JOIN' : 'HASH JOIN';
  }

  private key(fns: Fn[]): unknown {
    const r = this.r;
    if (fns.length === 1) {
      const v = fns[0](r);
      return v === null ? undefined : hashKey(v, this.collations[0]);
    }
    for (let i = 0; i < fns.length; i++) {
      const v = fns[i](r);
      if (v === null) return undefined;
      this.keyBuf[i] = v;
    }
    return hashKeyMulti(this.keyBuf, this.collations);
  }

  open(r: SqlValue[]): void {
    this.r = r;
    this.needOuter = true;
    if (this.correlated || this.builtEpoch !== this.state.epoch) {
      this.buildRegs = this.buildRegsFn();
      this.table = new Map();
      this.build.open(r);
      const regs = this.buildRegs;
      while (this.build.next()) {
        const k = this.key(this.buildKeys);
        if (k === undefined) continue;
        const row = new Array(regs.length);
        for (let i = 0; i < regs.length; i++) row[i] = r[regs[i]];
        const list = this.table.get(k);
        if (list) list.push(row);
        else this.table.set(k, [row]);
      }
      this.build.close();
      this.builtEpoch = this.state.epoch;
    }
    this.outer.open(r);
  }

  next(): boolean {
    const r = this.r;
    const regs = this.buildRegs;
    for (;;) {
      if (this.needOuter) {
        if (!this.outer.next()) return false;
        const k = this.key(this.probeKeys);
        this.matches = k === undefined ? undefined : this.table.get(k);
        this.mi = 0;
        this.needOuter = false;
        this.matched = false;
      }
      const m = this.matches;
      while (m !== undefined && this.mi < m.length) {
        const row = m[this.mi++];
        for (let i = 0; i < regs.length; i++) r[regs[i]] = row[i];
        if (this.residual === undefined || isTrue(this.residual(r))) {
          this.matched = true;
          return true;
        }
      }
      this.needOuter = true;
      if (this.left && !this.matched) {
        for (const reg of regs) r[reg] = null;
        return true;
      }
    }
  }

  close(): void {
    // Children consumed in open() are closed here too, so an error part-way releases their pages.
    this.build.close();
    this.outer.close();
  }
}

/** Caches the child's rows (per execution) so re-opens replay without re-running it. */
export class Materialize implements Operator {
  readonly children: Operator[];
  readonly detail = 'MATERIALIZE';
  private rows: SqlValue[][] = [];
  private builtEpoch = -1;
  private i = 0;
  private r!: SqlValue[];
  constructor(
    readonly child: Operator,
    readonly regsFn: () => number[],
    readonly state: ExecState,
    readonly correlated: boolean,
  ) {
    this.children = [child];
  }
  private regs: number[] = [];
  open(r: SqlValue[]): void {
    this.r = r;
    this.i = 0;
    if (this.correlated || this.builtEpoch !== this.state.epoch) {
      this.regs = this.regsFn();
      this.rows = [];
      this.child.open(r);
      while (this.child.next()) this.rows.push(this.regs.map((g) => r[g]));
      this.child.close();
      this.builtEpoch = this.state.epoch;
    }
  }
  next(): boolean {
    if (this.i >= this.rows.length) return false;
    const row = this.rows[this.i++];
    const regs = this.regs;
    for (let k = 0; k < regs.length; k++) this.r[regs[k]] = row[k];
    return true;
  }
  close(): void {
    // The rows stay cached; closing the child releases its pages if the build stopped part-way.
    this.child.close();
  }
}

export class Project implements Operator {
  readonly children: Operator[];
  readonly detail = '';
  private r!: SqlValue[];
  constructor(
    readonly child: Operator,
    readonly fns: Fn[],
    readonly outRegs: number[],
  ) {
    this.children = [child];
  }
  open(r: SqlValue[]): void {
    this.r = r;
    this.child.open(r);
  }
  next(): boolean {
    if (!this.child.next()) return false;
    const r = this.r;
    const fns = this.fns;
    const out = this.outRegs;
    for (let i = 0; i < fns.length; i++) r[out[i]] = fns[i](r);
    return true;
  }
  close(): void {
    this.child.close();
  }
}

export interface AggSpec {
  def: AggregateFunction;
  args: Fn[];
  argTypes: import('./convert.js').StaticType[];
  distinct: boolean;
  filter?: Fn;
  outReg: number;
  collation: Collation;
  star: boolean;
  isMinMax: boolean;
  /** Function name and bound argument / FILTER expressions (for pipeline fusion). */
  name: string;
  argExprs: import('../plan/expr.js').BoundExpr[];
  filterExpr?: import('../plan/expr.js').BoundExpr;
}

interface Group {
  keys: SqlValue[];
  states: AggregateState[];
  seen: (Set<unknown> | null)[];
  bare: SqlValue[] | null;
}

/** Partitions per spill level of a hash aggregate. */
const AGG_PARTITIONS = 16;
/** Re-partitioning depth after which a partition is aggregated in memory regardless. */
const AGG_MAX_LEVEL = 6;

/**
 * GROUP BY with a hash table. When the groups outgrow `work_mem` (and a spill area exists), it
 * goes grace-hash: groups already in memory keep accumulating, and rows for keys not yet seen
 * are written, with their aggregate arguments evaluated, to hash partitions in the spill file.
 * After the in-memory groups are returned, each partition is aggregated on its own (partitioned
 * again, with another hash, if it is still too big).
 */
export class HashAggregate implements Operator {
  readonly children: Operator[];
  private r!: SqlValue[];
  private groups: Group[] = [];
  private gi = 0;
  private readonly argBufs: SqlValue[][];
  /** Exactly one min()/max(): bare columns come from the row that produced the extreme. */
  private readonly minMaxIndex: number;
  /** Values per spilled row: keys, per aggregate (filter flag,) arguments, bare columns. */
  private readonly width: number;
  private bytes = 0;
  private spilling = false;
  private pending: { run: Run; level: number }[] = [];

  constructor(
    readonly child: Operator,
    readonly groupFns: Fn[],
    readonly groupColls: Collation[],
    readonly groupRegs: number[],
    readonly aggs: AggSpec[],
    readonly bareRegs: number[],
    readonly spill: SpillArea | null = null,
  ) {
    this.children = [child];
    this.argBufs = aggs.map((a) => new Array(a.args.length).fill(null));
    const mm = aggs.flatMap((a, i) => (a.isMinMax ? [i] : []));
    this.minMaxIndex = mm.length === 1 ? mm[0] : -1;
    this.width = groupFns.length + aggs.reduce((n, a) => n + (a.filter !== undefined ? 1 : 0) + a.args.length, 0) + bareRegs.length;
  }

  get detail(): string {
    return this.groupFns.length ? 'USE TEMP B-TREE FOR GROUP BY' : '';
  }

  private newGroup(keys: SqlValue[]): Group {
    this.bytes += 96 + 64 * this.aggs.length + rowBytes(keys);
    return {
      keys,
      states: this.aggs.map((a) => a.def.create(a.star ? [] : a.argTypes, a.collation)),
      seen: this.aggs.map((a) => (a.distinct ? new Set() : null)),
      bare: null,
    };
  }

  private get budget(): number {
    return this.spill !== null && this.spill.enabled && this.groupFns.length > 0 ? this.spill.workMem : Infinity;
  }

  private partitions(): RunWriter[] {
    if (!this.spilling) {
      this.spill!.acquire();
      this.spilling = true;
    }
    return Array.from({ length: AGG_PARTITIONS }, () => new RunWriter(this.spill!));
  }

  private finishPartitions(parts: RunWriter[], level: number): void {
    for (const w of parts) {
      const run = w.finish();
      if (run.rows > 0) {
        this.pending.push({ run, level });
      }
    }
  }

  open(r: SqlValue[]): void {
    this.r = r;
    this.gi = 0;
    this.releaseSpill();
    this.bytes = 0;
    const budget = this.budget;
    const map = new Map<unknown, Group>();
    const groups: Group[] = [];
    const nk = this.groupFns.length;
    const keyVals: SqlValue[] = new Array(nk).fill(null);
    let single: Group | null = null;
    let parts: RunWriter[] | null = null;
    const rec: SqlValue[] = new Array(this.width).fill(null);
    this.child.open(r);
    while (this.child.next()) {
      let g: Group;
      if (nk === 0) {
        if (single === null) {
          single = this.newGroup([]);
          groups.push(single);
        }
        g = single;
      } else {
        for (let i = 0; i < nk; i++) keyVals[i] = this.groupFns[i](r);
        const k = nk === 1 ? hashKey(keyVals[0], this.groupColls[0]) : hashKeyMulti(keyVals, this.groupColls);
        let found = map.get(k);
        if (found === undefined) {
          if (parts !== null) {
            this.record(keyVals, rec);
            parts[partitionHash(k, 0) % AGG_PARTITIONS].add(rec, this.width);
            continue;
          }
          found = this.newGroup(keyVals.slice());
          map.set(k, found);
          groups.push(found);
        }
        g = found;
      }
      this.step(g);
      if (this.bytes > budget && parts === null) parts = this.partitions();
    }
    this.child.close();
    if (parts !== null) this.finishPartitions(parts, 0);
    if (nk === 0 && single === null) groups.push(this.newGroup([]));
    this.groups = groups;
  }

  /** Evaluate the current row into a spill record (keys, then per aggregate its inputs, then bare columns). */
  private record(keyVals: SqlValue[], rec: SqlValue[]): void {
    for (let i = 0; i < keyVals.length; i++) rec[i] = keyVals[i];
    this.inputs(rec);
  }

  /** The current row's aggregate inputs (FILTER flag, then arguments only if it passes) and bare columns, after the keys. */
  private inputs(rec: SqlValue[]): void {
    const r = this.r;
    let o = this.groupFns.length;
    for (const a of this.aggs) {
      let pass = true;
      if (a.filter !== undefined) {
        pass = isTrue(a.filter(r));
        rec[o++] = pass ? 1 : 0;
      }
      for (let j = 0; j < a.args.length; j++) rec[o++] = pass ? a.args[j](r) : null;
    }
    for (let i = 0; i < this.bareRegs.length; i++) rec[o++] = r[this.bareRegs[i]];
  }

  /**
   * Step group `g` with the current row. The same accumulation as {@link stepRecord}, reading the
   * registers directly: going through a record costs ~20% on in-memory GROUP BY (measured), so the
   * two stay separate. Keep them in step.
   */
  private step(g: Group): void {
    const r = this.r;
    const aggs = this.aggs;
    for (let i = 0; i < aggs.length; i++) {
      const a = aggs[i];
      if (a.filter !== undefined && !isTrue(a.filter(r))) continue;
      const buf = this.argBufs[i];
      for (let j = 0; j < a.args.length; j++) buf[j] = a.args[j](r);
      const seen = g.seen[i];
      if (seen !== null) {
        if (buf[0] === null) continue;
        const k = hashKey(buf[0], a.collation);
        if (seen.has(k)) continue;
        seen.add(k);
        this.bytes += 16 + valueBytes(buf[0]);
      }
      g.states[i].step(buf);
    }
    const bare = this.bareRegs;
    if (bare.length > 0) {
      const take = this.minMaxIndex < 0 || g.bare === null || (g.states[this.minMaxIndex] as MinMaxState).changed;
      if (take) {
        if (g.bare === null) g.bare = new Array(bare.length);
        for (let i = 0; i < bare.length; i++) g.bare[i] = r[bare[i]];
      }
    }
  }

  /** Step group `g` with a record: aggregate inputs from offset `keys`, then bare columns. */
  private stepRecord(g: Group, rec: SqlValue[]): void {
    const aggs = this.aggs;
    let o = this.groupFns.length;
    for (let i = 0; i < aggs.length; i++) {
      const a = aggs[i];
      let pass = true;
      if (a.filter !== undefined) pass = rec[o++] === 1;
      const buf = this.argBufs[i];
      for (let j = 0; j < a.args.length; j++) buf[j] = rec[o++];
      if (!pass) continue;
      const seen = g.seen[i];
      if (seen !== null) {
        if (buf[0] === null) continue;
        const k = hashKey(buf[0], a.collation);
        if (seen.has(k)) continue;
        seen.add(k);
        this.bytes += 16 + valueBytes(buf[0]);
      }
      g.states[i].step(buf);
    }
    const bare = this.bareRegs;
    if (bare.length > 0) {
      const take = this.minMaxIndex < 0 || g.bare === null || (g.states[this.minMaxIndex] as MinMaxState).changed;
      if (take) {
        if (g.bare === null) g.bare = new Array(bare.length);
        for (let i = 0; i < bare.length; i++) g.bare[i] = rec[o + i];
      }
    }
  }

  /** Aggregate the next spilled partition into `groups`; false when none are left. */
  private loadPartition(): boolean {
    const nk = this.groupFns.length;
    const w = this.width;
    while (this.pending.length > 0) {
      const { run, level } = this.pending.pop()!;
      const reader = new RunReader(this.spill!, run);
      const map = new Map<unknown, Group>();
      const groups: Group[] = [];
      const rec: SqlValue[] = new Array(w).fill(null);
      const budget = level < AGG_MAX_LEVEL ? this.budget : Infinity;
      let parts: RunWriter[] | null = null;
      this.bytes = 0;
      this.groups = [];
      while (reader.next(rec, w)) {
        const k = nk === 1 ? hashKey(rec[0], this.groupColls[0]) : hashKeyMulti(rec.slice(0, nk), this.groupColls);
        let g = map.get(k);
        if (g === undefined) {
          if (parts !== null) {
            parts[partitionHash(k, level + 1) % AGG_PARTITIONS].add(rec, w);
            continue;
          }
          g = this.newGroup(rec.slice(0, nk));
          map.set(k, g);
          groups.push(g);
        }
        this.stepRecord(g, rec);
        if (this.bytes > budget && parts === null) parts = this.partitions();
      }
      if (parts !== null) this.finishPartitions(parts, level + 1);
      this.groups = groups;
      this.gi = 0;
      if (groups.length > 0) return true;
    }
    return false;
  }

  next(): boolean {
    while (this.gi >= this.groups.length) {
      if (this.pending.length === 0 || !this.loadPartition()) return false;
    }
    const g = this.groups[this.gi++];
    const r = this.r;
    for (let i = 0; i < this.groupRegs.length; i++) r[this.groupRegs[i]] = g.keys[i];
    const bare = this.bareRegs;
    for (let i = 0; i < bare.length; i++) r[bare[i]] = g.bare === null ? null : g.bare[i];
    for (let i = 0; i < this.aggs.length; i++) r[this.aggs[i].outReg] = g.states[i].final();
    return true;
  }

  private releaseSpill(): void {
    this.pending = [];
    if (this.spilling) {
      this.spilling = false;
      this.spill!.release();
    }
  }

  close(): void {
    // Children consumed in open() are closed here too, so an error part-way releases their pages.
    this.child.close();
    this.groups = [];
    this.releaseSpill();
  }
}

export interface SortKey {
  reg: number;
  desc: boolean;
  nullsFirst: boolean;
  collation: Collation;
}

/** Sorted runs merged at once; more are first merged into longer runs. */
const SORT_FAN_IN = 64;

/** One input of a k-way merge: a spilled run or the rows still in memory. */
interface MergeSource {
  cur: SqlValue[];
  advance(): boolean;
}

/**
 * ORDER BY. Sorts in memory; when the rows outgrow `work_mem` (and a spill area exists) it becomes
 * an external merge sort: each memory-full of rows is sorted and written as a run to the spill
 * file, and the runs (plus the last, in-memory one) are merged as rows are read.
 */
export class Sort implements Operator {
  readonly children: Operator[];
  readonly detail = 'USE TEMP B-TREE FOR ORDER BY';
  private r!: SqlValue[];
  private rows: SqlValue[][] = [];
  private i = 0;
  private readonly keyIdx: number[];
  private spilling = false;
  private sources: MergeSource[] = [];
  private heap: number[] = [];
  private remaining = 0;

  constructor(
    readonly child: Operator,
    readonly keys: SortKey[],
    /** Registers carried through the sort (must include the key registers). */
    readonly regs: number[],
    /** Keep only the first `limit()` rows (top-N), when known. */
    readonly limit?: (r: SqlValue[]) => number,
    readonly spill: SpillArea | null = null,
  ) {
    this.children = [child];
    this.keyIdx = keys.map((k) => regs.indexOf(k.reg));
  }

  private compare = (a: SqlValue[], b: SqlValue[]): number => {
    const keys = this.keys;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const x = a[this.keyIdx[i]];
      const y = b[this.keyIdx[i]];
      let c: number;
      if (x === null || y === null) {
        if (x === y) continue;
        return (x === null) === k.nullsFirst ? -1 : 1;
      }
      c = compareValues(x, y, k.collation);
      if (c !== 0) return k.desc ? -c : c;
    }
    return 0;
  };

  open(r: SqlValue[]): void {
    this.r = r;
    this.i = 0;
    this.releaseSpill();
    let rows: SqlValue[][] = [];
    const regs = this.regs;
    const n = regs.length;
    const cap = this.limit ? this.limit(r) : -1;
    const area = this.spill;
    const budget = area !== null && area.enabled ? area.workMem : Infinity;
    let bytes = 0;
    let runs: Run[] = [];
    this.child.open(r);
    while (this.child.next()) {
      const row = new Array(n);
      for (let j = 0; j < n; j++) row[j] = r[regs[j]];
      rows.push(row);
      if (cap >= 0 && rows.length >= Math.max(64, cap * 4)) {
        rows.sort(this.compare);
        bytes = budget === Infinity ? 0 : Math.ceil((bytes * cap) / rows.length);
        rows.length = cap;
      }
      // Memory accounting samples every 16th row (the estimate is coarse anyway): no per-row cost.
      if (budget !== Infinity && (rows.length & 15) === 0 && (bytes += 16 * rowBytes(row, n)) > budget) {
        // Memory is full: write it out as a sorted run.
        if (!this.spilling) {
          area!.acquire();
          this.spilling = true;
        }
        rows.sort(this.compare);
        if (cap >= 0 && rows.length > cap) rows.length = cap;
        const w = new RunWriter(area!);
        for (const x of rows) w.add(x, n);
        runs.push(w.finish());
        rows = [];
        bytes = 0;
      }
    }
    this.child.close();
    rows.sort(this.compare);
    if (cap >= 0 && rows.length > cap) rows.length = cap;
    if (runs.length === 0) {
      this.rows = rows;
      return;
    }
    // Merge passes until the runs fit one merge, then merge lazily as rows are read.
    // Merge passes keep the runs in input order (ties go to the earlier run: a stable sort).
    while (runs.length + 1 > SORT_FAN_IN) {
      const merged: Run[] = [];
      for (let i = 0; i < runs.length; i += SORT_FAN_IN) {
        const group = runs.slice(i, i + SORT_FAN_IN);
        if (group.length === 1) {
          merged.push(group[0]);
          continue;
        }
        const w = new RunWriter(area!);
        this.startMerge(group, [], -1);
        while (this.pop()) w.add(this.out, n);
        merged.push(w.finish());
      }
      runs = merged;
    }
    this.startMerge(runs, rows, cap);
  }

  /** The row most recently produced by {@link pop}. */
  private out: SqlValue[] = [];

  private startMerge(runs: Run[], memRows: SqlValue[][], cap: number): void {
    const n = this.regs.length;
    const sources: MergeSource[] = runs.map((run) => {
      const reader = new RunReader(this.spill!, run);
      const src: MergeSource = { cur: new Array(n), advance: () => reader.next(src.cur, n) };
      return src;
    });
    if (memRows.length > 0) {
      let k = 0;
      const src: MergeSource = {
        cur: memRows[0],
        advance: () => {
          if (++k >= memRows.length) return false;
          src.cur = memRows[k];
          return true;
        },
      };
      sources.push(src);
    }
    this.sources = sources;
    this.heap = [];
    for (let i = 0; i < sources.length; i++) {
      if (i < runs.length && !sources[i].advance()) continue;
      this.heap.push(i);
      this.siftUp(this.heap.length - 1);
    }
    this.remaining = cap >= 0 ? cap : Infinity;
  }

  /** Ties go to the earlier source (earlier input), keeping the sort stable. */
  private less(a: number, b: number): boolean {
    const c = this.compare(this.sources[a].cur, this.sources[b].cur);
    return c < 0 || (c === 0 && a < b);
  }

  private siftUp(i: number): void {
    const h = this.heap;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(h[i], h[p])) break;
      [h[i], h[p]] = [h[p], h[i]];
      i = p;
    }
  }

  private siftDown(i: number): void {
    const h = this.heap;
    for (;;) {
      const l = 2 * i + 1;
      if (l >= h.length) return;
      const m = l + 1 < h.length && this.less(h[l + 1], h[l]) ? l + 1 : l;
      if (!this.less(h[m], h[i])) return;
      [h[i], h[m]] = [h[m], h[i]];
      i = m;
    }
  }

  /** Take the smallest row of the merge into `out` (copied); false when the merge is done. */
  private pop(): boolean {
    const h = this.heap;
    if (h.length === 0 || this.remaining <= 0) return false;
    this.remaining--;
    const s = this.sources[h[0]];
    const out = this.out;
    const n = this.regs.length;
    for (let j = 0; j < n; j++) out[j] = s.cur[j];
    if (s.advance()) this.siftDown(0);
    else {
      const last = h.pop()!;
      if (h.length > 0) {
        h[0] = last;
        this.siftDown(0);
      }
    }
    return true;
  }

  next(): boolean {
    const regs = this.regs;
    if (this.spilling) {
      if (!this.pop()) return false;
      for (let j = 0; j < regs.length; j++) this.r[regs[j]] = this.out[j];
      return true;
    }
    if (this.i >= this.rows.length) return false;
    const row = this.rows[this.i++];
    for (let j = 0; j < regs.length; j++) this.r[regs[j]] = row[j];
    return true;
  }

  private releaseSpill(): void {
    this.sources = [];
    this.heap = [];
    if (this.spilling) {
      this.spilling = false;
      this.spill!.release();
    }
  }

  close(): void {
    // Children consumed in open() are closed here too, so an error part-way releases their pages.
    this.child.close();
    this.rows = [];
    this.releaseSpill();
  }
}

export class Distinct implements Operator {
  readonly children: Operator[];
  readonly detail = 'USE TEMP B-TREE FOR DISTINCT';
  private r!: SqlValue[];
  private seen = new Set<unknown>();
  private readonly buf: SqlValue[];
  constructor(
    readonly child: Operator,
    readonly regs: number[],
    readonly collations: Collation[],
  ) {
    this.children = [child];
    this.buf = new Array(regs.length).fill(null);
  }
  open(r: SqlValue[]): void {
    this.r = r;
    this.seen = new Set();
    this.child.open(r);
  }
  next(): boolean {
    const r = this.r;
    while (this.child.next()) {
      for (let i = 0; i < this.regs.length; i++) this.buf[i] = r[this.regs[i]];
      const k = this.regs.length === 1 ? hashKey(this.buf[0], this.collations[0]) : hashKeyMulti(this.buf, this.collations);
      if (this.seen.has(k)) continue;
      this.seen.add(k);
      return true;
    }
    return false;
  }
  close(): void {
    this.child.close();
    this.seen = new Set();
  }
}

export class Limit implements Operator {
  readonly children: Operator[];
  readonly detail = '';
  private remaining = 0;
  private skip = 0;
  constructor(
    readonly child: Operator,
    readonly limitFn: Fn | undefined,
    readonly offsetFn: Fn | undefined,
  ) {
    this.children = [child];
  }
  static evalCount(fn: Fn | undefined, r: SqlValue[], dflt: number): number {
    if (!fn) return dflt;
    const v = fn(r);
    if (v === null) throw new SmaltError('SMALT_MISMATCH', 'datatype mismatch');
    const n = Number(toNumeric(v));
    if (!Number.isFinite(n) || (typeof v === 'string' && !/^\s*[+-]?\d+\s*$/.test(v))) throw new SmaltError('SMALT_MISMATCH', 'datatype mismatch');
    return Math.trunc(n);
  }
  open(r: SqlValue[]): void {
    const lim = Limit.evalCount(this.limitFn, r, -1);
    this.remaining = lim < 0 ? Infinity : lim;
    this.skip = Math.max(0, Limit.evalCount(this.offsetFn, r, 0));
    if (this.remaining > 0) this.child.open(r);
  }
  next(): boolean {
    if (this.remaining <= 0) return false;
    while (this.skip > 0) {
      if (!this.child.next()) return (this.remaining = 0), false;
      this.skip--;
    }
    if (!this.child.next()) return (this.remaining = 0), false;
    this.remaining--;
    return true;
  }
  close(): void {
    this.child.close();
  }
}

export class Values implements Operator {
  readonly children: Operator[] = [];
  readonly detail = 'SCAN CONSTANT ROW';
  private r!: SqlValue[];
  private i = 0;
  constructor(
    readonly rows: Fn[][],
    readonly outRegs: number[],
  ) {}
  open(r: SqlValue[]): void {
    this.r = r;
    this.i = 0;
  }
  next(): boolean {
    if (this.i >= this.rows.length) return false;
    const row = this.rows[this.i++];
    for (let j = 0; j < row.length; j++) this.r[this.outRegs[j]] = row[j](this.r);
    return true;
  }
  close(): void {}
}

/** UNION ALL / UNION / INTERSECT / EXCEPT over children that all write the same registers. */
export class Compound implements Operator {
  readonly children: Operator[];
  private r!: SqlValue[];
  private ci = 0;
  private seen = new Set<unknown>();
  private rightSet: Set<unknown> | null = null;
  private readonly buf: SqlValue[];
  constructor(
    readonly left: Operator,
    readonly right: Operator,
    readonly op: 'UNION' | 'UNION ALL' | 'INTERSECT' | 'EXCEPT',
    readonly regs: number[],
    readonly collations: Collation[],
  ) {
    this.children = [left, right];
    this.buf = new Array(regs.length).fill(null);
  }
  get detail(): string {
    return `COMPOUND QUERY (${this.op})`;
  }
  private key(): string {
    for (let i = 0; i < this.regs.length; i++) this.buf[i] = this.r[this.regs[i]];
    return hashKeyMulti(this.buf, this.collations);
  }
  open(r: SqlValue[]): void {
    this.r = r;
    this.ci = 0;
    this.seen = new Set();
    this.rightSet = null;
    if (this.op === 'INTERSECT' || this.op === 'EXCEPT') {
      const set = new Set<unknown>();
      this.right.open(r);
      while (this.right.next()) set.add(this.key());
      this.right.close();
      this.rightSet = set;
    }
    this.left.open(r);
  }
  next(): boolean {
    for (;;) {
      const child = this.ci === 0 ? this.left : this.right;
      if (!child.next()) {
        if (this.ci === 0 && (this.op === 'UNION' || this.op === 'UNION ALL')) {
          this.left.close();
          this.ci = 1;
          this.right.open(this.r);
          continue;
        }
        return false;
      }
      if (this.op === 'UNION ALL') return true;
      const k = this.key();
      if (this.seen.has(k)) continue;
      if (this.rightSet !== null) {
        const inRight = this.rightSet.has(k);
        if (inRight !== (this.op === 'INTERSECT')) continue;
      }
      this.seen.add(k);
      return true;
    }
  }
  close(): void {
    this.left.close();
    this.right.close();
  }
}

/** Render an EXPLAIN QUERY PLAN tree (id, parent, detail), skipping nodes without detail. */
export function explainRows(root: Operator): { id: number; parent: number; detail: string }[] {
  const out: { id: number; parent: number; detail: string }[] = [];
  let id = 0;
  const walk = (op: Operator, parent: number): void => {
    let me = parent;
    if (op.detail) {
      me = ++id;
      out.push({ id: me, parent, detail: op.detail });
    }
    for (const c of op.children) walk(c, me);
  };
  walk(root, 0);
  return out;
}

/**
 * RIGHT and FULL OUTER JOIN. The inner (right-hand) side is materialized, hashed on equality keys
 * when there are any, and every inner row carries a "matched" flag. Outer rows are joined as usual
 * (FULL also emits an unmatched outer row with the inner registers NULL); once the outer side is
 * exhausted, every inner row that never matched is emitted with all outer registers NULL.
 */
export class OuterJoin implements Operator {
  readonly children: Operator[];
  private r!: SqlValue[];
  private rows: SqlValue[][] = [];
  private matchedFlags = new Uint8Array(0);
  private table: Map<unknown, number[]> | null = null;
  private candidates: number[] | null = null;
  private ci = 0;
  private outerActive = false;
  private outerMatched = false;
  private draining = false;
  private di = 0;
  private innerRegs: number[] = [];
  private outerRegs: number[] = [];

  constructor(
    readonly outer: Operator,
    readonly inner: Operator,
    readonly innerRegsFn: () => number[],
    readonly outerRegsFn: () => number[],
    readonly full: boolean,
    readonly cond: Fn | undefined,
    readonly buildKeys: Fn[] = [],
    readonly probeKeys: Fn[] = [],
    readonly collations: Collation[] = [],
  ) {
    this.children = [outer, inner];
  }

  get detail(): string {
    return `${this.full ? 'FULL' : 'RIGHT'} OUTER ${this.buildKeys.length ? 'HASH ' : ''}JOIN`;
  }

  private key(fns: Fn[]): unknown {
    const r = this.r;
    if (fns.length === 1) {
      const v = fns[0](r);
      return v === null ? undefined : hashKey(v, this.collations[0]);
    }
    const vals: SqlValue[] = [];
    for (const f of fns) {
      const v = f(r);
      if (v === null) return undefined;
      vals.push(v);
    }
    return hashKeyMulti(vals, this.collations);
  }

  open(r: SqlValue[]): void {
    this.r = r;
    this.innerRegs = this.innerRegsFn();
    this.outerRegs = this.outerRegsFn();
    const rows: SqlValue[][] = [];
    const table = this.buildKeys.length ? new Map<unknown, number[]>() : null;
    const inner = this.inner;
    try {
      inner.open(r);
      while (inner.next()) {
        rows.push(this.innerRegs.map((g) => r[g]));
        if (table) {
          const k = this.key(this.buildKeys);
          if (k === undefined) continue; // NULL keys never match
          let list = table.get(k);
          if (!list) table.set(k, (list = []));
          list.push(rows.length - 1);
        }
      }
    } finally {
      inner.close();
    }
    this.rows = rows;
    this.table = table;
    this.matchedFlags = new Uint8Array(rows.length);
    this.outerActive = false;
    this.draining = false;
    this.di = 0;
    this.outer.open(r);
  }

  private setInner(j: number): void {
    const row = this.rows[j];
    for (let i = 0; i < this.innerRegs.length; i++) this.r[this.innerRegs[i]] = row[i];
  }

  next(): boolean {
    const r = this.r;
    if (!this.draining) {
      for (;;) {
        if (!this.outerActive) {
          if (!this.outer.next()) {
            this.draining = true;
            break;
          }
          this.outerActive = true;
          this.outerMatched = false;
          this.ci = 0;
          if (this.table) {
            const k = this.key(this.probeKeys);
            this.candidates = k === undefined ? null : (this.table.get(k) ?? null);
          } else this.candidates = null;
        }
        const n = this.table ? (this.candidates?.length ?? 0) : this.rows.length;
        while (this.ci < n) {
          const j = this.table ? this.candidates![this.ci++] : this.ci++;
          this.setInner(j);
          if (this.cond && truthy(this.cond(r)) !== true) continue;
          this.matchedFlags[j] = 1;
          this.outerMatched = true;
          return true;
        }
        this.outerActive = false;
        if (this.full && !this.outerMatched) {
          for (const g of this.innerRegs) r[g] = null;
          return true;
        }
      }
    }
    // Inner rows that never matched, with the outer side NULL.
    while (this.di < this.rows.length) {
      const j = this.di++;
      if (this.matchedFlags[j]) continue;
      this.setInner(j);
      for (const g of this.outerRegs) r[g] = null;
      return true;
    }
    return false;
  }

  close(): void {
    // Children consumed in open() are closed here too, so an error part-way releases their pages.
    this.inner.close();
    this.outer.close();
    this.rows = [];
    this.table = null;
  }
}

/** The self-reference of a WITH RECURSIVE CTE: yields the row the recursion is expanding, once per open. */
export class WorkingScan implements Operator {
  readonly children: Operator[] = [];
  /** Set by RecursiveCte before each recursive step. */
  row: SqlValue[] | null = null;
  private done = false;
  private r!: SqlValue[];

  constructor(
    readonly name: string,
    private readonly regs: number[],
  ) {}

  get detail(): string {
    return `SCAN ${this.name} (recursive step)`;
  }

  open(r: SqlValue[]): void {
    this.r = r;
    this.done = false;
  }

  next(): boolean {
    if (this.done || this.row === null) return false;
    this.done = true;
    const row = this.row;
    for (let j = 0; j < this.regs.length; j++) this.r[this.regs[j]] = row[j];
    return true;
  }

  close(): void {}
}

/**
 * WITH RECURSIVE, evaluated like SQLite: the initial SELECT seeds a queue; each step takes one row
 * from the queue, outputs it, and runs the recursive SELECT(s) with that row as the working table,
 * queueing their results. UNION (not ALL) discards rows already seen. An ORDER BY on the CTE makes
 * the queue a priority queue (FIFO among equal keys); LIMIT stops the recursion, OFFSET skips output.
 */
export class RecursiveCte implements Operator {
  readonly children: Operator[];
  private r!: SqlValue[];
  private queue: { row: SqlValue[]; seq: number }[] = [];
  private head = 0;
  private seq = 0;
  private seen = new Set<string>();
  private produced = 0;
  private skip = 0;
  private limit = -1;

  constructor(
    private readonly name: string,
    private readonly initial: Operator,
    private readonly recursive: Operator[],
    private readonly outRegs: number[],
    private readonly working: WorkingScan,
    private readonly distinct: boolean,
    private readonly collations: Collation[],
    private readonly order: { index: number; desc: boolean; nullsFirst: boolean; collation: Collation }[] | null,
    private readonly limitFn?: Fn,
    private readonly offsetFn?: Fn,
  ) {
    this.children = [initial, ...recursive];
  }

  get detail(): string {
    return `RECURSIVE CTE ${this.name}${this.distinct ? ' (UNION)' : ''}`;
  }

  open(r: SqlValue[]): void {
    this.r = r;
    this.queue = [];
    this.head = 0;
    this.seq = 0;
    this.seen = new Set();
    this.produced = 0;
    this.limit = -1;
    this.skip = 0;
    if (this.limitFn) {
      const v = this.limitFn(r);
      this.limit = typeof v === 'number' || typeof v === 'bigint' ? Number(v) : -1;
    }
    if (this.offsetFn) {
      const v = this.offsetFn(r);
      this.skip = typeof v === 'number' || typeof v === 'bigint' ? Math.max(0, Number(v)) : 0;
    }
    if (this.limit === 0) return;
    this.runInto(this.initial);
  }

  private runInto(op: Operator): void {
    const r = this.r;
    try {
      op.open(r);
      while (op.next()) this.add(this.outRegs.map((g) => r[g]));
    } finally {
      op.close();
    }
  }

  private add(row: SqlValue[]): void {
    if (this.distinct) {
      const k = hashKeyMulti(row, this.collations);
      if (this.seen.has(k)) return;
      this.seen.add(k);
    }
    const item = { row, seq: this.seq++ };
    if (!this.order) {
      this.queue.push(item);
      return;
    }
    // Binary heap on the CTE's ORDER BY, insertion order breaking ties.
    const q = this.queue;
    q.push(item);
    let i = q.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.cmp(q[i], q[p]) >= 0) break;
      [q[i], q[p]] = [q[p], q[i]];
      i = p;
    }
  }

  private cmp(a: { row: SqlValue[]; seq: number }, b: { row: SqlValue[]; seq: number }): number {
    for (const k of this.order!) {
      const x = a.row[k.index];
      const y = b.row[k.index];
      if (x === null || y === null) {
        if (x === y) continue;
        return (x === null) === k.nullsFirst ? -1 : 1;
      }
      const c = compareValues(x, y, k.collation);
      if (c !== 0) return k.desc ? -c : c;
    }
    return a.seq - b.seq;
  }

  private pop(): SqlValue[] | null {
    if (!this.order) {
      if (this.head >= this.queue.length) return null;
      const row = this.queue[this.head++].row;
      if (this.head > 1024 && this.head * 2 > this.queue.length) {
        this.queue = this.queue.slice(this.head);
        this.head = 0;
      }
      return row;
    }
    const q = this.queue;
    if (q.length === 0) return null;
    const top = q[0];
    const last = q.pop()!;
    if (q.length > 0) {
      q[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const rr = l + 1;
        let m = i;
        if (l < q.length && this.cmp(q[l], q[m]) < 0) m = l;
        if (rr < q.length && this.cmp(q[rr], q[m]) < 0) m = rr;
        if (m === i) break;
        [q[i], q[m]] = [q[m], q[i]];
        i = m;
      }
    }
    return top.row;
  }

  next(): boolean {
    for (;;) {
      if (this.limit >= 0 && this.produced >= this.limit) return false;
      const row = this.pop();
      if (row === null) return false;
      this.working.row = row;
      for (const op of this.recursive) this.runInto(op);
      if (this.skip > 0) {
        this.skip--;
        continue;
      }
      const r = this.r;
      for (let j = 0; j < this.outRegs.length; j++) r[this.outRegs[j]] = row[j];
      this.produced++;
      return true;
    }
  }

  close(): void {
    // Children consumed in open() are closed here too, so an error part-way releases their pages.
    this.initial.close();
    for (const op of this.recursive) op.close();
    this.queue = [];
    this.seen = new Set();
    this.working.row = null;
  }
}

/** Rows of a virtual table (information_schema, table-valued pragma functions), computed at open. */
export class VirtualScan implements Operator {
  readonly children: Operator[] = [];
  private rows: SqlValue[][] = [];
  private i = 0;
  private r!: SqlValue[];

  constructor(
    readonly label: string,
    private readonly produce: (r: SqlValue[]) => SqlValue[][],
    private readonly regs: number[],
  ) {}

  get detail(): string {
    // External data (M8) is labelled `EXTERNAL name (location)`; other virtual tables are computed.
    return this.label.startsWith('EXTERNAL ') ? `SCAN ${this.label}` : `SCAN ${this.label} VIRTUAL TABLE`;
  }

  open(r: SqlValue[]): void {
    this.r = r;
    this.rows = this.produce(r);
    this.i = 0;
  }

  next(): boolean {
    if (this.i >= this.rows.length) return false;
    const row = this.rows[this.i++];
    const regs = this.regs;
    for (let j = 0; j < regs.length; j++) this.r[regs[j]] = row[j] ?? null;
    return true;
  }

  close(): void {
    this.rows = [];
  }
}

export interface AnalyzeRow {
  id: number;
  parent: number;
  detail: string;
  /** Planner estimate (rows per loop), when the planner costed this operator. */
  estRows: number | null;
  loops: number;
  rows: number;
  /** Inclusive wall time in open + next, milliseconds. */
  timeMs: number;
}

/**
 * EXPLAIN ANALYZE: run the plan to completion with every operator instrumented (per instance) for
 * loops (open calls), rows produced and inclusive time, then restore the operators.
 */
export function explainAnalyze(root: Operator, r: SqlValue[], estimates: WeakMap<Operator, number>): AnalyzeRow[] {
  const out: AnalyzeRow[] = [];
  const restore: (() => void)[] = [];
  const now = (): number => performance.now();
  let id = 0;
  const walk = (op: Operator, parent: number): void => {
    const row: AnalyzeRow = { id: ++id, parent, detail: op.detail || op.constructor.name.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase(), estRows: estimates.get(op) ?? null, loops: 0, rows: 0, timeMs: 0 };
    out.push(row);
    const o = op as { open: Operator['open']; next: Operator['next'] };
    const open = o.open;
    const next = o.next;
    o.open = function (this: Operator, regs: SqlValue[]): void {
      row.loops++;
      const t0 = now();
      try {
        open.call(this, regs);
      } finally {
        row.timeMs += now() - t0;
      }
    };
    o.next = function (this: Operator): boolean {
      const t0 = now();
      try {
        const ok = next.call(this);
        if (ok) row.rows++;
        return ok;
      } finally {
        row.timeMs += now() - t0;
      }
    };
    restore.push(() => {
      delete (o as Partial<typeof o>).open;
      delete (o as Partial<typeof o>).next;
    });
    for (const c of op.children) walk(c, row.id);
  };
  walk(root, 0);
  try {
    try {
      root.open(r);
      while (root.next());
    } finally {
      root.close();
    }
  } finally {
    for (const f of restore) f();
  }
  return out;
}

/**
 * Single-table scan + WHERE + aggregates (no GROUP BY) fused into one generated function that walks
 * the leaf pages directly. Produces one row of aggregate results, like HashAggregate.
 */
export class FusedScanAggregate implements Operator {
  readonly children: Operator[] = [];
  private r!: SqlValue[];
  private done = false;
  private states: AggregateState[] = [];

  constructor(
    readonly access: TableAccess,
    readonly aggs: AggSpec[],
    /** Generated: run(r, states) consumes the whole table. */
    readonly run: (r: SqlValue[], states: AggregateState[]) => void,
    private readonly label?: string,
  ) {}

  get detail(): string {
    return this.label ?? `SCAN ${this.access.tableName} (fused scan + filter + aggregate)`;
  }

  open(r: SqlValue[]): void {
    this.r = r;
    this.done = false;
    this.states = this.aggs.map((a) => a.def.create(a.star ? [] : a.argTypes, a.collation));
    this.run(r, this.states);
  }

  next(): boolean {
    if (this.done) return false;
    this.done = true;
    for (let i = 0; i < this.aggs.length; i++) this.r[this.aggs[i].outReg] = this.states[i].final();
    return true;
  }

  close(): void {
    this.states = [];
  }
}

const SCAN_BATCH = 256;

/**
 * Full table scan + WHERE fused into generated code that decodes and filters rows straight off the
 * leaf pages and hands passing rows to the consumer in batches. Generated on first open (when the
 * decode list is final).
 */
export class FusedScanFilter implements Operator {
  readonly children: Operator[] = [];
  private fill: ((st: ScanState, r: SqlValue[], out: SqlValue[]) => number) | null = null;
  private regs: number[] = [];
  private readonly st: ScanState = { f: null, i: 0 };
  private buf: SqlValue[] = [];
  private count = 0;
  private pos = 0;
  private done = false;
  private r!: SqlValue[];

  constructor(
    readonly access: TableAccess,
    private readonly build: (cap: number) => { fill: (st: ScanState, r: SqlValue[], out: SqlValue[]) => number; regs: number[] },
    private readonly first: () => { bytes: Uint8Array; view: DataView } | null,
    private readonly release: (page: { bytes: Uint8Array; view: DataView }) => void,
  ) {}

  get detail(): string {
    return `SCAN ${this.access.tableName} (fused scan + filter)`;
  }

  open(r: SqlValue[]): void {
    if (this.fill === null) {
      const b = this.build(SCAN_BATCH);
      this.fill = b.fill;
      this.regs = b.regs;
      this.buf = new Array(SCAN_BATCH * Math.max(1, b.regs.length)).fill(null);
    }
    this.close();
    this.r = r;
    this.st.f = this.first();
    this.st.i = 0;
    this.count = 0;
    this.pos = 0;
    this.done = false;
  }

  next(): boolean {
    if (this.pos >= this.count) {
      if (this.done) return false;
      this.count = this.fill!(this.st, this.r, this.buf);
      this.pos = 0;
      if (this.count < SCAN_BATCH) this.done = true;
      if (this.count === 0) return false;
    }
    const regs = this.regs;
    const w = regs.length;
    const base = this.pos * w;
    const r = this.r;
    for (let j = 0; j < w; j++) r[regs[j]] = this.buf[base + j];
    this.pos++;
    return true;
  }

  close(): void {
    if (this.st.f !== null) {
      this.release(this.st.f);
      this.st.f = null;
    }
  }
}

/** Scan + WHERE + GROUP BY + aggregates fused into one generated loop (hash aggregation inline). */
export class FusedGroupAggregate implements Operator {
  readonly children: Operator[] = [];
  private run: ((r: SqlValue[], groups: Map<unknown, unknown>, order: unknown[]) => void) | null = null;
  private order: { keys: SqlValue[]; st: AggregateState[] }[] = [];
  private gi = 0;
  private r!: SqlValue[];

  /** The equivalent (spilling) hash aggregate, used once the groups outgrow work_mem. */
  fallback: HashAggregate | null = null;
  private delegated = false;

  constructor(
    readonly access: TableAccess,
    private readonly build: () => (r: SqlValue[], groups: Map<unknown, unknown>, order: unknown[]) => void,
    readonly groupRegs: number[],
    readonly aggs: AggSpec[],
    private readonly label?: string,
    /** Group memory used by the generated loop's newGroup (null: unlimited). */
    private readonly budget: { used: number; limit: number; area: SpillArea } | null = null,
  ) {}

  get detail(): string {
    return this.label ?? `SCAN ${this.access.tableName} (fused scan + filter + GROUP BY)`;
  }

  open(r: SqlValue[]): void {
    this.run ??= this.build();
    this.r = r;
    this.gi = 0;
    // Re-opened without close (the inner side of a nested loop): end the previous delegation, or
    // the fallback's spill hold would outlive the statement.
    if (this.delegated) this.fallback!.close();
    this.delegated = false;
    const order: { keys: SqlValue[]; st: AggregateState[] }[] = [];
    if (this.budget) {
      this.budget.used = 0;
      this.budget.limit = this.fallback && this.budget.area.enabled ? this.budget.area.workMem : Infinity;
    }
    try {
      this.run(r, new Map(), order);
    } catch (e) {
      if (e !== SpillRestart || !this.fallback) throw e;
      // Too many groups to hold: run the query again with the hash aggregate, which spills.
      this.order = [];
      this.delegated = true;
      this.fallback.open(r);
      return;
    }
    this.order = order;
  }

  next(): boolean {
    if (this.delegated) return this.fallback!.next();
    if (this.gi >= this.order.length) return false;
    const g = this.order[this.gi++];
    const r = this.r;
    for (let i = 0; i < this.groupRegs.length; i++) r[this.groupRegs[i]] = g.keys[i];
    for (let i = 0; i < this.aggs.length; i++) r[this.aggs[i].outReg] = g.st[i].final();
    return true;
  }

  close(): void {
    this.order = [];
    if (this.delegated) {
      this.delegated = false;
      this.fallback!.close();
    }
  }
}
