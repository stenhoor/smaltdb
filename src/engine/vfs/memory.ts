import { SmaltError } from '../errors.js';
import type { OpenOptions, Vfs, VfsFile } from './types.js';

/** Backing store for one in-memory file. Survives close/reopen within the same MemoryVfs. */
class MemoryBlob {
  data = new Uint8Array(0);
  length = 0;

  ensureCapacity(n: number): void {
    if (n <= this.data.length) return;
    let cap = Math.max(4096, this.data.length);
    while (cap < n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.data.subarray(0, this.length));
    this.data = next;
  }
}

class MemoryFile implements VfsFile {
  private closed = false;
  constructor(
    readonly path: string,
    private readonly blob: MemoryBlob,
    private readonly vfs: MemoryVfs,
  ) {}

  read(dst: Uint8Array, offset: number): number {
    this.check();
    const n = Math.max(0, Math.min(dst.length, this.blob.length - offset));
    if (n > 0) dst.set(this.blob.data.subarray(offset, offset + n));
    return n;
  }

  write(src: Uint8Array, offset: number): number {
    this.check();
    const end = offset + src.length;
    this.blob.ensureCapacity(end);
    this.blob.data.set(src, offset);
    if (end > this.blob.length) this.blob.length = end;
    this.vfs.stats.writes++;
    return src.length;
  }

  size(): number {
    this.check();
    return this.blob.length;
  }

  truncate(size: number): void {
    this.check();
    if (size > this.blob.length) {
      this.blob.ensureCapacity(size);
      this.blob.data.fill(0, this.blob.length, size);
    }
    this.blob.length = size;
  }

  flush(): void {
    this.check();
    this.vfs.stats.flushes++;
  }

  close(): void {
    this.closed = true;
  }

  private check(): void {
    if (this.closed) throw new SmaltError('SMALT_MISUSE', `file ${this.path} is closed`);
  }
}

/** In-memory VFS for tests, Node, and `storage: 'memory'` databases. */
export class MemoryVfs implements Vfs {
  readonly name = 'memory';
  readonly stats = { writes: 0, flushes: 0 };
  private readonly files = new Map<string, MemoryBlob>();

  async open(path: string, options: OpenOptions = {}): Promise<VfsFile> {
    return this.openSync(path, options);
  }

  openSync(path: string, options: OpenOptions = {}): VfsFile {
    let blob = this.files.get(path);
    if (!blob) {
      if (options.create === false) throw new SmaltError('SMALT_CANTOPEN', `no such file: ${path}`);
      blob = new MemoryBlob();
      this.files.set(path, blob);
    }
    return new MemoryFile(path, blob, this);
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }
}
