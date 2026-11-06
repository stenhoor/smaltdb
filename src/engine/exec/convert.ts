import { formatReal, textToNumber } from '../catalog/schema.js';
import type { StorageType } from '../storage/record.js';
import { type SqlValue, normalizeInt } from '../values.js';

/**
 * Static expression types inferred at compile time. 'num' = INTEGER or REAL, 'any' = unknown.
 * Integral JS numbers are ambiguous between INTEGER and REAL at runtime, so REAL-ness is tracked
 * statically where SQLite semantics depend on it (division, typeof, text conversion).
 */
export type StaticType = 'int' | 'real' | 'num' | 'text' | 'blob' | 'null' | 'any';

/** Column affinity used for comparisons (SQLite rules). */
export type Affinity = 'INTEGER' | 'REAL' | 'NUMERIC' | 'TEXT' | 'BLOB' | 'NONE';

/** Re-exported from the plan layer, where every language reads them (plan/catalog.ts). */
export { affinityOfStorage, planTypeOfStorage as staticTypeOfStorage } from '../plan/catalog.js';

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;
const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/**
 * True for INTEGER values. Integers outside ±(2^53-1) are always bigint in smaltdb, so a JS number
 * outside that range (e.g. the REAL result of an int64 overflow) is a REAL even if integral.
 */
export function isIntValue(v: SqlValue): boolean {
  return typeof v === 'bigint' || (typeof v === 'number' && Number.isSafeInteger(v));
}

/** Parse the longest numeric prefix of `s` (SQLite arithmetic on text): '12abc' -> 12, 'abc' -> 0. */
export function textPrefixToNumber(s: string): number | bigint {
  let i = 0;
  const n = s.length;
  while (i < n && isSpace(s.charCodeAt(i))) i++;
  const start = i;
  if (i < n && (s[i] === '+' || s[i] === '-')) i++;
  const digitsStart = i;
  while (i < n && isDigit(s.charCodeAt(i))) i++;
  let isReal = false;
  if (i < n && s[i] === '.') {
    const save = i;
    i++;
    while (i < n && isDigit(s.charCodeAt(i))) i++;
    if (i - save > 1 || i - digitsStart > 1) isReal = true;
    else i = save;
  }
  if (i === digitsStart) return 0;
  if (i < n && (s[i] === 'e' || s[i] === 'E')) {
    let j = i + 1;
    if (j < n && (s[j] === '+' || s[j] === '-')) j++;
    if (j < n && isDigit(s.charCodeAt(j))) {
      while (j < n && isDigit(s.charCodeAt(j))) j++;
      i = j;
      isReal = true;
    }
  }
  const text = s.slice(start, i);
  if (!isReal) {
    const b = BigInt(text);
    if (b >= I64_MIN && b <= I64_MAX) return normalizeInt(b);
    return Number(text);
  }
  return Number(text);
}

function isSpace(c: number): boolean {
  return c === 32 || (c >= 9 && c <= 13);
}
function isDigit(c: number): boolean {
  return c >= 48 && c <= 57;
}

/** Numeric value for arithmetic: NULL stays NULL, text/blob use their numeric prefix. */
export function toNumeric(v: SqlValue): number | bigint | null {
  if (v === null) return null;
  if (typeof v === 'number' || typeof v === 'bigint') return v;
  if (typeof v === 'string') return textPrefixToNumber(v);
  return textPrefixToNumber(textDecoder.decode(v));
}

/** Apply NUMERIC/INTEGER/REAL affinity: text that looks numeric becomes a number. */
export function applyNumericAffinity(v: SqlValue): SqlValue {
  if (typeof v !== 'string') return v;
  const n = textToNumber(v);
  return n === undefined ? v : n;
}

/** Apply TEXT affinity: numbers become text. */
export function applyTextAffinity(v: SqlValue, isReal: boolean): SqlValue {
  if (typeof v === 'number' || typeof v === 'bigint') return toText(v, isReal);
  return v;
}

