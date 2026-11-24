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
 *
 * A row may also be known to be gone (ADR 0042, section 2): deleted in the graph's index while its table still has
 * it, until the table is brought up to date. Its reader gives no row, and does not read the table.
 */

import { type SqlValue, TypedValue } from '../values.js';
import { type MapCompare, mapProbe } from './nested-ops.js';

const PAGE_BITS = 12;
const PAGE = 1 << PAGE_BITS;
const MASK = PAGE - 1;
/** A row's start where it has no bytes: not known, or known to have NULL props. */
const UNKNOWN = -1;
const NULL_PROPS = -2;
/** A row deleted in the index whose table still has it. */
const GONE = -3;

/** A props value the maps can hold: a map's bytes as a row stores them, or NULL. */
export const holdable = (v: SqlValue): v is Uint8Array | null => v === null || (v instanceof Uint8Array && !(v instanceof TypedValue));

/** A condition on one key of a row's props, as `mapProbe` (nested-ops.ts) checks it on a map's bytes. */
export interface PropsCheck {
  readonly key: Uint8Array;
  readonly op: MapCompare;
  readonly lit: Uint8Array | null;
}

export class GraphProps {
  private buf = new Uint8Array(0);
  /** Bytes of `buf` written, and those of them no row points at. */
  private used = 0;
  private dead = 0;
  /** By page of rowids: each row's start in `buf` (or UNKNOWN, NULL_PROPS), and its end. */
  private readonly starts: (Int32Array | undefined)[] = [];
  private readonly ends: (Int32Array | undefined)[] = [];
  /** By page of rowids: how many of its rows have bytes in `buf`. A rewrite reads only the pages that have some. */
  private readonly live: number[] = [];
  /**
   * By page of rowids: how many of its rows are known (those gone too). A page whose last known row is forgotten is
   * let go: rows that are made and deleted, with ids that only go up, would leave a page for every 4,096 of them.
   */
  private readonly held: number[] = [];
  /**
   * The one page kept though none of its rows is known (-1: none): the last that came to that. A row made and
   * deleted again, over and over, would otherwise make a page and let it go each time.
   */
  private spare = -1;
  private pages = 0;
  /** Rows known, those whose props are NULL included. */
  rows = 0;
  /** Set when the index let these maps go: a scan that still has them reads nothing from them and adds nothing. */
  closed = false;
  /**
   * Set while the maps take no more rows read from their table (`set` of a row not known does nothing): the index is
   * over its limit, and the maps hold rows their table has not yet (ADR 0042, section 2), so they can't be let go.
   */
  full = false;

  /** `grown` is called when the maps take more memory: a larger buffer, or one more page of rowids. */
  constructor(private readonly grown: () => void = () => undefined) {}

  /** The memory it takes. */
  bytes(): number {
    return this.buf.length + this.pages * PAGE * 8;
  }

  /**
   * Whether the row is known: read before, and not written since in a way the maps did not follow. A row known to be
   * gone is known too (`gone`).
   */
  known(rowid: number): boolean {
    const p = this.page(rowid >>> PAGE_BITS);
    return p !== undefined && p[rowid & MASK] !== UNKNOWN && !this.closed;
  }

  /** Whether the row is known and there: not one that is gone. */
  here(rowid: number): boolean {
    const p = this.page(rowid >>> PAGE_BITS);
    if (p === undefined || this.closed) return false;
    const s = p[rowid & MASK]!;
    return s !== UNKNOWN && s !== GONE;
  }

  /** Whether the row is known to be gone: deleted in the index, and still in its table. */
  gone(rowid: number): boolean {
    const p = this.page(rowid >>> PAGE_BITS);
    return p !== undefined && p[rowid & MASK] === GONE && !this.closed;
  }

  /** The row's props: its map's bytes, or null where they are NULL; undefined for a row not known, and for one gone. */
  get(rowid: number): Uint8Array | null | undefined {
    const page = rowid >>> PAGE_BITS;
    const p = this.page(page);
    if (p === undefined || this.closed) return undefined;
    const i = rowid & MASK;
    const s = p[i]!;
    if (s < 0) return s === NULL_PROPS ? null : undefined;
    return this.buf.slice(s, this.ends[page]![i]!);
  }

  /**
   * Whether a row's props rule out one of `checks`, each a condition a plan needs to be true of them: the row is known
   * and has NULL props, or a map that fails one, or is gone. The map is read where it lies, with no copy. False for a
   * row not known: its reader reads the table.
   */
  rulesOut(rowid: number, checks: readonly PropsCheck[]): boolean {
    const page = rowid >>> PAGE_BITS;
    const p = this.page(page);
    if (p === undefined || this.closed) return false;
    const i = rowid & MASK;
    const s = p[i]!;
    if (s < 0) return s !== UNKNOWN;
    const e = this.ends[page]![i]!;
    const buf = this.buf;
    for (let c = 0; c < checks.length; c++) {
      const x = checks[c]!;
      if (!mapProbe(buf, s, e, x.key, x.op, x.lit)) return true;
    }
    return false;
  }

