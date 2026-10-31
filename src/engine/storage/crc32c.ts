/** CRC-32C (Castagnoli), slice-by-8 table implementation. Used for page and WAL frame checksums. */

const TABLES: Uint32Array[] = (() => {
  const t0 = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
    t0[i] = c >>> 0;
  }
  const tables = [t0];
  for (let t = 1; t < 8; t++) {
    const prev = tables[t - 1];
    const cur = new Uint32Array(256);
    for (let i = 0; i < 256; i++) cur[i] = (prev[i] >>> 8) ^ t0[prev[i] & 0xff];
    tables.push(cur);
  }
  return tables;
})();
const [T0, T1, T2, T3, T4, T5, T6, T7] = TABLES;

export function crc32c(buf: Uint8Array, start = 0, end = buf.length, seed = 0): number {
  let crc = ~seed >>> 0;
  let i = start;
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
  for (; i < end; i++) crc = T0[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return ~crc >>> 0;
}
