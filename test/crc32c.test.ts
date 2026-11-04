import { describe, expect, it } from 'vitest';
import { crc32c } from '../src/engine/storage/crc32c.js';

describe('crc32c', () => {
  it('matches the standard check value', () => {
    expect(crc32c(new TextEncoder().encode('123456789'))).toBe(0xe3069283);
  });

  it('is consistent between slice-by-8 and bytewise tails', () => {
    const data = new Uint8Array(1031).map((_, i) => (i * 31 + 7) & 0xff);
    // Same data, different alignment of the 8-byte loop: compare against a naive implementation.
    const naive = (b: Uint8Array) => {
      let c = ~0 >>> 0;
      for (const x of b) {
        c ^= x;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
      }
      return ~c >>> 0;
    };
    for (const len of [0, 1, 7, 8, 9, 63, 1031]) {
      expect(crc32c(data, 0, len)).toBe(naive(data.subarray(0, len)));
      expect(crc32c(data, 3, len)).toBe(len >= 3 ? naive(data.subarray(3, len)) : naive(new Uint8Array(0)));
    }
  });

  it('matches a bitwise reference for every alignment, length and seed (word path and byte path)', () => {
    // A seeded bitwise CRC-32C: crc32c(b, s, e, seed) continues a CRC whose value so far is `seed`.
    const ref = (b: Uint8Array, seed: number): number => {
      let c = ~seed >>> 0;
      for (const x of b) {
        c ^= x;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
      }
      return ~c >>> 0;
    };
    const backing = new Uint8Array(8300).map((_, i) => (i * 2654435761) >>> 24);
    for (const base of [0, 1, 2, 3]) {
      // Views at every byte offset of the backing buffer, so the word loop starts at every alignment.
      const view = backing.subarray(base, base + 8192);
      for (const start of [0, 1, 2, 3, 4, 5, 6, 7]) {
        for (const len of [0, 1, 7, 8, 15, 31, 32, 33, 39, 40, 63, 64, 65, 200, 8192 - 8]) {
          for (const seed of [0, 0xdeadbeef]) {
            const end = start + len;
            expect(crc32c(view, start, end, seed), `base ${base} start ${start} len ${len}`).toBe(ref(view.subarray(start, end), seed));
          }
        }
      }
    }
    // Chaining: a CRC over two parts equals the CRC over the whole.
    const whole = backing.subarray(0, 8216);
    expect(crc32c(whole, 24, 8216, crc32c(whole, 0, 16))).toBe(ref(new Uint8Array([...whole.subarray(0, 16), ...whole.subarray(24, 8216)]), 0));
  });
});
