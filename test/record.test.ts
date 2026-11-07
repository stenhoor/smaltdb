import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { encodeRowidKey, readRowidKey } from '../src/engine/storage/key-codec.js';
import { RecordEncoder, RecordLayout, RecordReader, type StorageType } from '../src/engine/storage/record.js';
import { compareBytes } from '../src/engine/util/bytes.js';
import type { SqlValue } from '../src/engine/values.js';

const I64 = { min: -(2n ** 63n), max: 2n ** 63n - 1n };
const norm = (v: bigint): number | bigint => (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v);

const valueFor: Record<StorageType, fc.Arbitrary<SqlValue>> = {
  INTEGER: fc.oneof(fc.integer(), fc.bigInt(I64).map(norm), fc.constantFrom(2 ** 53 - 1, -(2 ** 53 - 1), 0)),
  BOOLEAN: fc.constantFrom(0, 1),
  DATE: fc.integer({ min: -1e6, max: 1e6 }),
  TIME: fc.integer({ min: 0, max: 86_400_000_000 - 1 }),
  DATETIME: fc.oneof(fc.integer(), fc.bigInt(I64).map(norm)),
  DURATION: fc.oneof(fc.integer(), fc.bigInt(I64).map(norm)),
  REAL: fc.double({ noNaN: true }),
  TEXT: fc.string({ unit: 'grapheme', maxLength: 30 }),
  BLOB: fc.uint8Array({ maxLength: 40 }),
  LIST: fc.uint8Array({ maxLength: 40 }),
  STRUCT: fc.uint8Array({ maxLength: 40 }),
  ANY: fc.oneof(fc.integer(), fc.double({ noNaN: true }).filter((d) => !Number.isInteger(d)), fc.string(), fc.uint8Array({ maxLength: 10 }), fc.bigInt(I64).map(norm)),
  NUMERIC: fc.oneof(fc.integer(), fc.double({ noNaN: true }).filter((d) => !Number.isInteger(d))),
};
const typeArb = fc.constantFrom<StorageType>('INTEGER', 'BOOLEAN', 'DATE', 'TIME', 'DATETIME', 'DURATION', 'LIST', 'STRUCT', 'REAL', 'TEXT', 'BLOB', 'ANY', 'NUMERIC');

describe('record format', () => {
  it('round-trips random rows', () => {
    fc.assert(
      fc.property(
        fc.array(typeArb, { minLength: 1, maxLength: 20 }).chain((types) =>
          fc.tuple(fc.constant(types), fc.tuple(...types.map((t) => fc.option(valueFor[t], { freq: 4, nil: null })))),
        ),
        ([types, values]) => {
          const layout = new RecordLayout(types);
          const enc = new RecordEncoder(layout);
          const bytes = enc.encode(values).slice();
          const r = new RecordReader(layout);
          // Place the record at an offset inside a larger buffer to exercise offsets.
          const host = new Uint8Array(bytes.length + 13);
          host.set(bytes, 7);
          r.reset(host, 7, bytes.length);
          for (let i = 0; i < types.length; i++) {
            const v = values[i];
            const got = r.column(i);
            if (v instanceof Uint8Array) expect([...(got as Uint8Array)]).toEqual([...v]);
            else if (typeof v === 'number' && Object.is(v, -0)) expect(got === 0).toBe(true);
            else expect(got).toEqual(v);
            expect(r.isNull(i)).toBe(v === null);
          }
        },
      ),
      { numRuns: 3000 },
    );
  });

  it('uses wide offsets for large var data and reads defaults for missing columns', () => {
    const old = new RecordLayout(['INTEGER', 'TEXT']);
    const big = 'x'.repeat(70000);
    const bytes = new RecordEncoder(old).encode([5, big]).slice();
    expect(bytes[0] & 1).toBe(1);
    const newer = new RecordLayout(['INTEGER', 'TEXT', 'REAL', 'TEXT']);
    const r = new RecordReader(newer, [null, null, 1.5, 'dflt']);
    r.reset(bytes, 0, bytes.length);
    expect(r.column(0)).toBe(5);
    expect(r.column(1)).toBe(big);
    expect(r.column(2)).toBe(1.5);
    expect(r.column(3)).toBe('dflt');
  });

  it('tracks REAL-ness of integral values in ANY columns', () => {
    const layout = new RecordLayout(['ANY', 'ANY']);
    const bytes = new RecordEncoder(layout).encode([2.5, 3]).slice();
    const r = new RecordReader(layout);
    r.reset(bytes, 0, bytes.length);
    expect(r.isStoredReal(0)).toBe(true);
    expect(r.isStoredReal(1)).toBe(false);
  });

  it('rowid keys order numerically and round-trip', () => {
    fc.assert(
      fc.property(fc.bigInt(I64), fc.bigInt(I64), (a, b) => {
        const ka = encodeRowidKey(norm(a));
        const kb = encodeRowidKey(norm(b));
        expect(Math.sign(compareBytes(ka, kb))).toBe(a < b ? -1 : a > b ? 1 : 0);
        expect(readRowidKey(ka, 0)).toEqual(norm(a));
      }),
      { numRuns: 5000 },
    );
  });
});
