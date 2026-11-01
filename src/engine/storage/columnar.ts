/**
 * Columnar segments (ADR 0008): the storage of `storage = 'columnar'` materialized views.
 *
 * Rows are grouped into row groups of {@link ROW_GROUP_ROWS}. Each column of a row group is one
 * encoded chunk, stored as a value in an ordinary B+tree keyed by (u32 rowGroup, u16 column), both
 * big-endian, so large chunks use the tree's overflow pages and everything inherits the pager's
 * WAL atomicity, crash safety and free-page handling. Per row group, key (rg, 0xFFFF) holds the
 * row count and a zone map (null count, min, max) per column; key (0xFFFFFFFF, 0) holds the
 * store header (row groups, rows, columns).
 *
 * Chunk value (little-endian):
 *   u8 encoding | u8 flags (1 = has null bitmap) | u16 0 | u32 count
 *   [null bitmap: ceil(count / 8) bytes, padded to 8]   (bit set = NULL)
 *   payload, starting 8-byte aligned:
 *     NULLS  -
 *     F64    count × f64
 *     I32    count × i32
 *     DICT   u32 dictCount | u32 codeWidth (2|4) | u32 offsets[dictCount + 1] | utf8 | pad 4 | codes
 *     STR    u32 offsets[count + 1] | utf8
 *     BLOB   u32 offsets[count + 1] | bytes
 *     ANY    per value: u8 tag (0 null, 1 f64, 2 i64, 3 text, 4 blob) | payload (f64, i64, u32 len + bytes)
 */
import { CorruptionError } from '../errors.js';
import type { SqlValue } from '../values.js';
import type { BTree } from './btree.js';

export const ROW_GROUP_ROWS = 8192;

const ENC_NULLS = 0;
const ENC_F64 = 1;
const ENC_I32 = 2;
const ENC_DICT = 3;
const ENC_STR = 4;
const ENC_BLOB = 5;
const ENC_ANY = 6;

const META_COL = 0xffff;
const HEADER_RG = 0xffffffff;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** A decoded column chunk. */
export interface Chunk {
  readonly enc: number;
  readonly count: number;
  /** Bit i set = row i is NULL (null when the chunk has no NULLs). */
  readonly nulls: Uint8Array | null;
  /** F64 / I32 values. */
  readonly num: Float64Array | Int32Array | null;
  /** DICT: distinct strings and per-row codes. */
  readonly dict: string[] | null;
  readonly codes: Uint16Array | Uint32Array | null;
  /** STR / BLOB / ANY values. */
  readonly vals: SqlValue[] | null;
  /** Approximate decoded size, for the cache budget. */
  readonly bytes: number;
}

/** Zone map of one column in one row group. */
export interface Zone {
  nulls: number;
  /** Numeric min/max (when every non-NULL value is a number). */
  numMin?: number;
  numMax?: number;
  /** Text min/max in BINARY order (when every non-NULL value is text of at most 64 UTF-8 bytes). */
  textMin?: string;
  textMax?: string;
}

export interface RowGroupMeta {
  rows: number;
  zones: Zone[];
}

/** Value of row `i` of a chunk. */
export function chunkValue(c: Chunk, i: number): SqlValue {
  if (c.nulls !== null && (c.nulls[i >>> 3] & (1 << (i & 7))) !== 0) return null;
  switch (c.enc) {
    case ENC_F64:
    case ENC_I32:
      return c.num![i];
    case ENC_DICT:
      return c.dict![c.codes![i]];
    case ENC_NULLS:
      return null;
    default:
      return c.vals![i];
  }
}

function chunkKey(rg: number, col: number): Uint8Array {
  const k = new Uint8Array(6);
  const v = new DataView(k.buffer);
  v.setUint32(0, rg, false);
  v.setUint16(4, col, false);
  return k;
}

// ------------------------------------------------------------------ writing

/** Appends rows and writes complete row groups to an empty tree. */
export class ColumnStoreWriter {
  /** Per column, a row group's values (preallocated, reused across row groups). */
  private readonly cols: SqlValue[][];
  private rows = 0;
  private rg = 0;
  private total = 0;
  private readonly enc = new ChunkEncoder();
  /** Chunks are written in key order, so the tree is built bottom-up. */
  private readonly loader: ReturnType<BTree['bulkLoader']>;

  constructor(
    tree: BTree,
    private readonly ncols: number,
  ) {
    this.cols = Array.from({ length: ncols }, () => new Array<SqlValue>(ROW_GROUP_ROWS).fill(null));
    this.loader = tree.bulkLoader();
  }

