import { CorruptionError } from '../errors.js';

/**
 * Order-preserving ("memcmp-comparable") key encoding for index keys (format 2, ADR 0006).
 *
 * Byte-wise comparison of encoded keys gives the same order as SQLite value comparison:
 * NULL < numbers (INTEGER and REAL compared numerically) < TEXT (by collation) < BLOB.
 *
 *   NULL   0x01
 *   number |v| = 1.m × 2^E, encoded by sign and E:
 *            0x02            negative, E >= 64     | ~u16 E        | ~mantissa
 *            0x03..0x42      negative, E = 63..0   |               | ~mantissa
 *            0x43            negative, E < 0       | ~u16 (E+1100) | ~mantissa
 *            0x44            zero
 *            0x45            positive, E < 0       | u16 (E+1100)  | mantissa
 *            0x46..0x85      positive, E = 0..63   |               | mantissa
 *            0x86            positive, E >= 64     | u16 E         | mantissa
 *          mantissa = the bits after the leading 1, in 7-bit groups from the most significant,
 *          trailing all-zero groups dropped; byte = group << 1 | (1 if another group follows).
 *          No groups (a power of two) is the single byte 0x00. So 1..127 take 2 bytes, up to 2^14
 *          3 bytes, a double with a full mantissa 9 bytes, any int64 at most 10 bytes. Values are
 *          exact: int64 beyond 2^53 orders correctly against REALs. -0 is 0.
 *   NaN    0x87: after every number, Infinity included, and equal to itself (ADR 0018)
 *   text   0x90 | collated UTF-8, 0x00 escaped as 00 FF | 00 00
 *   blob   0xA0 | bytes, 0x00 escaped as 00 FF | 00 00
 *
 * Each component is prefix-free, so a DESC column is encoded by inverting its bytes. No tag (nor
 * inverted tag) is 0x00 or 0xFF, so appending 0xFF to a complete component bounds all its extensions.
 *
 * Index entries end with a rowid suffix: the rowid as a number component followed by one byte
 * holding that component's length, so the rowid is found from the end of the key
 * ({@link rowidSuffixStart}).
 */

import { Collation, type SqlValue } from '../values.js';

export { Collation, type SqlValue };

export interface KeyColumn {
  desc?: boolean;
  collation?: Collation;
}

const TAG_NULL = 0x01;
const TAG_NEG_HUGE = 0x02;
const TAG_NEG_E0 = 0x42; // negative with exponent E: TAG_NEG_E0 - E
const TAG_NEG_TINY = 0x43;
const TAG_ZERO = 0x44;
const TAG_POS_TINY = 0x45;
const TAG_POS_E0 = 0x46; // positive with exponent E: TAG_POS_E0 + E
const TAG_POS_HUGE = 0x86;
const TAG_NAN = 0x87;
const TAG_TEXT = 0x90;
const TAG_BLOB = 0xa0;
const TINY_BIAS = 1100;

/** One byte past every NULL component: a lower bound that skips NULLs of an ascending column. */
export const KEY_AFTER_NULL: Uint8Array = Uint8Array.of(TAG_NULL + 1);

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const BIG_2_53 = 2n ** 53n;
const TWO_32 = 4294967296;

const f64 = new Float64Array(1);
const f64u = new Uint32Array(f64.buffer); // little-endian host: [lo, hi]
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const LO = LITTLE ? 0 : 1;
const HI = LITTLE ? 1 : 0;

export class KeyEncoder {
  private buf = new Uint8Array(64);
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

  /** The encoded key without copying; valid until the next reset or add. */
  view(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }

  add(value: SqlValue, col?: KeyColumn): this {
    const start = this.len;
    if (value === null) this.putByte(TAG_NULL);
    else if (typeof value === 'number') this.addNumber(value);
    else if (typeof value === 'bigint') this.addBigInt(value);
    else if (typeof value === 'string') this.addTextRaw(value, col?.collation ?? Collation.Binary);
    else this.addEscaped(TAG_BLOB, value, value.length);
    if (col?.desc) this.invert(start);
    return this;
  }

  /** Append an index entry's rowid suffix (number component + its length byte). */
  addRowid(rowid: number | bigint): this {
    const start = this.len;
    if (typeof rowid === 'number') this.addNumber(rowid);
    else this.addBigInt(rowid);
    this.putByte(this.len - start);
    return this;
  }

