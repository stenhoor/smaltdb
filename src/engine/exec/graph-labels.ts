/**
 * A property graph's label index in memory (ADR 0040, section 5: "the index also holds each node's labels"): for each
 * label, the set of nodes that have it, so "does node n have label L" is a lookup and not a probe of the label
 * index's B+tree, and a label's nodes are read from its set, in id order, and counted there. It is part of the
 * graph's index (exec/graph-index.ts): built with it from the label index table, kept by that table's writer, and
 * dropped with it.
 *
 * A set is a bitmap over node ids, in pages of 32,768 ids made as they are needed, so ids need not be dense.
 */

/** Node ids per page, as a power of two, and a page's 32-bit words. */
const PAGE_BITS = 15;
const PAGE_WORDS = 1 << (PAGE_BITS - 5);
/** For a scan of a label's pages (`pagesOf`). */
export const LABEL_PAGE_BITS = PAGE_BITS;
export const LABEL_PAGE_WORDS = PAGE_WORDS;

/** A label's set: its pages, and how many nodes have the label. */
interface LabelSet {
  readonly pages: (Uint32Array | undefined)[];
  count: number;
}

export class GraphLabels {
  private readonly sets = new Map<string, LabelSet>();
  private pages = 0;
  /** Entries in all sets. */
  entries = 0;

  /** Bytes held. */
  bytes(): number {
    return this.pages * PAGE_WORDS * 4;
  }

  /** Whether the node has the label. */
  has(label: string, node: number): boolean {
    const set = this.sets.get(label);
    if (set === undefined) return false;
    const page = set.pages[node >>> PAGE_BITS];
    return page !== undefined && (page[(node >>> 5) & (PAGE_WORDS - 1)]! & (1 << (node & 31))) !== 0;
  }

  /** How many nodes have the label. */
  count(label: string): number {
    return this.sets.get(label)?.count ?? 0;
  }

  /**
   * A label's set, for a scan of its nodes in id order: its pages of 32,768 ids (`LABEL_PAGE_BITS`), each a bitmap of
   * 1,024 words or undefined where no node of the page has the label. Undefined for a label no node has had.
   */
  pagesOf(label: string): readonly (Uint32Array | undefined)[] | undefined {
    return this.sets.get(label)?.pages;
  }

  /** Gives the node the label. False when it had it already. */
  add(label: string, node: number): boolean {
    let set = this.sets.get(label);
    if (set === undefined) this.sets.set(label, (set = { pages: [], count: 0 }));
    const at = node >>> PAGE_BITS;
    let page = set.pages[at];
    if (page === undefined) {
      page = set.pages[at] = new Uint32Array(PAGE_WORDS);
      this.pages++;
    }
    const word = (node >>> 5) & (PAGE_WORDS - 1);
    const bit = 1 << (node & 31);
    if ((page[word]! & bit) !== 0) return false;
    page[word] = page[word]! | bit;
    set.count++;
    this.entries++;
    return true;
  }

  /** Takes the label from the node. False when it didn't have it. */
  remove(label: string, node: number): boolean {
    const set = this.sets.get(label);
    const page = set?.pages[node >>> PAGE_BITS];
    if (page === undefined) return false;
    const word = (node >>> 5) & (PAGE_WORDS - 1);
    const bit = 1 << (node & 31);
    if ((page[word]! & bit) === 0) return false;
    page[word] = page[word]! & ~bit;
    set!.count--;
    this.entries--;
    return true;
  }

  /** Every entry, label by label and by node id. */
  forEach(fn: (label: string, node: number) => void): void {
    for (const [label, set] of this.sets) {
      set.pages.forEach((page, at) => {
        if (page === undefined) return;
        for (let w = 0; w < PAGE_WORDS; w++) {
          let bits = page[w]!;
          while (bits !== 0) {
            const b = 31 - Math.clz32(bits & -bits);
            fn(label, (at << PAGE_BITS) + (w << 5) + b);
            bits &= bits - 1;
          }
        }
      });
    }
  }
}
