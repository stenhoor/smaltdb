/**
 * A graph index's relationships in one direction (ADR 0040, section 1): for each node, its relationships as entries of
 * three 32-bit integers (the type's position in the graph, the node at the other end, the relationship's rowid), sorted
 * by all three. That is the order an endpoint index gives for one type, so a type is a range, "is there a relationship
 * to this node" is a binary search, and a reader of the lists returns rows in the index's order.
 *
 * - **Blocks.** A node's entries are a block of 1 to {@link CHUNK} entries in a slab of 32-bit integers; a full block
 *   moves to one of twice the size. Freed blocks are reused by size.
 * - **Long lists.** A node with more than CHUNK entries has a directory of blocks (chunks), so adding to a list of a
 *   million entries moves at most one chunk.
 * - **Nodes.** A node's list is found through a table of heads made in pages of {@link PAGE} ids, so ids need not be
 *   dense: a page exists once a node in it has a relationship.
 *
 * Ids are integers from 0 to 2^31 - 1; the caller checks (exec/graph-index.ts).
 */

/** Integers in the largest slab. A block lives in one slab; the first slab is small and each next one twice as large. */
const SLAB_BITS = 18;
const SLAB = 1 << SLAB_BITS;
const SLAB_MASK = SLAB - 1;
const FIRST_SLAB = 1 << 12;
/** The most entries a block holds. */
export const CHUNK = 1024;
/** The block size classes: a block of class c holds up to 2^c entries. */
const MIN_CLASS = 0;
const MAX_CLASS = 10;
/** Node ids per page of heads. */
const PAGE_BITS = 12;
export const PAGE = 1 << PAGE_BITS;
const PAGE_MASK = PAGE - 1;
/** A block's header: its length, and its class above these bits. */
const LEN_BITS = 12;
const LEN_MASK = (1 << LEN_BITS) - 1;

/** The blocks of a list too long for one. */
interface Dir {
  /** Block references, in order; the first `n` are used. */
  chunks: Int32Array;
  n: number;
}

/** Where a reader is in a node's list: entries are `a[i]`, `a[i + 1]`, `a[i + 2]` while `i < end`; then {@link more}. */
export class ListCursor {
  a: Int32Array = EMPTY;
  i = 0;
  end = 0;
  /** @internal */
  dir: Dir | null = null;
  /** @internal */
  chunk = 0;
  /** @internal */
  lists: GraphLists | null = null;

  /** At the end of a block: moves to the list's next block. False when there is none. */
  more(): boolean {
    const d = this.dir;
    if (d === null) return false;
    for (;;) {
      const next = this.chunk + 1;
      if (next >= d.n) return false;
      this.chunk = next;
      if (this.lists!.enter(this, d.chunks[next]!, 0)) return true;
    }
  }
}

const EMPTY = new Int32Array(0);

export class GraphLists {
  private slabs: Int32Array[] = [];
  /** The next free integer in the last slab, and that slab's size. */
  private top = 0;
  private room = 0;
  private slabInts = 0;
  private pages: (Int32Array | undefined)[] = [];
  private pageCount = 0;
  private dirs: (Dir | undefined)[] = [];
  private freeDirs: number[] = [];
  private dirInts = 0;
  private readonly free: number[][] = [];
  /** Entries in all lists. */
  entries = 0;
  /** Nodes that have an entry. */
  nodes = 0;
  /** Moves with every change: a cursor from before it must seek again (blocks move and are reused). */
  version = 0;

  /** Bytes held. */
  bytes(): number {
    return 4 * (this.slabInts + this.pageCount * PAGE + this.dirInts);
  }

  // ---------------------------------------------------------------- blocks

  /** A block for up to 2^cls entries, empty. A reference is a slab's number and an offset in it; 0 is no block. */
  private alloc(cls: number): number {
    const f = this.free[cls];
    let ref: number;
    if (f !== undefined && f.length > 0) ref = f.pop()!;
    else {
      const size = 1 + 3 * (1 << cls);
      if (this.top + size > this.room) {
        this.room = Math.min(SLAB, this.room === 0 ? FIRST_SLAB : 2 * this.room);
        this.slabs.push(new Int32Array(this.room));
        this.slabInts += this.room;
        // Offset 0 of the first slab is never a block: a reference of 0 means none.
        this.top = this.slabs.length === 1 ? 1 : 0;
      }
      ref = ((this.slabs.length - 1) << SLAB_BITS) | this.top;
      this.top += size;
    }
    this.slabs[ref >>> SLAB_BITS]![ref & SLAB_MASK] = cls << LEN_BITS;
    return ref;
  }

