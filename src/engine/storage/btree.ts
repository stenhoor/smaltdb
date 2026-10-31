import { CorruptionError, MisuseError } from '../errors.js';
import { compareKeyAt, compareRanges } from '../util/bytes.js';
import { PAGE_HEADER_SIZE as H, PH_CELL_COUNT, PH_CONTENT_START, PH_FRAG_BYTES, PH_PREV, PH_RIGHT, PageType } from './format.js';
import type { Frame, Pager } from './pager.js';

/*
 * B+tree over memcmp-comparable byte-string keys with byte-string values.
 *
 * Page body is a slotted page: a u16 slot directory grows up from the header, cell content grows
 * down from `usableSize`.
 *
 *   leaf cell:      u16 keyLen | u8 flags | u32 valueLen | key | value            (inline)
 *                   u16 keyLen | u8 flags | u32 valueLen | key | u32 overflowHead (flags & OVERFLOW)
 *   interior cell:  u32 child | u16 keyLen | key
 *
 * Interior page with cells (k0,c0)..(kn-1,cn-1) and right pointer r: child ci holds keys < ki,
 * r holds keys >= kn-1. Separators are suffix-truncated (shortest byte string that separates).
 * Leaves are doubly linked (PH_RIGHT = next, PH_PREV = previous) for range scans.
 * The root page number never changes: root splits move the root's content into new children.
 */

const LEAF_HDR = 7;
const INT_HDR = 6;
const FLAG_OVERFLOW = 1;
const MAX_DEPTH = 40;

/** Minimal page-buffer shape shared by frames and scratch buffers. */
interface PageBuf {
  readonly bytes: Uint8Array;
  readonly view: DataView;
}

// ------------------------------------------------------------------ slotted-page primitives

function nCells(p: PageBuf): number {
  return p.view.getUint16(PH_CELL_COUNT, true);
}
function slot(p: PageBuf, i: number): number {
  return p.view.getUint16(H + 2 * i, true);
}
function rightPtr(p: PageBuf): number {
  return p.view.getUint32(PH_RIGHT, true);
}
function setRightPtr(p: PageBuf, v: number): void {
  p.view.setUint32(PH_RIGHT, v, true);
}
function prevPtr(p: PageBuf): number {
  return p.view.getUint32(PH_PREV, true);
}
function setPrevPtr(p: PageBuf, v: number): void {
  p.view.setUint32(PH_PREV, v, true);
}
function isLeaf(p: PageBuf): boolean {
  return p.bytes[0] === PageType.BTreeLeaf;
}

function cellSizeAt(p: PageBuf, off: number, leaf: boolean): number {
  if (leaf) {
    const kl = p.view.getUint16(off, true);
    return p.bytes[off + 2] & FLAG_OVERFLOW ? LEAF_HDR + kl + 4 : LEAF_HDR + kl + p.view.getUint32(off + 3, true);
  }
  return INT_HDR + p.view.getUint16(off + 4, true);
}

function initPage(p: PageBuf, type: number, usable: number): void {
  p.bytes.fill(0, 0, usable);
  p.bytes[0] = type;
  p.view.setUint16(PH_CONTENT_START, usable, true);
}

function freeSpace(p: PageBuf): number {
  return p.view.getUint16(PH_CONTENT_START, true) - (H + 2 * nCells(p)) + p.view.getUint16(PH_FRAG_BYTES, true);
}

export interface IntegrityReport {
  /** Pages in the tree, including overflow pages. */
  pages: number;
  leaves: number;
  overflowPages: number;
  depth: number;
  keys: number;
}

export class BTree {
  readonly usable: number;
  /** Largest cell stored inline; guarantees >= 4 cells per page. */
  private readonly maxLocal: number;
  readonly maxKeySize: number;
  private readonly overflowCapacity: number;

  private readonly pathPg = new Int32Array(MAX_DEPTH);
  private readonly pathIdx = new Int32Array(MAX_DEPTH);
  private depth = 0;
  private readonly scratch: PageBuf;
  private readonly cellBuf: Uint8Array;
  private readonly cellView: DataView;

