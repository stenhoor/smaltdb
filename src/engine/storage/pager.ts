import { CorruptionError, MisuseError, SmaltError } from '../errors.js';
import type { VfsFile } from '../vfs/types.js';
import { crc32c } from './crc32c.js';
import type { SharedWalIndex } from './shared-wal.js';
import { Wal, type WalStats } from './wal.js';
import {
  DB_HEADER_SIZE,
  DEFAULT_PAGE_SIZE,
  DEFAULT_RESERVED_BYTES,
  DH_CATALOG_ROOT,
  DH_DEFINITION_ROOT,
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
  /** Prefetched by read-ahead; checksum not yet verified. */
  unverified = false;
  readonly view: DataView;
  constructor(
    readonly index: number,
    readonly bytes: Uint8Array,
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}

export interface PagerOptions {
  /**
   * The owner's WAL index in shared memory (ADR 0021 step 3): the owner (`owner: true`) publishes to it; a reader that
   * reads through the owner refreshes its snapshot from it instead of scanning the log.
   */
  sharedWal?: { index: SharedWalIndex; owner: boolean };
  /** Page size for a new database (power of two, 512..65536). Ignored for existing files. */
  pageSize?: number;
  /** Buffer-pool budget in bytes (default 16 MiB). The pool grows past it only when every frame is pinned or dirty. */
  cacheSizeBytes?: number;
  /** Verify page checksums on every read from storage (default true). */
  verifyChecksums?: boolean;
  /** Call `flush()` on commit (`synchronous=full`, default true). */
  syncOnCommit?: boolean;
  /** Checkpoint automatically once the WAL holds this many bytes (default 4 MiB). */
  walAutoCheckpointBytes?: number;
  /**
   * On a cache miss, read the aligned extent of this many bytes around the page in one call
   * (default 64 KiB; 0 disables). OPFS read calls have a high fixed cost, so neighbours are almost free.
   */
  readAheadBytes?: number;
}

export interface PagerStats {
  hits: number;
  misses: number;
  reads: number;
  writes: number;
  evictions: number;
  /** Automatic checkpoints that failed after a commit (retried later). */
  failedCheckpoints: number;
  /** Frames allocated beyond the configured budget (no-steal overflow). */
  overflowFrames: number;
  /** Pages loaded by read-ahead. */
  prefetched: number;
}

/** Upper bound on a single coalesced write during commit (no-WAL mode). */
const WRITE_BATCH_BYTES = 1024 * 1024;

/** Undo information for one savepoint level (statement journal or SQL SAVEPOINT). */
interface Savepoint {
  /** Page images captured on first modification within this level (created on the first one). */
  images: Map<number, Uint8Array> | null;
  /** Uncaptured pages (re)allocated within this level; dropped on rollback (created on the first one). */
  fresh: Set<number> | null;
  pageCount: number;
  /** Database header bytes (first DB_HEADER_SIZE) at the start of this level. */
  header: Uint8Array;
}

/**
 * Page cache, page allocation, transactions and savepoints for one database.
 *
 * Changes accumulate in dirty frames (no-steal: dirty frames are never evicted). With a WAL
 * (default), {@link commit} appends the changed pages to the log and flushes it, which makes the
 * commit atomic and durable; checkpoints copy pages back into the database file. Without a WAL
 * (`journalMode: 'off'`), pages are written in place: durable but not crash-atomic.
 *
 * In-memory databases ({@link Pager.openMemory}) have no backing file: frames are the database and
 * are never evicted, pages carry no checksums, and commit only forgets the transaction's undo
 * images. Rollback restores the images captured on each page's first modification.
 */

/** Page fetches between interrupt checks. */
const INTERRUPT_EVERY = 256;

export class Pager {
  readonly pageSize: number;
  /** Bytes per page available to page formats (page size minus reserved trailer). */
  readonly usableSize: number;
  readonly stats: PagerStats = { hits: 0, misses: 0, reads: 0, writes: 0, evictions: 0, failedCheckpoints: 0, overflowFrames: 0, prefetched: 0 };

  private readonly frames: Frame[] = [];
  private readonly map = new Map<number, Frame>();
  private readonly dirtyList: Frame[] = [];
  /** Frames currently dirty (dirtyList may also hold stale entries of discarded frames). */
  private dirtyCount = 0;
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
  private readonly autoCheckpoint: number;
  private readonly extentPages: number;
  private extentBuf: Uint8Array | null = null;
  /** In-memory database: no file, no eviction, no checksums. */
  private readonly memory: boolean = false;
  /** In memory: undo images for the open transaction (committed contents of modified pages). */
  private txn: Savepoint | null = null;
  /** In memory: slabs holding the transaction's undo images, reused after commit/rollback. */
  private readonly slabs: Uint8Array[] = [];
  private slabIdx = 0;
  private slabOff = 0;
  /** In memory: frames returned by discard(), reused before new ones are created. */
  private readonly spare: Frame[] = [];

  private constructor(
    private readonly file: VfsFile | null,
    private readonly wal: Wal | null,
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
    this.autoCheckpoint = options.walAutoCheckpointBytes ?? 4 * 1024 * 1024;
    this.extentPages = Math.max(1, Math.floor((options.readAheadBytes ?? 64 * 1024) / pageSize));
    const budget = options.cacheSizeBytes ?? 16 * 1024 * 1024;
    this.targetFrames = Math.max(16, Math.floor(budget / pageSize));
    if (file === null) {
      // In memory: frames are created as pages are, and never evicted.
      this.memory = true;
      this.targetFrames = Infinity;
      this.txn = this.newLevel();
      return;
    }
    const arena = new Uint8Array(this.targetFrames * pageSize);
    for (let i = 0; i < this.targetFrames; i++) {
      this.frames.push(new Frame(i, arena.subarray(i * pageSize, (i + 1) * pageSize)));
    }
  }

  /**
   * Open (or initialize, if empty) a database. With `walFile`, committed transactions are recovered
   * from the write-ahead log first.
   */
  static open(file: VfsFile, options: PagerOptions = {}, walFile?: VfsFile): Pager {
    const verify = options.verifyChecksums ?? true;
    let pageSize: number | null = null;
    let reserved = DEFAULT_RESERVED_BYTES;
    if (file.size() > 0) {
      const probe = new Uint8Array(DB_HEADER_SIZE);
      if (file.read(probe, 0) < DB_HEADER_SIZE) throw new CorruptionError('file too small to be a smaltdb database');
      ({ pageSize, reserved } = parseHeader(probe));
    }
    if (pageSize === null && walFile) pageSize = Wal.probePageSize(walFile);
    if (pageSize === null) pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    validatePageSize(pageSize);
    const wal = walFile ? Wal.open(walFile, pageSize, options.sharedWal) : null;

    const header = new Uint8Array(pageSize);
    let found = false;
    if (wal && wal.read(0, header)) found = true;
    else if (file.size() > 0) {
      if (file.read(header, 0) !== pageSize) throw new CorruptionError('truncated header page');
      found = true;
    }
    if (found) {
      ({ reserved } = parseHeader(header));
      if (verify) checkChecksum(header, 0);
      return new Pager(file, wal, pageSize, reserved, header, options);
    }
    // New database.
    header.set(MAGIC, DH_MAGIC);
    const v = new DataView(header.buffer);
    v.setUint16(DH_FORMAT_MAJOR, FORMAT_MAJOR, true);
    v.setUint16(DH_FORMAT_MINOR, FORMAT_MINOR, true);
    v.setUint32(DH_PAGE_SIZE, pageSize, true);
    v.setUint8(DH_RESERVED_BYTES, DEFAULT_RESERVED_BYTES);
    v.setUint32(DH_PAGE_COUNT, 1, true);
    const pager = new Pager(file, wal, pageSize, DEFAULT_RESERVED_BYTES, header, options);
    pager.headerDirty = true;
    pager.commit();
    return pager;
  }

  /** A new, empty in-memory database. Its contents disappear when it is closed. */
  static openMemory(options: PagerOptions = {}): Pager {
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
    const pager = new Pager(null, null, pageSize, DEFAULT_RESERVED_BYTES, header, options);
    pager.headerDirty = true;
    pager.commit();
    return pager;
  }

  /** True for in-memory databases. */
  get inMemory(): boolean {
    return this.memory;
  }

  /** Read-only snapshot reader (parallel reader workers): never writes. */
  private readOnly = false;

  /**
   * Open a read-only reader of a database that another handle writes (in WAL mode). Its view is
   * the committed state at open time; {@link refreshSnapshot} moves it to the latest commit.
   */
  static openReader(file: VfsFile, walFile: VfsFile, options: PagerOptions = {}): Pager {
    if (file.size() === 0 && Wal.probePageSize(walFile) === null) throw new SmaltError('SMALT_CANTOPEN', 'reader: the database does not exist yet');
    const p = Pager.open(file, options, walFile);
    p.readOnly = true;
    return p;
  }

  /**
   * Reader: move the snapshot to the latest commit in the WAL. Only pages changed since the last
   * snapshot leave the cache (all of them after a checkpoint started a new log). Returns whether
   * anything changed. No page may be pinned.
   */
  refreshSnapshot(): boolean {
    const wal = this.wal;
    if (!this.readOnly || wal === null) throw new MisuseError('refreshSnapshot needs a WAL reader');
    const before = this.changeCounter;
    const r = wal.refresh();
    let changed: Set<number> | null;
    if (r === 'no-log') {
      // Only the file: unchanged unless commits (and a checkpoint) happened since the last look.
      const h = new Uint8Array(this.pageSize);
      this.file!.read(h, 0);
      // (A checkpoint alone only moves the same page contents from the log into the file.)
      if (new DataView(h.buffer).getUint32(DH_CHANGE_COUNTER, true) === before) return false;
      changed = null;
    } else changed = r;
    if (changed !== null && changed.size === 0) return false;
    for (const f of this.frames) {
      if (f.pgno === -1) continue;
      if (changed === null || changed.has(f.pgno)) this.discard(f);
    }
    // The header (page 0): the newest copy is in the log, else in the file.
    if (!wal.read(0, this.header)) this.file!.read(this.header, 0);
    this.committedHeader.set(this.header);
    return true;
  }

  private newLevel(): Savepoint {
    return { images: null, fresh: null, pageCount: this.pageCount, header: this.header.slice(0, DB_HEADER_SIZE) };
  }

  /**
   * Buffers for savepoint (statement) page images and header copies, reused: most statements capture a page or
   * two and release them at once, and allocating an ArrayBuffer per capture dominated small writes.
   */
  private readonly imagePool: Uint8Array[] = [];
  private readonly headerPool: Uint8Array[] = [];

  private savepointImage(src: Uint8Array): Uint8Array {
    const img = this.imagePool.pop() ?? new Uint8Array(this.pageSize);
    img.set(src);
    return img;
  }

  /** Return a savepoint level's buffers that nothing keeps (a level popped without merging, or merged and left over). */
  private recycle(sp: Savepoint, kept: Map<number, Uint8Array> | null): void {
    if (sp.images !== null) {
      for (const [pgno, img] of sp.images) if (kept?.get(pgno) !== img && this.imagePool.length < 256) this.imagePool.push(img);
    }
    if (this.headerPool.length < 16) this.headerPool.push(sp.header);
  }

  /** In memory: keep the committed contents of a page before its first change in the transaction. */
  private captureTxn(f: Frame): void {
    const t = this.txn!;
    if (f.pgno < t.pageCount && !t.images?.has(f.pgno)) {
      const img = this.imageBuffer();
      img.set(f.bytes);
      (t.images ??= new Map()).set(f.pgno, img);
    }
  }

  /** A page-sized buffer from the undo slabs (64 pages each), valid until the transaction ends. */
  private imageBuffer(): Uint8Array {
    const ps = this.pageSize;
    const SLAB = 64;
    if (this.slabIdx >= this.slabs.length || this.slabOff === SLAB) {
      if (this.slabOff === SLAB) {
        this.slabIdx++;
        this.slabOff = 0;
      }
      if (this.slabIdx >= this.slabs.length) this.slabs.push(new Uint8Array(SLAB * ps));
    }
    const slab = this.slabs[this.slabIdx];
    const off = this.slabOff++ * ps;
    return slab.subarray(off, off + ps);
  }

  /** The transaction ended: undo images are dead, so their slabs can be reused. Keeps at most 16 MiB. */
  private resetImages(): void {
    this.slabIdx = 0;
    this.slabOff = 0;
    const keep = Math.max(1, Math.floor((16 << 20) / (64 * this.pageSize)));
    if (this.slabs.length > keep) this.slabs.length = keep;
  }

  get walStats(): WalStats | null {
    return this.wal?.stats ?? null;
  }

  /** Bytes currently held in the WAL (0 without a WAL). */
  get walSize(): number {
    return this.wal?.size ?? 0;
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

  /** Root of the stored definitions (catalog/stored.ts), 0 until the first one is written. */
  get definitionRoot(): number {
    return this.hv.getUint32(DH_DEFINITION_ROOT, true);
  }

  set definitionRoot(pgno: number) {
    this.setHeaderU32(DH_DEFINITION_ROOT, pgno);
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

  /** Drop every pin (after a failed write statement, when no cursor can hold one). */
  releaseAllPins(): void {
    for (const f of this.frames) f.pins = 0;
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

  /**
   * Called every {@link INTERRUPT_EVERY} page fetches while set; throws to abort the running
   * statement (cancellation). Page fetches happen throughout scans, lookups and writes, so this
   * bounds how long a statement runs after it is cancelled.
   */
  interrupt: (() => void) | null = null;
  private fetches = 0;

  /** Fetch a page (pinned). Page 0 (the database header) is not accessible here. */
  get(pgno: number): Frame {
    if (this.interrupt !== null && ++this.fetches >= INTERRUPT_EVERY) {
      this.fetches = 0;
      this.interrupt();
    }
    const cached = this.map.get(pgno);
    if (cached !== undefined) {
      cached.pins++;
      cached.ref = true;
      this.stats.hits++;
      if (cached.unverified) {
        cached.unverified = false;
        if (this.verify) {
          try {
            checkChecksum(cached.bytes, pgno);
          } catch (e) {
            cached.pins--;
            this.discard(cached);
            throw e;
          }
        }
      }
      return cached;
    }
    if (pgno <= 0 || pgno >= this.pageCount) throw new CorruptionError(`page ${pgno} out of range (pageCount=${this.pageCount})`);
    this.stats.misses++;
    const f = this.takeFrame(pgno);
    if (this.file === null) {
      // In memory, an uncached page was never written (e.g. a free page).
      f.bytes.fill(0);
      return f;
    }
    let n: number;
    if (this.wal !== null && this.wal.read(pgno, f.bytes)) n = this.pageSize;
    else if (this.extentPages > 1) n = this.readExtent(pgno, f);
    else n = this.file!.read(f.bytes, pgno * this.pageSize);
    this.stats.reads++;
    if (n < this.pageSize) {
      f.bytes.fill(0, n);
    } else if (this.verify) {
      checkChecksum(f.bytes, pgno);
    }
    return f;
  }

  /**
   * Read the aligned extent containing `pgno` with one call. The requested page goes into `f`;
   * neighbours that are not cached (and not newer in the WAL) become low-priority cache entries,
   * verified lazily on first use. Returns the bytes available for the requested page.
   */
  private readExtent(pgno: number, f: Frame): number {
    const ps = this.pageSize;
    const e = this.extentPages;
    const start = pgno - (pgno % e);
    const count = Math.min(e, this.pageCount - start);
    if (this.extentBuf === null) this.extentBuf = new Uint8Array(e * ps);
    const buf = this.extentBuf;
    const got = this.file!.read(buf.subarray(0, count * ps), start * ps);
    const off = (pgno - start) * ps;
    const n = Math.max(0, Math.min(ps, got - off));
    if (n > 0) f.bytes.set(buf.subarray(off, off + n));
    for (let q = start; q < start + count; q++) {
      if (q === pgno || q === 0 || (q - start + 1) * ps > got || this.map.has(q)) continue;
      if (this.wal !== null && this.wal.has(q)) continue;
      const g = this.takeFrame(q);
      g.bytes.set(buf.subarray((q - start) * ps, (q - start + 1) * ps));
      g.unverified = true;
      g.ref = false; // first candidates for eviction until actually used
      g.pins = 0;
      this.stats.prefetched++;
    }
    return n;
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
    if (this.readOnly) throw new SmaltError('SMALT_READONLY', 'attempt to write a read-only snapshot');
    if (this.txn !== null && !f.dirty) this.captureTxn(f);
    const sp = this.top;
    if (sp !== undefined && f.pgno < sp.pageCount && !sp.images?.has(f.pgno) && !sp.fresh?.has(f.pgno)) {
      (sp.images ??= new Map()).set(f.pgno, this.savepointImage(f.bytes));
    }
    f.unverified = false; // contents of a dirty frame are authoritative
    if (!f.dirty) {
      f.dirty = true;
      this.dirtyCount++;
      this.dirtyList.push(f);
    }
  }

  private markDirtyNoCapture(f: Frame): void {
    f.unverified = false;
    if (!f.dirty) {
      f.dirty = true;
      this.dirtyCount++;
      this.dirtyList.push(f);
    }
  }

  // ---------------------------------------------------------------- savepoints

  /** Savepoint stack; the top level receives page snapshots. Statements are savepoints too. */
  private readonly savepoints: Savepoint[] = [];

  private get top(): Savepoint | undefined {
    return this.savepoints[this.savepoints.length - 1];
  }

  /** Number of open savepoint levels. */
  get savepointDepth(): number {
    return this.savepoints.length;
  }

  /** Open a savepoint level; returns its depth (1-based). */
  beginSavepoint(): number {
    const header = this.headerPool.pop() ?? new Uint8Array(DB_HEADER_SIZE);
    header.set(this.header.subarray(0, DB_HEADER_SIZE));
    this.savepoints.push({ images: null, fresh: null, pageCount: this.pageCount, header });
    return this.savepoints.length;
  }

  /** Keep changes made since savepoint `depth` (and any inner levels) and close those levels. */
  releaseSavepoint(depth: number): void {
    this.checkDepth(depth);
    while (this.savepoints.length >= depth) {
      const child = this.savepoints.pop()!;
      const parent = this.top;
      if (!parent) {
        this.recycle(child, null);
        break;
      }
      if (child.images !== null) {
        for (const [pgno, img] of child.images) {
          if (pgno < parent.pageCount && !parent.images?.has(pgno) && !parent.fresh?.has(pgno)) (parent.images ??= new Map()).set(pgno, img);
        }
      }
      if (child.fresh !== null) for (const pgno of child.fresh) if (pgno < parent.pageCount && !parent.images?.has(pgno)) (parent.fresh ??= new Set()).add(pgno);
      this.recycle(child, parent.images);
    }
  }

  /**
   * Undo every change made since savepoint `depth` was opened. With `keep`, that level stays open
   * (SQL `ROLLBACK TO`); otherwise it is closed too. No page may be pinned.
   */
  rollbackToSavepoint(depth: number, keep: boolean): void {
    this.checkDepth(depth);
    for (const f of this.frames) if (f.pins > 0) throw new MisuseError(`savepoint rollback with pinned page ${f.pgno}`);
    while (this.savepoints.length >= depth) {
      const sp = this.savepoints.pop()!;
      this.restoreLevel(sp);
      this.recycle(sp, null);
    }
    if (keep) this.beginSavepoint();
  }

  private restoreLevel(sp: Savepoint): void {
    // Pages allocated past the level's end of file disappear; reused free pages revert to their stored image.
    for (const f of this.frames) if (f.pgno >= sp.pageCount) this.discard(f);
    if (sp.fresh !== null) {
      for (const pgno of sp.fresh) {
        if (sp.images?.has(pgno)) continue;
        const f = this.map.get(pgno);
        if (f !== undefined) this.discard(f);
      }
    }
    if (sp.images !== null) for (const [pgno, image] of sp.images) {
      let f = this.map.get(pgno);
      if (f === undefined) f = this.takeFrame(pgno);
      else f.pins++;
      f.bytes.set(image);
      this.markDirtyNoCapture(f);
      this.release(f);
    }
    this.header.set(sp.header);
    this.headerDirty = true;
  }

  private checkDepth(depth: number): void {
    if (depth < 1 || depth > this.savepoints.length) throw new MisuseError(`no savepoint at depth ${depth}`);
  }

  /** Begin a statement-level savepoint. */
  beginStatement(): void {
    this.beginSavepoint();
  }

  get inStatement(): boolean {
    return this.savepoints.length > 0;
  }

  /** Keep the statement's changes (they remain part of the enclosing transaction or savepoint). */
  commitStatement(): void {
    this.releaseSavepoint(this.savepoints.length);
  }

  /** Undo every change made since beginStatement. */
  rollbackStatement(): void {
    if (this.savepoints.length === 0) throw new MisuseError('no active statement');
    this.rollbackToSavepoint(this.savepoints.length, false);
  }

  /** Allocate a page (pinned, dirty, zero-filled), reusing the freelist when possible. */
  allocate(): Frame {
    if (this.readOnly) throw new SmaltError('SMALT_READONLY', 'attempt to write a read-only snapshot');
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
    const sp = this.top;
    if (sp !== undefined && pgno < sp.pageCount && !sp.images?.has(pgno)) (sp.fresh ??= new Set()).add(pgno);
    f.unverified = false;
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
          // In memory the frame is the only copy, so keep it even when clean.
          if (cached.dirty || this.memory) this.captureForStatement(cached);
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
    } else if (this.top !== undefined && pgno < this.top.pageCount) {
      t = this.get(pgno); // read the current contents so the statement snapshot is correct
    } else {
      t = this.takeFrame(pgno);
    }
    this.captureForStatement(t);
    t.unverified = false;
    t.bytes.fill(0);
    t.bytes[0] = PageType.FreelistTrunk;
    t.view.setUint32(PH_RIGHT, head, true);
    this.markDirty(t);
    this.release(t);
    this.setHeaderU32(DH_FREELIST_HEAD, pgno);
    this.setHeaderU32(DH_FREELIST_COUNT, this.freelistCount + 1);
  }

  // ---------------------------------------------------------------- transactions

  /**
   * Make the transaction durable. With a WAL: append changed pages + header to the log and flush
   * (atomic). Without: write pages in place and then the header, then flush.
   */
  /** Parallel readers: checkpoints wait while this returns false (a reader is reading the files). */
  checkpointGate: (() => boolean) | null = null;

  commit(): void {
    this.checkOpen();
    if (this.savepoints.length > 0) throw new MisuseError('commit with open savepoints');
    if (!this.inTransaction) return;
    if (this.memory) {
      for (const f of this.dirtyList) f.dirty = false;
      this.dirtyList.length = 0;
    this.dirtyCount = 0;
      this.hv.setUint32(DH_CHANGE_COUNTER, (this.changeCounter + 1) >>> 0, true);
      this.committedHeader.set(this.header);
      this.headerDirty = false;
      this.txn = this.newLevel();
      this.resetImages();
      return;
    }
    if (this.wal !== null) {
      this.commitToWal(this.wal);
      return;
    }
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
        this.file!.write(batch.subarray(0, (j - i) * ps), first.pgno * ps);
        this.stats.writes += j - i;
      }
      for (let k = i; k < j; k++) dirty[k].dirty = false;
      i = j;
    }
    dirty.length = 0;
    this.dirtyCount = 0;
    this.hv.setUint32(DH_CHANGE_COUNTER, (this.changeCounter + 1) >>> 0, true);
    this.writePage(this.header, 0);
    this.committedHeader.set(this.header);
    this.headerDirty = false;
    if (this.syncOnCommit) this.file!.flush();
    this.trimOverflowFrames();
  }

  private commitToWal(wal: Wal): void {
    const dirty = this.dirtyList.sort((a, b) => a.pgno - b.pgno);
    const pages: { pgno: number; bytes: Uint8Array }[] = [];
    for (const f of dirty) {
      if (!f.dirty) continue;
      if (pages.length > 0 && pages[pages.length - 1].pgno === f.pgno) continue;
      this.sealPage(f.bytes);
      pages.push({ pgno: f.pgno, bytes: f.bytes });
    }
    this.hv.setUint32(DH_CHANGE_COUNTER, (this.changeCounter + 1) >>> 0, true);
    this.sealPage(this.header);
    pages.push({ pgno: 0, bytes: this.header });
    wal.commit(pages, this.pageCount, this.syncOnCommit);
    for (const f of dirty) f.dirty = false;
    dirty.length = 0;
    this.dirtyCount = 0;
    this.stats.writes += pages.length;
    this.committedHeader.set(this.header);
    this.headerDirty = false;
    this.trimOverflowFrames();
    // Best-effort: the commit is durable in the WAL already. A failing checkpoint must not turn a
    // committed transaction into an error (callers would treat it as not committed); it is retried
    // at the next commit and on close.
    if (wal.size >= this.autoCheckpoint) {
      try {
        this.checkpoint();
      } catch {
        this.stats.failedCheckpoints++;
      }
    }
  }

  /** Copy committed WAL pages into the database file and reset the log. No transaction may be open. */
  checkpoint(): void {
    this.checkOpen();
    const wal = this.wal;
    if (wal === null || wal.isEmpty) return;
    if (this.readOnly) return;
    // Readers are reading the files: keep the log (it is replayed on the next open if need be).
    if (this.checkpointGate !== null && !this.checkpointGate()) return;
    if (this.inTransaction) throw new MisuseError('checkpoint inside a transaction');
    wal.checkpoint(this.file!, (pgno) => {
      if (pgno === 0) return this.header;
      const f = this.map.get(pgno);
      return f !== undefined && !f.dirty ? f.bytes : null;
    });
  }

  /** Discard all uncommitted changes. No page may be pinned. */
  rollback(): void {
    this.checkOpen();
    this.savepoints.length = 0;
    for (const f of this.dirtyList) {
      if (f.dirty && f.pins > 0) throw new MisuseError(`rollback with pinned page ${f.pgno}`);
    }
    if (this.memory) {
      // Restore committed images; pages created by the transaction disappear.
      this.restoreLevel(this.txn!);
      for (const f of this.dirtyList) f.dirty = false;
      this.dirtyList.length = 0;
    this.dirtyCount = 0;
      this.header.set(this.committedHeader);
      this.headerDirty = false;
      this.txn = this.newLevel();
      this.resetImages();
      return;
    }
    for (const f of this.dirtyList) if (f.dirty) this.discard(f);
    this.dirtyList.length = 0;
    this.dirtyCount = 0;
    this.header.set(this.committedHeader);
    this.headerDirty = false;
    this.trimOverflowFrames();
  }

  close(): void {
    if (this.closed) return;
    if (this.inTransaction) this.rollback();
    if (this.wal !== null) {
      if (!this.readOnly) this.checkpoint();
      this.wal.close();
    }
    this.file?.close();
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
    this.file!.write(bytes, pgno * this.pageSize);
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
    if (this.txn !== null) this.captureTxn(f);
    const sp = this.top;
    if (sp !== undefined && f.pgno < sp.pageCount && !sp.images?.has(f.pgno) && !sp.fresh?.has(f.pgno)) {
      (sp.images ??= new Map()).set(f.pgno, this.savepointImage(f.bytes));
    }
  }

  /** Drop a frame's contents and return it to the free pool. Any dirty-list entry goes stale (see commit). */
  private discard(f: Frame): void {
    if (this.memory && f.pgno !== -1) this.spare.push(f);
    this.map.delete(f.pgno);
    if (f.dirty) this.dirtyCount--;
    f.dirty = false;
    f.pgno = -1;
    f.ref = false;
    f.unverified = false;
  }

  /** Release frames allocated beyond the budget once they are no longer pinned or dirty. */
  private trimOverflowFrames(): void {
    if (this.memory) return;
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
    if (this.memory) {
      let f = this.spare.pop();
      if (f === undefined) {
        f = new Frame(this.frames.length, new Uint8Array(this.pageSize));
        this.frames.push(f);
      }
      f.pgno = pgno;
      f.pins = 1;
      f.ref = true;
      f.unverified = false;
      this.map.set(pgno, f);
      return f;
    }
    const frames = this.frames;
    const n = frames.length;
    let victim: Frame | undefined;
    // No-steal: dirty frames stay until commit. When (nearly) all are dirty, sweeping the clock
    // for the few clean ones costs O(frames) per miss: grow instead (trimmed after commit).
    const sweep = this.dirtyCount < n - (n >>> 3) ? 2 * n : 0;
    for (let scanned = 0; scanned < sweep; scanned++) {
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
    victim.unverified = false;
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

function parseHeader(probe: Uint8Array): { pageSize: number; reserved: number } {
  for (let i = 0; i < MAGIC.length; i++) {
    if (probe[DH_MAGIC + i] !== MAGIC[i]) throw new SmaltError('SMALT_NOTADB', 'file is not a smaltdb database');
  }
  const pv = new DataView(probe.buffer, probe.byteOffset, probe.byteLength);
  const major = pv.getUint16(DH_FORMAT_MAJOR, true);
  if (major !== FORMAT_MAJOR) throw new SmaltError('SMALT_FORMAT', `unsupported format version ${major}.x (engine supports ${FORMAT_MAJOR}.x)`);
  const pageSize = pv.getUint32(DH_PAGE_SIZE, true);
  validatePageSize(pageSize);
  const reserved = pv.getUint8(DH_RESERVED_BYTES);
  if (reserved < 4) throw new CorruptionError(`invalid reserved byte count ${reserved}`);
  return { pageSize, reserved };
}
