import { CorruptionError } from '../errors.js';

/**
 * Order-preserving ("memcmp-comparable") key encoding for index and table keys.
 *
 * Byte-wise comparison of encoded keys gives the same order as SQLite value comparison:
 * NULL < numbers (INTEGER and REAL compared numerically) < TEXT (by collation) < BLOB.
 *
 *   NULL   0x05
 *   number 0x15 | 8-byte order-preserving float64 (big-endian) | u16 (delta + 0x8000)
 *          `delta` is the exact integer minus its nearest double, so int64 values beyond 2^53 order
 *          correctly against each other and against REALs. NaN is NULL, -0 is 0.
 *   text   0x25 | collated UTF-8, 0x00 escaped as 00 FF | 00 00
 *   blob   0x35 | bytes, 0x00 escaped as 00 FF | 00 00
 *
 * Each component is prefix-free, so a DESC column is encoded by inverting its bytes.
 */

export type SqlValue = null | number | bigint | string | Uint8Array;

export const Collation = { Binary: 0, NoCase: 1, RTrim: 2 } as const;
export type Collation = (typeof Collation)[keyof typeof Collation];

export interface KeyColumn {
  desc?: boolean;
  collation?: Collation;
}

const TAG_NULL = 0x05;
const TAG_NUM = 0x15;
const TAG_TEXT = 0x25;
const TAG_BLOB = 0x35;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const BIG_2_53 = 2n ** 53n;

export class KeyEncoder {
  private buf = new Uint8Array(64);
  private view = new DataView(this.buf.buffer);
  private len = 0;
  private tmp = new Uint8Array(64);

  reset(): this {
    this.len = 0;
    return this;
  }

  get length(): number {
    return this.len;
  }

  /** Copy of the encoded key. */
  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }

  add(value: SqlValue, col?: KeyColumn): this {
    const start = this.len;
    if (value === null) this.putByte(TAG_NULL);
    else if (typeof value === 'number') this.addNumberRaw(value, 0);
    else if (typeof value === 'bigint') this.addBigIntRaw(value);
    else if (typeof value === 'string') this.addTextRaw(value, col?.collation ?? Collation.Binary);
    else this.addEscaped(TAG_BLOB, value, value.length);
    if (col?.desc) this.invert(start);
    return this;
  }

  private addNumberRaw(v: number, delta: number): void {
    if (Number.isNaN(v)) {
      this.putByte(TAG_NULL);
      return;
    }
    if (v === 0) v = 0; // normalize -0
    this.ensure(11);
    const b = this.buf;
    const o = this.len;
    b[o] = TAG_NUM;
    this.view.setFloat64(o + 1, v, false);
    if (b[o + 1] & 0x80) {
      for (let i = 1; i <= 8; i++) b[o + i] = ~b[o + i] & 0xff;
    } else {
      b[o + 1] |= 0x80;
    }
    this.view.setUint16(o + 9, delta + 0x8000, false);
    this.len = o + 11;
  }

  private addBigIntRaw(v: bigint): void {
    if (v > -BIG_2_53 && v < BIG_2_53) {
      this.addNumberRaw(Number(v), 0);
      return;
    }
    const d = Number(v); // nearest double (integral)
    this.addNumberRaw(d, Number(v - BigInt(d)));
  }

  private addTextRaw(s: string, collation: Collation): void {
    const max = s.length * 3;
    if (this.tmp.length < max) this.tmp = new Uint8Array(Math.max(max, this.tmp.length * 2));
    let n = textEncoder.encodeInto(s, this.tmp).written;
    const t = this.tmp;
    if (collation === Collation.NoCase) {
      for (let i = 0; i < n; i++) {
        const c = t[i];
        if (c >= 0x41 && c <= 0x5a) t[i] = c + 0x20;
      }
    } else if (collation === Collation.RTrim) {
      while (n > 0 && t[n - 1] === 0x20) n--;
    }
    this.addEscaped(TAG_TEXT, t, n);
  }

  private addEscaped(tag: number, src: Uint8Array, n: number): void {
    this.ensure(2 * n + 3);
    const b = this.buf;
    let o = this.len;
    b[o++] = tag;
    for (let i = 0; i < n; i++) {
      const c = src[i];
      b[o++] = c;
      if (c === 0) b[o++] = 0xff;
    }
    b[o++] = 0;
    b[o++] = 0;
    this.len = o;
  }

  private putByte(x: number): void {
    this.ensure(1);
    this.buf[this.len++] = x;
  }

  private invert(start: number): void {
    const b = this.buf;
    for (let i = start; i < this.len; i++) b[i] = ~b[i] & 0xff;
  }

  private ensure(extra: number): void {
    const need = this.len + extra;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }
}

const sharedEncoder = new KeyEncoder();

/** Encode a tuple of values as a single comparable key. */
export function encodeKey(values: readonly SqlValue[], cols?: readonly KeyColumn[]): Uint8Array {
  const e = sharedEncoder.reset();
  for (let i = 0; i < values.length; i++) e.add(values[i], cols?.[i]);
  return e.finish();
}

/**
 * Decode a key produced by {@link encodeKey}. `cols` must match the encoding's DESC flags.
 * NOCASE/RTRIM text decodes to its collated form (the original is not recoverable).
 * Integers beyond 2^53 decode as bigint; other numbers as number.
 */
export function decodeKey(key: Uint8Array, cols?: readonly KeyColumn[]): SqlValue[] {
  const out: SqlValue[] = [];
  let pos = 0;
  let col = 0;
  while (pos < key.length) {
    const desc = cols?.[col]?.desc === true;
    const flip = desc ? 0xff : 0;
    const tag = key[pos] ^ flip;
    if (tag === TAG_NULL) {
      out.push(null);
      pos += 1;
    } else if (tag === TAG_NUM) {
      if (pos + 11 > key.length) throw new CorruptionError('truncated numeric key');
      const raw = new Uint8Array(8);
      for (let i = 0; i < 8; i++) raw[i] = key[pos + 1 + i] ^ flip;
      if (raw[0] & 0x80) raw[0] &= 0x7f;
      else for (let i = 0; i < 8; i++) raw[i] = ~raw[i] & 0xff;
      const d = new DataView(raw.buffer).getFloat64(0, false);
      const delta = (((key[pos + 9] ^ flip) << 8) | (key[pos + 10] ^ flip)) - 0x8000;
      out.push(delta === 0 ? d : BigInt(d) + BigInt(delta));
      pos += 11;
    } else if (tag === TAG_TEXT || tag === TAG_BLOB) {
      const bytes: number[] = [];
      pos++;
      for (;;) {
        if (pos >= key.length) throw new CorruptionError('unterminated key component');
        const c = key[pos++] ^ flip;
        if (c === 0) {
          const nx = key[pos++] ^ flip;
          if (nx === 0) break;
          if (nx !== 0xff) throw new CorruptionError('invalid escape in key');
          bytes.push(0);
        } else {
          bytes.push(c);
        }
      }
      const u8 = Uint8Array.from(bytes);
      out.push(tag === TAG_TEXT ? textDecoder.decode(u8) : u8);
    } else {
      throw new CorruptionError(`invalid key tag 0x${tag.toString(16)}`);
    }
    col++;
  }
  return out;
}