  constructor(
    readonly pager: Pager,
    readonly root: number,
  ) {
    this.usable = pager.usableSize;
    this.maxLocal = Math.floor((this.usable - H) / 4) - 2;
    this.maxKeySize = this.maxLocal - LEAF_HDR - 4;
    this.overflowCapacity = this.usable - H;
    const s = new Uint8Array(pager.pageSize);
    this.scratch = { bytes: s, view: new DataView(s.buffer) };
    this.cellBuf = new Uint8Array(this.maxLocal);
    this.cellView = new DataView(this.cellBuf.buffer);
  }

  /** Allocate an empty tree and return its root page number. */
  static create(pager: Pager): number {
    const f = pager.allocate();
    initPage(f, PageType.BTreeLeaf, pager.usableSize);
    const pgno = f.pgno;
    pager.release(f);
    return pgno;
  }

  // ---------------------------------------------------------------- lookups

  get(key: Uint8Array): Uint8Array | undefined {
    const leaf = this.descend(key, false);
    try {
      const i = this.leafLowerBound(leaf, key);
      if (i < nCells(leaf)) {
        const off = slot(leaf, i);
        if (compareKeyAt(key, leaf.bytes, off + LEAF_HDR, leaf.view.getUint16(off, true)) === 0) {
          return this.readValue(leaf, off);
        }
      }
      return undefined;
    } finally {
      this.pager.release(leaf);
    }
  }

  has(key: Uint8Array): boolean {
    const leaf = this.descend(key, false);
    try {
      const i = this.leafLowerBound(leaf, key);
      if (i >= nCells(leaf)) return false;
      const off = slot(leaf, i);
      return compareKeyAt(key, leaf.bytes, off + LEAF_HDR, leaf.view.getUint16(off, true)) === 0;
    } finally {
      this.pager.release(leaf);
    }
  }

  /** Number of keys, summed from per-leaf cell counts along the leaf chain (no row decoding). */
  count(): number {
    const pager = this.pager;
    let f = this.descendForCursor(null, false);
    let n = 0;
    for (;;) {
      n += nCells(f);
      const next = rightPtr(f);
      pager.release(f);
      if (next === 0) return n;
      f = pager.get(next);
    }
  }

  cursor(): BTreeCursor {
    return new BTreeCursor(this);
  }

  // ---------------------------------------------------------------- mutations

  /** Insert or replace. */
  put(key: Uint8Array, value: Uint8Array): void {
    if (key.length > this.maxKeySize) throw new MisuseError(`key too large (${key.length} > ${this.maxKeySize} bytes)`);
    const pager = this.pager;
    const leaf = this.descend(key, true);
    try {
      pager.markDirty(leaf);
      const i = this.leafLowerBound(leaf, key);
      if (i < nCells(leaf)) {
        const off = slot(leaf, i);
        if (compareKeyAt(key, leaf.bytes, off + LEAF_HDR, leaf.view.getUint16(off, true)) === 0) {
          this.freeCellOverflow(leaf, off);
          this.removeCell(leaf, i, true);
        }
      }
      const size = this.buildLeafCell(key, value);
      if (!this.insertCell(leaf, i, this.cellBuf, size)) this.splitLeaf(leaf, i, this.cellBuf.slice(0, size));
    } finally {
      pager.release(leaf);
    }
  }

  /** Delete a key. Returns true if it existed. */
  delete(key: Uint8Array): boolean {
    const pager = this.pager;
    const leaf = this.descend(key, true);
    let rebalance = false;
    try {
      const i = this.leafLowerBound(leaf, key);
      if (i >= nCells(leaf)) return false;
      const off = slot(leaf, i);
      if (compareKeyAt(key, leaf.bytes, off + LEAF_HDR, leaf.view.getUint16(off, true)) !== 0) return false;
      pager.markDirty(leaf);
      this.freeCellOverflow(leaf, off);
      this.removeCell(leaf, i, true);
      rebalance = leaf.pgno !== this.root && this.isUnderfull(leaf);
    } finally {
      pager.release(leaf);
    }
    if (rebalance) this.rebalance(this.depth - 1);
    return true;
  }

  /** Free every page of the tree, including the root. */
  destroy(): void {
    this.freeSubtree(this.root);
  }

