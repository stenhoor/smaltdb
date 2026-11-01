import { CorruptionError } from '../errors.js';
import type { VfsFile } from '../vfs/types.js';
import { crc32c } from './crc32c.js';

/**
 * Write-ahead log (docs/STORAGE_FORMAT.md §6). A commit appends every changed page (including the
 * database header, page 0) as frames, the last one marked as the commit frame, and flushes once.
 * The main database file is only written by checkpoints.
 *
 *   WAL header (32 bytes):  magic "smaltwal" | u32 version | u32 pageSize | u32 salt1 | u32 salt2 |
 *                           u32 checkpointSeq | u32 crc32c(bytes 0..28)
 *   Frame:                  u32 pgno | u32 commitPageCount (0 = not a commit frame) | u32 salt1 |
 *                           u32 salt2 | u32 chainCrc | u32 reserved | page bytes
 *
 * `chainCrc` is crc32c(frame header bytes 0..16 + page), seeded with the previous frame's chainCrc
 * (the first frame is seeded with the header crc). Recovery accepts frames only while salts match
 * and the chain verifies, and only up to the last commit frame, so torn or stale frames are ignored.
 * All fields are little-endian.
 */

export const WAL_HEADER_SIZE = 32;
export const WAL_FRAME_HEADER_SIZE = 24;
const MAGIC = [0x73, 0x6d, 0x61, 0x6c, 0x74, 0x77, 0x61, 0x6c]; // "smaltwal"
const VERSION = 1;
const READ_CHUNK = 1024 * 1024;

export interface WalStats {
  commits: number;
  framesWritten: number;
  checkpoints: number;
  recoveredFrames: number;
}

export class Wal {
  /** pgno -> byte offset of the latest committed frame for that page. */
  private readonly index = new Map<number, number>();
  private salt1 = 0;
  private salt2 = 0;
  private seq = 0;
  private lastCrc = 0;
  /** Byte offset where the next frame goes (just past the last valid commit frame). */
  private end = 0;
  /** Database page count recorded by the last commit (0 when the WAL is empty). */
  private committedPageCount = 0;
  private writeBuf = new Uint8Array(0);
  readonly stats: WalStats = { commits: 0, framesWritten: 0, checkpoints: 0, recoveredFrames: 0 };

  private constructor(
    readonly file: VfsFile,
    readonly pageSize: number,
  ) {}

  get frameSize(): number {
    return WAL_FRAME_HEADER_SIZE + this.pageSize;
  }

  /** Bytes of committed frames currently in the log. */
  get size(): number {
    return this.end;
  }

  get isEmpty(): boolean {
    return this.index.size === 0;
  }

  /** Page count of the database as of the last commit in the log (0 if none). */
  get pageCount(): number {
    return this.committedPageCount;
  }

  has(pgno: number): boolean {
    return this.index.has(pgno);
  }

  /** Read the page size recorded in an existing WAL header, or null if the WAL is empty/invalid. */
  static probePageSize(file: VfsFile): number | null {
    const h = new Uint8Array(WAL_HEADER_SIZE);
    if (file.read(h, 0) < WAL_HEADER_SIZE) return null;
    const v = new DataView(h.buffer);
    for (let i = 0; i < 8; i++) if (h[i] !== MAGIC[i]) return null;
    if (crc32c(h, 0, 28) !== v.getUint32(28, true)) return null;
    return v.getUint32(12, true);
  }

  /** Open a WAL file and recover every committed frame. */
  static open(file: VfsFile, pageSize: number): Wal {
    const wal = new Wal(file, pageSize);
    wal.recover();
    return wal;
  }

  private recover(): void {
    const file = this.file;
    const h = new Uint8Array(WAL_HEADER_SIZE);
    const valid = file.read(h, 0) === WAL_HEADER_SIZE && this.headerValid(h);
    if (!valid) {
      this.startFresh(1);
      return;
    }
    const v = new DataView(h.buffer);
    this.salt1 = v.getUint32(16, true);
    this.salt2 = v.getUint32(20, true);
    this.seq = v.getUint32(24, true);
    this.lastCrc = v.getUint32(28, true);
    this.end = WAL_HEADER_SIZE;
    this.scan(null);
  }

