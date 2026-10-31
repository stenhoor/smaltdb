import { CorruptionError, MisuseError, SmaltError } from '../errors.js';
import type { VfsFile } from '../vfs/types.js';
import { crc32c } from './crc32c.js';
import {
  DB_HEADER_SIZE,
  DEFAULT_PAGE_SIZE,
  DEFAULT_RESERVED_BYTES,
  DH_CATALOG_ROOT,
  DH_CHANGE_COUNTER,
  DH_FORMAT_MAJOR,
  DH_FORMAT_MINOR,
  DH_FREELIST_COUNT,
  DH_FREELIST_HEAD,
  DH_MAGIC,
  DH_PAGE_COUNT,
  DH_PAGE_SIZE,
  DH_RESERVED_BYTES,
  DH_SCHEMA_COOKIE,
  FORMAT_MAJOR,
  FORMAT_MINOR,
  MAGIC,
  MAX_PAGE_SIZE,
  MIN_PAGE_SIZE,
  PAGE_HEADER_SIZE,
  PH_CELL_COUNT,
  PH_RIGHT,
  PageType,
} from './format.js';

/**
 * A buffer-pool frame. Frames are preallocated and reused, so fetching a page allocates nothing.
 * A frame returned by {@link Pager.get} / {@link Pager.allocate} is *pinned* and must be
 * returned with {@link Pager.release}.
 */
export class Frame {
  pgno = -1;
  pins = 0;
  dirty = false;
  ref = false;
  readonly view: DataView;
  constructor(
    readonly index: number,
    readonly bytes: Uint8Array,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}

export interface PagerOptions {
  /** Page size for a new database (power of two, 512..65536). Ignored for existing files. */
  pageSize?: number;
  /** Buffer-pool budget in bytes (default 16 MiB). The pool grows past it only when every frame is pinned or dirty. */
  cacheSizeBytes?: number;
  /** Verify page checksums on every read from storage (default true). */
  verifyChecksums?: boolean;
  /** Call `flush()` on commit (`synchronous=full`, default true). */
  syncOnCommit?: boolean;
}

export interface PagerStats {
  hits: number;
  misses: number;
  reads: number;
  writes: number;
  evictions: number;
  /** Frames allocated beyond the configured budget (no-steal overflow). */
  overflowFrames: number;
}

/**
 * Page cache plus page allocation for a single database file.
 *
 * M0 transaction model: changes accumulate in dirty frames (no-steal: dirty frames are never
 * evicted) and are written by {@link commit}; {@link rollback} discards them. This is *not*
 * crash-atomic. The WAL (milestone M2) replaces the write-back step in `commit`.
 */
/** Upper bound on a single coalesced write during commit. */
const WRITE_BATCH_BYTES = 1024 * 1024;

export class Pager {
  readonly pageSize: number;
  /** Bytes per page available to page formats (page size minus reserved trailer). */
  readonly usableSize: number;
  readonly stats: PagerStats = { hits: 0, misses: 0, reads: 0, writes: 0, evictions: 0, overflowFrames: 0 };

  private readonly frames: Frame[] = [];
  private readonly map = new Map<number, Frame>();
  private readonly dirtyList: Frame[] = [];
  private hand = 0;
  private readonly targetFrames: number;
  private readonly verify: boolean;
  private readonly syncOnCommit: boolean;
  /** Live database header (page 0). */
  private readonly header: Uint8Array;
  private readonly hv: DataView;
  /** Header as of the last commit, restored by rollback. */
  private readonly committedHeader: Uint8Array;
  private headerDirty = false;
  private closed = false;

  private constructor(
    private readonly file: VfsFile,
    pageSize: number,
    reservedBytes: number,
    header: Uint8Array,
    options: PagerOptions,
  ) {
    this.pageSize = pageSize;
    this.usableSize = pageSize - reservedBytes;
    this.header = header;
    this.hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
    this.committedHeader = header.slice();
    this.verify = options.verifyChecksums ?? true;
    this.syncOnCommit = options.syncOnCommit ?? true;
    const budget = options.cacheSizeBytes ?? 16 * 1024 * 1024;
    this.targetFrames = Math.max(16, Math.floor(budget / pageSize));
    const arena = new Uint8Array(this.targetFrames * pageSize);
    for (let i = 0; i < this.targetFrames; i++) {
      this.frames.push(new Frame(i, arena.subarray(i * pageSize, (i + 1) * pageSize)));
    }
  }