  /**
   * Verify structural invariants: key order within and across pages, separator bounds, uniform
   * leaf depth, sibling links, and overflow chain lengths. Throws CorruptionError on violation.
   */
  checkIntegrity(): IntegrityReport {
    const report: IntegrityReport = { pages: 0, leaves: 0, overflowPages: 0, depth: -1, keys: 0 };
    const leaves: number[] = [];
    this.checkNode(this.root, null, null, 0, report, leaves);
    // Sibling links must chain the leaves left to right.
    for (let i = 0; i < leaves.length; i++) {
      const f = this.pager.get(leaves[i]);
      const prev = prevPtr(f);
      const next = rightPtr(f);
      this.pager.release(f);
      const expPrev = i > 0 ? leaves[i - 1] : 0;
      const expNext = i < leaves.length - 1 ? leaves[i + 1] : 0;
      if (leaves.length > 1 || leaves[0] !== this.root) {
        if (prev !== expPrev || next !== expNext) {
          throw new CorruptionError(`leaf ${leaves[i]}: sibling links (${prev},${next}) expected (${expPrev},${expNext})`);
        }
      }
    }
    return report;
  }

  private checkNode(
    pg: number,
    lower: Uint8Array | null,
    upper: Uint8Array | null,
    depth: number,
    report: IntegrityReport,
    leaves: number[],
  ): void {
    const pager = this.pager;
    const f = pager.get(pg);
    report.pages++;
    const children: Array<[number, Uint8Array | null, Uint8Array | null]> = [];
    const overflow: Array<[number, number]> = [];
    try {
      const leaf = isLeaf(f);
      if (!leaf && f.bytes[0] !== PageType.BTreeInterior) throw new CorruptionError(`page ${pg}: bad type ${f.bytes[0]}`);
      const n = nCells(f);
      const cs = f.view.getUint16(PH_CONTENT_START, true);
      if (H + 2 * n > cs || cs > this.usable) throw new CorruptionError(`page ${pg}: slot directory overlaps content`);
      let used = 0;
      let prevKey: Uint8Array | null = lower;
      for (let i = 0; i < n; i++) {
        const off = slot(f, i);
        const size = cellSizeAt(f, off, leaf);
        if (off < cs || off + size > this.usable) throw new CorruptionError(`page ${pg}: cell ${i} out of bounds`);
        used += size;
        const ko = leaf ? off + LEAF_HDR : off + INT_HDR;
        const kl = leaf ? f.view.getUint16(off, true) : f.view.getUint16(off + 4, true);
        const key = f.bytes.slice(ko, ko + kl);
        if (prevKey !== null) {
          const c = compareRanges(key, 0, kl, prevKey, 0, prevKey.length);
          // Keys strictly increase within a page; the first key may equal the inherited lower bound.
          if (c < 0 || (c === 0 && i > 0)) throw new CorruptionError(`page ${pg}: keys out of order at cell ${i}`);
        }
        if (upper !== null && compareRanges(key, 0, kl, upper, 0, upper.length) >= 0) {
          throw new CorruptionError(`page ${pg}: key ${i} not below upper bound`);
        }
        if (leaf) {
          report.keys++;
          if (f.bytes[off + 2] & FLAG_OVERFLOW) {
            overflow.push([f.view.getUint32(ko + kl, true), f.view.getUint32(off + 3, true)]);
          }
        } else {
          children.push([f.view.getUint32(off, true), prevKey, key]);
        }
        prevKey = key;
      }
      const frag = f.view.getUint16(PH_FRAG_BYTES, true);
      if (used + frag !== this.usable - cs) throw new CorruptionError(`page ${pg}: space accounting mismatch`);
      if (leaf) {
        report.leaves++;
        leaves.push(pg);
        if (report.depth === -1) report.depth = depth;
        else if (report.depth !== depth) throw new CorruptionError(`leaf ${pg} at depth ${depth}, expected ${report.depth}`);
      } else {
        children.push([rightPtr(f), prevKey, upper]);
      }
    } finally {
      pager.release(f);
    }
    for (const [head, len] of overflow) {
      let pgo = head;
      let remaining = len;
      while (remaining > 0) {
        if (pgo === 0) throw new CorruptionError('overflow chain too short');
        const o = pager.get(pgo);
        const t = o.bytes[0];
        const next = rightPtr(o);
        pager.release(o);
        if (t !== PageType.Overflow) throw new CorruptionError(`page ${pgo}: expected overflow page`);
        report.pages++;
        report.overflowPages++;
        remaining -= this.overflowCapacity;
        pgo = next;
      }
      if (pgo !== 0) throw new CorruptionError('overflow chain too long');
    }
    for (const [c, lo, hi] of children) this.checkNode(c, lo, hi, depth + 1, report, leaves);
  }