  private addNumber(v: number): void {
    if (v !== v) {
      this.putByte(TAG_NAN);
      return;
    }
    if (v === 0) {
      this.putByte(TAG_ZERO);
      return;
    }
    this.ensure(12);
    const neg = v < 0;
    const a = neg ? -v : v;
    const start = this.len;
    if (a < 2147483648 && a === Math.floor(a)) {
      // Small integer: exponent from the highest bit, mantissa = the bits below it.
      const e = 31 - Math.clz32(a);
      this.buf[this.len++] = neg ? TAG_NEG_E0 - e : TAG_POS_E0 + e;
      // Left-align the e mantissa bits in a 32-bit word, then emit 7-bit groups.
      this.putMantissa32(e === 0 ? 0 : (a << (32 - e)) >>> 0, e);
    } else {
      f64[0] = a;
      const hi = f64u[HI];
      const lo = f64u[LO];
      const ef = (hi >>> 20) & 0x7ff;
      if (ef === 0) {
        // Subnormal: rare; normalize with BigInt.
        this.len = start;
        this.addBigMagnitude(neg, (BigInt(hi & 0xfffff) << 32n) | BigInt(lo), -1074);
        return;
      }
      const e = ef - 1023;
      this.putTag(neg, e);
      this.putMantissa52(hi & 0xfffff, lo);
    }
    if (neg) this.invert(start + 1);
  }

  private putTag(neg: boolean, e: number): void {
    const b = this.buf;
    if (e >= 0 && e < 64) b[this.len++] = neg ? TAG_NEG_E0 - e : TAG_POS_E0 + e;
    else {
      b[this.len++] = e < 0 ? (neg ? TAG_NEG_TINY : TAG_POS_TINY) : neg ? TAG_NEG_HUGE : TAG_POS_HUGE;
      const x = e < 0 ? e + TINY_BIAS : e;
      b[this.len++] = x >>> 8;
      b[this.len++] = x & 0xff;
    }
  }

  /** Mantissa given as `n` bits left-aligned in the 32-bit word `w` (n <= 31). */
  private putMantissa32(w: number, n: number): void {
    const b = this.buf;
    if (w === 0) {
      b[this.len++] = 0;
      return;
    }
    // Groups up to the last non-zero one.
    let o = this.len;
    for (let shift = 25; ; shift -= 7) {
      const g = shift >= 0 ? (w >>> shift) & 0x7f : (w << -shift) & 0x7f;
      const rest = shift > 0 ? (w << (32 - shift)) >>> 0 : 0; // bits after this group
      b[o++] = (g << 1) | (rest !== 0 ? 1 : 0);
      if (rest === 0) break;
    }
    void n;
    this.len = o;
  }

  /** 52-bit mantissa: high 20 bits in `h`, low 32 in `l`. */
  private putMantissa52(h: number, l: number): void {
    const b = this.buf;
    if (h === 0 && l === 0) {
      b[this.len++] = 0;
      return;
    }
    let o = this.len;
    // Bit position p (0 = most significant of the 52); group covers p..p+6.
    for (let p = 0; p < 52; p += 7) {
      let g: number;
      if (p + 7 <= 20) g = (h >>> (13 - p)) & 0x7f;
      else if (p >= 20) {
        const sh = 25 - (p - 20); // bits of l: position (p-20) from the top
        g = sh >= 0 ? (l >>> sh) & 0x7f : (l << -sh) & 0x7f;
      } else {
        const hb = 20 - p; // bits from h
        g = ((h & ((1 << hb) - 1)) << (7 - hb)) | (l >>> (32 - (7 - hb)));
      }
      // Any bits after this group?
      const q = p + 7;
      let rest: boolean;
      if (q >= 52) rest = false;
      else if (q < 20) rest = (h & ((1 << (20 - q)) - 1)) !== 0 || l !== 0;
      else rest = q - 20 >= 32 ? false : ((l << (q - 20)) >>> 0) !== 0;
      b[o++] = (g << 1) | (rest ? 1 : 0);
      if (!rest) break;
    }
    this.len = o;
  }

  private addBigInt(v: bigint): void {
    if (v > -BIG_2_53 && v < BIG_2_53) {
      this.addNumber(Number(v));
      return;
    }
    const neg = v < 0n;
    this.addBigMagnitude(neg, neg ? -v : v, 0);
  }