  /** Open (or initialize, if empty) a database file. */
  static open(file: VfsFile, options: PagerOptions = {}): Pager {
    const size = file.size();
    if (size === 0) {
      const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
      validatePageSize(pageSize);
      const header = new Uint8Array(pageSize);
      header.set(MAGIC, DH_MAGIC);
      const v = new DataView(header.buffer);
      v.setUint16(DH_FORMAT_MAJOR, FORMAT_MAJOR, true);
      v.setUint16(DH_FORMAT_MINOR, FORMAT_MINOR, true);
      v.setUint32(DH_PAGE_SIZE, pageSize, true);
      v.setUint8(DH_RESERVED_BYTES, DEFAULT_RESERVED_BYTES);
      v.setUint32(DH_PAGE_COUNT, 1, true);
      const pager = new Pager(file, pageSize, DEFAULT_RESERVED_BYTES, header, options);
      pager.headerDirty = true;
      pager.commit();
      return pager;
    }

    const probe = new Uint8Array(DB_HEADER_SIZE);
    if (file.read(probe, 0) < DB_HEADER_SIZE) throw new CorruptionError('file too small to be a smaltdb database');
    for (let i = 0; i < MAGIC.length; i++) {
      if (probe[DH_MAGIC + i] !== MAGIC[i]) throw new SmaltError('SMALT_NOTADB', 'file is not a smaltdb database');
    }
    const pv = new DataView(probe.buffer);
    const major = pv.getUint16(DH_FORMAT_MAJOR, true);
    if (major !== FORMAT_MAJOR) {
      throw new SmaltError('SMALT_FORMAT', `unsupported format version ${major}.x (engine supports ${FORMAT_MAJOR}.x)`);
    }
    const pageSize = pv.getUint32(DH_PAGE_SIZE, true);
    validatePageSize(pageSize);
    const reserved = pv.getUint8(DH_RESERVED_BYTES);
    if (reserved < 4 || reserved > 255) throw new CorruptionError(`invalid reserved byte count ${reserved}`);
    const header = new Uint8Array(pageSize);
    if (file.read(header, 0) !== pageSize) throw new CorruptionError('truncated header page');
    if (options.verifyChecksums ?? true) checkChecksum(header, 0);
    return new Pager(file, pageSize, reserved, header, options);
  }

  // ---------------------------------------------------------------- header fields

  get pageCount(): number {
    return this.hv.getUint32(DH_PAGE_COUNT, true);
  }

  get freelistCount(): number {
    return this.hv.getUint32(DH_FREELIST_COUNT, true);
  }

  get catalogRoot(): number {
    return this.hv.getUint32(DH_CATALOG_ROOT, true);
  }

  set catalogRoot(pgno: number) {
    this.setHeaderU32(DH_CATALOG_ROOT, pgno);
  }

  get schemaCookie(): number {
    return this.hv.getUint32(DH_SCHEMA_COOKIE, true);
  }

  set schemaCookie(v: number) {
    this.setHeaderU32(DH_SCHEMA_COOKIE, v);
  }

  get changeCounter(): number {
    return this.hv.getUint32(DH_CHANGE_COUNTER, true);
  }

  /** True when there are uncommitted changes. */
  get inTransaction(): boolean {
    if (this.headerDirty) return true;
    for (const f of this.dirtyList) if (f.dirty) return true;
    return false;
  }

  /** Number of currently pinned frames (should be 0 between operations; used by tests). */
  pinnedCount(): number {
    let n = 0;
    for (const f of this.frames) if (f.pins > 0) n++;
    return n;
  }

  private setHeaderU32(off: number, v: number): void {
    this.hv.setUint32(off, v, true);
    this.headerDirty = true;
  }

  // ---------------------------------------------------------------- page access

  /** Fetch a page (pinned). Page 0 (the database header) is not accessible here. */
  get(pgno: number): Frame {
    const cached = this.map.get(pgno);
    if (cached !== undefined) {
      cached.pins++;
      cached.ref = true;
      this.stats.hits++;
      return cached;
    }
    if (pgno <= 0 || pgno >= this.pageCount) throw new CorruptionError(`page ${pgno} out of range (pageCount=${this.pageCount})`);
    this.stats.misses++;
    const f = this.takeFrame(pgno);
    const n = this.file.read(f.bytes, pgno * this.pageSize);
    this.stats.reads++;
    if (n < this.pageSize) {
      f.bytes.fill(0, n);
    } else if (this.verify) {
      checkChecksum(f.bytes, pgno);
    }
    return f;
  }

  release(f: Frame): void {
    if (f.pins <= 0) throw new MisuseError(`release of unpinned page ${f.pgno}`);
    f.pins--;
  }