  private release(ref: number, cls: number): void {
    (this.free[cls] ??= []).push(ref);
  }

  /** The position (in entries) of the first entry of the block at `off` in `a` that is not below (type, other, rowid). */
  private lowerBound(a: Int32Array, off: number, type: number, other: number, rowid: number): number {
    let lo = 0;
    let hi = a[off]! & LEN_MASK;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const at = off + 1 + 3 * mid;
      const t = a[at]!;
      let below: boolean;
      if (t !== type) below = t < type;
      else {
        const o = a[at + 1]!;
        below = o !== other ? o < other : a[at + 2]! < rowid;
      }
      if (below) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** The chunk of `d` that (type, other, rowid) is in or belongs in: the last whose first entry is not above it. */
  private chunkFor(d: Dir, type: number, other: number, rowid: number): number {
    let lo = 0;
    let hi = d.n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      const ref = d.chunks[mid]!;
      const a = this.slabs[ref >>> SLAB_BITS]!;
      const at = (ref & SLAB_MASK) + 1;
      const t = a[at]!;
      let above: boolean;
      if (t !== type) above = t > type;
      else {
        const o = a[at + 1]!;
        above = o !== other ? o > other : a[at + 2]! > rowid;
      }
      if (above) hi = mid - 1;
      else lo = mid;
    }
    return lo;
  }

  // ---------------------------------------------------------------- heads

  /** A node's head: 0 for no list, a block's reference, or a directory as -(its number + 1). */
  private head(node: number): number {
    const p = this.pages[node >>> PAGE_BITS];
    return p === undefined ? 0 : p[node & PAGE_MASK]!;
  }

  private setHead(node: number, value: number): void {
    let p = this.pages[node >>> PAGE_BITS];
    if (p === undefined) {
      this.pages[node >>> PAGE_BITS] = p = new Int32Array(PAGE);
      this.pageCount++;
    }
    p[node & PAGE_MASK] = value;
  }

  private newDir(first: number, second: number): number {
    const d: Dir = { chunks: new Int32Array(8), n: 2 };
    d.chunks[0] = first;
    d.chunks[1] = second;
    this.dirInts += 8;
    const at = this.freeDirs.length > 0 ? this.freeDirs.pop()! : this.dirs.length;
    this.dirs[at] = d;
    return at;
  }

  /** Puts `ref` in `d` at position `at`. */
  private insertChunk(d: Dir, at: number, ref: number): void {
    if (d.n === d.chunks.length) {
      const next = new Int32Array(2 * d.chunks.length);
      next.set(d.chunks);
      this.dirInts += d.chunks.length;
      d.chunks = next;
    }
    d.chunks.copyWithin(at + 1, at, d.n);
    d.chunks[at] = ref;
    d.n++;
  }

  /** Moves the upper half of the full block `ref` to a new block, and returns it. */
  private split(ref: number): number {
    const a = this.slabs[ref >>> SLAB_BITS]!;
    const off = ref & SLAB_MASK;
    const half = CHUNK >>> 1;
    const upper = this.alloc(MAX_CLASS);
    const b = this.slabs[upper >>> SLAB_BITS]!;
    const boff = upper & SLAB_MASK;
    b.set(a.subarray(off + 1 + 3 * half, off + 1 + 3 * CHUNK), boff + 1);
    b[boff] = (MAX_CLASS << LEN_BITS) | half;
    a[off] = (MAX_CLASS << LEN_BITS) | half;
    return upper;
  }

  /** Writes an entry at position `at` of the block `ref`, which has room, moving the entries from there up. */
  private put(ref: number, at: number, type: number, other: number, rowid: number): void {
    const a = this.slabs[ref >>> SLAB_BITS]!;
    const off = ref & SLAB_MASK;
    const len = a[off]! & LEN_MASK;
    const i = off + 1 + 3 * at;
    if (at < len) a.copyWithin(i + 3, i, off + 1 + 3 * len);
    a[i] = type;
    a[i + 1] = other;
    a[i + 2] = rowid;
    a[off] = a[off]! + 1;
  }

