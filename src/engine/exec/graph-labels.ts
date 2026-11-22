/**
 * A property graph's label index in memory (ADR 0040, section 5: "the index also holds each node's labels"): for each
 * label, the set of nodes that have it, so "does node n have label L" is a lookup and not a probe of the label
 * index's B+tree, and a label's nodes are read from its set, in id order, and counted there. It is part of the
 * graph's index (exec/graph-index.ts): built with it from the label index table, kept by that table's writer, and
 * dropped with it.
 *
 * A set is a bitmap over node ids, in pages of 32,768 ids made as they are needed, so ids need not be dense. It
 * knows the lowest and the highest node it has had since it was last empty, so a scan of a label of a few nodes
 * reads the words between them and not its page's 1,024.
 */

/** Node ids per page, as a power of two, and a page's 32-bit words. */
const PAGE_BITS = 15;
const PAGE_WORDS = 1 << (PAGE_BITS - 5);
/** For a scan of a label's set (`setOf`): the words of a page, as a power of two. */
export const LABEL_PAGE_WORD_BITS = PAGE_BITS - 5;

/** A label's set: its pages, how many nodes have the label, and the ids its nodes lie between. */
interface LabelSet {
  readonly pages: (Uint32Array | undefined)[];
  count: number;
  /** No node has the label below `first` or above `last`: the lowest and highest since the set was last empty (0 and -1 while it is). */
  first: number;
  last: number;
}

/** A label's set as a scan reads it. */
export type LabelNodes = Readonly<Omit<LabelSet, 'pages'>> & { readonly pages: readonly (Uint32Array | undefined)[] };

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

  /** Whether the node has a label. */
  any(node: number): boolean {
    const at = node >>> PAGE_BITS;
    const word = (node >>> 5) & (PAGE_WORDS - 1);
    const bit = 1 << (node & 31);
    for (const set of this.sets.values()) {
      const page = set.pages[at];
      if (page !== undefined && (page[word]! & bit) !== 0) return true;
    }
    return false;
  }

  /** The labels the node has. */
  labelsOf(node: number): string[] {
    const out: string[] = [];
    const word = (node >>> 5) & (PAGE_WORDS - 1);
    const bit = 1 << (node & 31);
    for (const [label, set] of this.sets) {
      const page = set.pages[node >>> PAGE_BITS];
      if (page !== undefined && (page[word]! & bit) !== 0) out.push(label);
    }
    return out;
  }

  /** How many nodes have the label. */
  count(label: string): number {
    return this.sets.get(label)?.count ?? 0;
  }

  /**
   * A label's set, for a scan of its nodes in id order: its pages of 32,768 ids, each a bitmap of 1,024 words
   * (`LABEL_PAGE_WORD_BITS`) or undefined where no node of the page has the label, and the ids its nodes lie
   * between. Undefined for a label no node has had. The set is the one writes change: a scan reads it as it is.
   */
  setOf(label: string): LabelNodes | undefined {
    return this.sets.get(label);
  }

  /** Gives the node the label. False when it had it already. */
  add(label: string, node: number): boolean {
    let set = this.sets.get(label);
    if (set === undefined) this.sets.set(label, (set = { pages: [], count: 0, first: 0, last: -1 }));
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
    if (set.count++ === 0) set.first = set.last = node;
    else if (node < set.first) set.first = node;
    else if (node > set.last) set.last = node;
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
    // The nodes left lie between the same ids, or closer; an empty set starts again.
    if (--set!.count === 0) {
      set!.first = 0;
      set!.last = -1;
    }
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