  /**
   * Mark a pinned page as modified in the current transaction. Must be called *before* the page is
   * changed: inside a statement, the first call snapshots the page for {@link rollbackStatement}.
   */
  markDirty(f: Frame): void {
    const images = this.stmtImages;
    if (images !== null && f.pgno < this.stmtPageCount && !images.has(f.pgno) && !this.stmtFresh.has(f.pgno)) {
      images.set(f.pgno, f.bytes.slice());
    }
    if (!f.dirty) {
      f.dirty = true;
      this.dirtyList.push(f);
    }
  }

  private markDirtyNoCapture(f: Frame): void {
    if (!f.dirty) {
      f.dirty = true;
      this.dirtyList.push(f);
    }
  }

  // ---------------------------------------------------------------- statement savepoints

  /** Page images captured on first modification within the current statement (null = no statement). */
  private stmtImages: Map<number, Uint8Array> | null = null;
  private stmtPageCount = 0;
  private stmtHeader: Uint8Array | null = null;
  /** Uncaptured pages (re)allocated during the statement; dropped on statement rollback. */
  private readonly stmtFresh = new Set<number>();

  /** Begin a statement-level savepoint. Changes made until commitStatement/rollbackStatement can be undone. */
  beginStatement(): void {
    if (this.stmtImages !== null) throw new MisuseError('statement already active');
    this.stmtImages = new Map();
    this.stmtFresh.clear();
    this.stmtPageCount = this.pageCount;
    this.stmtHeader = this.header.slice();
  }

  get inStatement(): boolean {
    return this.stmtImages !== null;
  }

  /** Keep the statement's changes (they remain part of the enclosing transaction). */
  commitStatement(): void {
    this.stmtFresh.clear();
    this.stmtImages = null;
    this.stmtHeader = null;
  }

  /** Undo every change made since beginStatement. No page may be pinned. */
  rollbackStatement(): void {
    const images = this.stmtImages;
    const header = this.stmtHeader;
    if (images === null || header === null) throw new MisuseError('no active statement');
    this.stmtImages = null;
    this.stmtHeader = null;
    for (const f of this.frames) {
      if (f.pins > 0) throw new MisuseError(`statement rollback with pinned page ${f.pgno}`);
    }
    // Pages allocated past the old end of file disappear; reused free pages revert to their stored image.
    for (const f of this.frames) if (f.pgno >= this.stmtPageCount) this.discard(f);
    for (const pgno of this.stmtFresh) {
      if (images.has(pgno)) continue;
      const f = this.map.get(pgno);
      if (f !== undefined) this.discard(f);
    }
    this.stmtFresh.clear();
    for (const [pgno, image] of images) {
      let f = this.map.get(pgno);
      if (f === undefined) f = this.takeFrame(pgno);
      else f.pins++;
      f.bytes.set(image);
      this.markDirtyNoCapture(f);
      this.release(f);
    }
    this.header.set(header);
    this.headerDirty = true;
  }

  /** Allocate a page (pinned, dirty, zero-filled), reusing the freelist when possible. */
  allocate(): Frame {
    const head = this.hv.getUint32(DH_FREELIST_HEAD, true);
    let pgno: number;
    if (head !== 0) {
      const trunk = this.get(head);
      const n = trunk.view.getUint16(PH_CELL_COUNT, true);
      if (n > 0) {
        pgno = trunk.view.getUint32(PAGE_HEADER_SIZE + (n - 1) * 4, true);
        this.markDirty(trunk);
        trunk.view.setUint16(PH_CELL_COUNT, n - 1, true);
        this.release(trunk);
      } else {
        // Reuse the empty trunk page itself. It holds freelist structure, so snapshot it.
        pgno = head;
        this.captureForStatement(trunk);
        this.setHeaderU32(DH_FREELIST_HEAD, trunk.view.getUint32(PH_RIGHT, true));
        this.release(trunk);
      }
      this.setHeaderU32(DH_FREELIST_COUNT, this.freelistCount - 1);
    } else {
      pgno = this.pageCount;
      this.setHeaderU32(DH_PAGE_COUNT, pgno + 1);
    }
    let f = this.map.get(pgno);
    if (f !== undefined) {
      f.pins++;
      f.ref = true;
    } else {
      f = this.takeFrame(pgno);
    }
    // No snapshot needed: the page was free when the statement began, or it was freed during the
    // statement (then either captured, or clean, so its committed image is on disk). Remember it so
    // a statement rollback drops this frame instead of writing it.
    if (this.stmtImages !== null && pgno < this.stmtPageCount && !this.stmtImages.has(pgno)) this.stmtFresh.add(pgno);
    f.bytes.fill(0);
    this.markDirtyNoCapture(f);
    return f;
  }