  add(row: readonly SqlValue[]): void {
    const i = this.rows++;
    for (let c = 0; c < this.ncols; c++) this.cols[c][i] = row[c];
    if (this.rows === ROW_GROUP_ROWS) this.flush();
  }

  /** Add the row held in registers `r[regs[c]]`. */
  addFrom(r: readonly SqlValue[], regs: readonly number[]): void {
    const i = this.rows++;
    for (let c = 0; c < this.ncols; c++) this.cols[c][i] = r[regs[c]];
    if (this.rows === ROW_GROUP_ROWS) this.flush();
  }

  /** Write the last partial row group and the header; returns the row count. */
  finish(): number {
    if (this.ncols > 0 && this.rows > 0) this.flush();
    const h = new Uint8Array(12);
    const v = new DataView(h.buffer);
    v.setUint32(0, this.rg, true);
    v.setFloat64(4, this.total, true);
    this.put(chunkKey(HEADER_RG, 0), h);
    this.loader.finish();
    return this.total;
  }

  private put(key: Uint8Array, value: Uint8Array): void {
    this.loader.add(key, 0, key.length, value);
  }

  private flush(): void {
    const rows = this.rows;
    const zones: Zone[] = [];
    for (let c = 0; c < this.ncols; c++) {
      const col = this.cols[c];
      if (rows < col.length) col.length = rows; // last, partial row group
      const { bytes, zone } = this.enc.encode(col);
      this.put(chunkKey(this.rg, c), bytes);
      zones.push(zone);
    }
    this.put(chunkKey(this.rg, META_COL), encodeMeta(rows, zones));
    this.rg++;
    this.total += rows;
    this.rows = 0;
  }
}

