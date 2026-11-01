import { SmaltError } from '../errors.js';
import type { OpenOptions, Vfs, VfsFile } from './types.js';

/**
 * Minimal structural types for the OPFS sync access handle, so we don't depend on lib.dom
 * versions. Baseline: Chrome 108, Firefox 111, Safari 17 (all methods synchronous).
 */
interface SyncAccessHandle {
  read(buffer: Uint8Array, options?: { at?: number }): number;
  write(buffer: Uint8Array, options?: { at?: number }): number;
  getSize(): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}

interface FileHandleWithSync {
  createSyncAccessHandle(options?: { mode?: string }): Promise<SyncAccessHandle>;
}

class OpfsFile implements VfsFile {
  constructor(
    readonly path: string,
    private readonly handle: SyncAccessHandle,
  ) {}

  read(dst: Uint8Array, offset: number): number {
    return this.handle.read(dst, { at: offset });
  }

  write(src: Uint8Array, offset: number): number {
    return this.handle.write(src, { at: offset });
  }

  size(): number {
    return this.handle.getSize();
  }

  truncate(size: number): void {
    this.handle.truncate(size);
  }

  flush(): void {
    this.handle.flush();
  }

  close(): void {
    this.handle.close();
  }
}

export interface OpfsVfsOptions {
  /** Directory (inside the OPFS root) that holds all smaltdb files. Default `smaltdb`. */
  rootDir?: string;
}

/**
 * OPFS-backed VFS. Must run inside a dedicated worker (sync access handles are not available
 * on the main thread, in shared workers, or in service workers).
 */
export class OpfsVfs implements Vfs {
  readonly name = 'opfs';
  private readonly rootDir: string;

  constructor(options: OpfsVfsOptions = {}) {
    this.rootDir = options.rootDir ?? 'smaltdb';
  }

  static isSupported(): boolean {
    const g = globalThis as { FileSystemFileHandle?: { prototype: object }; navigator?: { storage?: { getDirectory?: unknown } } };
    return (
      typeof g.navigator?.storage?.getDirectory === 'function' &&
      g.FileSystemFileHandle !== undefined &&
      'createSyncAccessHandle' in g.FileSystemFileHandle.prototype
    );
  }

  async open(path: string, options: OpenOptions = {}): Promise<VfsFile> {
    const create = options.create !== false;
    const { dir, name } = await this.resolve(path, create);
    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await dir.getFileHandle(name, { create });
    } catch (e) {
      throw new SmaltError('SMALT_CANTOPEN', `cannot open ${path}: ${(e as Error).message}`);
    }
    let handle: SyncAccessHandle;
    try {
      handle = await (fileHandle as unknown as FileHandleWithSync).createSyncAccessHandle(options.shared ? { mode: 'readwrite-unsafe' } : undefined);
    } catch (e) {
      // NoModificationAllowedError: another worker/tab holds the exclusive handle.
      throw new SmaltError('SMALT_BUSY', `cannot lock ${path}: ${(e as Error).message}`);
    }
    return new OpfsFile(path, handle);
  }

  async delete(path: string): Promise<void> {
    try {
      const { dir, name } = await this.resolve(path, false);
      await dir.removeEntry(name);
    } catch (e) {
      if ((e as DOMException).name !== 'NotFoundError') throw e;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      const { dir, name } = await this.resolve(path, false);
      await dir.getFileHandle(name);
      return true;
    } catch {
      return false;
    }
  }

  private async resolve(path: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    const parts = [this.rootDir, ...path.split('/')].filter((p) => p.length > 0);
    const name = parts.pop();
    if (!name) throw new SmaltError('SMALT_MISUSE', `invalid path: ${path}`);
    let dir = await navigator.storage.getDirectory();
    for (const part of parts) dir = await dir.getDirectoryHandle(part, { create });
    return { dir, name };
  }
}
