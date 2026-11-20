/**
 * A path search over a property graph's edge tables (ADR 0040, section 2.3): what a `paths` operation that keeps one
 * path per node (mode `walk`, selector `any` or `anyShortest`, `minHops` 0 or 1) runs, as the table function
 * `smalt_paths(start, target, what)` its rewrite calls for each input row (exec/plan-normalize.ts).
 *
 * A breadth-first search from the start: nodes are taken in the order they were found, and each one's relationships
 * in the order of the operation's edge tables, outgoing before incoming, by other node and rowid, which is the order
 * the rewrite to `iterate` reads them in. The first path found to a node is kept, so the rows, their order and each
 * path are the rewrite's. With a target, the search stops when it finds it.
 *
 * A node's relationships come from the graph's index in memory, or, when the graph isn't indexed, from the edge
 * tables' endpoint indexes: the same relationships in the same order.
 */
import type { BTree, BTreeCursor } from '../storage/btree.js';
import { compareKeyAt } from '../util/bytes.js';
import { decodeKey, decodeSmallRun, encodeKey, readIndexRowid, rowidSuffixStart } from '../storage/key-codec.js';
import type { SqlValue } from '../values.js';
import { type GraphLists, ListCursor } from './graph-lists.js';

/** One way of reading one edge table: from the nodes in one endpoint column to those in the other. */
export interface Way {
  /** The edge table's position in the operation's `edges`: a hop's `edge`. */
  readonly edge: number;
  /** In the graph's index: the lists by this endpoint (out or in), and the table's type there. */
  readonly lists: GraphLists | null;
  readonly type: number;
  /** The endpoint index on (from, to), read when the graph isn't indexed. */
  readonly tree: BTree;
}

/** What a search walks: its ways in order (the operation's edge tables, each outgoing before incoming). */
export interface PathSearch {
  readonly ways: readonly Way[];
  readonly minHops: number;
  readonly maxHops: number | undefined;
  /** Whether the operation names a target: without one every node reached is a row. */
  readonly target: boolean;
}

const KEY_COLUMNS = [
  { desc: false, collation: 0 },
  { desc: false, collation: 0 },
] as const;

/** The rows of a search from `start`: where each path ends, its hops, and the path. */
export function* searchPaths(s: PathSearch, start: SqlValue, target: SqlValue): Generator<SqlValue[]> {
  if (start === null || (s.target && target === null)) return;
  // The nodes found, in order: each with its hops from the start and the hop that found it.
  const nodes: SqlValue[] = [start];
  const hops: number[] = [0];
  const parent: number[] = [-1];
  const edge: number[] = [0];
  const rowids: (number | bigint)[] = [0];
  /** The nodes a path is kept to. With `minHops` 1 the start is not one until a path comes back to it. */
  const seen = new Set<SqlValue>();
  const row = (i: number): SqlValue[] => {
    // A hop as `paths` gives it: the edge table's position, the relationship's rowid, and the nodes it went from and to.
    const path: Uint8Array[] = [];
    for (let k = i; parent[k]! >= 0; k = parent[k]!) path.push(encodeKey([edge[k]!, rowids[k]!, nodes[parent[k]!]!, nodes[k]!]));
    return [nodes[i]!, hops[i]!, encodeKey(path.reverse())];
  };
  if (s.minHops === 0) {
    seen.add(start);
    if (!s.target) yield row(0);
    else if (same(start, target)) {
      yield row(0);
      return;
    }
  }
  const cursor = new ListCursor();
  const run = new Float64Array(3);
  const trees: (BTreeCursor | null)[] = s.ways.map(() => null);
  try {
    for (let q = 0; q < nodes.length; q++) {
      const from = nodes[q]!;
      const depth = hops[q]!;
      if (s.maxHops !== undefined && depth >= s.maxHops) continue;
      // A node walked from is a number: an id. Anything else a table holds as an endpoint ends its path.
      if (typeof from !== 'number' && typeof from !== 'bigint') continue;
      for (let w = 0; w < s.ways.length; w++) {
        const way = s.ways[w]!;
        if (way.lists !== null) {
          if (typeof from !== 'number' || from < 0 || from > 2147483647 || !Number.isInteger(from)) continue;
          const lists = way.lists;
          const type = way.type;
          lists.seek(cursor, from, type);
          for (;;) {
            if (cursor.i >= cursor.end && !cursor.more()) break;
            const a = cursor.a;
            const i = cursor.i;
            if (a[i] !== type) break;
            cursor.i = i + 3;
            const to = a[i + 1]!;
            if (seen.has(to)) continue;
            seen.add(to);
            nodes.push(to);
            hops.push(depth + 1);
            parent.push(q);
            edge.push(way.edge);
            rowids.push(a[i + 2]!);
            if (!s.target) yield row(nodes.length - 1);
            else if (same(to, target)) {
              yield row(nodes.length - 1);
              return;
            }
          }
          continue;
        }
        const c = (trees[w] ??= way.tree.cursor());
        const lower = encodeKey([from]);
        const upper = new Uint8Array(lower.length + 1);
        upper.set(lower);
        upper[lower.length] = 0xff;
        for (let ok = c.seekNear(lower); ok; ok = c.next()) {
          c.loadKey();
          if (compareKeyAt(upper, c.keyBytes, c.keyOffset, c.keyLength) <= 0) break;
          let to: SqlValue;
          let rowid: number | bigint;
          if (decodeSmallRun(c.keyBytes, c.keyOffset, run)) {
            to = run[1]!;
            rowid = run[2]!;
          } else {
            const end = c.keyOffset + c.keyLength;
            to = decodeKey(c.keyBytes.subarray(c.keyOffset, rowidSuffixStart(c.keyBytes, end)), KEY_COLUMNS)[1]!;
            rowid = readIndexRowid(c.keyBytes, end);
          }
          if (seen.has(to)) continue;
          seen.add(to);
          nodes.push(to);
          hops.push(depth + 1);
          parent.push(q);
          edge.push(way.edge);
          rowids.push(rowid);
          if (!s.target) yield row(nodes.length - 1);
          else if (same(to, target)) {
            yield row(nodes.length - 1);
            return;
          }
        }
      }
    }
  } finally {
    for (const c of trees) c?.close();
  }
}

/** Two node ids the same: numbers by value (an integer and the real it equals are one id). */
function same(a: SqlValue, b: SqlValue): boolean {
  // eslint-disable-next-line eqeqeq
  return a === b || ((typeof a === 'number' || typeof a === 'bigint') && (typeof b === 'number' || typeof b === 'bigint') && a == b);
}