class ByteWriter {
  buf = new Uint8Array(1024);
  view = new DataView(this.buf.buffer);
  len = 0;
  ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.len + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
  u8(x: number): void {
    this.ensure(1);
    this.buf[this.len++] = x;
  }
  u16(x: number): void {
    this.ensure(2);
    this.view.setUint16(this.len, x, true);
    this.len += 2;
  }
  u32(x: number): void {
    this.ensure(4);
    this.view.setUint32(this.len, x, true);
    this.len += 4;
  }
  f64(x: number): void {
    this.ensure(8);
    this.view.setFloat64(this.len, x, true);
    this.len += 8;
  }
  bytes(b: Uint8Array): void {
    this.ensure(b.length);
    this.buf.set(b, this.len);
    this.len += b.length;
  }
  align(n: number): void {
    while (this.len % n !== 0) this.u8(0);
  }
  result(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

const MAX_ZONE_TEXT = 64;
const SURROGATE = /[\uD800-\uDFFF]/;

/** Encodes column chunks, reusing its byte buffers between chunks. */
class ChunkEncoder {
  private readonly w = new ByteWriter();
  private text = new Uint8Array(1 << 16);

  encode(vals: SqlValue[]): { bytes: Uint8Array; zone: Zone } {
    this.w.len = 0;
    return encodeChunk(vals, this.w, this);
  }

  /** UTF-8 of every string in `vals` into one buffer; ends[i] = end offset of value i. */
  utf8All(vals: SqlValue[], ends: Uint32Array): Uint8Array {
    let pos = 0;
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (typeof v === 'string') {
        if (pos + v.length * 3 > this.text.length) {
          const next = new Uint8Array(Math.max(this.text.length * 2, pos + v.length * 3));
          next.set(this.text.subarray(0, pos));
          this.text = next;
        }
        pos += textEncoder.encodeInto(v, this.text.subarray(pos)).written;
      }
      ends[i] = pos;
    }
    return this.text.subarray(0, pos);
  }
}

function encodeChunk(vals: SqlValue[], w: ByteWriter, ce: ChunkEncoder): { bytes: Uint8Array; zone: Zone } {
  const n = vals.length;
  let nulls = 0;
  let allNum = true;
  let allInt32 = true;
  let allStr = true;
  let allBlob = true;
  let numMin = Infinity;
  let numMax = -Infinity;
  let textMin: string | undefined;
  let textMax: string | undefined;
  let textZone = true;
  for (const v of vals) {
    if (v === null) {
      nulls++;
      continue;
    }
    if (typeof v === 'number') {
      allStr = allBlob = false;
      if (v < numMin) numMin = v;
      if (v > numMax) numMax = v;
      if (!(v === (v | 0) && !Object.is(v, -0))) allInt32 = false;
    } else if (typeof v === 'string') {
      allNum = allInt32 = allBlob = false;
      // At most 3 UTF-8 bytes per UTF-16 unit: short strings need no encoding to check.
      if (textZone && v.length * 3 > MAX_ZONE_TEXT && textEncoder.encode(v).length > MAX_ZONE_TEXT) textZone = false;
      // UTF-16 order equals code point (BINARY) order unless surrogates are involved.
      if (textMin === undefined) textMin = textMax = v;
      else if (SURROGATE.test(v) || SURROGATE.test(textMin) || SURROGATE.test(textMax!)) {
        if (binaryLess(v, textMin)) textMin = v;
        if (binaryLess(textMax!, v)) textMax = v;
      } else {
        if (v < textMin) textMin = v;
        if (v > textMax!) textMax = v;
      }
    } else {
      allNum = allInt32 = allStr = false;
      if (!(v instanceof Uint8Array)) allBlob = false;
    }
  }
  const zone: Zone = { nulls };
  const nonNull = n - nulls;
  let enc: number;
  if (nonNull === 0) enc = ENC_NULLS;
  else if (allNum) enc = allInt32 ? ENC_I32 : ENC_F64;
  else if (allStr) enc = ENC_STR;
  else if (allBlob) enc = ENC_BLOB;
  else enc = ENC_ANY;
  if (enc === ENC_I32 || enc === ENC_F64) {
    zone.numMin = numMin;
    zone.numMax = numMax;
  }
  if (enc === ENC_STR && textZone) {
    zone.textMin = textMin;
    zone.textMax = textMax;
  }
  // Dictionary when values repeat (at most half as many distinct values as rows).
  let dict: Map<string, number> | null = null;
  if (enc === ENC_STR) {
    dict = new Map();
    for (const v of vals) {
      if (v !== null && !dict.has(v as string)) {
        dict.set(v as string, dict.size);
        if (dict.size > nonNull / 2) break;
      }
    }
    if (dict.size <= nonNull / 2) enc = ENC_DICT;
    else dict = null;
  }
  w.u8(enc);
  w.u8(nulls > 0 && enc !== ENC_NULLS ? 1 : 0);
  w.u16(0);
  w.u32(n);
  if (nulls > 0 && enc !== ENC_NULLS) {
    const bm = new Uint8Array((n + 7) >>> 3);
    for (let i = 0; i < n; i++) if (vals[i] === null) bm[i >>> 3] |= 1 << (i & 7);
    w.bytes(bm);
  }
  w.align(8);
  switch (enc) {
    case ENC_F64: {
      // The payload starts 8-byte aligned in the writer's buffer: write through a typed view.
      w.ensure(8 * n);
      const f = new Float64Array(w.buf.buffer, w.len, n);
      for (let i = 0; i < n; i++) {
        const v = vals[i];
        f[i] = v === null ? 0 : (v as number);
      }
      w.len += 8 * n;
      break;
    }
    case ENC_I32: {
      w.ensure(4 * n);
      const a = new Int32Array(w.buf.buffer, w.len, n);
      for (let i = 0; i < n; i++) {
        const v = vals[i];
        a[i] = v === null ? 0 : (v as number);
      }
      w.len += 4 * n;
      break;
    }
    case ENC_DICT: {
      const entries = [...dict!.keys()];
      const enc8 = entries.map((s) => textEncoder.encode(s));
      const wide = entries.length > 65535;
      w.u32(entries.length);
      w.u32(wide ? 4 : 2);
      let off = 0;
      for (const b of enc8) {
        w.u32(off);
        off += b.length;
      }
      w.u32(off);
      for (const b of enc8) w.bytes(b);
      w.align(4);
      for (const v of vals) {
        const code = v === null ? 0 : dict!.get(v as string)!;
        if (wide) w.u32(code);
        else w.u16(code);
      }
      break;
    }
    case ENC_STR: {
      const ends = new Uint32Array(n);
      const text = ce.utf8All(vals, ends);
      w.ensure(4 * (n + 1));
      w.u32(0);
      for (let i = 0; i < n; i++) w.u32(ends[i]);
      w.bytes(text);
      break;
    }
    case ENC_BLOB: {
      let off = 0;
      for (const v of vals) {
        w.u32(off);
        off += v === null ? 0 : (v as Uint8Array).length;
      }
      w.u32(off);
      for (const v of vals) if (v !== null) w.bytes(v as Uint8Array);
      break;
    }
    case ENC_ANY:
      for (const v of vals) {
        if (v === null) w.u8(0);
        else if (typeof v === 'number') {
          w.u8(1);
          w.f64(v);
        } else if (typeof v === 'bigint') {
          w.u8(2);
          w.ensure(8);
          w.view.setBigInt64(w.len, v, true);
          w.len += 8;
        } else if (typeof v === 'string') {
          const b = textEncoder.encode(v);
          w.u8(3);
          w.u32(b.length);
          w.bytes(b);
        } else {
          w.u8(4);
          w.u32(v.length);
          w.bytes(v);
        }
      }
      break;
  }
  return { bytes: w.result(), zone };
}

/** BINARY collation order of two strings (UTF-8 byte order = code point order). */
function binaryLess(a: string, b: string): boolean {
  // UTF-16 code unit order differs from code point order only for surrogates; compare by code point.
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a.codePointAt(i)!;
    const y = b.codePointAt(i)!;
    if (x !== y) return x < y;
    if (x > 0xffff) i++;
  }
  return a.length < b.length;
}

