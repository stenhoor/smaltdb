import type { IndexSchema, TableSchema } from '../catalog/schema.js';
import { BTree } from '../storage/btree.js';
import { decodeKey, readRowidKey, writeRowidKey } from '../storage/key-codec.js';
import { RecordReader, type RecordLayout } from '../storage/record.js';
import type { SqlValue } from '../values.js';
import { hashKey } from './convert.js';

/**
 * Table and index statistics for the cost-based optimizer (docs/QUERY_ENGINE.md §3).
 * Gathered by ANALYZE and persisted as JSON in `smalt_stat(tbl, idx, stat)`.
 */
export interface TableStats {
  rows: number;
  /** Estimated distinct non-NULL values per column (HyperLogLog). */
  ndv: number[];
  /** NULLs per column. */
  nulls: number[];
}

export interface IndexStats {
  rows: number;
  /** avg[k] = average rows per distinct value of the first k+1 index columns (like sqlite_stat1). */
  avg: number[];
}

// ------------------------------------------------------------------ HyperLogLog

const HLL_BITS = 12;
const HLL_M = 1 << HLL_BITS;

/** Small HyperLogLog (4096 registers, ~1.6% standard error) for distinct-value counts. */
export class HyperLogLog {
  private readonly reg = new Uint8Array(HLL_M);

  add(h: number): void {
    const idx = h >>> (32 - HLL_BITS);
    const w = (h << HLL_BITS) | (1 << (HLL_BITS - 1));
    const rank = Math.clz32(w) + 1;
    if (rank > this.reg[idx]) this.reg[idx] = rank;
  }

  count(): number {
    let sum = 0;
    let zeros = 0;
    for (let i = 0; i < HLL_M; i++) {
      sum += 2 ** -this.reg[i];
      if (this.reg[i] === 0) zeros++;
    }
    const alpha = 0.7213 / (1 + 1.079 / HLL_M);
    const est = (alpha * HLL_M * HLL_M) / sum;
    if (est <= 2.5 * HLL_M && zeros > 0) return Math.round(HLL_M * Math.log(HLL_M / zeros)); // linear counting
    return Math.round(est);
  }
}

/** 32-bit hash of a SQL value (numbers by value, so 1 and 1.0 hash alike). */
export function hashValue(v: SqlValue): number {
  const k = hashKey(v);
  if (typeof k === 'number') {
    // Mix the float bits.
    F64[0] = k === 0 ? 0 : k;
    return mix(I32[0] ^ Math.imul(I32[1], 0x9e3779b1));
  }
  const s = typeof k === 'bigint' ? 'n' + k.toString() : String(k);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return mix(h);
}

const F64 = new Float64Array(1);
const I32 = new Int32Array(F64.buffer);

function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// ------------------------------------------------------------------ gathering

/** Scan a table and compute its statistics. */
export function analyzeTable(tree: BTree, table: TableSchema): TableStats {
  const n = table.columns.length;
  const hll = Array.from({ length: n }, () => new HyperLogLog());
  const nulls = new Array(n).fill(0);
  const reader = new RecordReader(table.layout, table.recordDefaults);
  let rows = 0;
  const c = tree.cursor();
  try {
    for (let ok = c.first(); ok; ok = c.next()) {
      rows++;
      c.loadValue();
      reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
      for (let i = 0; i < n; i++) {
        if (i === table.rowidAlias) continue;
        const v = reader.column(i);
        if (v === null) nulls[i]++;
        else hll[i].add(hashValue(v));
      }
    }
  } finally {
    c.close();
  }
  const ndv = hll.map((h, i) => (i === table.rowidAlias ? rows : Math.min(h.count(), rows - nulls[i])));
  return { rows, ndv, nulls };
}