  /**
   * Scan frames after `end`, adding complete transactions to the index. `changed` (if given)
   * collects the page numbers of newly committed frames.
   */
  private scan(changed: Set<number> | null): void {
    const file = this.file;
    let crc = this.lastCrc;
    const fs = this.frameSize;
    const size = file.size();
    const pending = new Map<number, number>();
    let off = this.end;
    let buf = new Uint8Array(0);
    let bufStart = 0;
    while (off + fs <= size) {
      // Read in large chunks: OPFS read calls have a high fixed cost.
      if (off + fs > bufStart + buf.length) {
        const len = Math.max(fs, Math.min(READ_CHUNK - (READ_CHUNK % fs), size - off));
        buf = new Uint8Array(len);
        file.read(buf, off);
        bufStart = off;
      }
      const p = off - bufStart;
      const fv = new DataView(buf.buffer, p, WAL_FRAME_HEADER_SIZE);
      if (fv.getUint32(8, true) !== this.salt1 || fv.getUint32(12, true) !== this.salt2) break;
      const c1 = crc32c(buf, p, p + 16, crc);
      const c = crc32c(buf, p + WAL_FRAME_HEADER_SIZE, p + fs, c1);
      if (c !== fv.getUint32(16, true)) break;
      crc = c;
      pending.set(fv.getUint32(0, true), off);
      const commit = fv.getUint32(4, true);
      off += fs;
      if (commit !== 0) {
        for (const [pg, o] of pending) {
          this.index.set(pg, o);
          changed?.add(pg);
        }
        this.stats.recoveredFrames += pending.size;
        pending.clear();
        this.committedPageCount = commit;
        this.end = off;
        this.lastCrc = crc;
      }
    }
  }

  /**
   * Reader snapshots (parallel readers, ADR 0009): catch up with transactions another handle has
   * committed since the last scan. Returns the pages they changed, or null when the log was
   * checkpointed and restarted (a new generation): then every cached page may be stale.
   */
  refresh(): Set<number> | null | 'no-log' {
    const h = new Uint8Array(WAL_HEADER_SIZE);
    const valid = this.file.read(h, 0) === WAL_HEADER_SIZE && this.headerValid(h);
    const v = new DataView(h.buffer);
    // No log (checkpointed and not restarted yet): the database file alone is current. Whether it
    // changed since this reader looked is for the caller to tell (from the header's change counter).
    if (!valid) {
      this.index.clear();
      this.committedPageCount = 0;
      this.end = 0;
      return 'no-log';
    }
    if (v.getUint32(16, true) !== this.salt1 || v.getUint32(20, true) !== this.salt2 || v.getUint32(24, true) !== this.seq) {
      this.index.clear();
      this.committedPageCount = 0;
      this.recover();
      return null;
    }
    const changed = new Set<number>();
    this.scan(changed);
    return changed;
  }

  private headerValid(h: Uint8Array): boolean {
    for (let i = 0; i < 8; i++) if (h[i] !== MAGIC[i]) return false;
    const v = new DataView(h.buffer, h.byteOffset, h.byteLength);
    if (v.getUint32(8, true) !== VERSION || v.getUint32(12, true) !== this.pageSize) return false;
    return crc32c(h, 0, 28) === v.getUint32(28, true);
  }

  /** Start a new (empty) log generation with fresh salts. Does not touch the file. */
  private startFresh(seq: number): void {
    this.index.clear();
    this.committedPageCount = 0;
    this.seq = seq;
    this.salt1 = (this.salt1 + 1) >>> 0;
    const r = new Uint32Array(1);
    crypto.getRandomValues(r);
    this.salt2 = r[0];
    this.end = 0; // header is written lazily with the first commit
  }

  private headerBytes(): Uint8Array {
    const h = new Uint8Array(WAL_HEADER_SIZE);
    const v = new DataView(h.buffer);
    h.set(MAGIC, 0);
    v.setUint32(8, VERSION, true);
    v.setUint32(12, this.pageSize, true);
    v.setUint32(16, this.salt1, true);
    v.setUint32(20, this.salt2, true);
    v.setUint32(24, this.seq, true);
    v.setUint32(28, crc32c(h, 0, 28), true);
    return h;
  }

  /** Read the latest committed version of `pgno` into `dst`. Returns false if the page is not in the log. */
  read(pgno: number, dst: Uint8Array): boolean {
    const off = this.index.get(pgno);
    if (off === undefined) return false;
    const n = this.file.read(dst, off + WAL_FRAME_HEADER_SIZE);
    if (n !== this.pageSize) throw new CorruptionError(`WAL frame for page ${pgno} is truncated`);
    return true;
  }

