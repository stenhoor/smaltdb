import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Collation, KeyEncoder, decodeKey, encodeKey, type KeyColumn, readIndexRowid, rowidSuffixStart, type SqlValue } from '../src/engine/storage/key-codec.js';
import { compareBytes } from '../src/engine/util/bytes.js';

const enc = new TextEncoder();

/** Reference: SQLite's value ordering (NaN treated as NULL, as SQLite does). */
function rank(v: SqlValue): number {
  if (v === null || (typeof v === 'number' && Number.isNaN(v))) return 0;
  if (typeof v === 'number' || typeof v === 'bigint') return 1;
  if (typeof v === 'string') return 2;
  return 3;
}

function cmpNumeric(a: number | bigint, b: number | bigint): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  const flip = typeof a === 'bigint';
  const n = (flip ? b : a) as number;
  const big = (flip ? a : b) as bigint;
  let r: number;
  if (n === Infinity) r = 1;
  else if (n === -Infinity) r = -1;
  else if (Number.isInteger(n)) r = BigInt(n) < big ? -1 : BigInt(n) > big ? 1 : 0;
  else r = BigInt(Math.floor(n)) < big ? -1 : 1;
  return (flip ? -r : r) || 0;
}

function collate(s: string, c: Collation): Uint8Array {
  let b = enc.encode(s);
  if (c === Collation.NoCase) b = b.map((x) => (x >= 0x41 && x <= 0x5a ? x + 0x20 : x));
  if (c === Collation.RTrim) {
    let n = b.length;
    while (n > 0 && b[n - 1] === 0x20) n--;
    b = b.subarray(0, n);
  }
  return b;
}

function cmpValue(a: SqlValue, b: SqlValue, col: KeyColumn = {}): number {
  const ra = rank(a);
  const rb = rank(b);
  let r: number;
  if (ra !== rb) r = ra - rb;
  else if (ra === 0) r = 0;
  else if (ra === 1) r = cmpNumeric(a as number | bigint, b as number | bigint);
  else if (ra === 2) r = compareBytes(collate(a as string, col.collation ?? 0), collate(b as string, col.collation ?? 0));
  else r = compareBytes(a as Uint8Array, b as Uint8Array);
  r = Math.sign(r);
  return (col.desc ? -r : r) || 0;
}

const I64_MIN = -(2n ** 63n);
const I64_MAX = 2n ** 63n - 1n;

const valueArb: fc.Arbitrary<SqlValue> = fc.oneof(
  fc.constant(null),
  fc.double(),
  fc.integer(),
  fc.bigInt({ min: I64_MIN, max: I64_MAX }),
  // values clustered around the 2^53 precision boundary
  fc.bigInt({ min: 2n ** 53n - 5000n, max: 2n ** 53n + 5000n }),
  fc.bigInt({ min: 2n ** 62n - 5000n, max: 2n ** 62n + 5000n }).map((x) => (Math.random() < 0.5 ? -x : x)),
  fc.constantFrom(2 ** 53, 2 ** 53 + 2, 2 ** 62, -(2 ** 63), 2 ** 63, 0.5, -0, Infinity, -Infinity, Number.MIN_VALUE, -Number.MIN_VALUE, 2.2250738585072014e-308, Number.MAX_VALUE, 1 / 3, 2 ** 31, 2 ** 31 - 1, -(2 ** 31)),
  // small integers and fractions (the compact forms) and subnormals
  fc.integer({ min: -300, max: 300 }),
  fc.integer({ min: -300, max: 300 }).map((x) => x / 8),
  fc.double({ min: -1e-300, max: 1e-300 }),
  fc.string({ unit: 'binary', maxLength: 12 }),
  fc.constantFrom('', '\0', 'a\0', 'a', 'A', 'a ', 'a  ', 'ab', 'é'),
  fc.uint8Array({ maxLength: 10 }),
);

const colArb: fc.Arbitrary<KeyColumn> = fc.record({
  desc: fc.boolean(),
  collation: fc.constantFrom(Collation.Binary, Collation.NoCase, Collation.RTrim),
});