  /** A block like `ref` of the next class, with its entries; `ref` is freed. */
  private grow(ref: number): number {
    const a = this.slabs[ref >>> SLAB_BITS]!;
    const off = ref & SLAB_MASK;
    const cls = a[off]! >>> LEN_BITS;
    const len = a[off]! & LEN_MASK;
    const bigger = this.alloc(cls + 1);
    const b = this.slabs[bigger >>> SLAB_BITS]!;
    const boff = bigger & SLAB_MASK;
    b.set(a.subarray(off + 1, off + 1 + 3 * len), boff + 1);
    b[boff] = ((cls + 1) << LEN_BITS) | len;
    this.release(ref, cls);
    return bigger;
  }

  // ---------------------------------------------------------------- writes

  /** Adds an entry to a node's list. It must not be there. */
  add(node: number, type: number, other: number, rowid: number): void {
    this.entries++;
    this.version++;
    let h = this.head(node);
    if (h === 0) {
      h = this.alloc(MIN_CLASS);
      this.setHead(node, h);
      this.nodes++;
    }
    if (h > 0) {
      const a = this.slabs[h >>> SLAB_BITS]!;
      const off = h & SLAB_MASK;
      const header = a[off]!;
      const len = header & LEN_MASK;
      if (len < 1 << (header >>> LEN_BITS)) {
        this.put(h, this.lowerBound(a, off, type, other, rowid), type, other, rowid);
        return;
      }
      if (len < CHUNK) {
        h = this.grow(h);
        this.setHead(node, h);
        this.put(h, this.lowerBound(this.slabs[h >>> SLAB_BITS]!, h & SLAB_MASK, type, other, rowid), type, other, rowid);
        return;
      }
      // A full block of the largest class: the list gets a directory.
      const upper = this.split(h);
      h = -(this.newDir(h, upper) + 1);
      this.setHead(node, h);
    }
    const d = this.dirs[-h - 1]!;
    let c = this.chunkFor(d, type, other, rowid);
    let ref = d.chunks[c]!;
    if ((this.slabs[ref >>> SLAB_BITS]![ref & SLAB_MASK]! & LEN_MASK) === CHUNK) {
      this.insertChunk(d, c + 1, this.split(ref));
      c = this.chunkFor(d, type, other, rowid);
      ref = d.chunks[c]!;
    }
    this.put(ref, this.lowerBound(this.slabs[ref >>> SLAB_BITS]!, ref & SLAB_MASK, type, other, rowid), type, other, rowid);
  }

  /**
   * Adds an entry that sorts after every entry of the node's list: a build that reads an endpoint index in key order,
   * type after type. Blocks fill completely, where {@link add} leaves a split one half full.
   */
  append(node: number, type: number, other: number, rowid: number): void {
    this.entries++;
    this.version++;
    let h = this.head(node);
    if (h === 0) {
      h = this.alloc(MIN_CLASS);
      this.setHead(node, h);
      this.nodes++;
    }
    if (h > 0) {
      const a = this.slabs[h >>> SLAB_BITS]!;
      const off = h & SLAB_MASK;
      const header = a[off]!;
      const len = header & LEN_MASK;
      if (len === 1 << (header >>> LEN_BITS)) {
        if (len < CHUNK) {
          h = this.grow(h);
          this.setHead(node, h);
        } else {
          const next = this.alloc(MAX_CLASS);
          this.setHead(node, -(this.newDir(h, next) + 1));
          h = next;
        }
      }
      this.put(h, this.slabs[h >>> SLAB_BITS]![h & SLAB_MASK]! & LEN_MASK, type, other, rowid);
      return;
    }
    const d = this.dirs[-h - 1]!;
    let ref = d.chunks[d.n - 1]!;
    if ((this.slabs[ref >>> SLAB_BITS]![ref & SLAB_MASK]! & LEN_MASK) === CHUNK) {
      ref = this.alloc(MAX_CLASS);
      this.insertChunk(d, d.n, ref);
    }
    this.put(ref, this.slabs[ref >>> SLAB_BITS]![ref & SLAB_MASK]! & LEN_MASK, type, other, rowid);
  }

