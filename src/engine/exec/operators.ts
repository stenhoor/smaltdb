import { SmaltError } from '../errors.js';
import type { BTree, BTreeCursor } from '../storage/btree.js';
import { KeyEncoder, ROWID_KEY_SIZE, readNumericKeyAt, readRowidKey, writeRowidKey } from '../storage/key-codec.js';
import { type RecordReader, decodeTagged, decodeUtf8, readInt64 } from '../storage/record.js';
import { type LoaderHelpers, type LoaderSpec, type ScanState, codegenEnabled, generateLoader } from './codegen.js';

const LOADER_HELPERS: LoaderHelpers = { readInt64, utf8: decodeUtf8, tagged: decodeTagged, rowid: readRowidKey };
import { Collation, type SqlValue, compareValues } from '../values.js';
import { applyNumericAffinity, hashKey, hashKeyMulti, toNumeric } from './convert.js';
import { type Fn, isTrue } from './expr.js';
import { type AggregateFunction, type AggregateState, MinMaxState } from './functions.js';

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
    if (d.length > 0) {
      const b = page.bytes;
      const kl = b[off] | (b[off + 1] << 8);
      let bytes = b;
      let start = off + 7 + kl;
      let len = page.view.getUint32(off + 3, true);
      if (b[off + 2] & 1) {
        bytes = this.tree.readValue(page, off);
        start = 0;
        len = bytes.length;
      }
      const rd = this.reader;
      rd.reset(bytes, start, len);
      for (let i = 0; i < d.length; i += 2) r[d[i + 1]] = rd.column(d[i]);
    }
    if (this.rowidReg >= 0) {
      const id = readRowidKey(page.bytes, off + 7);
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
        const target = typeof this.hiVal === 'number' ? Math.min(Math.floor(this.hiVal), I64_MAX_N) : this.hiVal;
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
        if (start > I64_MAX_N) return false;
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
      if (typeof p === 'number' && !Number.isInteger(p)) continue;
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

  constructor(
    readonly access: TableAccess,
    readonly spec: IndexScanSpec,
  ) {}

  get detail(): string {
    const cols = this.spec.eq.length;
    const parts: string[] = [];
    for (let i = 0; i < cols; i++) parts.push('=?');
    if (this.spec.lo || this.spec.hi) parts.push('range');
    return `SEARCH ${this.access.tableName} USING INDEX ${this.spec.indexName} (${parts.length ? parts.join(',') : 'scan'})`;
  }

  open(r: SqlValue[]): void {
    this.r = r;
    this.started = false;
    this.done = false;
    if (this.idx === null) this.idx = this.spec.tree.cursor();
    if (this.tab === null) this.tab = this.access.tree.cursor();
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
        this.lower = concat(prefix, new Uint8Array([0x06]));
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
    const c = this.idx!;
    let ok: boolean;
    if (!this.started) {
      this.started = true;
      if (!this.bounds()) return (this.done = true), false;
      ok = c.seek(this.lower!);
    } else ok = c.next();
    if (!ok || c.compareKey(this.upper!) >= 0) return (this.done = true), false;
    // The rowid is the last key component (11-byte numeric encoding).
    c.loadKey();
    const kb = c.keyBytes;
    const end = c.keyOffset + c.keyLength;
    const rowid = readNumericKeyAt(kb, end - 11);
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
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

// ------------------------------------------------------------------ relational operators

export class Filter implements Operator {
  readonly children: Operator[];
  private r!: SqlValue[];
  constructor(
    readonly child: Operator,
    readonly pred: Fn,
    /** Source predicate (lets the planner fuse scan + filter + aggregate into generated code). */
    readonly ast?: import('../sql/ast.js').Expr,
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
  close(): void {}
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
  /** Function name and argument / FILTER ASTs (for pipeline fusion). */
  name: string;
  argAsts: import('../sql/ast.js').Expr[];
  filterAst?: import('../sql/ast.js').Expr;
}

interface Group {
  keys: SqlValue[];
  states: AggregateState[];
  seen: (Set<unknown> | null)[];
  bare: SqlValue[] | null;
}

export class HashAggregate implements Operator {
  readonly children: Operator[];
  private r!: SqlValue[];
  private groups: Group[] = [];
  private gi = 0;
  private readonly argBufs: SqlValue[][];
  /** Exactly one min()/max(): bare columns come from the row that produced the extreme. */
  private readonly minMaxIndex: number;

  constructor(
    readonly child: Operator,
    readonly groupFns: Fn[],
    readonly groupColls: Collation[],
    readonly groupRegs: number[],
    readonly aggs: AggSpec[],
    readonly bareRegs: number[],
  ) {
    this.children = [child];
    this.argBufs = aggs.map((a) => new Array(a.args.length).fill(null));
    const mm = aggs.flatMap((a, i) => (a.isMinMax ? [i] : []));
    this.minMaxIndex = mm.length === 1 ? mm[0] : -1;
  }

  get detail(): string {
    return this.groupFns.length ? 'USE TEMP B-TREE FOR GROUP BY' : '';
  }

  private newGroup(keys: SqlValue[]): Group {
    return {
      keys,
      states: this.aggs.map((a) => a.def.create(a.star ? [] : a.argTypes, a.collation)),
      seen: this.aggs.map((a) => (a.distinct ? new Set() : null)),
      bare: null,
    };
  }

  open(r: SqlValue[]): void {
    this.r = r;
    this.gi = 0;
    const map = new Map<unknown, Group>();
    const groups: Group[] = [];
    const nk = this.groupFns.length;
    const keyVals: SqlValue[] = new Array(nk).fill(null);
    let single: Group | null = null;
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
          found = this.newGroup(keyVals.slice());
          map.set(k, found);
          groups.push(found);
        }
        g = found;
      }
      this.step(g);
    }
    this.child.close();
    if (nk === 0 && single === null) groups.push(this.newGroup([]));
    this.groups = groups;
  }

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

  next(): boolean {
    if (this.gi >= this.groups.length) return false;
    const g = this.groups[this.gi++];
    const r = this.r;
    for (let i = 0; i < this.groupRegs.length; i++) r[this.groupRegs[i]] = g.keys[i];
    const bare = this.bareRegs;
    for (let i = 0; i < bare.length; i++) r[bare[i]] = g.bare === null ? null : g.bare[i];
    for (let i = 0; i < this.aggs.length; i++) r[this.aggs[i].outReg] = g.states[i].final();
    return true;
  }

  close(): void {
    this.groups = [];
  }
}