  /**
   * A page of rowids' starts, or undefined for one no row of is known. A page past the last one held is not read
   * from the list: a read past an array's end makes V8 drop the optimized code of the scan that asked (a bailout,
   * `out of bounds`), and the scan runs slower until it is optimized again. A row with a rowid past every row read
   * before, which a new node is, asks for such a page.
   */
  private page(page: number): Int32Array | undefined {
    const starts = this.starts;
    return page < starts.length ? starts[page] : undefined;
  }

  /** The row's slot, with its bytes (if it had any) counted dead. */
  private slot(rowid: number): Int32Array {
    const page = rowid >>> PAGE_BITS;
    let p = this.starts[page];
    if (p === undefined) {
      p = this.starts[page] = new Int32Array(PAGE).fill(UNKNOWN);
      this.ends[page] = new Int32Array(PAGE);
      this.live[page] = 0;
      this.held[page] = 0;
      this.pages++;
      this.grown();
    }
    const i = rowid & MASK;
    const s = p[i]!;
    if (s >= 0) {
      this.dead += this.ends[page]![i]! - s;
      this.live[page]!--;
    }
    // Every caller but `forget` leaves the row known.
    if (s === UNKNOWN) this.held[page]!++;
    else if (s !== GONE) this.rows--;
    return p;
  }

  /** The row has these props, as its table does: read from it, or written to it. */
  set(rowid: number, props: Uint8Array | null): void {
    if (this.full && !this.known(rowid)) return;
    this.put(rowid, props);
  }

  /** The row has these props, whether its table has them yet or not. */
  put(rowid: number, props: Uint8Array | null): void {
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
    this.live[rowid >>> PAGE_BITS]!++;
    this.used += n;
  }

  /** The row is gone, and its table still has it: it is given by no reader until the table is brought up to date. */
  setGone(rowid: number): void {
    if (this.closed) return;
    this.slot(rowid)[rowid & MASK] = GONE;
  }

  /** The row is not known any more: it went, or was written in a way the maps do not follow. */
  forget(rowid: number): void {
    if (!this.known(rowid)) return;
    this.slot(rowid)[rowid & MASK] = UNKNOWN;
    const page = rowid >>> PAGE_BITS;
    if (--this.held[page]! > 0 || this.spare === page) return;
    // No row of the page is known any more: it is the one kept, and the one kept before it goes.
    const old = this.spare;
    this.spare = page;
    if (old < 0 || this.held[old] !== 0 || this.starts[old] === undefined) return;
    this.starts[old] = undefined;
    this.ends[old] = undefined;
    this.pages--;
  }

  /** No row is known any more. The buffer and the pages of rowids stay, for the rows read next. */
  clear(): void {
    for (const p of this.starts) p?.fill(UNKNOWN);
    this.live.fill(0);
    this.held.fill(0);
    this.spare = -1;
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
      const buf = this.buf;
      let at = 0;
      // Rows whose bytes lie one after another are copied as one run. A rewrite leaves the rows in the order of their
      // rowids, and rows written one after another in that order lie so too: the rows not written since, and those
      // one statement wrote, are a few long runs, where each row was a copy of its own.
      let from = 0;
      let to = 0;
      let runAt = 0;
      for (let page = 0; page < this.starts.length; page++) {
        const p = this.starts[page];
        // A page none of whose rows has bytes is not read: rows that come and go leave many.
        if (p === undefined || this.live[page] === 0) continue;
        const e = this.ends[page]!;
        for (let i = 0; i < PAGE; i++) {
          const s = p[i]!;
          if (s < 0) continue;
          const end = e[i]!;
          if (s !== to) {
            if (to > from) next.set(buf.subarray(from, to), runAt);
            from = s;
            runAt = at;
          }
          to = end;
          p[i] = at;
          at += end - s;
          e[i] = at;
        }
      }
      if (to > from) next.set(buf.subarray(from, to), runAt);
      this.used = at;
      this.dead = 0;
    }
    const grew = next.length > this.buf.length;
    this.buf = next;
    if (grew) this.grown();
  }

  /** Every row known and not gone, with its props (null where they are NULL), by rowid. */
  forEach(fn: (rowid: number, props: Uint8Array | null) => void): void {
    for (let page = 0; page < this.starts.length; page++) {
      const p = this.starts[page];
      if (p === undefined) continue;
      const e = this.ends[page]!;
      for (let i = 0; i < PAGE; i++) {
        const s = p[i]!;
        if (s === UNKNOWN || s === GONE) continue;
        fn(page * PAGE + i, s < 0 ? null : this.buf.subarray(s, e[i]!));
      }
    }
  }
}
