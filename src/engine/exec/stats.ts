import type { IndexSchema, TableSchema } from '../catalog/schema.js';
import { BTree } from '../storage/btree.js';
import { decodeKey } from '../storage/key-codec.js';
import { RecordReader } from '../storage/record.js';
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

/**
 * Cheap row-count estimate without ANALYZE: walk the leftmost path and multiply the fanout at each
 * level by the leaf's cell count. Reads only `depth` pages (usually cached).
 */
export function estimateRows(tree: BTree): number {
  return tree.estimateCount();
}
