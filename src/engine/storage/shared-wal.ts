/**
 * The owner's WAL index in a `SharedArrayBuffer`, for readers that read through the owner (ADR 0021, step 3).
 *
 * Before each query a reader moves its snapshot to the latest commit (`Wal.refresh`). Reading the log for that costs
 * a round trip to the owner even when nothing changed (the log's size), and reading and checking every new frame when
 * something did. The owner already knows: after each commit it appends the commit's pages and frame offsets here, and
 * publishes the log's committed end. A reader then refreshes from memory: with no new commit, without any I/O.
 *
 *   Int32 header: [0] sequence (odd while the owner writes)  [1] generation (a new log: a checkpoint or reopen)
 *                 [2] entries published  [3] page count of the last commit  [4] overflow (entries did not fit)
 *   Float64 at byte 32: the log's committed end
 *   then CAPACITY page numbers (Int32) and CAPACITY frame offsets (Float64)
 *
 * Only the owner writes. Entries are written before the header publishes them, under a sequence number readers check
 * (a seqlock). When a log outgrows the capacity, the index says so (overflow) and readers scan the log file instead,
 * as without it, until the next generation.
 */

const HEADER = 8;
const END_AT = HEADER * 4;
const PGNOS_AT = END_AT + 8;

/** What a reader sees of the owner's log: consistent as of one commit. */
export interface SharedWalState {
  generation: number;
  count: number;
  end: number;
  pageCount: number;
  overflow: boolean;
}

export class SharedWalIndex {
  private readonly hdr: Int32Array;
  private readonly end: Float64Array;
  private readonly pgnos: Int32Array;
  private readonly offsets: Float64Array;
  readonly capacity: number;

  /** An index for up to `capacity` frames per log generation (12 bytes each). */
  static create(capacity = 64 * 1024): SharedArrayBuffer {
    const offsetsAt = Math.ceil((PGNOS_AT + capacity * 4) / 8) * 8;
    const sab = new SharedArrayBuffer(offsetsAt + capacity * 8);
    return sab;
  }

  constructor(sab: SharedArrayBuffer) {
    this.hdr = new Int32Array(sab, 0, HEADER);
    this.end = new Float64Array(sab, END_AT, 1);
    const offsetsAt = (bytes: number): number => Math.ceil((PGNOS_AT + bytes) / 8) * 8;
    // capacity from the buffer's size: offsetsAt(4c) + 8c = byteLength
    let c = Math.floor((sab.byteLength - PGNOS_AT) / 12);
    while (c > 0 && offsetsAt(c * 4) + c * 8 > sab.byteLength) c--;
    this.capacity = c;
    this.pgnos = new Int32Array(sab, PGNOS_AT, c);
    this.offsets = new Float64Array(sab, offsetsAt(c * 4), c);
  }

  // ---------------------------------------------------------------- owner

  private begin(): void {
    Atomics.add(this.hdr, 0, 1);
  }

  private done(): void {
    Atomics.add(this.hdr, 0, 1);
  }

  /** Owner: a new, empty log (after a checkpoint restarted it, or at open). */
  newGeneration(): void {
    this.begin();
    this.hdr[1]++;
    this.hdr[2] = 0;
    this.hdr[3] = 0;
    this.hdr[4] = 0;
    this.end[0] = 0;
    this.done();
  }

  /** Owner: a commit's pages and their frame offsets, then the log's new committed end and page count. */
  append(pgnos: ArrayLike<number>, offsets: ArrayLike<number>, end: number, pageCount: number): void {
    const at = this.hdr[2];
    const n = pgnos.length;
    if (this.hdr[4] !== 0 || at + n > this.capacity) {
      if (this.hdr[4] === 0) {
        this.begin();
        this.hdr[4] = 1;
        this.done();
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      this.pgnos[at + i] = pgnos[i];
      this.offsets[at + i] = offsets[i];
    }
    this.begin();
    this.hdr[2] = at + n;
    this.hdr[3] = pageCount;
    this.end[0] = end;
    this.done();
  }

  // ---------------------------------------------------------------- readers

  /** The owner's log as of its latest commit. */
  state(): SharedWalState {
    const hdr = this.hdr;
    for (;;) {
      const seq = Atomics.load(hdr, 0);
      if ((seq & 1) !== 0) continue;
      const s = { generation: hdr[1], count: hdr[2], pageCount: hdr[3], overflow: hdr[4] !== 0, end: this.end[0] };
      if (Atomics.load(hdr, 0) === seq) return s;
    }
  }

  /** Entry `i` (below a published count): a page and the offset of its frame. */
  pgno(i: number): number {
    return this.pgnos[i];
  }

  offset(i: number): number {
    return this.offsets[i];
  }

  /** The current generation (to check that entries read belong to the state read). */
  get generation(): number {
    return Atomics.load(this.hdr, 1);
  }
}