  /** |value| = mag × 2^scale (mag > 0), exactly. */
  private addBigMagnitude(neg: boolean, mag: bigint, scale: number): void {
    this.ensure(24);
    const start = this.len;
    const bits = mag.toString(2).length;
    const e = bits - 1 + scale;
    this.putTag(neg, e);
    const mbits = bits - 1;
    let m = mag - (1n << BigInt(mbits));
    if (m === 0n) this.buf[this.len++] = 0;
    else {
      // Left-align to a multiple of 7 bits, drop trailing zero groups.
      const groups = Math.ceil(mbits / 7);
      m <<= BigInt(groups * 7 - mbits);
      const out: number[] = [];
      for (let i = groups - 1; i >= 0; i--) out.push(Number((m >> BigInt(i * 7)) & 0x7fn));
      while (out.length > 1 && out[out.length - 1] === 0) out.pop();
      for (let i = 0; i < out.length; i++) this.buf[this.len++] = (out[i] << 1) | (i < out.length - 1 ? 1 : 0);
    }
    if (neg) this.invert(start + 1);
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
  }
}

const sharedEncoder = new KeyEncoder();

/** Encode a tuple of values as a single comparable key. */
export function encodeKey(values: readonly SqlValue[], cols?: readonly KeyColumn[]): Uint8Array {
  const e = sharedEncoder.reset();
  for (let i = 0; i < values.length; i++) e.add(values[i], cols?.[i]);
  return e.finish();
}

/** POW2[k + 1074] = 2^k for k in -1074..1023. */
const POW2 = new Float64Array(2098);
for (let k = -1074; k <= 1023; k++) POW2[k + 1074] = 2 ** k;

/** x × 2^k for any k a decoded component can need (two steps where 2^k alone would underflow). */
function scale2(x: number, k: number): number {
  if (k >= -1022 && k <= 1023) return x * POW2[k + 1074];
  return k < 0 ? x * 2 ** (k + 600) * 2 ** -600 : x * 2 ** (k - 600) * 2 ** 600;
}

/** End offset of the component last decoded by decodeSmallPos / decodeNumber. */
let decPos = 0;

/**
 * Fast path for an ascending non-negative number below 2^53 (every rowid, most index values): the
 * tag at key[pos] gives the exponent directly. Returns -1 when the component is not one (callers
 * fall back to {@link decodeNumber}). Sets decPos.
 */
function decodeSmallPos(key: Uint8Array, pos: number): number {
  const tag = key[pos];
  if (tag === TAG_ZERO) {
    decPos = pos + 1;
    return 0;
  }
  const e = tag - TAG_POS_E0;
  if (e < 0 || e > 52) return -1;
  // 1.mantissa as an integer of 1 + nb bits; nb <= 56, value < 2^53: exact in a double.
  let acc = 1;
  let nb = 0;
  let p = pos + 1;
  for (;;) {
    const byte = key[p++];
    acc = acc * 128 + (byte >>> 1);
    nb += 7;
    if ((byte & 1) === 0) break;
    if (nb >= 56) return -1;
  }
  decPos = p;
  return acc * POW2[e - nb + 1074];
}

/**
 * Decode the number component whose tag is at key[pos] (bytes XOR `flip`); sets decPos past it.
 */
function decodeNumber(key: Uint8Array, pos: number, flip: number, tag: number): number | bigint {
  if (tag === TAG_ZERO) {
    decPos = pos + 1;
    return 0;
  }
  let neg: boolean;
  let e: number;
  let p = pos + 1;
  if (tag >= TAG_POS_E0 && tag < TAG_POS_E0 + 64) {
    neg = false;
    e = tag - TAG_POS_E0;
  } else if (tag > TAG_NEG_HUGE && tag <= TAG_NEG_E0) {
    neg = true;
    e = TAG_NEG_E0 - tag;
  } else {
    neg = tag < TAG_ZERO;
    const inv = flip ^ (neg ? 0xff : 0);
    if (p + 2 > key.length) throw new CorruptionError('truncated numeric key');
    const x = ((key[p] ^ inv) << 8) | (key[p + 1] ^ inv);
    p += 2;
    e = tag === TAG_POS_TINY || tag === TAG_NEG_TINY ? x - TINY_BIAS : x;
  }
  const inv = flip ^ (neg ? 0xff : 0);
  // Mantissa groups: up to 4 groups (28 bits) in `hiM`, the rest in `loM`.
  let hiM = 0;
  let loM = 0;
  let nHi = 0;
  let nLo = 0;
  let last = 0;
  for (;;) {
    if (p >= key.length) throw new CorruptionError('truncated numeric key');
    const byte = key[p++] ^ inv;
    const g = byte >>> 1;
    if (nHi < 28) {
      hiM = hiM * 128 + g;
      nHi += 7;
    } else {
      loM = loM * 128 + g;
      nLo += 7;
      if (nLo > 56) throw new CorruptionError('numeric key mantissa too long');
    }
    last = g;
    if ((byte & 1) === 0) break;
  }
  decPos = p;
  const nb = nHi + nLo;
  // Significant bits after the leading 1 (trailing zeros of the last group excluded).
  const sig = last === 0 ? 0 : nb - (31 - Math.clz32(last & -last));
  let v: number | bigint;
  if (sig <= 52) {
    // Exact in a double: (2^nb + mantissa) × 2^(e - nb), mantissa = hiM × 2^nLo + loM.
    v = scale2(2 ** nHi + hiM, e - nHi) + scale2(loM, e - nb);
  } else {
    // Integer with more than 53 significant bits (int64 beyond 2^53).
    let m = 1n;
    for (let q = pos + 1 + (tag === TAG_POS_HUGE || tag === TAG_NEG_HUGE ? 2 : 0); q < p; q++) m = (m << 7n) | BigInt((key[q] ^ inv) >>> 1);
    const sh = e - nb;
    const big = sh >= 0 ? m << BigInt(sh) : m >> BigInt(-sh);
    v = big >= -BIG_2_53 && big <= BIG_2_53 ? Number(big) : big;
    if (neg) return typeof v === 'bigint' ? -v : -v;
    return v;
  }
  return neg ? -v : v;
}

