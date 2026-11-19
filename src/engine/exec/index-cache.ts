/**
 * An index of a property graph's tables held in memory (prototype of option B, smaltcy ADR 0004): an edge table's
 * `(start, end)` and `(end, start)` indexes and the label index, each a two-column index, as one group per value of its
 * first column of its entries' second column and rowid, in the index's order. An equality seek on the first column (a
 * hop from a node: its relationships) or on both (a label check) reads the group instead of the B-tree.
 *
 * The cache is built from the index on first use and rebuilt when its table may have changed: after a write to the
 * table, a rollback, or a commit (this connection's or another's). It holds no data the index doesn't.
 */
import type { SqlValue } from '../values.js';
import type { BTree } from '../storage/btree.js';
import { decodeKey, readIndexRowid, rowidSuffixStart, type KeyColumn } from '../storage/key-codec.js';

export interface IndexGroup {
  /** The entries' second column, in index order. */
  readonly second: SqlValue[];
  readonly rowids: (number | bigint)[];
  /** By second column: the entries' positions (built on the first two-column seek). */
  bySecond?: Map<SqlValue, number[]>;
}

export class IndexCache {
  private constructor(private readonly groups: Map<SqlValue, IndexGroup>) {}

  /** The group of entries whose first column is `v` (a number or text, as the index's key holds it). */
  group(v: SqlValue): IndexGroup | undefined {
    return this.groups.get(v);
  }

  /** Every entry of a two-column index, read once in order. */
  static build(tree: BTree, columns: KeyColumn[]): IndexCache {
    const groups = new Map<SqlValue, IndexGroup>();
    const c = tree.cursor();
    try {
      let last: SqlValue | undefined;
      let g: IndexGroup | undefined;
      for (let ok = c.first(); ok; ok = c.next()) {
        c.loadKey();
        const kb = c.keyBytes;
        const end = c.keyOffset + c.keyLength;
        const [a, b] = decodeKey(kb.subarray(c.keyOffset, rowidSuffixStart(kb, end)), columns);
        if (g === undefined || a !== last) {
          g = groups.get(a!);
          if (g === undefined) groups.set(a!, (g = { second: [], rowids: [] }));
          last = a;
        }
        g.second.push(b!);
        g.rowids.push(readIndexRowid(kb, end));
      }
    } finally {
      c.close();
    }
    return new IndexCache(groups);
  }
}

/** The positions in `g` of the entries whose second column is `v`. */
export function entriesWith(g: IndexGroup, v: SqlValue): number[] | undefined {
  let by = g.bySecond;
  if (by === undefined) {
    by = new Map();
    for (let i = 0; i < g.second.length; i++) {
      const k = g.second[i]!;
      const list = by.get(k);
      if (list) list.push(i);
      else by.set(k, [i]);
    }
    g.bySecond = by;
  }
  return by.get(v);
}
