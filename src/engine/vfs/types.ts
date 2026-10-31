/**
 * Virtual file system abstraction.
 *
 * Opening a file is asynchronous (OPFS requires it), but every operation on an open file is
 * **synchronous**: the pager never awaits on the hot path. This matches OPFS
 * `FileSystemSyncAccessHandle`, which is only available in dedicated workers.
 */
export interface VfsFile {
  readonly path: string;
  /** Read into `dst` starting at byte `offset`. Returns bytes read (short read at EOF). */
  read(dst: Uint8Array, offset: number): number;
  /** Write `src` at byte `offset`, extending the file if needed. Returns bytes written. */
  write(src: Uint8Array, offset: number): number;
  size(): number;
  truncate(size: number): void;
  /** Durably persist previous writes. */
  flush(): void;
  close(): void;
}

export interface OpenOptions {
  /** Create the file if it does not exist (default true). */
  create?: boolean;
}

export interface Vfs {
  readonly name: string;
  open(path: string, options?: OpenOptions): Promise<VfsFile>;
  delete(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}
