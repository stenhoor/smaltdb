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
});
