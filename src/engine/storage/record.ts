import { CorruptionError } from '../errors.js';
import { type SqlValue, normalizeInt } from '../values.js';

/**
 * Row record format (table B+tree values). See docs/STORAGE_FORMAT.md §3.
 *
 *   u8  flags        bit0: var-offset width is u32 (else u16)
 *   u16 n            number of columns physically present (columns added later read their default)
 *   null bitmap      ceil(n / 8) bytes, bit i set = column i is NULL
 *   fixed area       INTEGER (int64 as u32 lo + i32 hi) and REAL (float64) columns at fixed offsets
 *   var offsets      end offset (relative to var data start) of each TEXT/BLOB/ANY/NUMERIC column
 *   var data         TEXT as UTF-8, BLOB raw, ANY/NUMERIC as tag byte + payload
 *
 * Fixed-width columns are directly addressable, and any single column decodes without touching the
 * others. All multi-byte fields are little-endian.
 */

export type StorageType = 'INTEGER' | 'REAL' | 'TEXT' | 'BLOB' | 'ANY' | 'NUMERIC';

const TAG_INT = 1;
const TAG_REAL = 2;
const TAG_TEXT = 3;
const TAG_BLOB = 4;

const TWO_32 = 4294967296;
const HI_SAFE_MIN = -2097152; // hi words whose int64 value is within ±2^53
const HI_SAFE_MAX = 2097151;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function isFixed(t: StorageType): boolean {
  return t === 'INTEGER' || t === 'REAL';
}

interface PartialLayout {
  n: number;
  fixedSize: number;
  varCount: number;
  /** Per column: offset within the fixed area (fixed types) or index into the var table. */
  slot: Int32Array;
}

/** Precomputed offsets for a table's column types. Immutable; shared by encoders/readers. */
export class RecordLayout {
  readonly fixed: Uint8Array;
  private readonly partial = new Map<number, PartialLayout>();
  readonly full: PartialLayout;

  constructor(readonly types: readonly StorageType[]) {
    this.fixed = Uint8Array.from(types, (t) => (isFixed(t) ? 1 : 0));
    this.full = this.computeFor(types.length);
  }

  /** Layout of a record that stores only the first `n` columns. */
  forCount(n: number): PartialLayout {
    if (n === this.types.length) return this.full;
    let p = this.partial.get(n);
    if (p === undefined) {
      if (n > this.types.length) throw new CorruptionError(`record has ${n} columns, table has ${this.types.length}`);
      p = this.computeFor(n);
      this.partial.set(n, p);
    }
    return p;
  }

  private computeFor(n: number): PartialLayout {
    const slot = new Int32Array(n);
    let fixedSize = 0;
    let varCount = 0;
    for (let i = 0; i < n; i++) {
      if (this.fixed[i]) {
        slot[i] = fixedSize;
        fixedSize += 8;
      } else {
        slot[i] = varCount++;
      }
    }
    return { n, fixedSize, varCount, slot };
  }
}

/** Encodes rows into a reusable buffer. `encode` returns a view that is valid until the next call. */
export class RecordEncoder {
  private buf = new Uint8Array(256);
  private view = new DataView(this.buf.buffer);
  private readonly varEnds: Int32Array;

  constructor(readonly layout: RecordLayout) {
    this.varEnds = new Int32Array(layout.full.varCount);
  }

  /**
   * Encode `values` (one per table column, already coerced to the column's storage type).
   * INTEGER columns take number (integral) or bigint; REAL takes number; TEXT string; BLOB Uint8Array.
   */
  encode(values: readonly SqlValue[]): Uint8Array {
    const layout = this.layout;
    const L = layout.full;
    const n = L.n;
    const types = layout.types;
    const bitmapSize = (n + 7) >>> 3;

    // Pass 1: var sizes (upper bound for text: 3 bytes per UTF-16 unit).
    let varBound = 0;
    for (let i = 0; i < n; i++) {
      if (layout.fixed[i]) continue;
      const v = values[i];
      if (v === null) continue;
      if (typeof v === 'string') varBound += v.length * 3 + 1;
      else if (v instanceof Uint8Array) varBound += v.length + 1;
      else varBound += 9;
    }
    const wideGuess = varBound > 0xffff;
    const offWidth = wideGuess ? 4 : 2;
    const headerSize = 3 + bitmapSize;
    const fixedStart = headerSize;
    const varTableStart = fixedStart + L.fixedSize;
    const varDataStart = varTableStart + L.varCount * offWidth;
    this.ensure(varDataStart + varBound);
    const b = this.buf;
    const dv = this.view;
    b.fill(0, 0, varDataStart);
    b[0] = wideGuess ? 1 : 0;
    dv.setUint16(1, n, true);

    let pos = varDataStart;
    for (let i = 0; i < n; i++) {
      const v = values[i];
      const t = types[i];
      if (v === null || v === undefined) {
        b[3 + (i >>> 3)] |= 1 << (i & 7);
        if (!layout.fixed[i]) this.varEnds[L.slot[i]] = pos - varDataStart;
        continue;
      }
      if (t === 'INTEGER') {
        writeInt64(dv, fixedStart + L.slot[i], v as number | bigint);
      } else if (t === 'REAL') {
        dv.setFloat64(fixedStart + L.slot[i], typeof v === 'bigint' ? Number(v) : (v as number), true);
      } else {
        if (t === 'TEXT') {
          pos += textEncoder.encodeInto(v as string, b.subarray(pos)).written;
        } else if (t === 'BLOB') {
          b.set(v as Uint8Array, pos);
          pos += (v as Uint8Array).length;
        } else {
          pos = writeTagged(b, dv, pos, v);
        }
        this.varEnds[L.slot[i]] = pos - varDataStart;
      }
    }
    for (let j = 0; j < L.varCount; j++) {
      if (wideGuess) dv.setUint32(varTableStart + 4 * j, this.varEnds[j], true);
      else dv.setUint16(varTableStart + 2 * j, this.varEnds[j], true);
    }
    return b.subarray(0, pos);
  }

