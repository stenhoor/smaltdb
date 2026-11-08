/**
 * Proxied files for parallel readers (ADR 0021, step 1). Where OPFS has no `readwrite-unsafe` handles (Firefox,
 * Safari), only the owner can open the database and WAL files, so a reader reads them through the owner: over a
 * channel in a `SharedArrayBuffer`, waiting with `Atomics.wait` until the owner has answered.
 *
 * A channel holds one request at a time:
 *
 *   Int32 [0] state (IDLE, REQUEST, DONE)   [1] op (READ, SIZE)   [2] file (DB, WAL)   [3] length
 *         [4] result: bytes read, or ERROR (then [3] is the length of the UTF-8 message in the data area)
 *   Float64 at byte 24: offset (READ) or size (SIZE's answer)
 *   bytes from DATA_OFFSET: the data area
 *
 * The reader writes the request and sets REQUEST, then wakes the owner (a message) and waits. The owner answers
 * every channel in REQUEST state (`ProxyServer.service`): when the message arrives, and while its own statements run
 * (from the pager's periodic check), since the message waits while the owner is busy. It sets DONE and notifies.
 * The reader reads the answer and sets IDLE. The owner never waits on a reader.
 */
import { SmaltError } from '../errors.js';
import { BLOCK, SharedCache } from './shared-cache.js';
import type { OpenOptions, Vfs, VfsFile } from './types.js';

const IDLE = 0;
const REQUEST = 1;
const DONE = 2;
const OP_READ = 1;
const OP_SIZE = 2;
const ERROR = -1;
const DATA_OFFSET = 32;
/** The data area of a channel by default: the largest read in one round trip (WAL scans read 1 MiB chunks). */
export const CHANNEL_DATA_BYTES = 1024 * 1024;

/** The files a reader reads through its channel. */
const FILE_DB = 0;
const FILE_WAL = 1;
type ProxiedFile = typeof FILE_DB | typeof FILE_WAL;

/** A channel for one reader. `dataBytes` is for tests (a small area splits reads). */
export function createChannel(dataBytes = CHANNEL_DATA_BYTES): SharedArrayBuffer {
  return new SharedArrayBuffer(DATA_OFFSET + dataBytes);
}

/** A reader's end of a channel: one of the owner's files, read-only. */
class ProxyFile implements VfsFile {
  private readonly ctl: Int32Array;
  private readonly num: Float64Array;
  private readonly data: Uint8Array;

  constructor(
    readonly path: string,
    channel: SharedArrayBuffer,
    private readonly file: ProxiedFile,
    private readonly wake: () => void,
    private readonly cache: SharedCache | null,
    private readonly rewind: () => void,
  ) {
    this.ctl = new Int32Array(channel, 0, 6);
    this.num = new Float64Array(channel, 24, 1);
    this.data = new Uint8Array(channel, DATA_OFFSET);
  }

  /** Ask the owner and wait for the answer: the result slot. */
  private call(op: number, offset: number, length: number): number {
    const ctl = this.ctl;
    if (Atomics.load(ctl, 0) !== IDLE) throw new SmaltError('SMALT_MISUSE', 'reader: a proxied read is already in progress');
    ctl[1] = op;
    ctl[2] = this.file;
    ctl[3] = length;
    this.num[0] = offset;
    Atomics.store(ctl, 0, REQUEST);
    this.wake();
    while (Atomics.load(ctl, 0) === REQUEST) Atomics.wait(ctl, 0, REQUEST);
    const result = ctl[4];
    if (result === ERROR) {
      const message = new TextDecoder().decode(this.data.slice(0, ctl[3]));
      Atomics.store(ctl, 0, IDLE);
      throw new SmaltError('SMALT_IOERR', `reader: ${this.path}: ${message}`);
    }
    return result;
  }

  read(dst: Uint8Array, offset: number): number {
    // With a shared cache (step 2), whole blocks come from it; a miss asks the owner for whole blocks, which it caches.
    if (this.cache !== null && this.data.length >= BLOCK) return this.readCached(dst, offset, this.cache);
    return this.readThrough(dst, offset);
  }