/** Scan an index and compute rows-per-key for each prefix (keys are compared by decoded values). */
export function analyzeIndex(tree: BTree, index: IndexSchema): IndexStats {
  const k = index.columns.length;
  const distinct = new Array(k).fill(0);
  let rows = 0;
  let prev: SqlValue[] | null = null;
  const c = tree.cursor();
  try {
    for (let ok = c.first(); ok; ok = c.next()) {
      rows++;
      const key = c.key();
      const vals = decodeKey(key.subarray(0, key.length - 11), index.columns).slice(0, k);
      let firstDiff = prev === null ? 0 : k;
      if (prev !== null) {
        for (let i = 0; i < k; i++) {
          if (!sameKey(prev[i], vals[i])) {
            firstDiff = i;
            break;
          }
        }
      }
      for (let i = firstDiff; i < k; i++) distinct[i]++;
      prev = vals;
    }
  } finally {
    c.close();
  }
  return { rows, avg: distinct.map((d) => (d === 0 ? 1 : rows / d)) };
}

function sameKey(a: SqlValue, b: SqlValue): boolean {
  if (a === b) return true;
  if (a instanceof Uint8Array && b instanceof Uint8Array) return a.length === b.length && a.every((x, i) => x === b[i]);
  // eslint-disable-next-line eqeqeq
  return (typeof a === 'number' || typeof a === 'bigint') && (typeof b === 'number' || typeof b === 'bigint') && a == b;
}

// ------------------------------------------------------------------ sampling

/** Tables up to this many (estimated) rows are analyzed exactly instead of sampled. */
export const EXACT_STATS_ROWS = 4096;
/** Rows sampled from larger tables. */
const SAMPLE_ROWS = 512;

/**
 * Statistics for tables that have never been ANALYZEd, computed on demand by the planner.
 * Small tables are scanned exactly. Larger ones are sampled at {@link SAMPLE_ROWS} uniformly random
 * rowid positions (visited in ascending order). Single random rows, rather than runs of consecutive
 * rows or evenly spaced positions, keep clustered columns (runs of equal values in insertion order)
 * and periodic data from biasing the sample. Columns are hashed from their raw record bytes, without
 * decoding. Per-column distinct counts are scaled up with the Duj1 estimator (Haas & Stokes 1998):
 * D = n·d / (n − f1 + f1·n/N), where d is the distinct values in the sample and f1 the values seen
 * exactly once; it gives N for all-distinct samples and d when nothing is a singleton. Heavily
 * skewed columns (one value covering most rows) are underestimated; that needs most-common-value lists.
 */
export function sampleTable(tree: BTree, table: TableSchema, estimatedRows: number): TableStats | undefined {
  if (estimatedRows <= EXACT_STATS_ROWS) return analyzeTable(tree, table);
  const n = table.columns.length;
  const freq = Array.from({ length: n }, () => new Map<number, number>());
  const nulls = new Array(n).fill(0);
  const reader = new RecordReader(table.layout, table.recordDefaults);
  const layout = table.layout;
  let sampled = 0;
  const c = tree.cursor();
  try {
    if (!c.first()) return undefined;
    c.loadKey();
    const lo = Number(readRowidKey(c.keyBytes, c.keyOffset));
    c.last();
    c.loadKey();
    const hi = Number(readRowidKey(c.keyBytes, c.keyOffset));
    // Deterministic pseudo-random positions (xorshift32 seeded by the root page), ascending.
    const span = hi - lo + 1;
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || !Number.isSafeInteger(span)) return undefined;
    const targets = new Float64Array(SAMPLE_ROWS);
    let seed = (table.rootPage * 0x9e3779b1) >>> 0 || 1;
    for (let i = 0; i < SAMPLE_ROWS; i++) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      targets[i] = lo + Math.floor((seed / 4294967296) * span);
    }
    targets.sort();
    const key = new Uint8Array(8);
    let seen = -Infinity; // last rowid sampled (a target in a rowid gap lands on the next row; count it once)
    for (let i = 0; i < SAMPLE_ROWS; i++) {
      writeRowidKey(key, 0, Math.max(targets[i], seen + 1));
      if (!c.seek(key)) break;
      c.loadKey();
      seen = Number(readRowidKey(c.keyBytes, c.keyOffset));
      c.loadValue();
      sampled++;
      if (!hashRaw(c.valueBytes, c.valueOffset, layout, table.rowidAlias, freq, nulls)) {
        // Short record (older row after ADD COLUMN): decode values instead.
        reader.reset(c.valueBytes, c.valueOffset, c.valueLength);
        for (let k = 0; k < n; k++) {
          if (k === table.rowidAlias) continue;
          const v = reader.column(k);
          if (v === null) nulls[k]++;
          else bump(freq[k], hashValue(v));
        }
      }
    }
  } finally {
    c.close();
  }
  // Too few rows to say anything (e.g. rowids beyond ±2^53 cannot be seeked by position): no statistics.
  if (sampled < 64) return undefined;
  const N = Math.max(estimatedRows, sampled);
  const ns = sampled;
  const ndv = freq.map((m, k) => {
    if (k === table.rowidAlias) return N;
    let f1 = 0;
    for (const cnt of m.values()) if (cnt === 1) f1++;
    const d = m.size;
    const nonNull = Math.round(N * (1 - nulls[k] / ns));
    const sampleNonNull = ns - nulls[k];
    if (sampleNonNull <= 0) return 0;
    const est = (sampleNonNull * d) / (sampleNonNull - f1 + (f1 * sampleNonNull) / Math.max(1, nonNull));
    return Math.max(d, Math.min(Math.round(est), nonNull));
  });
  return { rows: N, ndv, nulls: nulls.map((x) => Math.round((x / ns) * N)) };
}

