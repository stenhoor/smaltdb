/** CRC-32C (Castagnoli), slice-by-8 table implementation. Used for page and WAL frame checksums. */

// Int32 tables keep every step in 32-bit integer arithmetic (Uint32 values above 2^31 are not small integers in V8).
const TABLES: Int32Array[] = (() => {
  const t0 = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t0[i] = c;
  }
  const tables = [t0];
  for (let t = 1; t < 8; t++) {
    const prev = tables[t - 1];
    const cur = new Int32Array(256);
    for (let i = 0; i < 256; i++) cur[i] = (prev[i] >>> 8) ^ t0[prev[i] & 0xff];
    tables.push(cur);
  }
  return tables;
})();
const [T0, T1, T2, T3, T4, T5, T6, T7] = TABLES;

/** Words read through an Int32Array are little-endian only on little-endian hosts (every browser engine today). */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/** Below this many bytes, the byte loop is cheaper than creating a word view. */
const WORD_MIN = 32;

export function crc32c(buf: Uint8Array, start = 0, end = buf.length, seed = 0): number {
  let crc = ~seed;
  let i = start;
  if (LITTLE_ENDIAN && end - start >= WORD_MIN) {
    // Byte steps up to a 4-byte boundary of the underlying buffer, then 8 bytes per step read as two words
    // (about twice as fast as assembling the words from bytes).
    while (((buf.byteOffset + i) & 3) !== 0) crc = T0[(crc ^ buf[i++]) & 0xff] ^ (crc >>> 8);
    const n8 = (end - i) >>> 3;
    const w = new Int32Array(buf.buffer, buf.byteOffset + i, n8 * 2);
    for (let j = 0; j < w.length; j += 2) {
      const a = w[j] ^ crc;
      const b = w[j + 1];
      crc =
        T7[a & 0xff] ^
        T6[(a >>> 8) & 0xff] ^
        T5[(a >>> 16) & 0xff] ^
        T4[a >>> 24] ^
        T3[b & 0xff] ^
        T2[(b >>> 8) & 0xff] ^
        T1[(b >>> 16) & 0xff] ^
        T0[b >>> 24];
    }
    i += n8 * 8;
  } else {
    const end8 = end - ((end - start) & 7);
    for (; i < end8; i += 8) {
      const a = (buf[i] | (buf[i + 1] << 8) | (buf[i + 2] << 16) | (buf[i + 3] << 24)) ^ crc;
      crc =
        T7[a & 0xff] ^
        T6[(a >>> 8) & 0xff] ^
        T5[(a >>> 16) & 0xff] ^
        T4[a >>> 24] ^
        T3[buf[i + 4]] ^
        T2[buf[i + 5]] ^
        T1[buf[i + 6]] ^
        T0[buf[i + 7]];
    }
  }
  for (; i < end; i++) crc = T0[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}