  /**
   * The last part block the owner sent (the end of the file, which the shared cache never holds), kept until the next
   * snapshot refresh ({@link ProxyVfs.forget}): the WAL's last block, read once per page in it otherwise.
   */
  private tail: { block: number; bytes: Uint8Array } | null = null;
  /** Read-ahead: the block after the last run the owner sent, and how many blocks the next sequential miss asks for. */
  private nextBlock = -1;
  private window = 1;

  forget(): void {
    this.tail = null;
  }

  private readCached(dst: Uint8Array, offset: number, cache: SharedCache): number {
    // A refresh (and opening) starts by reading the WAL's header, and nothing else reads there: a new snapshot.
    if (offset === 0 && this.file === FILE_WAL) this.rewind();
    const room = this.data.length - (this.data.length % BLOCK);
    let done = 0;
    while (done < dst.length) {
      const pos = offset + done;
      const block = Math.floor(pos / BLOCK);
      const from = pos - block * BLOCK;
      const len = Math.min(BLOCK - from, dst.length - done);
      const tail = this.tail;
      if (tail !== null && tail.block === block && from + len <= tail.bytes.length) {
        dst.set(tail.bytes.subarray(from, from + len), done);
        done += len;
        continue;
      }
      if (cache.read(this.file, block, from, len, dst, done)) {
        done += len;
        continue;
      }
      // A miss right after the last run is a sequential scan: ask for a run twice as long (up to the data area),
      // which the owner caches for the other readers too. Elsewhere, only the blocks this read needs.
      this.window = block === this.nextBlock ? Math.min(this.window * 2, room / BLOCK) : 1;
      const start = block * BLOCK;
      const need = Math.ceil((offset + dst.length - start) / BLOCK);
      const want = Math.min(room, Math.max(need, this.window) * BLOCK);
      const n = this.call(OP_READ, start, want);
      this.nextBlock = block + Math.ceil(n / BLOCK);
      const take = Math.max(0, Math.min(n - from, dst.length - done));
      dst.set(this.data.subarray(from, from + take), done);
      const last = n % BLOCK;
      if (last !== 0) this.tail = { block: block + Math.floor(n / BLOCK), bytes: this.data.slice(n - last, n) };
      Atomics.store(this.ctl, 0, IDLE);
      done += take;
      if (n < want) break; // end of file
    }
    return done;
  }

  private readThrough(dst: Uint8Array, offset: number): number {
    const max = this.data.length;
    let done = 0;
    while (done < dst.length) {
      const want = Math.min(max, dst.length - done);
      const n = this.call(OP_READ, offset + done, want);
      dst.set(this.data.subarray(0, n), done);
      Atomics.store(this.ctl, 0, IDLE);
      done += n;
      if (n < want) break; // end of file
    }
    return done;
  }

  size(): number {
    this.call(OP_SIZE, 0, 0);
    const size = this.num[0];
    Atomics.store(this.ctl, 0, IDLE);
    return size;
  }

  write(): number {
    throw new SmaltError('SMALT_READONLY', `reader: ${this.path} is read-only`);
  }

  truncate(): void {
    throw new SmaltError('SMALT_READONLY', `reader: ${this.path} is read-only`);
  }

  flush(): void {}

  close(): void {}
}

/**
 * A reader's file system: the database (`dbPath`) and its WAL are the owner's, read through `channel`; anything
 * else (the reader's own spill file) is opened in `local`. `wake` tells the owner a request is waiting.
 */
export class ProxyVfs implements Vfs {
  readonly name = 'proxy';

  constructor(
    private readonly channel: SharedArrayBuffer,
    private readonly dbPath: string,
    private readonly wake: () => void,
    private readonly local: Vfs,
    cache: SharedArrayBuffer | null = null,
  ) {
    this.cache = cache === null ? null : new SharedCache(cache);
  }

  /** The shared cache, when the owner gave one (stats). */
  readonly cache: SharedCache | null;