/** Count hash `h` (masked to 30 bits so Map keys stay V8 small integers). */
function bump(m: Map<number, number>, h: number): void {
  const k = h & 0x3fffffff;
  m.set(k, (m.get(k) ?? 0) + 1);
}

function varEnd(b: Uint8Array, vt: number, wide: boolean, j: number): number {
  return wide ? (b[vt + 4 * j] | (b[vt + 4 * j + 1] << 8) | (b[vt + 4 * j + 2] << 16) | (b[vt + 4 * j + 3] << 24)) >>> 0 : b[vt + 2 * j] | (b[vt + 2 * j + 1] << 8);
}

/**
 * Hash every column of a full-width record straight from its bytes (no value decoding): fixed
 * INTEGER/REAL slots by their 8 bytes, variable-length columns by their encoded bytes. Within one
 * column equal values have equal encodings (ANY columns may count 1 and 1.0 apart, which is
 * harmless for estimates). Returns false for records with fewer columns than the table.
 */
function hashRaw(b: Uint8Array, vo: number, layout: RecordLayout, rowidAlias: number, freq: Map<number, number>[], nulls: number[]): boolean {
  const types = layout.types;
  const n = types.length;
  if ((b[vo + 1] | (b[vo + 2] << 8)) !== n) return false;
  const L = layout.full;
  const bm = vo + 3;
  const fx = bm + ((n + 7) >>> 3);
  const vt = fx + L.fixedSize;
  const wide = (b[vo] & 1) === 1;
  const vd = vt + L.varCount * (wide ? 4 : 2);
  for (let k = 0; k < n; k++) {
    if (k === rowidAlias) continue;
    if (b[bm + (k >>> 3)] & (1 << (k & 7))) {
      nulls[k]++;
      continue;
    }
    const sl = L.slot[k];
    let h: number;
    if (layout.fixed[k]) {
      const o = fx + sl;
      const lo = b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
      const hi = b[o + 4] | (b[o + 5] << 8) | (b[o + 6] << 16) | (b[o + 7] << 24);
      h = mix(lo ^ Math.imul(hi, 0x9e3779b1));
    } else {
      const st = vd + (sl === 0 ? 0 : varEnd(b, vt, wide, sl - 1));
      const fin = vd + varEnd(b, vt, wide, sl);
      h = 0x811c9dc5;
      for (let i = st; i < fin; i++) h = Math.imul(h ^ b[i], 0x01000193);
      h = mix(h);
    }
    bump(freq[k], h);
  }
  return true;
}

/**
 * Cheap row-count estimate without ANALYZE: walk the leftmost path and multiply the fanout at each
 * level by the leaf's cell count. Reads only `depth` pages (usually cached).
 */
export function estimateRows(tree: BTree): number {
  return tree.estimateCount();
}
