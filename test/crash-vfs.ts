import type { OpenOptions, Vfs, VfsFile } from '../src/engine/vfs/types.js';

type Op = { file: string; kind: 'write'; offset: number; data: Uint8Array } | { file: string; kind: 'truncate'; size: number } | { file: string; kind: 'flush' };

class Store {
  data = new Uint8Array(0);
  len = 0;
  write(src: Uint8Array, off: number): void {
    const end = off + src.length;
    if (end > this.data.length) {
      const next = new Uint8Array(Math.max(end, this.data.length * 2, 4096));
      next.set(this.data.subarray(0, this.len));
      this.data = next;
    }
    this.data.set(src, off);
    if (end > this.len) this.len = end;
  }
  truncate(n: number): void {
    if (n > this.len) this.write(new Uint8Array(n - this.len), this.len);
    this.len = n;
  }
}

/**
 * A VFS that records every write, truncate and flush (across all files, in order) so tests can
 * rebuild what storage would contain if the process died at any point.
 */
export class CrashVfs implements Vfs {
  readonly name = 'crash';
  readonly log: Op[] = [];
  private readonly live = new Map<string, Store>();

  async open(path: string, options: OpenOptions = {}): Promise<VfsFile> {
    return this.openSync(path, options);
  }

  openSync(path: string, _options: OpenOptions = {}): VfsFile {
    let st = this.live.get(path);
    if (!st) {
      st = new Store();
      this.live.set(path, st);
    }
    const store = st;
    const log = this.log;
    return {
      path,
      read(dst, offset) {
        const n = Math.max(0, Math.min(dst.length, store.len - offset));
        if (n > 0) dst.set(store.data.subarray(offset, offset + n));
        return n;
      },
      write(src, offset) {
        log.push({ file: path, kind: 'write', offset, data: src.slice() });
        store.write(src, offset);
        return src.length;
      },
      size: () => store.len,
      truncate(size) {
        log.push({ file: path, kind: 'truncate', size });
        store.truncate(size);
      },
      flush() {
        log.push({ file: path, kind: 'flush' });
      },
      close() {},
    };
  }

  async delete(path: string): Promise<void> {
    this.live.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.live.has(path);
  }

  /**
   * File contents if the process crashed just before op `k`.
   *  - 'prefix': every op before k reached storage.
   *  - 'torn': like prefix, plus op k (if a write) only half-written.
   *  - 'lost-unflushed': ops on a file after its last flush (before k) are lost.
   */
  imageAt(k: number, mode: 'prefix' | 'torn' | 'lost-unflushed'): Map<string, Uint8Array> {
    const stores = new Map<string, Store>();
    const get = (f: string): Store => {
      let s = stores.get(f);
      if (!s) stores.set(f, (s = new Store()));
      return s;
    };
    let limit: Map<string, number> | null = null;
    if (mode === 'lost-unflushed') {
      limit = new Map();
      for (let i = 0; i < k; i++) if (this.log[i].kind === 'flush') limit.set(this.log[i].file, i);
    }
    for (let i = 0; i < k; i++) {
      const op = this.log[i];
      if (limit && i >= (limit.get(op.file) ?? -1)) continue;
      const s = get(op.file);
      if (op.kind === 'write') s.write(op.data, op.offset);
      else if (op.kind === 'truncate') s.truncate(op.size);
    }
    if (mode === 'torn' && k < this.log.length) {
      const op = this.log[k];
      if (op.kind === 'write' && op.data.length > 1) {
        const half = Math.max(1, Math.floor(op.data.length / 2 / 512) * 512 || Math.floor(op.data.length / 2));
        get(op.file).write(op.data.subarray(0, half), op.offset);
      }
    }
    const out = new Map<string, Uint8Array>();
    for (const [f, s] of stores) out.set(f, s.data.slice(0, s.len));
    for (const f of this.live.keys()) if (!out.has(f)) out.set(f, new Uint8Array(0));
    return out;
  }
}
