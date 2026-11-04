/**
 * A file-system VFS for the Node benchmark harness only (smaltdb ships OPFS and memory VFSs): synchronous reads and
 * writes on an open file descriptor, and fsync on flush (as durable as SQLite's synchronous=FULL).
 */
import { closeSync, existsSync, fstatSync, fsyncSync, ftruncateSync, mkdirSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { OpenOptions, Vfs, VfsFile } from '../../src/engine/vfs/types.js';

class NodeFile implements VfsFile {
  constructor(
    readonly path: string,
    private fd: number,
  ) {}

  read(dst: Uint8Array, offset: number): number {
    let done = 0;
    while (done < dst.length) {
      const n = readSync(this.fd, dst, done, dst.length - done, offset + done);
      if (n === 0) break;
      done += n;
    }
    return done;
  }

  write(src: Uint8Array, offset: number): number {
    let done = 0;
    while (done < src.length) done += writeSync(this.fd, src, done, src.length - done, offset + done);
    return done;
  }

  size(): number {
    return fstatSync(this.fd).size;
  }

  truncate(size: number): void {
    ftruncateSync(this.fd, size);
  }

  flush(): void {
    fsyncSync(this.fd);
  }

  close(): void {
    if (this.fd >= 0) closeSync(this.fd);
    this.fd = -1;
  }
}

export class NodeFileVfs implements Vfs {
  readonly name = 'node-fs';

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async open(path: string, options: OpenOptions = {}): Promise<VfsFile> {
    const full = join(this.dir, path);
    if (options.create === false && !existsSync(full)) throw new Error(`no such file: ${path}`);
    return new NodeFile(path, openSync(full, existsSync(full) ? 'r+' : 'w+'));
  }

  async delete(path: string): Promise<void> {
    rmSync(join(this.dir, path), { force: true });
  }

  async exists(path: string): Promise<boolean> {
    return existsSync(join(this.dir, path));
  }
}