function encodeMeta(rows: number, zones: Zone[]): Uint8Array {
  const w = new ByteWriter();
  w.u32(rows);
  w.u16(zones.length);
  for (const z of zones) {
    w.u32(z.nulls);
    if (z.numMin !== undefined) {
      w.u8(1);
      w.f64(z.numMin);
      w.f64(z.numMax!);
    } else if (z.textMin !== undefined) {
      w.u8(2);
      for (const s of [z.textMin, z.textMax!]) {
        const b = textEncoder.encode(s);
        w.u16(b.length);
        w.bytes(b);
      }
    } else w.u8(0);
  }
  return w.result();
}

// ------------------------------------------------------------------ reading

function decodeMeta(b: Uint8Array): RowGroupMeta {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const rows = v.getUint32(0, true);
  const n = v.getUint16(4, true);
  let p = 6;
  const zones: Zone[] = [];
  for (let i = 0; i < n; i++) {
    const z: Zone = { nulls: v.getUint32(p, true) };
    const kind = b[p + 4];
    p += 5;
    if (kind === 1) {
      z.numMin = v.getFloat64(p, true);
      z.numMax = v.getFloat64(p + 8, true);
      p += 16;
    } else if (kind === 2) {
      const s: string[] = [];
      for (let k = 0; k < 2; k++) {
        const len = v.getUint16(p, true);
        s.push(textDecoder.decode(b.subarray(p + 2, p + 2 + len)));
        p += 2 + len;
      }
      z.textMin = s[0];
      z.textMax = s[1];
    }
    zones.push(z);
  }
  return { rows, zones };
}

function decodeChunk(b: Uint8Array): Chunk {
  // `b` is a fresh copy (offset 0), so typed-array views below are aligned.
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const enc = b[0];
  const hasNulls = (b[1] & 1) !== 0;
  const n = v.getUint32(4, true);
  let p = 8;
  let nulls: Uint8Array | null = null;
  if (hasNulls) {
    nulls = b.subarray(p, p + ((n + 7) >>> 3));
    p += (n + 7) >>> 3;
    p = (p + 7) & ~7;
  }
  const base = b.byteOffset;
  const out = { enc, count: n, nulls, num: null as Float64Array | Int32Array | null, dict: null as string[] | null, codes: null as Uint16Array | Uint32Array | null, vals: null as SqlValue[] | null, bytes: b.length };
  switch (enc) {
    case ENC_NULLS:
      break;
    case ENC_F64:
      out.num = new Float64Array(b.buffer, base + p, n);
      break;
    case ENC_I32:
      out.num = new Int32Array(b.buffer, base + p, n);
      break;
    case ENC_DICT: {
      const dn = v.getUint32(p, true);
      const width = v.getUint32(p + 4, true);
      p += 8;
      const offs = p;
      p += 4 * (dn + 1);
      const strBase = p;
      const dict: string[] = [];
      for (let i = 0; i < dn; i++) dict.push(textDecoder.decode(b.subarray(strBase + v.getUint32(offs + 4 * i, true), strBase + v.getUint32(offs + 4 * i + 4, true))));
      p = strBase + v.getUint32(offs + 4 * dn, true);
      p = (p + 3) & ~3;
      out.dict = dict;
      out.codes = width === 4 ? new Uint32Array(b.buffer, base + p, n) : new Uint16Array(b.buffer, base + p, n);
      out.bytes += dict.reduce((s, x) => s + 2 * x.length, 0);
      break;
    }
    case ENC_STR:
    case ENC_BLOB: {
      const offs = p;
      const dataBase = p + 4 * (n + 1);
      const vals: SqlValue[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const s = dataBase + v.getUint32(offs + 4 * i, true);
        const e = dataBase + v.getUint32(offs + 4 * i + 4, true);
        vals[i] = enc === ENC_STR ? textDecoder.decode(b.subarray(s, e)) : b.slice(s, e);
      }
      out.vals = vals;
      break;
    }
    case ENC_ANY: {
      const vals: SqlValue[] = new Array(n);
      for (let i = 0; i < n; i++) {
        const tag = b[p++];
        if (tag === 0) vals[i] = null;
        else if (tag === 1) {
          vals[i] = v.getFloat64(p, true);
          p += 8;
        } else if (tag === 2) {
          const x = v.getBigInt64(p, true);
          vals[i] = x >= -(2n ** 53n) && x <= 2n ** 53n ? Number(x) : x;
          p += 8;
        } else {
          const len = v.getUint32(p, true);
          const s = b.subarray(p + 4, p + 4 + len);
          vals[i] = tag === 3 ? textDecoder.decode(s) : s.slice();
          p += 4 + len;
        }
      }
      out.vals = vals;
      break;
    }
    default:
      throw new CorruptionError(`invalid column chunk encoding ${enc}`);
  }
  return out;
}