  private ensure(n: number): void {
    if (n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < n) cap *= 2;
    this.buf = new Uint8Array(cap);
    this.view = new DataView(this.buf.buffer);
  }
}

function writeInt64(dv: DataView, off: number, v: number | bigint): void {
  if (typeof v === 'number') {
    const hi = Math.floor(v / TWO_32);
    dv.setUint32(off, v - hi * TWO_32, true);
    dv.setInt32(off + 4, hi, true);
  } else {
    dv.setBigInt64(off, v, true);
  }
}

export function readInt64(dv: DataView, off: number): number | bigint {
  const lo = dv.getUint32(off, true);
  const hi = dv.getInt32(off + 4, true);
  if (hi >= HI_SAFE_MIN && hi <= HI_SAFE_MAX) return hi * TWO_32 + lo;
  return normalizeInt(dv.getBigInt64(off, true));
}

function writeTagged(b: Uint8Array, dv: DataView, pos: number, v: SqlValue): number {
  switch (typeof v) {
    case 'number':
      if (Number.isInteger(v) && v >= -9007199254740991 && v <= 9007199254740991) {
        b[pos] = TAG_INT;
        writeInt64(dv, pos + 1, v);
      } else {
        b[pos] = TAG_REAL;
        dv.setFloat64(pos + 1, v, true);
      }
      return pos + 9;
    case 'bigint':
      b[pos] = TAG_INT;
      dv.setBigInt64(pos + 1, v, true);
      return pos + 9;
    case 'string':
      b[pos] = TAG_TEXT;
      return pos + 1 + textEncoder.encodeInto(v, b.subarray(pos + 1)).written;
    default: {
      const blob = v as Uint8Array;
      b[pos] = TAG_BLOB;
      b.set(blob, pos + 1);
      return pos + 1 + blob.length;
    }
  }
}

/** Decode an ANY/NUMERIC (tagged) value stored in [start, end). */
export function decodeTagged(b: Uint8Array, dv: DataView, start: number, end: number): SqlValue {
  switch (b[start]) {
    case TAG_INT:
      return readInt64(dv, start + 1);
    case TAG_REAL:
      return dv.getFloat64(start + 1, true);
    case TAG_TEXT:
      return decodeUtf8(b, start + 1, end);
    case TAG_BLOB:
      return b.slice(start + 1, end);
    default:
      throw new CorruptionError(`invalid value tag ${b[start]}`);
  }
}

/** Fast UTF-8 decode: short ASCII strings avoid TextDecoder call overhead. */
/**
 * Longest ASCII string decoded in JS. Node's TextDecoder is native and fast, so there only short
 * strings (where the call overhead dominates) are built in JS.
 */
const JS_DECODE_MAX = typeof (globalThis as { process?: { versions?: { node?: string } } }).process?.versions?.node === 'string' ? 24 : 64;