  private proxied(path: string): ProxiedFile | null {
    return path === this.dbPath ? FILE_DB : path === `${this.dbPath}-wal` ? FILE_WAL : null;
  }

  private readonly opened: ProxyFile[] = [];

  async open(path: string, options?: OpenOptions): Promise<VfsFile> {
    const file = this.proxied(path);
    if (file === null) return this.local.open(path, options);
    const f = new ProxyFile(path, this.channel, file, this.wake, this.cache, () => this.forget());
    this.opened.push(f);
    return f;
  }

  /**
   * Forget what the proxied files keep between reads (the end of each file). It happens at every snapshot refresh,
   * when the WAL's header is read: within a snapshot a reader reads only committed bytes, which do not change until
   * the next one (the log only grows, and checkpoints wait for idle readers).
   */
  forget(): void {
    for (const f of this.opened) f.forget();
  }

  async delete(path: string): Promise<void> {
    if (this.proxied(path) !== null) throw new SmaltError('SMALT_READONLY', `reader: cannot delete ${path}`);
    return this.local.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.proxied(path) !== null || this.local.exists(path);
  }
}

/** The owner's file: before each of its own reads and writes, it answers the readers waiting for it. */
class OwnedFile implements VfsFile {
  constructor(
    readonly inner: VfsFile,
    private readonly owner: OwnedVfs,
  ) {}

  get path(): string {
    return this.inner.path;
  }

  read(dst: Uint8Array, offset: number): number {
    this.owner.onIo?.();
    const n = this.inner.read(dst, offset);
    this.owner.onRead?.(this.inner.path, dst, offset, n);
    return n;
  }

  write(src: Uint8Array, offset: number): number {
    this.owner.onIo?.();
    this.owner.onChange?.(this.inner.path, 'write');
    return this.inner.write(src, offset);
  }

  size(): number {
    return this.inner.size();
  }

  truncate(size: number): void {
    this.owner.onChange?.(this.inner.path, 'truncate');
    this.inner.truncate(size);
  }

  flush(): void {
    this.owner.onIo?.();
    this.inner.flush();
  }

  close(): void {
    this.inner.close();
  }
}

/**
 * The owner's file system for proxied readers: `inner`, remembering the files it opened, so the owner can answer
 * readers' requests from its own handles. While the owner reads from or writes to its files (a cold query, a commit),
 * it answers the readers first (`onIo`), so a reader waits for at most one of the owner's own calls.
 */
export class OwnedVfs implements Vfs {
  readonly name: string;
  private readonly files = new Map<string, VfsFile>();
  /** Called before each of the owner's own file reads and writes: `ProxyServer` answers its readers. */
  onIo: (() => void) | null = null;
  /** Called after each of the owner's own reads, with what it read: `ProxyServer` caches whole blocks. */
  onRead: ((path: string, bytes: Uint8Array, offset: number, n: number) => void) | null = null;
  /** Called before the owner writes to or truncates a file: `ProxyServer` forgets cached blocks that may change. */
  onChange: ((path: string, how: 'write' | 'truncate') => void) | null = null;

  constructor(private readonly inner: Vfs) {
    this.name = inner.name;
  }

  async open(path: string, options?: OpenOptions): Promise<VfsFile> {
    const f = await this.inner.open(path, options);
    this.files.set(path, f);
    return new OwnedFile(f, this);
  }

  delete(path: string): Promise<void> {
    return this.inner.delete(path);
  }

  exists(path: string): Promise<boolean> {
    return this.inner.exists(path);
  }

  /** The file most recently opened at `path`, if any. */
  file(path: string): VfsFile | undefined {
    return this.files.get(path);
  }
}

/** The owner's end: answers its readers' channels from its own handles. */
export class ProxyServer {
  private readonly channels: { ctl: Int32Array; num: Float64Array; data: Uint8Array }[] = [];
  private scratch = new Uint8Array(0);
  /** Requests answered (diagnostics). */
  answered = 0;

