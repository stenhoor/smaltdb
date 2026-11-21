/**
 * A table's property maps in memory, by rowid (ADR 0041, section 2): for a node or edge table of an indexed property
 * graph, the `props` map of each row that was read by its rowid, as the table stores it. A row is known once it was
 * read (its map, or that its props are NULL); any other is not, and its reader reads the table and tells what it
 * found.
 *
 * The maps' bytes are in one buffer; where each row's begin and end is kept in pages of rowids, so a table with few
 * rows at high rowids takes little. A row's bytes are never changed where they lie: a new or changed map is added at
 * the buffer's end and the row is pointed at it, and the bytes it leaves are counted as dead. When a buffer that needs
 * room is at least half dead, the live maps are written to a new one. What `get` gives is the row's own copy, as a row
 * decoded from the table is.
 */

import { type SqlValue, TypedValue } from '../values.js';

const PAGE_BITS = 12;
const PAGE = 1 << PAGE_BITS;
const MASK = PAGE - 1;
/** A row's start where it has no bytes: not known, or known to have NULL props. */
const UNKNOWN = -1;
const NULL_PROPS = -2;

/** A props value the maps can hold: a map's bytes as a row stores them, or NULL. */
export const holdable = (v: SqlValue): v is Uint8Array | null => v === null || (v instanceof Uint8Array && !(v instanceof TypedValue));

export class GraphProps {
  private buf = new Uint8Array(0);
  /** Bytes of `buf` written, and those of them no row points at. */
  private used = 0;
  private dead = 0;
  /** By page of rowids: each row's start in `buf` (or UNKNOWN, NULL_PROPS), and its end. */
  private readonly starts: (Int32Array | undefined)[] = [];
  private readonly ends: (Int32Array | undefined)[] = [];
  private pages = 0;
  /** Rows known, those whose props are NULL included. */
  rows = 0;
  /** Set when the index let these maps go: a scan that still has them reads nothing from them and adds nothing. */
  closed = false;

  /** `grown` is called when the maps take more memory: a larger buffer, or one more page of rowids. */
  constructor(private readonly grown: () => void = () => undefined) {}

  /** The memory it takes. */
  bytes(): number {
    return this.buf.length + this.pages * PAGE * 8;
  }

  /** Whether the row is known: read before, and not written since in a way the maps did not follow. */
  known(rowid: number): boolean {
    const p = this.starts[rowid >>> PAGE_BITS];
    return p !== undefined && p[rowid & MASK] !== UNKNOWN && !this.closed;
  }

  /** The row's props: its map's bytes, or null where they are NULL; undefined for a row not known. */
  get(rowid: number): Uint8Array | null | undefined {
    const page = rowid >>> PAGE_BITS;
    const p = this.starts[page];
    if (p === undefined || this.closed) return undefined;
    const i = rowid & MASK;
    const s = p[i]!;
    if (s < 0) return s === NULL_PROPS ? null : undefined;
    return this.buf.slice(s, this.ends[page]![i]!);
  }

  /** The row's slot, with its bytes (if it had any) counted dead. */
  private slot(rowid: number): Int32Array {
    const page = rowid >>> PAGE_BITS;
    let p = this.starts[page];
    if (p === undefined) {
      p = this.starts[page] = new Int32Array(PAGE).fill(UNKNOWN);
      this.ends[page] = new Int32Array(PAGE);
      this.pages++;
      this.grown();
    }
    const i = rowid & MASK;
    const s = p[i]!;
    if (s >= 0) this.dead += this.ends[page]![i]! - s;
    if (s !== UNKNOWN) this.rows--;
    return p;
  }

  /** The row has these props. */
  set(rowid: number, props: Uint8Array | null): void {
    if (this.closed) return;
    const p = this.slot(rowid);
    const i = rowid & MASK;
    this.rows++;
    if (props === null) {
      p[i] = NULL_PROPS;
      return;
    }
    const n = props.length;
    if (this.used + n > this.buf.length) {
      // The row's old bytes, if it had any, are dead by now: it is left out of a rewrite.
      p[i] = UNKNOWN;
      this.room(n);
    }
    this.buf.set(props, this.used);
    p[i] = this.used;
    this.ends[rowid >>> PAGE_BITS]![i] = this.used + n;
    this.used += n;
  }

  /** The row is not known any more: it went, or was written in a way the maps do not follow. */
  forget(rowid: number): void {
    if (!this.known(rowid)) return;
    this.slot(rowid)[rowid & MASK] = UNKNOWN;
  }

  /** No row is known any more. The buffer and the pages of rowids stay, for the rows read next. */
  clear(): void {
    for (const p of this.starts) p?.fill(UNKNOWN);
    this.used = 0;
    this.dead = 0;
    this.rows = 0;
  }

  /** Makes room for `n` more bytes: a larger buffer, holding only the live maps when at least as much is dead. */
  private room(n: number): void {
    const live = this.used - this.dead;
    const next = new Uint8Array(Math.max(4096, 2 * (live + n)));
    if (this.dead * 2 < this.used) {
      next.set(this.buf.subarray(0, this.used));
    } else {
      let at = 0;
      for (let page = 0; page < this.starts.length; page++) {
        const p = this.starts[page];
        if (p === undefined) continue;
        const e = this.ends[page]!;
        for (let i = 0; i < PAGE; i++) {
          const s = p[i]!;
          if (s < 0) continue;
          const len = e[i]! - s;
          next.set(this.buf.subarray(s, s + len), at);
          p[i] = at;
          e[i] = at + len;
          at += len;
        }
      }
      this.used = at;
      this.dead = 0;
    }
    const grew = next.length > this.buf.length;
    this.buf = next;
    if (grew) this.grown();
  }

  /** Every row known, with its props (null where they are NULL), by rowid. */
  forEach(fn: (rowid: number, props: Uint8Array | null) => void): void {
    for (let page = 0; page < this.starts.length; page++) {
      const p = this.starts[page];
      if (p === undefined) continue;
      const e = this.ends[page]!;
      for (let i = 0; i < PAGE; i++) {
        const s = p[i]!;
        if (s === UNKNOWN) continue;
        fn(page * PAGE + i, s < 0 ? null : this.buf.subarray(s, e[i]!));
      }
    }
  }
}
