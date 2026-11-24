/**
 * `setMapKey` (exec/nested-ops.ts): one key of a map set, or taken away, in the map's bytes. It gives the bytes the
 * map has when it is encoded whole from its entries.
 */
import { describe, expect, it } from 'vitest';
import { setMapKey } from '../src/engine/exec/nested-ops.js';
import { decodeKey, encodeKey } from '../src/engine/storage/key-codec.js';
import type { SqlValue } from '../src/engine/values.js';
import { compareCodePoints } from '../src/shared/nested.js';

/** A map's bytes from its entries, as a map is stored: by key. */
function mapOf(entries: Map<string, SqlValue>): Uint8Array {
  const flat: SqlValue[] = [];
  for (const k of [...entries.keys()].sort(compareCodePoints)) flat.push(k, entries.get(k)!);
  return encodeKey(flat);
}

describe('setMapKey', () => {
  const random = (seed: number) => () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  it('sets a key a map has, adds one it has not, in its place, and takes one away', () => {
    const m = mapOf(new Map<string, SqlValue>([['b', 1], ['d', 'x']]));
    const key = (k: string) => encodeKey([k]);
    const value = (v: SqlValue) => encodeKey([v]);
    const read = (bytes: Uint8Array) => decodeKey(bytes);
    expect(read(setMapKey(m, key('b'), value(2)))).toEqual(['b', 2, 'd', 'x']);
    expect(read(setMapKey(m, key('a'), value(0)))).toEqual(['a', 0, 'b', 1, 'd', 'x']);
    expect(read(setMapKey(m, key('c'), value(null)))).toEqual(['b', 1, 'c', null, 'd', 'x']);
    expect(read(setMapKey(m, key('e'), value(-1.5)))).toEqual(['b', 1, 'd', 'x', 'e', -1.5]);
    expect(read(setMapKey(m, key('d'), null))).toEqual(['b', 1]);
    // Taking away a key the map has not gives the map itself, and so does the value a key has already.
    expect(setMapKey(m, key('c'), null)).toBe(m);
    expect(setMapKey(m, key('b'), value(1))).toBe(m);
    expect(setMapKey(m, key('d'), value('x'))).toBe(m);
    expect(read(setMapKey(encodeKey([]), key('k'), value('v')))).toEqual(['k', 'v']);
  });

  it('a value of as many bytes, of more and of fewer, at the start, in the middle and at the end', () => {
    const entries = new Map<string, SqlValue>([['a', 'one'], ['m', 500], ['z', 'last']]);
    const m = mapOf(entries);
    const copy = m.slice();
    const bytes = (v: SqlValue) => encodeKey([v]).length;
    // The numbers 500, 501 and 2 are two, three and one byte after their tag: a set of one over another changes the length.
    expect([bytes(500), bytes(501), bytes(2)].every((n, i, all) => i === 0 || n !== all[i - 1])).toBe(true);
    for (const k of ['a', 'm', 'z']) {
      for (const v of [500, 501, 2, 'one', 'on', 'onee', '', null] as SqlValue[]) {
        const want = new Map(entries).set(k, v);
        const got = setMapKey(m, encodeKey([k]), encodeKey([v]));
        expect([...got], `${k} = ${String(v)}`).toEqual([...mapOf(want)]);
        // The map given is never written: what was read from it before is still what it holds.
        expect([...m]).toEqual([...copy]);
        if (entries.get(k) !== v) expect(got).not.toBe(m);
      }
    }
  });

  it('gives the bytes of the map encoded whole, for keys and values of every kind', () => {
    const next = random(7);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
    const keys = ['', 'a', 'ab', 'abc', 'b', 'B', 'é', 'z', 'name', 'name2', 'na', '\u0000', 'a\u0000b', '😀', 'ß'];
    const values: SqlValue[] = [0, 1, -1, 2.5, -1e300, 1e-300, 123456789012, '', 'text', 'a\u0000b', '😀', new Uint8Array([1, 0, 2]), new Uint8Array(0), 9007199254740993n, null];
    for (let round = 0; round < 400; round++) {
      const entries = new Map<string, SqlValue>();
      for (let i = Math.floor(next() * 6); i > 0; i--) entries.set(pick(keys), pick(values));
      let bytes = mapOf(entries);
      for (let step = 0; step < 6; step++) {
        const k = pick(keys);
        const remove = next() < 0.3;
        const v = pick(values);
        if (remove) entries.delete(k);
        else entries.set(k, v);
        bytes = setMapKey(bytes, encodeKey([k]), remove ? null : encodeKey([v]));
        expect([...bytes], `round ${round}, step ${step}`).toEqual([...mapOf(entries)]);
      }
    }
  });
});