  /** Return a page to the freelist. The page must not be pinned. */
  free(pgno: number): void {
    if (pgno <= 0 || pgno >= this.pageCount) throw new MisuseError(`free of invalid page ${pgno}`);
    const cached = this.map.get(pgno);
    if (cached !== undefined && cached.pins > 0) throw new MisuseError(`free of pinned page ${pgno}`);
    const head = this.hv.getUint32(DH_FREELIST_HEAD, true);
    const capacity = Math.floor((this.usableSize - PAGE_HEADER_SIZE) / 4);
    if (head !== 0) {
      const trunk = this.get(head);
      const n = trunk.view.getUint16(PH_CELL_COUNT, true);
      if (n < capacity) {
        this.markDirty(trunk);
        trunk.view.setUint32(PAGE_HEADER_SIZE + n * 4, pgno, true);
        trunk.view.setUint16(PH_CELL_COUNT, n + 1, true);
        this.release(trunk);
        this.setHeaderU32(DH_FREELIST_COUNT, this.freelistCount + 1);
        // Contents of a freed page are irrelevant; drop any cached copy so it is never written.
        // Inside a statement, keep its image first so a statement rollback can resurrect it.
        if (cached !== undefined) {
          if (cached.dirty) this.captureForStatement(cached);
          this.discard(cached);
        }
        return;
      }
      this.release(trunk);
    }
    // The freed page becomes the new freelist trunk.
    let t: Frame;
    if (cached !== undefined) {
      t = cached;
      t.pins++;
    } else if (this.stmtImages !== null && pgno < this.stmtPageCount) {
      t = this.get(pgno); // read the current contents so the statement snapshot is correct
    } else {
      t = this.takeFrame(pgno);
    }
    this.captureForStatement(t);
    t.bytes.fill(0);
    t.bytes[0] = PageType.FreelistTrunk;
    t.view.setUint32(PH_RIGHT, head, true);
    this.markDirty(t);
    this.release(t);
    this.setHeaderU32(DH_FREELIST_HEAD, pgno);
    this.setHeaderU32(DH_FREELIST_COUNT, this.freelistCount + 1);
  }

  // ---------------------------------------------------------------- transactions

  /** Write all dirty pages and the header, then flush (if `syncOnCommit`). */
  commit(): void {
    this.checkOpen();
    if (this.stmtImages !== null) throw new MisuseError('commit inside an active statement');
    if (!this.inTransaction) return;
    // The list may contain stale entries (discarded frames, or a frame listed twice after reuse);
    // only frames still flagged dirty are written, each once.
    // Runs of consecutive pages are coalesced into one large write (far fewer OPFS calls).
    const dirty = this.dirtyList.sort((a, b) => a.pgno - b.pgno);
    const ps = this.pageSize;
    const maxRun = Math.max(1, Math.floor(WRITE_BATCH_BYTES / ps));
    let i = 0;
    while (i < dirty.length) {
      const first = dirty[i];
      if (!first.dirty) {
        i++;
        continue;
      }
      // Collect the run [i, j) of dirty frames with consecutive page numbers.
      let j = i + 1;
      let next = first.pgno + 1;
      while (j < dirty.length && j - i < maxRun) {
        const f = dirty[j];
        if (!f.dirty || f.pgno !== next) break;
        next++;
        j++;
      }
      if (j - i === 1) {
        this.writePage(first.bytes, first.pgno);
      } else {
        const batch = this.writeBuffer(j - i);
        for (let k = i; k < j; k++) {
          this.sealPage(dirty[k].bytes);
          batch.set(dirty[k].bytes, (k - i) * ps);
        }
        this.file.write(batch.subarray(0, (j - i) * ps), first.pgno * ps);
        this.stats.writes += j - i;
      }
      for (let k = i; k < j; k++) dirty[k].dirty = false;
      i = j;
    }
    dirty.length = 0;
    this.hv.setUint32(DH_CHANGE_COUNTER, (this.changeCounter + 1) >>> 0, true);
    this.writePage(this.header, 0);
    this.committedHeader.set(this.header);
    this.headerDirty = false;
    if (this.syncOnCommit) this.file.flush();
    this.trimOverflowFrames();
  }

  /** Discard all uncommitted changes. No page may be pinned. */
  rollback(): void {
    this.checkOpen();
    this.stmtFresh.clear();
    this.stmtImages = null;
    this.stmtHeader = null;
    for (const f of this.dirtyList) {
      if (f.dirty && f.pins > 0) throw new MisuseError(`rollback with pinned page ${f.pgno}`);
    }
    for (const f of this.dirtyList) if (f.dirty) this.discard(f);
    this.dirtyList.length = 0;
    this.header.set(this.committedHeader);
    this.headerDirty = false;
    this.trimOverflowFrames();
  }