export function toText(v: SqlValue, isReal = false): string | null {
  if (v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return isReal || !Number.isSafeInteger(v) ? formatReal(v) : String(v);
  return textDecoder.decode(v);
}

export function toBlob(v: SqlValue, isReal = false): Uint8Array | null {
  if (v === null) return null;
  if (v instanceof Uint8Array) return v;
  return textEncoder.encode(toText(v, isReal)!);
}

/** CAST(x AS INTEGER). */
export function castToInteger(v: SqlValue): number | bigint | null {
  if (v === null) return null;
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return realToInt(v);
  const n = typeof v === 'string' ? textPrefixToNumber(v) : textPrefixToNumber(textDecoder.decode(v));
  return typeof n === 'number' ? realToInt(n) : n;
}

/** Truncate a REAL toward zero, saturating at the int64 range (SQLite behaviour). */
export function realToInt(x: number): number | bigint {
  if (Number.isNaN(x)) return 0;
  if (Number.isSafeInteger(x)) return x;
  const t = Math.trunc(x);
  if (Number.isSafeInteger(t)) return t;
  if (t >= 9223372036854775807) return I64_MAX;
  if (t <= -9223372036854775808) return I64_MIN;
  return normalizeInt(BigInt(t));
}

export function castToReal(v: SqlValue): number | null {
  if (v === null) return null;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  const n = typeof v === 'string' ? textPrefixToNumber(v) : textPrefixToNumber(textDecoder.decode(v));
  return Number(n);
}

/** CAST(x AS NUMERIC) */
export function castToNumeric(v: SqlValue): SqlValue {
  if (v === null || typeof v === 'number' || typeof v === 'bigint') return v;
  const s = typeof v === 'string' ? v : textDecoder.decode(v);
  const n = textPrefixToNumber(s);
  // A REAL that is integral and in range becomes INTEGER under NUMERIC affinity.
  if (typeof n === 'number' && Number.isInteger(n) && Number.isSafeInteger(n)) return n;
  return n;
}

/** Truthiness for WHERE/AND/OR/CASE: NULL -> null, otherwise numeric value != 0. */
export function truthy(v: SqlValue): boolean | null {
  if (v === null) return null;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'bigint') return v !== 0n;
  const n = toNumeric(v);
  return n !== 0 && n !== 0n;
}

/**
 * Map a value to a JS Map key so that SQL-equal values (under `nocase`/`rtrim` folding) share a
 * key: numbers (int and real) compare numerically, text and blobs never collide with each other.
 */
export function hashKey(v: SqlValue, collation = 0): unknown {
  if (v === null || typeof v === 'number' || typeof v === 'bigint') return v;
  if (typeof v === 'string') {
    let s = v;
    if (collation === 1) s = asciiLower(s);
    else if (collation === 2) s = s.replace(/ +$/, '');
    return s.length > 0 && s.charCodeAt(0) === 0 ? '\u0000S' + s : s;
  }
  let s = '\u0000B';
  for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]);
  return s;
}

/** Composite key for several values (GROUP BY, DISTINCT, multi-column joins). */
export function hashKeyMulti(values: readonly SqlValue[], collations?: readonly number[]): string {
  let s = '';
  for (let i = 0; i < values.length; i++) {
    const k = hashKey(values[i], collations?.[i] ?? 0);
    if (k === null) s += 'n;';
    else if (typeof k === 'number') s += (Object.is(k, -0) ? 0 : k) + ';';
    else if (typeof k === 'bigint') s += k.toString() + ';';
    else s += 't' + (k as string).length + ':' + (k as string);
  }
  return s;
}

export function asciiLower(s: string): string {
  let out = '';
  let changed = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      changed = true;
      break;
    }
  }
  if (!changed) return s;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : s[i];
  }
  return out;
}

export function asciiUpper(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    out += c >= 97 && c <= 122 ? String.fromCharCode(c - 32) : s[i];
  }
  return out;
}