/**
 * Decode a key produced by {@link encodeKey}. `cols` must match the encoding's DESC flags.
 * NOCASE/RTRIM text decodes to its collated form (the original is not recoverable).
 * Integers that a double cannot hold exactly decode as bigint; other numbers as number.
 * The key must not include an index entry's rowid suffix (see {@link rowidSuffixStart}).
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
    } else if (tag === TAG_NAN) {
      out.push(NaN);
      pos += 1;
    } else if (tag >= TAG_NEG_HUGE && tag <= TAG_POS_HUGE) {
      const u = flip === 0 ? decodeSmallPos(key, pos) : -1;
      out.push(u >= 0 ? u : decodeNumber(key, pos, flip, tag));
      pos = decPos;
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

/** Offset where the rowid suffix of an index entry `key[...end]` starts (= end of the column part). */
export function rowidSuffixStart(key: Uint8Array, end: number): number {
  const n = key[end - 1];
  if (n === 0 || n > 12 || n >= end) throw new CorruptionError('invalid index entry rowid suffix');
  return end - 1 - n;
}

/** The rowid of an index entry `key[...end]`. */
export function readIndexRowid(key: Uint8Array, end: number): number | bigint {
  const pos = rowidSuffixStart(key, end);
  const u = decodeSmallPos(key, pos);
  if (u >= 0) return u;
  const tag = key[pos];
  if (tag < TAG_NEG_HUGE || tag > TAG_POS_HUGE) throw new CorruptionError(`expected a numeric rowid, found tag 0x${tag.toString(16)}`);
  return decodeNumber(key, pos, 0, tag);
}

// ------------------------------------------------------------------ rowid keys

/**
 * Table B+trees are keyed by rowid using a compact 8-byte big-endian int64 with the sign bit
 * flipped (memcmp order = numeric order). Rowids are always integers, so no type tag is needed.
 */
export const ROWID_KEY_SIZE = 8;
export function writeRowidKey(out: Uint8Array, off: number, rowid: number | bigint): void {
  let hi: number;
  let lo: number;
  if (typeof rowid === 'number') {
    hi = Math.floor(rowid / TWO_32);
    lo = rowid - hi * TWO_32;
  } else {
    hi = Number(BigInt.asIntN(32, rowid >> 32n));
    lo = Number(BigInt.asUintN(32, rowid));
  }
  hi = (hi ^ 0x80000000) >>> 0;
  out[off] = hi >>> 24;
  out[off + 1] = (hi >>> 16) & 0xff;
  out[off + 2] = (hi >>> 8) & 0xff;
  out[off + 3] = hi & 0xff;
  out[off + 4] = lo >>> 24;
  out[off + 5] = (lo >>> 16) & 0xff;
  out[off + 6] = (lo >>> 8) & 0xff;
  out[off + 7] = lo & 0xff;
}

export function encodeRowidKey(rowid: number | bigint): Uint8Array {
  const out = new Uint8Array(8);
  writeRowidKey(out, 0, rowid);
  return out;
}

export function readRowidKey(b: Uint8Array, off: number): number | bigint {
  const hi = (((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) ^ 0x80000000) | 0;
  const lo = ((b[off + 4] << 24) | (b[off + 5] << 16) | (b[off + 6] << 8) | b[off + 7]) >>> 0;
  if (hi >= -2097152 && hi <= 2097151) return hi * TWO_32 + lo;
  const big = (BigInt(hi) << 32n) | BigInt(lo);
  return big >= BigInt(Number.MIN_SAFE_INTEGER) && big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big;
}