  // ---------------------------------------------------------------- descent

  /** Descend to the leaf that would hold `key` (pinned). Records the path when `record`. */
  private descend(key: Uint8Array, record: boolean): Frame {
    const pager = this.pager;
    let pg = this.root;
    let d = 0;
    for (;;) {
      const f = pager.get(pg);
      const type = f.bytes[0];
      if (type === PageType.BTreeLeaf) {
        if (record) this.depth = d;
        return f;
      }
      if (type !== PageType.BTreeInterior) {
        pager.release(f);
        throw new CorruptionError(`page ${pg}: expected b-tree page, found type ${type}`);
      }
      const i = this.interiorUpperBound(f, key);
      if (record) {
        if (d >= MAX_DEPTH) throw new CorruptionError('b-tree too deep');
        this.pathPg[d] = pg;
        this.pathIdx[d] = i;
      }
      d++;
      const child = i < nCells(f) ? f.view.getUint32(slot(f, i), true) : rightPtr(f);
      pager.release(f);
      pg = child;
    }
  }

  /** @internal Descend for cursors: leftmost (dir<0) or rightmost (dir>0) leaf, or toward `key`. */
  descendForCursor(key: Uint8Array | null, rightmost: boolean): Frame {
    if (key !== null) return this.descend(key, false);
    const pager = this.pager;
    let pg = this.root;
    for (;;) {
      const f = pager.get(pg);
      if (isLeaf(f)) return f;
      const child = rightmost ? rightPtr(f) : nCells(f) > 0 ? f.view.getUint32(slot(f, 0), true) : rightPtr(f);
      pager.release(f);
      pg = child;
    }
  }