describe('key codec', () => {
  it('orders single values like SQLite', () => {
    fc.assert(
      fc.property(valueArb, valueArb, colArb, (a, b, col) => {
        const ka = encodeKey([a], [col]);
        const kb = encodeKey([b], [col]);
        expect(Math.sign(compareBytes(ka, kb))).toBe(cmpValue(a, b, col));
      }),
      { numRuns: 20000 },
    );
  });

  it('orders tuples lexicographically by column', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(valueArb, valueArb, colArb), { minLength: 1, maxLength: 4 }),
        (cols) => {
          const ka = encodeKey(cols.map((c) => c[0]), cols.map((c) => c[2]));
          const kb = encodeKey(cols.map((c) => c[1]), cols.map((c) => c[2]));
          let expected = 0;
          for (const [a, b, col] of cols) {
            expected = cmpValue(a, b, col);
            if (expected !== 0) break;
          }
          expect(Math.sign(compareBytes(ka, kb))).toBe(expected);
        },
      ),
      { numRuns: 5000 },
    );
  });

  it('round-trips binary-collated values', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(valueArb, fc.boolean()), { maxLength: 5 }), (items) => {
        const cols = items.map(([, desc]) => ({ desc }));
        const values = items.map(([v]) => v);
        const decoded = decodeKey(encodeKey(values, cols), cols);
        expect(decoded.length).toBe(values.length);
        for (let i = 0; i < values.length; i++) {
          const v = values[i];
          const d = decoded[i];
          if (v === null || (typeof v === 'number' && Number.isNaN(v))) expect(d).toBeNull();
          else if (typeof v === 'number' || typeof v === 'bigint') expect(cmpNumeric(v, d as number | bigint)).toBe(0);
          else expect(d).toEqual(v);
        }
      }),
      { numRuns: 5000 },
    );
  });

  it('encodes int64 extremes distinctly and in order', () => {
    const vals = [I64_MIN, I64_MIN + 1n, -(2n ** 53n) - 1n, -1n, 0n, 1n, 2n ** 53n, 2n ** 53n + 1n, I64_MAX - 1n, I64_MAX];
    const keys = vals.map((v) => encodeKey([v]));
    for (let i = 1; i < keys.length; i++) expect(compareBytes(keys[i - 1], keys[i])).toBeLessThan(0);
    expect(decodeKey(keys[keys.length - 1])[0]).toBe(I64_MAX);
  });

  it('uses compact forms for small numbers', () => {
    const size = (v: SqlValue): number => encodeKey([v]).length;
    expect(size(0)).toBe(1);
    expect(size(1)).toBe(2);
    expect(size(127)).toBe(2);
    expect(size(-127)).toBe(2);
    expect(size(16383)).toBe(3);
    expect(size(2 ** 21 - 1)).toBe(4);
    expect(size(0.5)).toBe(4);
    expect(size(1 / 3)).toBeLessThanOrEqual(11);
    expect(size(1234.5678)).toBeLessThanOrEqual(9);
    expect(size(I64_MAX)).toBeLessThanOrEqual(10);
  });

  it('round-trips int64 exactly and keeps components prefix-free', () => {
    fc.assert(
      fc.property(valueArb, valueArb, (a, b) => {
        if (typeof a === 'bigint') {
          const d = decodeKey(encodeKey([a]))[0];
          expect(BigInt(d as number | bigint)).toBe(a);
        }
        const ka = encodeKey([a]);
        const kb = encodeKey([b]);
        if (cmpValue(a, b) !== 0 && ka.length < kb.length) {
          // A shorter key that is not equal must not be a prefix of the other.
          expect(ka.every((x, i) => x === kb[i])).toBe(false);
        }
      }),
      { numRuns: 20000 },
    );
  });

  it('stores the rowid as a suffix readable from the end', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(valueArb, colArb), { maxLength: 3 }), fc.oneof(fc.integer({ min: -1000, max: 2 ** 31 }), fc.bigInt({ min: I64_MIN, max: I64_MAX })), (cols, rowid) => {
        const e = new KeyEncoder();
        for (const [v, c] of cols) e.add(v, c);
        const prefixLen = e.length;
        e.addRowid(rowid);
        const k = e.finish();
        expect(rowidSuffixStart(k, k.length)).toBe(prefixLen);
        const r = readIndexRowid(k, k.length);
        expect(BigInt(r)).toBe(BigInt(rowid));
        expect(decodeKey(k.subarray(0, prefixLen), cols.map((c) => c[1])).length).toBe(cols.length);
      }),
      { numRuns: 5000 },
    );
  });
});