  /**
   * Append one transaction (pages must already carry their page checksums) and optionally flush.
   * The transaction is durable once this returns with `sync` set.
   */
  commit(pages: { pgno: number; bytes: Uint8Array }[], pageCount: number, sync: boolean): void {
    if (pages.length === 0) return;
    const fs = this.frameSize;
    let headerLen = 0;
    if (this.end === 0) headerLen = WAL_HEADER_SIZE;
    const total = headerLen + pages.length * fs;
    if (this.writeBuf.length < total) this.writeBuf = new Uint8Array(Math.max(total, this.writeBuf.length * 2));
    const buf = this.writeBuf;
    let p = 0;
    if (headerLen) {
      const h = this.headerBytes();
      buf.set(h, 0);
      this.lastCrc = new DataView(h.buffer).getUint32(28, true);
      p = WAL_HEADER_SIZE;
      this.end = WAL_HEADER_SIZE;
    }
    const dv = new DataView(buf.buffer);
    let crc = this.lastCrc;
    const start = this.end;
    for (let i = 0; i < pages.length; i++) {
      const pg = pages[i];
      dv.setUint32(p, pg.pgno, true);
      dv.setUint32(p + 4, i === pages.length - 1 ? pageCount : 0, true);
      dv.setUint32(p + 8, this.salt1, true);
      dv.setUint32(p + 12, this.salt2, true);
      buf.set(pg.bytes, p + WAL_FRAME_HEADER_SIZE);
      crc = crc32c(buf, p, p + 16, crc);
      crc = crc32c(buf, p + WAL_FRAME_HEADER_SIZE, p + fs, crc);
      dv.setUint32(p + 16, crc, true);
      dv.setUint32(p + 20, 0, true);
      p += fs;
    }
    // One write call for the whole transaction (chunked for very large ones).
    const writeAt = start - headerLen;
    for (let off = 0; off < total; off += 8 * 1024 * 1024) {
      this.file.write(buf.subarray(off, Math.min(total, off + 8 * 1024 * 1024)), writeAt + off);
    }
    if (sync) this.file.flush();
    for (let i = 0; i < pages.length; i++) this.index.set(pages[i].pgno, start + i * fs);
    this.end = start + pages.length * fs;
    this.lastCrc = crc;
    this.committedPageCount = pageCount;
    this.stats.commits++;
    this.stats.framesWritten += pages.length;
  }

  /**
   * Copy the latest version of every page into the database file, flush it, then reset the log.
   * `cached(pgno)` may return a clean, up-to-date copy of the page to avoid reading the WAL.
   */
  checkpoint(db: VfsFile, cached: (pgno: number) => Uint8Array | null): void {
    if (this.index.size === 0) return;
    const ps = this.pageSize;
    const fs = this.frameSize;
    // Group by pgno; read frames from the WAL in large sequential chunks.
    const entries = [...this.index].sort((a, b) => a[0] - b[0]);
    const byOffset = [...this.index].sort((a, b) => a[1] - b[1]);
    const pageData = new Map<number, Uint8Array>();
    let chunk = new Uint8Array(0);
    let chunkStart = -1;
    for (const [pgno, off] of byOffset) {
      const c = cached(pgno);
      if (c) {
        pageData.set(pgno, c);
        continue;
      }
      if (chunkStart < 0 || off < chunkStart || off + fs > chunkStart + chunk.length) {
        const len = Math.max(fs, Math.min(READ_CHUNK - (READ_CHUNK % fs), this.end - off));
        chunk = new Uint8Array(len);
        this.file.read(chunk, off);
        chunkStart = off;
      }
      const p = off - chunkStart + WAL_FRAME_HEADER_SIZE;
      pageData.set(pgno, chunk.slice(p, p + ps));
    }
    // Write runs of consecutive pages with one call each.
    let i = 0;
    while (i < entries.length) {
      let j = i + 1;
      while (j < entries.length && entries[j][0] === entries[j - 1][0] + 1 && j - i < 128) j++;
      const run = new Uint8Array((j - i) * ps);
      for (let k = i; k < j; k++) run.set(pageData.get(entries[k][0])!, (k - i) * ps);
      db.write(run, entries[i][0] * ps);
      i = j;
    }
    db.flush();
    // Only now is it safe to forget the log. A crash before the truncate replays the same frames again.
    this.startFresh(this.seq + 1);
    this.file.truncate(0);
    this.file.flush();
    this.stats.checkpoints++;
  }

  close(): void {
    this.file.close();
  }
}
