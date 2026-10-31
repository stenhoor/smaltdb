/**
 * Lexicographic (memcmp) comparison of `a` against `b[bOff .. bOff+bLen)`.
 * Returns <0, 0, >0. Hot path: keep monomorphic and allocation-free.
 */
export function compareKeyAt(a: Uint8Array, b: Uint8Array, bOff: number, bLen: number): number {
  const aLen = a.length;
  const n = aLen < bLen ? aLen : bLen;
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[bOff + i];
    if (d !== 0) return d;
  }
  return aLen - bLen;
}

/** Lexicographic comparison of two byte ranges. */
export function compareRanges(
  a: Uint8Array,
  aOff: number,
  aLen: number,
  b: Uint8Array,
  bOff: number,
  bLen: number,
): number {
  const n = aLen < bLen ? aLen : bLen;
  for (let i = 0; i < n; i++) {
    const d = a[aOff + i] - b[bOff + i];
    if (d !== 0) return d;
  }
  return aLen - bLen;
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  return compareRanges(a, 0, a.length, b, 0, b.length);
}