export function decodeUtf8(b: Uint8Array, start: number, end: number): string {
  const len = end - start;
  if (len === 0) return '';
  // Short ASCII strings (most text values) are built in JS, 8 characters per call: TextDecoder is a
  // host call, slower per call in browsers and contended across workers in Chromium. Measured on
  // 32-byte strings: 3x faster than TextDecoder in a Chromium worker, slightly faster in Node.
  if (len <= JS_DECODE_MAX) {
    let s = '';
    let i = start;
    for (; i + 8 <= end; i += 8) {
      const c0 = b[i], c1 = b[i + 1], c2 = b[i + 2], c3 = b[i + 3], c4 = b[i + 4], c5 = b[i + 5], c6 = b[i + 6], c7 = b[i + 7];
      if ((c0 | c1 | c2 | c3 | c4 | c5 | c6 | c7) & 0x80) return textDecoder.decode(b.subarray(start, end));
      s += String.fromCharCode(c0, c1, c2, c3, c4, c5, c6, c7);
    }
    for (; i < end; i++) {
      const c = b[i];
      if (c & 0x80) return textDecoder.decode(b.subarray(start, end));
      s += String.fromCharCode(c);
    }
    return s;
  }
  return textDecoder.decode(b.subarray(start, end));
}

/**
 * Reads columns of one record in place (no copy). Call {@link reset} for each record; the
 * underlying bytes must stay unchanged while reading (e.g. the cursor must not move).
 */
export class RecordReader {
  private b: Uint8Array = new Uint8Array(0);
  private dv: DataView = new DataView(new ArrayBuffer(0));
  private dvBuffer: ArrayBufferLike | null = null;
  private n = 0;
  private wide = false;
  private fixedStart = 0;
  private varTableStart = 0;
  private varDataStart = 0;
  private part: PartialLayout;

  constructor(
    readonly layout: RecordLayout,
    /** Values for columns missing from older records (ALTER TABLE ADD COLUMN). */
    private readonly defaults: readonly SqlValue[] = [],
  ) {
    this.part = layout.full;
  }

  reset(bytes: Uint8Array, offset: number, length: number): void {
    if (bytes.buffer !== this.dvBuffer) {
      this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      this.dvBuffer = bytes.buffer;
    } else if (this.dv.byteOffset !== bytes.byteOffset || this.dv.byteLength !== bytes.byteLength) {
      this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    this.b = bytes;
    const n = this.dv.getUint16(offset + 1, true);
    this.n = n;
    this.wide = (bytes[offset] & 1) === 1;
    this.part = n === this.layout.full.n ? this.layout.full : this.layout.forCount(n);
    this.fixedStart = offset + 3 + ((n + 7) >>> 3);
    this.varTableStart = this.fixedStart + this.part.fixedSize;
    this.varDataStart = this.varTableStart + this.part.varCount * (this.wide ? 4 : 2);
    if (this.varDataStart > offset + length) throw new CorruptionError('record header overruns record');
  }

  get columnCount(): number {
    return this.n;
  }

  isNull(i: number): boolean {
    if (i >= this.n) return (this.defaults[i] ?? null) === null;
    return (this.b[this.fixedStart - ((this.n + 7) >>> 3) + (i >>> 3)] & (1 << (i & 7))) !== 0;
  }

  column(i: number): SqlValue {
    if (i >= this.n) return this.defaults[i] ?? null;
    const b = this.b;
    const bitmapStart = this.fixedStart - ((this.n + 7) >>> 3);
    if (b[bitmapStart + (i >>> 3)] & (1 << (i & 7))) return null;
    const t = this.layout.types[i];
    const slot = this.part.slot[i];
    if (t === 'INTEGER') return readInt64(this.dv, this.fixedStart + slot);
    if (t === 'REAL') return this.dv.getFloat64(this.fixedStart + slot, true);
    const end = this.varDataStart + this.varEnd(slot);
    const start = slot === 0 ? this.varDataStart : this.varDataStart + this.varEnd(slot - 1);
    if (t === 'TEXT') return decodeUtf8(b, start, end);
    if (t === 'BLOB') return b.slice(start, end);
    switch (b[start]) {
      case TAG_INT:
        return readInt64(this.dv, start + 1);
      case TAG_REAL:
        return this.dv.getFloat64(start + 1, true);
      case TAG_TEXT:
        return decodeUtf8(b, start + 1, end);
      case TAG_BLOB:
        return b.slice(start + 1, end);
      default:
        throw new CorruptionError(`invalid value tag ${b[start]}`);
    }
  }

  /** For ANY/NUMERIC columns: true if the stored value is a REAL (even when integral). */
  isStoredReal(i: number): boolean {
    const t = this.layout.types[i];
    if (t === 'REAL') return !this.isNull(i);
    if (t === 'INTEGER' || t === 'TEXT' || t === 'BLOB' || i >= this.n || this.isNull(i)) return false;
    const slot = this.part.slot[i];
    const start = slot === 0 ? this.varDataStart : this.varDataStart + this.varEnd(slot - 1);
    return this.b[start] === TAG_REAL;
  }

  private varEnd(j: number): number {
    return this.wide ? this.dv.getUint32(this.varTableStart + 4 * j, true) : this.dv.getUint16(this.varTableStart + 2 * j, true);
  }
}
