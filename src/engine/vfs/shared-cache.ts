/**
 * A cache of file blocks in a `SharedArrayBuffer`, shared by an owner and its proxied readers (ADR 0021, step 2).
 *
 * It caches bytes of files, not pages: 64 KiB blocks of the database file and of the WAL, keyed by (file, block,
 * generation). Only bytes that cannot change while they are cached go in: whole blocks of the database file, and whole
 * blocks of the WAL below its last commit (a log only grows until it is checkpointed). Whenever the owner writes to the
 * database file or truncates a file (a checkpoint), it moves the generation on, so every earlier entry stops matching.
 *
 * Only the owner writes entries; readers only read them, so there are no locks. Each slot has a sequence number that
 * is odd while the owner writes it (a seqlock): a reader checks it before and after copying, and treats a change as a
 * miss. Slots are grouped in sets of WAYS by a hash of the key; the owner replaces within a set with a clock (readers
 * mark the slots they hit).
 *
 *   Int32 header: [0] generation   [1] sets
 *   Int32 per slot (META ints): [0] sequence   [1] file   [2] generation   [3] block   [4] referenced
 *   then the blocks, BLOCK bytes per slot
 */

export const BLOCK = 64 * 1024;
const WAYS = 8;
const HEADER = 4;
const META = 5;

export interface SharedCacheStats {
  hits: number;
  misses: number;
  inserts: number;
}

export class SharedCache {
  private readonly hdr: Int32Array;
  private readonly meta: Int32Array;
  private readonly data: Uint8Array;
  private readonly sets: number;
  /** Owner: the next way to look at in each set (clock hand). */
  private hands: Uint8Array | null = null;
  readonly stats: SharedCacheStats = { hits: 0, misses: 0, inserts: 0 };

  /** A cache of about `bytes` (at least one set of WAYS blocks). */
  static create(bytes: number): SharedArrayBuffer {
    const sets = Math.max(1, Math.floor(bytes / (BLOCK * WAYS)));
    const slots = sets * WAYS;
    const sab = new SharedArrayBuffer(HEADER * 4 + slots * META * 4 + slots * BLOCK);
    new Int32Array(sab, 0, HEADER)[1] = sets;
    return sab;
  }

  constructor(sab: SharedArrayBuffer) {
    this.hdr = new Int32Array(sab, 0, HEADER);
    this.sets = this.hdr[1];
    const slots = this.sets * WAYS;
    this.meta = new Int32Array(sab, HEADER * 4, slots * META);
    this.data = new Uint8Array(sab, HEADER * 4 + slots * META * 4, slots * BLOCK);
  }

  /** Bytes of blocks the cache holds. */
  get capacity(): number {
    return this.sets * WAYS * BLOCK;
  }

  private setOf(file: number, block: number): number {
    return ((Math.imul(block, 0x9e3779b1) ^ Math.imul(file + 1, 0x85ebca6b)) >>> 0) % this.sets;
  }

  /**
   * Copy `len` bytes of `block` of `file`, starting `from` bytes into it, to `dst` at `at`. False (and nothing
   * copied that counts) when the block is not cached in the current generation.
   */
  read(file: number, block: number, from: number, len: number, dst: Uint8Array, at: number): boolean {
    const gen = Atomics.load(this.hdr, 0);
    const base = this.setOf(file, block) * WAYS;
    const meta = this.meta;
    for (let w = 0; w < WAYS; w++) {
      const m = (base + w) * META;
      const seq = Atomics.load(meta, m);
      if ((seq & 1) !== 0 || meta[m + 1] !== file || meta[m + 3] !== block || meta[m + 2] !== gen) continue;
      const off = (base + w) * BLOCK + from;
      dst.set(this.data.subarray(off, off + len), at);
      if (Atomics.load(meta, m) !== seq || meta[m + 2] !== gen) break; // rewritten while copying
      if (meta[m + 4] === 0) Atomics.store(meta, m + 4, 1);
      this.stats.hits++;
      return true;
    }
    this.stats.misses++;
    return false;
  }

  /** Owner: cache a whole block (`src` holds BLOCK bytes). */
  insert(file: number, block: number, src: Uint8Array): void {
    const gen = this.hdr[0];
    const s = this.setOf(file, block);
    const base = s * WAYS;
    const meta = this.meta;
    let way = -1;
    for (let w = 0; w < WAYS; w++) {
      const m = (base + w) * META;
      if (meta[m + 1] === file && meta[m + 3] === block && meta[m + 2] === gen) return; // already cached
    }
    // Clock: the first way not referenced since the hand last passed, clearing marks on the way.
    const hands = (this.hands ??= new Uint8Array(this.sets));
    for (let i = 0; i < 2 * WAYS && way < 0; i++) {
      const w = hands[s];
      hands[s] = (w + 1) % WAYS;
      const m = (base + w) * META;
      if (meta[m + 2] !== gen || meta[m + 4] === 0) way = w;
      else Atomics.store(meta, m + 4, 0);
    }
    if (way < 0) way = hands[s];
    const m = (base + way) * META;
    Atomics.add(meta, m, 1); // odd: being written
    meta[m + 1] = file;
    meta[m + 2] = gen;
    meta[m + 3] = block;
    meta[m + 4] = 0;
    this.data.set(src.subarray(0, BLOCK), (base + way) * BLOCK);
    Atomics.add(meta, m, 1); // even: readable
    this.stats.inserts++;
  }

  /** Owner: a file changed in place (a write to the database file, a truncation): forget every entry. */
  bump(): void {
    Atomics.add(this.hdr, 0, 1);
  }
}