/**
 * Reader over a column store, with a cache of decoded chunks. Segments never change in place (a
 * refresh writes a new tree), so the cache only has to be dropped when the store is replaced.
 */
export class ColumnStore {
  private readonly cache = new Map<number, Chunk | RowGroupMeta>();
  private cachedBytes = 0;
  private header: { rowGroups: number; rows: number } | null = null;

  constructor(
    readonly tree: BTree,
    /** Decoded-chunk cache budget in bytes; the cache is cleared when it is exceeded. */
    private readonly budget = 64 << 20,
  ) {}

  private head(): { rowGroups: number; rows: number } {
    if (this.header === null) {
      const h = this.tree.get(chunkKey(HEADER_RG, 0));
      if (h === undefined) this.header = { rowGroups: 0, rows: 0 };
      else {
        const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
        this.header = { rowGroups: v.getUint32(0, true), rows: v.getFloat64(4, true) };
      }
    }
    return this.header;
  }

  get rowGroups(): number {
    return this.head().rowGroups;
  }

  get rows(): number {
    return this.head().rows;
  }

  meta(rg: number): RowGroupMeta {
    const key = rg * 65536 + META_COL;
    let m = this.cache.get(key) as RowGroupMeta | undefined;
    if (m === undefined) {
      const b = this.tree.get(chunkKey(rg, META_COL));
      if (b === undefined) throw new CorruptionError(`column store: row group ${rg} has no metadata`);
      m = decodeMeta(b);
      this.cache.set(key, m);
    }
    return m;
  }

  chunk(rg: number, col: number): Chunk {
    const key = rg * 65536 + col;
    let c = this.cache.get(key) as Chunk | undefined;
    if (c === undefined) {
      const b = this.tree.get(chunkKey(rg, col));
      if (b === undefined) throw new CorruptionError(`column store: missing chunk (${rg}, ${col})`);
      c = decodeChunk(b);
      if (this.cachedBytes + c.bytes > this.budget) {
        this.cache.clear();
        this.cachedBytes = 0;
      }
      this.cache.set(key, c);
      this.cachedBytes += c.bytes;
    }
    return c;
  }
}

/** Zone-map test: can a row group contain rows where `column op value` holds? (Conservative.) */
export function zoneMayMatch(z: Zone, rows: number, op: string, value: SqlValue, binaryText: boolean): boolean {
  if (value === null) return true; // comparisons with NULL: leave it to the filter
  if (z.nulls === rows) return false; // every value NULL: no comparison is true
  let lo: number | string;
  let hi: number | string;
  let x: number | string;
  if (typeof value === 'number' && z.numMin !== undefined) {
    lo = z.numMin;
    hi = z.numMax!;
    x = value;
  } else if (typeof value === 'string' && binaryText && z.textMin !== undefined) {
    lo = z.textMin;
    hi = z.textMax!;
    x = value;
    const lt = (a: string, b: string): boolean => binaryLess(a, b);
    switch (op) {
      case '=':
        return !lt(x, lo) && !lt(hi, x);
      case '<':
        return lt(lo, x);
      case '<=':
        return !lt(x, lo);
      case '>':
        return lt(x, hi);
      case '>=':
        return !lt(hi, x);
      default:
        return true;
    }
  } else return true;
  switch (op) {
    case '=':
      return x >= lo && x <= hi;
    case '<':
      return lo < x;
    case '<=':
      return lo <= x;
    case '>':
      return hi > x;
    case '>=':
      return hi >= x;
    default:
      return true;
  }
}