  close(): void {
    if (this.closed) return;
    if (this.inTransaction) this.rollback();
    this.file.close();
    this.closed = true;
  }

  // ---------------------------------------------------------------- internals

  /** Store the page checksum in its trailer. */
  private sealPage(bytes: Uint8Array): void {
    const sumOff = this.pageSize - 4;
    const sum = crc32c(bytes, 0, sumOff);
    bytes[sumOff] = sum & 0xff;
    bytes[sumOff + 1] = (sum >>> 8) & 0xff;
    bytes[sumOff + 2] = (sum >>> 16) & 0xff;
    bytes[sumOff + 3] = sum >>> 24;
  }

  private writePage(bytes: Uint8Array, pgno: number): void {
    this.sealPage(bytes);
    this.file.write(bytes, pgno * this.pageSize);
    this.stats.writes++;
  }

  private batchBuf: Uint8Array | null = null;

  private writeBuffer(pages: number): Uint8Array {
    const need = pages * this.pageSize;
    if (this.batchBuf === null || this.batchBuf.length < need) {
      this.batchBuf = new Uint8Array(Math.min(WRITE_BATCH_BYTES, Math.max(need, 64 * this.pageSize)));
    }
    return this.batchBuf;
  }

  private captureForStatement(f: Frame): void {
    if (this.stmtImages !== null && f.pgno < this.stmtPageCount && !this.stmtImages.has(f.pgno) && !this.stmtFresh.has(f.pgno)) {
      this.stmtImages.set(f.pgno, f.bytes.slice());
    }
  }

  /** Drop a frame's contents and return it to the free pool. Any dirty-list entry goes stale (see commit). */
  private discard(f: Frame): void {
    this.map.delete(f.pgno);
    f.dirty = false;
    f.pgno = -1;
    f.ref = false;
  }

  /** Release frames allocated beyond the budget once they are no longer pinned or dirty. */
  private trimOverflowFrames(): void {
    const frames = this.frames;
    while (frames.length > this.targetFrames) {
      const f = frames[frames.length - 1];
      if (f.pins > 0 || f.dirty) break;
      if (f.pgno !== -1) this.map.delete(f.pgno);
      frames.pop();
    }
    if (this.hand >= frames.length) this.hand = 0;
  }

  /** Get an unused frame bound to `pgno` (pinned once, not read). CLOCK replacement, no-steal. */
  private takeFrame(pgno: number): Frame {
    const frames = this.frames;
    const n = frames.length;
    let victim: Frame | undefined;
    for (let scanned = 0; scanned < 2 * n; scanned++) {
      const f = frames[this.hand];
      this.hand = this.hand + 1 === n ? 0 : this.hand + 1;
      if (f.pgno === -1) {
        victim = f;
        break;
      }
      if (f.pins > 0 || f.dirty) continue;
      if (f.ref) {
        f.ref = false;
        continue;
      }
      victim = f;
      break;
    }
    if (victim === undefined) {
      // Every frame is pinned or dirty: grow past the budget rather than fail (see stats.overflowFrames).
      victim = new Frame(frames.length, new Uint8Array(this.pageSize));
      frames.push(victim);
      this.stats.overflowFrames++;
    } else if (victim.pgno !== -1) {
      this.map.delete(victim.pgno);
      this.stats.evictions++;
    }
    victim.pgno = pgno;
    victim.pins = 1;
    victim.ref = true;
    this.map.set(pgno, victim);
    return victim;
  }

  private checkOpen(): void {
    if (this.closed) throw new MisuseError('pager is closed');
  }
}

function validatePageSize(n: number): void {
  if (n < MIN_PAGE_SIZE || n > MAX_PAGE_SIZE || (n & (n - 1)) !== 0) {
    throw new MisuseError(`invalid page size ${n} (power of two between ${MIN_PAGE_SIZE} and ${MAX_PAGE_SIZE})`);
  }
}

function checkChecksum(bytes: Uint8Array, pgno: number): void {
  const off = bytes.length - 4;
  const stored = (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16) | (bytes[off + 3] << 24)) >>> 0;
  if (crc32c(bytes, 0, off) === stored) return;
  // A never-written page inside the file (a hole left by a page freed in the same transaction it was allocated) is all zero.
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== 0) throw new CorruptionError(`page ${pgno}: checksum mismatch`);
}