  /** First cell index with key >= `key`. */
  leafLowerBound(p: PageBuf, key: Uint8Array): number {
    let lo = 0;
    let hi = nCells(p);
    const bytes = p.bytes;
    const view = p.view;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const off = view.getUint16(H + 2 * mid, true);
      if (compareKeyAt(key, bytes, off + LEAF_HDR, view.getUint16(off, true)) > 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** First cell index with key < separator (n means the right pointer). */
  private interiorUpperBound(p: PageBuf, key: Uint8Array): number {
    let lo = 0;
    let hi = nCells(p);
    const bytes = p.bytes;
    const view = p.view;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const off = view.getUint16(H + 2 * mid, true);
      if (compareKeyAt(key, bytes, off + INT_HDR, view.getUint16(off + 4, true)) < 0) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  // ---------------------------------------------------------------- cell helpers

  private buildLeafCell(key: Uint8Array, value: Uint8Array): number {
    const buf = this.cellBuf;
    const v = this.cellView;
    const kl = key.length;
    v.setUint16(0, kl, true);
    v.setUint32(3, value.length, true);
    buf.set(key, LEAF_HDR);
    if (LEAF_HDR + kl + value.length <= this.maxLocal) {
      buf[2] = 0;
      buf.set(value, LEAF_HDR + kl);
      return LEAF_HDR + kl + value.length;
    }
    buf[2] = FLAG_OVERFLOW;
    v.setUint32(LEAF_HDR + kl, this.writeOverflow(value), true);
    return LEAF_HDR + kl + 4;
  }

  /** @internal Copy of the value stored in leaf cell at `off`. */
  readValue(p: PageBuf, off: number): Uint8Array {
    const kl = p.view.getUint16(off, true);
    const vl = p.view.getUint32(off + 3, true);
    const start = off + LEAF_HDR + kl;
    if (!(p.bytes[off + 2] & FLAG_OVERFLOW)) return p.bytes.slice(start, start + vl);
    const out = new Uint8Array(vl);
    let pg = p.view.getUint32(start, true);
    let pos = 0;
    while (pos < vl) {
      if (pg === 0) throw new CorruptionError('overflow chain too short');
      const f = this.pager.get(pg);
      const n = Math.min(this.overflowCapacity, vl - pos);
      out.set(f.bytes.subarray(H, H + n), pos);
      pos += n;
      const next = rightPtr(f);
      this.pager.release(f);
      pg = next;
    }
    return out;
  }

  private writeOverflow(value: Uint8Array): number {
    const pager = this.pager;
    const cap = this.overflowCapacity;
    // Write the chain back-to-front so each page can point at its successor.
    let next = 0;
    const count = Math.ceil(value.length / cap);
    for (let c = count - 1; c >= 0; c--) {
      const f = pager.allocate();
      f.bytes[0] = PageType.Overflow;
      setRightPtr(f, next);
      f.bytes.set(value.subarray(c * cap, Math.min(value.length, (c + 1) * cap)), H);
      next = f.pgno;
      pager.release(f);
    }
    return next;
  }

  private freeCellOverflow(p: PageBuf, off: number): void {
    if (!(p.bytes[off + 2] & FLAG_OVERFLOW)) return;
    let pg = p.view.getUint32(off + LEAF_HDR + p.view.getUint16(off, true), true);
    while (pg !== 0) {
      const f = this.pager.get(pg);
      const next = rightPtr(f);
      this.pager.release(f);
      this.pager.free(pg);
      pg = next;
    }
  }

  /** Insert a cell at slot i. Returns false if it does not fit even after defragmentation. */
  private insertCell(p: PageBuf, i: number, src: Uint8Array, size: number): boolean {
    const view = p.view;
    const n = nCells(p);
    let cs = view.getUint16(PH_CONTENT_START, true);
    const gap = cs - (H + 2 * (n + 1));
    if (gap < size) {
      if (gap + view.getUint16(PH_FRAG_BYTES, true) < size) return false;
      this.defragment(p);
      cs = view.getUint16(PH_CONTENT_START, true);
    }
    cs -= size;
    p.bytes.set(size === src.length ? src : src.subarray(0, size), cs);
    if (i < n) p.bytes.copyWithin(H + 2 * (i + 1), H + 2 * i, H + 2 * n);
    view.setUint16(H + 2 * i, cs, true);
    view.setUint16(PH_CELL_COUNT, n + 1, true);
    view.setUint16(PH_CONTENT_START, cs, true);
    return true;
  }

  private removeCell(p: PageBuf, i: number, leaf: boolean): void {
    const view = p.view;
    const n = nCells(p);
    const off = slot(p, i);
    const size = cellSizeAt(p, off, leaf);
    if (i < n - 1) p.bytes.copyWithin(H + 2 * i, H + 2 * (i + 1), H + 2 * n);
    view.setUint16(PH_CELL_COUNT, n - 1, true);
    if (n === 1) {
      view.setUint16(PH_CONTENT_START, this.usable, true);
      view.setUint16(PH_FRAG_BYTES, 0, true);
    } else if (off === view.getUint16(PH_CONTENT_START, true)) {
      view.setUint16(PH_CONTENT_START, off + size, true);
    } else {
      view.setUint16(PH_FRAG_BYTES, view.getUint16(PH_FRAG_BYTES, true) + size, true);
    }
  }

  private defragment(p: PageBuf): void {
    const s = this.scratch;
    const leaf = isLeaf(p);
    s.bytes.set(p.bytes.subarray(0, this.usable));
    const n = nCells(p);
    let pos = this.usable;
    for (let i = 0; i < n; i++) {
      const off = slot(s, i);
      const size = cellSizeAt(s, off, leaf);
      pos -= size;
      p.bytes.set(s.bytes.subarray(off, off + size), pos);
      p.view.setUint16(H + 2 * i, pos, true);
    }
    p.view.setUint16(PH_CONTENT_START, pos, true);
    p.view.setUint16(PH_FRAG_BYTES, 0, true);
  }

  private usedBytes(p: PageBuf): number {
    return this.usable - freeSpace(p);
  }

  private isUnderfull(p: PageBuf): boolean {
    return this.usedBytes(p) < (this.usable >>> 2);
  }

  /** Copy cell i of `p` into a fresh array. */
  private copyCell(p: PageBuf, i: number, leaf: boolean): Uint8Array {
    const off = slot(p, i);
    return p.bytes.slice(off, off + cellSizeAt(p, off, leaf));
  }

  // ---------------------------------------------------------------- splits

  /** Leaf overflow: distribute existing cells plus `cell` (at index i) over two pages. */
  private splitLeaf(leaf: Frame, i: number, cell: Uint8Array): void {
    const pager = this.pager;
    const cells: Uint8Array[] = [];
    const n = nCells(leaf);
    for (let k = 0; k < n; k++) cells.push(this.copyCell(leaf, k, true));
    cells.splice(i, 0, cell);
    const m = splitPoint(cells);
    const lastLeft = cells[m - 1];
    const firstRight = cells[m];
    const sep = shortestSeparator(
      lastLeft, LEAF_HDR, lastLeft[0] | (lastLeft[1] << 8),
      firstRight, LEAF_HDR, firstRight[0] | (firstRight[1] << 8),
    );

    if (leaf.pgno === this.root) {
      const left = pager.allocate();
      const right = pager.allocate();
      this.fillPage(left, PageType.BTreeLeaf, cells, 0, m);
      this.fillPage(right, PageType.BTreeLeaf, cells, m, cells.length);
      setRightPtr(left, right.pgno);
      setPrevPtr(right, left.pgno);
      this.makeRootInterior(leaf, sep, left.pgno, right.pgno);
      pager.release(left);
      pager.release(right);
      return;
    }

    const oldNext = rightPtr(leaf);
    const oldPrev = prevPtr(leaf);
    const right = pager.allocate();
    this.fillPage(leaf, PageType.BTreeLeaf, cells, 0, m);
    this.fillPage(right, PageType.BTreeLeaf, cells, m, cells.length);
    setPrevPtr(leaf, oldPrev);
    setRightPtr(leaf, right.pgno);
    setPrevPtr(right, leaf.pgno);
    setRightPtr(right, oldNext);
    const rightPg = right.pgno;
    pager.release(right);
    if (oldNext !== 0) {
      const nx = pager.get(oldNext);
      pager.markDirty(nx);
      setPrevPtr(nx, rightPg);
      pager.release(nx);
    }
    this.insertIntoParent(this.depth - 1, sep, leaf.pgno, rightPg);
  }

  /** After splitting the child at path level `level`+1 into (left,right), add separator to parent. */
  private insertIntoParent(level: number, sep: Uint8Array, leftPg: number, rightPg: number): void {
    const pager = this.pager;
    const pf = pager.get(this.pathPg[level]);
    try {
      pager.markDirty(pf);
      const j = this.pathIdx[level];
      const cell = new Uint8Array(INT_HDR + sep.length);
      const cv = new DataView(cell.buffer);
      cv.setUint32(0, leftPg, true);
      cv.setUint16(4, sep.length, true);
      cell.set(sep, INT_HDR);
      // Pointer j used to reference `left` (whose old content is now split): point it at `right`,
      // then insert (sep -> left) in front of it.
      if (j < nCells(pf)) pf.view.setUint32(slot(pf, j), rightPg, true);
      else setRightPtr(pf, rightPg);
      if (!this.insertCell(pf, j, cell, cell.length)) this.splitInterior(pf, level, j, cell);
    } finally {
      pager.release(pf);
    }
  }

  private splitInterior(pf: Frame, level: number, j: number, cell: Uint8Array): void {
    const pager = this.pager;
    const cells: Uint8Array[] = [];
    const n = nCells(pf);
    for (let k = 0; k < n; k++) cells.push(this.copyCell(pf, k, false));
    cells.splice(j, 0, cell);
    const right0 = rightPtr(pf);
    let m = splitPoint(cells);
    if (m >= cells.length - 1) m = cells.length - 2;
    if (m < 1) m = 1;
    const promoted = cells[m];
    const promotedChild = promoted[0] | (promoted[1] << 8) | (promoted[2] << 16) | (promoted[3] * 0x1000000);
    const promotedKey = promoted.slice(INT_HDR);

    if (pf.pgno === this.root) {
      const left = pager.allocate();
      const right = pager.allocate();
      this.fillPage(left, PageType.BTreeInterior, cells, 0, m);
      setRightPtr(left, promotedChild);
      this.fillPage(right, PageType.BTreeInterior, cells, m + 1, cells.length);
      setRightPtr(right, right0);
      this.makeRootInterior(pf, promotedKey, left.pgno, right.pgno);
      pager.release(left);
      pager.release(right);
      return;
    }
    const right = pager.allocate();
    this.fillPage(pf, PageType.BTreeInterior, cells, 0, m);
    setRightPtr(pf, promotedChild);
    this.fillPage(right, PageType.BTreeInterior, cells, m + 1, cells.length);
    setRightPtr(right, right0);
    const rightPg = right.pgno;
    pager.release(right);
    this.insertIntoParent(level - 1, promotedKey, pf.pgno, rightPg);
  }

  private makeRootInterior(root: Frame, sep: Uint8Array, leftPg: number, rightPg: number): void {
    initPage(root, PageType.BTreeInterior, this.usable);
    setRightPtr(root, rightPg);
    const cell = new Uint8Array(INT_HDR + sep.length);
    const cv = new DataView(cell.buffer);
    cv.setUint32(0, leftPg, true);
    cv.setUint16(4, sep.length, true);
    cell.set(sep, INT_HDR);
    this.insertCell(root, 0, cell, cell.length);
  }

  private fillPage(p: PageBuf, type: number, cells: Uint8Array[], from: number, to: number): void {
    initPage(p, type, this.usable);
    for (let k = from; k < to; k++) {
      if (!this.insertCell(p, k - from, cells[k], cells[k].length)) throw new CorruptionError('split produced an overfull page');
    }
  }

  // ---------------------------------------------------------------- merges

  /** The child at path level `level` became underfull: try to merge it with a sibling. */
  private rebalance(level: number): void {
    const pager = this.pager;
    const parentPg = this.pathPg[level];
    const pf = pager.get(parentPg);
    let parentUnderfull = false;
    try {
      const n = nCells(pf);
      if (n === 0) return;
      const j = this.pathIdx[level];
      const k = j < n ? j : j - 1; // merge pointers k and k+1 into pointer k's page
      const childAt = (i: number): number => (i < n ? pf.view.getUint32(slot(pf, i), true) : rightPtr(pf));
      const leftPg = childAt(k);
      const rightPg = childAt(k + 1);
      const lf = pager.get(leftPg);
      const rf = pager.get(rightPg);
      try {
        const leaf = isLeaf(lf);
        const sepOff = slot(pf, k);
        const sepLen = pf.view.getUint16(sepOff + 4, true);
        const extra = leaf ? 0 : INT_HDR + sepLen + 2;
        const combined = this.usedBytes(lf) + this.usedBytes(rf) - H + extra;
        if (combined > this.usable) return;
        pager.markDirty(lf);
        pager.markDirty(pf);
        let at = nCells(lf);
        if (!leaf) {
          const cell = new Uint8Array(INT_HDR + sepLen);
          const cv = new DataView(cell.buffer);
          cv.setUint32(0, rightPtr(lf), true);
          cv.setUint16(4, sepLen, true);
          cell.set(pf.bytes.subarray(sepOff + INT_HDR, sepOff + INT_HDR + sepLen), INT_HDR);
          this.insertCell(lf, at++, cell, cell.length);
        }
        const rn = nCells(rf);
        for (let i = 0; i < rn; i++) {
          const off = slot(rf, i);
          const size = cellSizeAt(rf, off, leaf);
          if (!this.insertCell(lf, at++, rf.bytes.subarray(off, off + size), size)) {
            throw new CorruptionError('merge overflowed page');
          }
        }
        if (leaf) {
          const next = rightPtr(rf);
          setRightPtr(lf, next);
          if (next !== 0) {
            const nx = pager.get(next);
            pager.markDirty(nx);
            setPrevPtr(nx, leftPg);
            pager.release(nx);
          }
        } else {
          setRightPtr(lf, rightPtr(rf));
        }
        // Parent: pointer k+1 now refers to the merged page; drop separator k.
        if (k + 1 < n) pf.view.setUint32(slot(pf, k + 1), leftPg, true);
        else setRightPtr(pf, leftPg);
        this.removeCell(pf, k, false);
      } finally {
        pager.release(rf);
        pager.release(lf);
      }
      pager.free(rightPg);

      if (parentPg === this.root) {
        if (nCells(pf) === 0) {
          // Root has a single child left: pull the child's content up into the root.
          const only = rightPtr(pf);
          const cf = pager.get(only);
          pf.bytes.set(cf.bytes.subarray(0, this.usable));
          if (isLeaf(pf)) {
            setRightPtr(pf, 0);
            setPrevPtr(pf, 0);
          }
          pager.release(cf);
          pager.free(only);
        }
      } else {
        parentUnderfull = this.isUnderfull(pf);
      }
    } finally {
      pager.release(pf);
    }
    if (parentUnderfull && level > 0) this.rebalance(level - 1);
  }

  private freeSubtree(pg: number): void {
    const pager = this.pager;
    const f = pager.get(pg);
    const children: number[] = [];
    const overflowCells: number[] = [];
    if (isLeaf(f)) {
      const n = nCells(f);
      for (let i = 0; i < n; i++) overflowCells.push(slot(f, i));
      for (const off of overflowCells) this.freeCellOverflow(f, off);
    } else if (f.bytes[0] === PageType.BTreeInterior) {
      const n = nCells(f);
      for (let i = 0; i < n; i++) children.push(f.view.getUint32(slot(f, i), true));
      children.push(rightPtr(f));
    }
    pager.release(f);
    for (const c of children) this.freeSubtree(c);
    pager.free(pg);
  }
}

/** Choose the split index m (left = [0,m), right = [m,len)) balancing bytes; both sides non-empty. */
function splitPoint(cells: Uint8Array[]): number {
  let total = 0;
  for (const c of cells) total += c.length + 2;
  let acc = 0;
  let m = 0;
  while (m < cells.length && acc + cells[m].length + 2 <= total / 2) {
    acc += cells[m].length + 2;
    m++;
  }
  if (m < 1) m = 1;
  if (m > cells.length - 1) m = cells.length - 1;
  return m;
}

/** Shortest prefix p of `b` with a < p <= b (requires a < b). */
function shortestSeparator(
  a: Uint8Array, aOff: number, aLen: number,
  b: Uint8Array, bOff: number, bLen: number,
): Uint8Array {
  let i = 0;
  const n = Math.min(aLen, bLen);
  while (i < n && a[aOff + i] === b[bOff + i]) i++;
  if (compareRanges(a, aOff, aLen, b, bOff, bLen) >= 0) throw new CorruptionError('separator keys out of order');
  return b.slice(bOff, bOff + Math.min(i + 1, bLen));
}

/**
 * Bidirectional cursor over a B+tree. Holds a pin on its current leaf; call {@link close}.
 * Cursors are invalidated by writes to the tree (re-seek after modifying).
 */
export class BTreeCursor {
  private frame: Frame | null = null;
  private idx = 0;

  constructor(private readonly tree: BTree) {}

  get valid(): boolean {
    return this.frame !== null;
  }

  /** Position at the first key >= `key` (or the first key when omitted). */
  seek(key?: Uint8Array): boolean {
    this.close();
    const f = this.tree.descendForCursor(key ?? null, false);
    this.frame = f;
    this.idx = key === undefined ? 0 : this.tree.leafLowerBound(f, key);
    return this.settleForward();
  }

  first(): boolean {
    return this.seek();
  }

  last(): boolean {
    this.close();
    const f = this.tree.descendForCursor(null, true);
    this.frame = f;
    this.idx = nCells(f) - 1;
    return this.settleBackward();
  }

  next(): boolean {
    if (this.frame === null) return false;
    this.idx++;
    return this.settleForward();
  }

  prev(): boolean {
    if (this.frame === null) return false;
    this.idx--;
    return this.settleBackward();
  }

  key(): Uint8Array {
    const f = this.current();
    const off = slot(f, this.idx);
    return f.bytes.slice(off + LEAF_HDR, off + LEAF_HDR + f.view.getUint16(off, true));
  }

  /** Compare the current key with `key` without copying (memcmp order; current - key). */
  compareKey(key: Uint8Array): number {
    const f = this.current();
    const off = slot(f, this.idx);
    return -compareKeyAt(key, f.bytes, off + LEAF_HDR, f.view.getUint16(off, true));
  }

  value(): Uint8Array {
    const f = this.current();
    return this.tree.readValue(f, slot(f, this.idx));
  }

  close(): void {
    if (this.frame !== null) {
      this.tree.pager.release(this.frame);
      this.frame = null;
    }
  }

  private current(): Frame {
    if (this.frame === null) throw new MisuseError('cursor is not positioned');
    return this.frame;
  }

  private settleForward(): boolean {
    const pager = this.tree.pager;
    let f = this.frame!;
    while (this.idx >= nCells(f)) {
      const next = rightPtr(f);
      pager.release(f);
      if (next === 0) {
        this.frame = null;
        return false;
      }
      f = pager.get(next);
      this.frame = f;
      this.idx = 0;
    }
    return true;
  }

  private settleBackward(): boolean {
    const pager = this.tree.pager;
    let f = this.frame!;
    while (this.idx < 0) {
      const prev = prevPtr(f);
      pager.release(f);
      if (prev === 0) {
        this.frame = null;
        return false;
      }
      f = pager.get(prev);
      this.frame = f;
      this.idx = nCells(f) - 1;
    }
    return true;
  }
}