  /** The shared cache this owner fills, if any (step 2). */
  readonly cache: SharedCache | null;
  /** The bytes of the WAL up to its last commit: the part of the log that cannot change until a checkpoint. */
  walCommitted: () => number = () => 0;

  constructor(
    private readonly files: OwnedVfs,
    private readonly dbPath: string,
    /** The shared cache's memory, for the readers (undefined without one). */
    readonly cacheBuffer?: SharedArrayBuffer,
  ) {
    this.cache = cacheBuffer === undefined ? null : new SharedCache(cacheBuffer);
    files.onIo = () => this.service();
    if (this.cache !== null) {
      const c = this.cache;
      files.onRead = (path, bytes, offset, n) => {
        if (path === this.dbPath) this.fill(FILE_DB, bytes, offset, n);
      };
      // Writes to the database file happen only at checkpoints (and appends to the log beyond its last commit,
      // which is never cached); a truncation restarts the log or shrinks the file.
      files.onChange = (path, how) => {
        if (how === 'truncate' || path === this.dbPath) c.bump();
      };
    }
  }

  /**
   * Answer a read of whole blocks from the shared cache when another reader's request has just put them there (readers
   * scanning the same table ask for the same blocks at about the same time). False if any block is missing.
   */
  private fromCache(file: ProxiedFile, offset: number, len: number, dst: Uint8Array): boolean {
    const cache = this.cache;
    if (cache === null || offset % BLOCK !== 0 || len % BLOCK !== 0) return false;
    for (let at = 0; at < len; at += BLOCK) if (!cache.read(file, (offset + at) / BLOCK, 0, BLOCK, dst, at)) return false;
    return true;
  }

  /** Cache the whole blocks of `n` bytes read at `offset` that cannot change while cached. */
  private fill(file: ProxiedFile, bytes: Uint8Array, offset: number, n: number): void {
    const cache = this.cache;
    if (cache === null || offset % BLOCK !== 0) return;
    const limit = file === FILE_WAL ? Math.min(offset + n, this.walCommitted()) : offset + n;
    for (let at = offset; at + BLOCK <= limit; at += BLOCK) cache.insert(file, at / BLOCK, bytes.subarray(at - offset, at - offset + BLOCK));
  }

  add(channel: SharedArrayBuffer): void {
    this.channels.push({ ctl: new Int32Array(channel, 0, 6), num: new Float64Array(channel, 24, 1), data: new Uint8Array(channel, DATA_OFFSET) });
  }

  /** Answer every waiting request. Cheap when none waits. */
  service(): void {
    for (const ch of this.channels) {
      if (Atomics.load(ch.ctl, 0) !== REQUEST) continue;
      try {
        const file = this.files.file(ch.ctl[2] === FILE_WAL ? `${this.dbPath}-wal` : this.dbPath);
        if (file === undefined) throw new Error('not open');
        if (ch.ctl[1] === OP_SIZE) {
          ch.num[0] = file.size();
          ch.ctl[4] = 0;
        } else {
          const len = Math.min(ch.ctl[3], ch.data.length);
          const which = ch.ctl[2] === FILE_WAL ? FILE_WAL : FILE_DB;
          if (this.fromCache(which, ch.num[0], len, ch.data)) ch.ctl[4] = len;
          else {
            // Read into private memory, then copy: not every browser reads into shared memory.
            if (this.scratch.length < len) this.scratch = new Uint8Array(len);
            const n = file.read(this.scratch.subarray(0, len), ch.num[0]);
            ch.data.set(this.scratch.subarray(0, n));
            this.fill(which, this.scratch, ch.num[0], n);
            ch.ctl[4] = n;
          }
        }
      } catch (e) {
        const msg = new TextEncoder().encode(e instanceof Error ? e.message : String(e)).subarray(0, ch.data.length);
        ch.data.set(msg);
        ch.ctl[3] = msg.length;
        ch.ctl[4] = ERROR;
      }
      this.answered++;
      Atomics.store(ch.ctl, 0, DONE);
      Atomics.notify(ch.ctl, 0);
    }
  }
}
