/**
 * SQL values as represented in the engine.
 *
 *   NULL    -> null
 *   INTEGER -> number when within ±(2^53-1), otherwise bigint
 *   REAL    -> number
 *   TEXT    -> string
 *   BLOB    -> Uint8Array
 *
 * Note: an integral `number` is ambiguous between INTEGER and REAL. The engine tracks declared
 * column types for storage; for expression semantics (typeof(), integer division) values flow with
 * a separate "is real" marker only where SQLite semantics require it (see exec/expr.ts).
 */
export type SqlValue = null | number | bigint | string | Uint8Array;

const BIG_MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const BIG_MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Normalize a bigint to number when it is exactly representable as a safe integer. */
export function normalizeInt(v: bigint): number | bigint {
  return v >= BIG_MIN_SAFE && v <= BIG_MAX_SAFE ? Number(v) : v;
}

/** SQLite's ordering rank: NULL < numeric < TEXT < BLOB. */
export function typeRank(v: SqlValue): number {
  if (v === null) return 0;
  switch (typeof v) {
    case 'number':
    case 'bigint':
      return 1;
    case 'string':
      return 2;
    default:
      return 3;
  }
}

/**
 * Exact numeric comparison across number and bigint, in the engine's total order (ADR 0018): NaN equals NaN and
 * sorts after every number, Infinity included.
 */
export function compareNumeric(a: number | bigint, b: number | bigint): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : a === b ? 0 : nanOrder(a, b);
  if (typeof a === 'bigint' && typeof b === 'bigint') return a < b ? -1 : a > b ? 1 : 0;
  const flip = typeof a === 'bigint';
  const n = (flip ? b : a) as number;
  const big = (flip ? a : b) as bigint;
  let r: number;
  if (Number.isNaN(n)) r = 1;
  else if (n === Infinity) r = 1;
  else if (n === -Infinity) r = -1;
  else if (Number.isInteger(n)) {
    const bn = BigInt(n);
    r = bn < big ? -1 : bn > big ? 1 : 0;
  } else r = BigInt(Math.floor(n)) < big ? -1 : 1;
  return flip ? -r : r;
}

/** The order of two numbers neither less nor greater than the other, so at least one is NaN: NaN sorts last. */
function nanOrder(a: number, b: number): number {
  return a !== a ? (b !== b ? 0 : 1) : -1;
}

export function compareBlobs(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a[i] - b[i];
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/** Collation ids (shared with the key codec). */
export const Collation = { Binary: 0, NoCase: 1, RTrim: 2 } as const;
export type Collation = (typeof Collation)[keyof typeof Collation];

export function collationByName(name: string): Collation | undefined {
  switch (name.toUpperCase()) {
    case 'BINARY':
      return Collation.Binary;
    case 'NOCASE':
      return Collation.NoCase;
    case 'RTRIM':
      return Collation.RTrim;
    default:
      return undefined;
  }
}

/** Map a UTF-16 code unit so that code-unit order equals UTF-8 byte order (= code point order). */
function fixup(c: number): number {
  if (c >= 0xe000) return c - 0x800;
  if (c >= 0xd800) return c + 0x2000;
  return c;
}

function foldAscii(c: number): number {
  return c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
}

/**
 * Compare strings in UTF-8 byte order (what SQLite's BINARY collation does), which differs from
 * JS `<` for characters outside the BMP. NOCASE folds ASCII only; RTRIM ignores trailing spaces.
 */
export function compareText(a: string, b: string, collation: Collation = Collation.Binary): number {
  let la = a.length;
  let lb = b.length;
  if (collation === Collation.RTrim) {
    while (la > 0 && a.charCodeAt(la - 1) === 0x20) la--;
    while (lb > 0 && b.charCodeAt(lb - 1) === 0x20) lb--;
  }
  const n = la < lb ? la : lb;
  const nocase = collation === Collation.NoCase;
  for (let i = 0; i < n; i++) {
    let ca = a.charCodeAt(i);
    let cb = b.charCodeAt(i);
    if (ca === cb) continue;
    if (nocase) {
      ca = foldAscii(ca);
      cb = foldAscii(cb);
      if (ca === cb) continue;
    }
    if (ca >= 0xd800 || cb >= 0xd800) {
      ca = fixup(ca);
      cb = fixup(cb);
    }
    return ca < cb ? -1 : 1;
  }
  return la === lb ? 0 : la < lb ? -1 : 1;
}

/** Total order over SQL values following SQLite comparison semantics (NULLs equal, sorted first). */
export function compareValues(a: SqlValue, b: SqlValue, collation: Collation = Collation.Binary): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  switch (ra) {
    case 0:
      return 0;
    case 1:
      return compareNumeric(a as number | bigint, b as number | bigint);
    case 2:
      return compareText(a as string, b as string, collation);
    default:
      return compareBlobs(a as Uint8Array, b as Uint8Array);
  }
}