export interface SortKey {
  reg: number;
  desc: boolean;
  nullsFirst: boolean;
  collation: Collation;
}

export class Sort implements Operator {
  readonly children: Operator[];
  readonly detail = 'USE TEMP B-TREE FOR ORDER BY';
  private r!: SqlValue[];
  private rows: SqlValue[][] = [];
  private i = 0;
  private readonly keyIdx: number[];

  constructor(
    readonly child: Operator,
    readonly keys: SortKey[],
    /** Registers carried through the sort (must include the key registers). */
    readonly regs: number[],
    /** Keep only the first `limit()` rows (top-N), when known. */
    readonly limit?: (r: SqlValue[]) => number,
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
    const rows: SqlValue[][] = [];
    const regs = this.regs;
    const n = regs.length;
    const cap = this.limit ? this.limit(r) : -1;
    this.child.open(r);
    while (this.child.next()) {
      const row = new Array(n);
      for (let j = 0; j < n; j++) row[j] = r[regs[j]];
      rows.push(row);
      if (cap >= 0 && rows.length >= Math.max(64, cap * 4)) {
        rows.sort(this.compare);
        rows.length = cap;
      }
    }
    this.child.close();
    rows.sort(this.compare);
    if (cap >= 0 && rows.length > cap) rows.length = cap;
    this.rows = rows;
  }

  next(): boolean {
    if (this.i >= this.rows.length) return false;
    const row = this.rows[this.i++];
    const regs = this.regs;
    for (let j = 0; j < regs.length; j++) this.r[regs[j]] = row[j];
    return true;
  }

  close(): void {
    this.rows = [];
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
  ) {}

  get detail(): string {
    return `SCAN ${this.access.tableName} (fused scan + filter + aggregate)`;
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

  constructor(
    readonly access: TableAccess,
    private readonly build: () => (r: SqlValue[], groups: Map<unknown, unknown>, order: unknown[]) => void,
    readonly groupRegs: number[],
    readonly aggs: AggSpec[],
  ) {}

  get detail(): string {
    return `SCAN ${this.access.tableName} (fused scan + filter + GROUP BY)`;
  }

  open(r: SqlValue[]): void {
    this.run ??= this.build();
    this.r = r;
    this.gi = 0;
    const order: { keys: SqlValue[]; st: AggregateState[] }[] = [];
    this.run(r, new Map(), order);
    this.order = order;
  }

  next(): boolean {
    if (this.gi >= this.order.length) return false;
    const g = this.order[this.gi++];
    const r = this.r;
    for (let i = 0; i < this.groupRegs.length; i++) r[this.groupRegs[i]] = g.keys[i];
    for (let i = 0; i < this.aggs.length; i++) r[this.aggs[i].outReg] = g.st[i].final();
    return true;
  }

  close(): void {
    this.order = [];
  }
}