  /** Removes an entry from a node's list. False when it isn't there. */
  remove(node: number, type: number, other: number, rowid: number): boolean {
    const h = this.head(node);
    if (h === 0) return false;
    let d: Dir | null = null;
    let c = 0;
    let ref = h;
    if (h < 0) {
      d = this.dirs[-h - 1]!;
      c = this.chunkFor(d, type, other, rowid);
      ref = d.chunks[c]!;
    }
    const a = this.slabs[ref >>> SLAB_BITS]!;
    const off = ref & SLAB_MASK;
    const header = a[off]!;
    const len = header & LEN_MASK;
    const at = this.lowerBound(a, off, type, other, rowid);
    const i = off + 1 + 3 * at;
    if (at === len || a[i] !== type || a[i + 1] !== other || a[i + 2] !== rowid) return false;
    a.copyWithin(i, i + 3, off + 1 + 3 * len);
    a[off] = header - 1;
    this.entries--;
    this.version++;
    if (len > 1) return true;
    // The block is empty.
    this.release(ref, header >>> LEN_BITS);
    if (d === null) {
      this.setHead(node, 0);
      this.nodes--;
      return true;
    }
    d.chunks.copyWithin(c, c + 1, d.n);
    d.n--;
    if (d.n === 0) {
      this.dirInts -= d.chunks.length;
      this.dirs[-h - 1] = undefined;
      this.freeDirs.push(-h - 1);
      this.setHead(node, 0);
      this.nodes--;
    }
    return true;
  }

  // ---------------------------------------------------------------- reads

  /** @internal Points `c` at position `at` of the block `ref`. False when the block ends there. */
  enter(c: ListCursor, ref: number, at: number): boolean {
    const a = this.slabs[ref >>> SLAB_BITS]!;
    const off = ref & SLAB_MASK;
    c.a = a;
    c.i = off + 1 + 3 * at;
    c.end = off + 1 + 3 * (a[off]! & LEN_MASK);
    return c.i < c.end;
  }

  /**
   * Points `c` at the node's first entry that is not below (type, other, rowid). A reader takes entries while they
   * are of its type (and other node), calling {@link ListCursor.more} at the end of each block.
   */
  seek(c: ListCursor, node: number, type: number, other = 0, rowid = 0): void {
    const h = this.head(node);
    if (h === 0) {
      c.a = EMPTY;
      c.i = c.end = 0;
      c.dir = null;
      return;
    }
    if (h > 0) {
      c.dir = null;
      const a = this.slabs[h >>> SLAB_BITS]!;
      this.enter(c, h, type === 0 && other === 0 && rowid === 0 ? 0 : this.lowerBound(a, h & SLAB_MASK, type, other, rowid));
      return;
    }
    const d = this.dirs[-h - 1]!;
    c.dir = d;
    c.lists = this;
    const at = this.chunkFor(d, type, other, rowid);
    c.chunk = at;
    const ref = d.chunks[at]!;
    this.enter(c, ref, this.lowerBound(this.slabs[ref >>> SLAB_BITS]!, ref & SLAB_MASK, type, other, rowid));
  }

  /** Whether the node has the entry. */
  has(node: number, type: number, other: number, rowid: number): boolean {
    const c = SCRATCH;
    this.seek(c, node, type, other, rowid);
    if (c.i >= c.end && !c.more()) return false;
    return c.a[c.i] === type && c.a[c.i + 1] === other && c.a[c.i + 2] === rowid;
  }

  /** Every entry, node by node in id order and in each list's order. */
  forEach(fn: (node: number, type: number, other: number, rowid: number) => void): void {
    const c = new ListCursor();
    this.pages.forEach((p, pi) => {
      if (p === undefined) return;
      for (let k = 0; k < PAGE; k++) {
        if (p[k] === 0) continue;
        const node = pi * PAGE + k;
        this.seek(c, node, 0);
        while (c.i < c.end || c.more()) {
          fn(node, c.a[c.i]!, c.a[c.i + 1]!, c.a[c.i + 2]!);
          c.i += 3;
        }
      }
    });
  }
}

const SCRATCH = new ListCursor();
