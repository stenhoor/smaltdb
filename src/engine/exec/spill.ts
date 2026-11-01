/**
 * Spilling (M7.2, ADR 0010): sorts and hash aggregates that outgrow `work_mem` write
 * intermediate rows to a scratch file (`<db>-spill`, OPFS in browsers) instead of holding them in
 * the JS heap.
 *
 * The scratch file is one append-only area per database handle, shared by every spilling operator
 * of the running statement(s). Operators write rows in blocks of whole rows and remember where the
 * blocks went (a {@link Run}); the area is truncated back to empty when the last operator using it
 * closes. Nothing in it outlives a statement, so it needs no journal, no checksums and no recovery.
 *
 * Row format: values back to back, each a tag byte and its payload (no row header: the reader
 * knows the column count).
 */
import type { VfsFile } from '../vfs/types.js';
import { decodeUtf8 } from '../storage/record.js';
import type { SqlValue } from '../values.js';

/** Default work memory per spilling operator (bytes of estimated heap use). */
export const DEFAULT_WORK_MEM = 256 * 1024 * 1024;

const BLOCK = 64 * 1024;

const T_NULL = 0;
const T_INT32 = 1;
const T_F64 = 2;
const T_BIG = 3;
const T_TEXT = 4;
const T_BLOB = 5;

/** Approximate JS heap bytes held by a value (for spill decisions, not accounting). */
export function valueBytes(v: SqlValue): number {
  if (v === null || typeof v === 'number') return 8;
  if (typeof v === 'string') return 24 + 2 * v.length;
  if (typeof v === 'bigint') return 24;
  return 64 + v.byteLength;
}

/** Approximate heap bytes of a row array of `n` values. */
export function rowBytes(row: readonly SqlValue[], n = row.length): number {
  let b = 32 + 8 * n;
  for (let i = 0; i < n; i++) {
    const v = row[i];
    if (v !== null && typeof v !== 'number') b += valueBytes(v);
  }
  return b;
}

/** Spill blocks written by one writer, in order. */
export interface Run {
  readonly blocks: { off: number; len: number }[];
  readonly rows: number;
}

/** The scratch area of one database handle. */
export class SpillArea {
  /** Estimated heap bytes an operator may hold before it spills (0 = never spill). */
  workMem: number;
  /** Called between block reads and writes (cancellation, like page fetches). */
  interrupt: (() => void) | null = null;
  private end = 0;
  private users = 0;
  /** Bytes written since the database was opened (statistics, tests). */
  bytesWritten = 0;

  constructor(
    private readonly file: VfsFile | null,
    workMem = DEFAULT_WORK_MEM,
    /** Called once the file is closed (frees its name for other handles). */
    private readonly onClose: (() => void) | null = null,
  ) {
    this.workMem = workMem;
    file?.truncate(0);
  }

  /** Whether operators may spill (there is a scratch file and a limit). */
  get enabled(): boolean {
    return this.file !== null && this.workMem > 0;
  }

  /** An operator starts using the area (pair with {@link release}). */
  acquire(): void {
    this.users++;
  }

  /** An operator is done with everything it wrote: with no users left the file is emptied. */
  release(): void {
    if (this.users > 0 && --this.users === 0 && this.end > 0) {
      this.end = 0;
      this.file!.truncate(0);
    }
  }

  append(src: Uint8Array, len: number): number {
    this.interrupt?.();
    const off = this.end;
    this.file!.write(len === src.length ? src : src.subarray(0, len), off);
    this.end += len;
    this.bytesWritten += len;
    return off;
  }

  read(dst: Uint8Array, off: number): void {
    this.interrupt?.();
    const n = this.file!.read(dst, off);
    if (n !== dst.length) throw new Error(`spill file: short read (${n} of ${dst.length} at ${off})`);
  }

  close(): void {
    this.file?.truncate(0);
    this.file?.close();
    this.onClose?.();
  }
}

/** Scratch file names in use, per VFS: two handles in one process must not share (and truncate) one. */
const spillNamesInUse = new WeakMap<object, Set<string>>();

/**
 * Open a scratch file for a database handle: `base`, or `base-2`, `base-3`, … when another handle of
 * this process (or, with OPFS, another worker holding an exclusive handle) has it. Null when none
 * can be opened: the handle then never spills.
 */
export async function openSpillFile(vfs: { open(path: string): Promise<VfsFile> }, base: string): Promise<{ file: VfsFile; release: () => void } | null> {
  let names = spillNamesInUse.get(vfs);
  if (!names) spillNamesInUse.set(vfs, (names = new Set()));
  for (let n = 1; n <= 8; n++) {
    const path = n === 1 ? base : `${base}-${n}`;
    if (names.has(path)) continue;
    try {
      const file = await vfs.open(path);
      if (names.has(path)) {
        file.close(); // taken while we were opening it
        continue;
      }
      names.add(path);
      return { file, release: () => names.delete(path) };
    } catch {
      // locked by someone else: try the next name
    }
  }
  return null;
}

const textEncoder = new TextEncoder();

/** Writes rows to a run in the area. */
export class RunWriter {
  private buf = new Uint8Array(BLOCK + 1024);
  private view = new DataView(this.buf.buffer);
  private pos = 0;
  private rows = 0;
  private readonly blocks: { off: number; len: number }[] = [];

  constructor(private readonly area: SpillArea) {}

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(next.buffer);
  }

  private varint(n: number): void {
    while (n >= 0x80) {
      this.buf[this.pos++] = (n & 0x7f) | 0x80;
      n = Math.floor(n / 128);
    }
    this.buf[this.pos++] = n;
  }

  /** Append `values[0..n)`. */
  add(values: readonly SqlValue[], n = values.length): void {
    for (let i = 0; i < n; i++) {
      const v = values[i];
      if (v === null) {
        this.ensure(1);
        this.buf[this.pos++] = T_NULL;
      } else if (typeof v === 'number') {
        this.ensure(9);
        if ((v | 0) === v && !Object.is(v, -0)) {
          this.buf[this.pos++] = T_INT32;
          this.view.setInt32(this.pos, v, true);
          this.pos += 4;
        } else {
          this.buf[this.pos++] = T_F64;
          this.view.setFloat64(this.pos, v, true);
          this.pos += 8;
        }
      } else if (typeof v === 'string') {
        this.ensure(6 + v.length * 3);
        this.buf[this.pos++] = T_TEXT;
        // Length prefix after encoding: reserve 5 bytes when the string could need them.
        const start = this.pos;
        const ascii = v.length < 128;
        const at = start + (ascii ? 1 : 5);
        const { written } = textEncoder.encodeInto(v, this.buf.subarray(at));
        if (ascii && written < 128) this.buf[start] = written;
        else {
          if (ascii) this.buf.copyWithin(start + 5, at, at + written);
          let w = written;
          for (let k = 0; k < 4; k++) {
            this.buf[start + k] = (w & 0x7f) | 0x80;
            w = Math.floor(w / 128);
          }
          this.buf[start + 4] = w;
        }
        this.pos = start + (ascii && written < 128 ? 1 : 5) + written;
      } else if (typeof v === 'bigint') {
        this.ensure(9);
        this.buf[this.pos++] = T_BIG;
        this.view.setBigInt64(this.pos, v, true);
        this.pos += 8;
      } else {
        this.ensure(6 + v.byteLength);
        this.buf[this.pos++] = T_BLOB;
        this.varint(v.byteLength);
        this.buf.set(v, this.pos);
        this.pos += v.byteLength;
      }
    }
    this.rows++;
    if (this.pos >= BLOCK) this.flush();
  }

  private flush(): void {
    if (this.pos === 0) return;
    this.blocks.push({ off: this.area.append(this.buf, this.pos), len: this.pos });
    this.pos = 0;
  }

  finish(): Run {
    this.flush();
    return { blocks: this.blocks, rows: this.rows };
  }
}

/** Reads a run's rows back, block by block. */
export class RunReader {
  private buf = new Uint8Array(0);
  private view = new DataView(this.buf.buffer);
  private pos = 0;
  private len = 0;
  private block = 0;

  constructor(
    private readonly area: SpillArea,
    private readonly run: Run,
  ) {}

  /** Read the next row into `out[0..n)`; false at the end of the run. */
  next(out: SqlValue[], n: number): boolean {
    if (this.pos >= this.len) {
      if (this.block >= this.run.blocks.length) return false;
      const b = this.run.blocks[this.block++];
      if (this.buf.length < b.len) {
        this.buf = new Uint8Array(Math.max(b.len, BLOCK + 1024));
        this.view = new DataView(this.buf.buffer);
      }
      this.area.read(this.buf.subarray(0, b.len), b.off);
      this.pos = 0;
      this.len = b.len;
    }
    const buf = this.buf;
    for (let i = 0; i < n; i++) {
      const tag = buf[this.pos++];
      switch (tag) {
        case T_NULL:
          out[i] = null;
          break;
        case T_INT32:
          out[i] = this.view.getInt32(this.pos, true);
          this.pos += 4;
          break;
        case T_F64:
          out[i] = this.view.getFloat64(this.pos, true);
          this.pos += 8;
          break;
        case T_BIG:
          out[i] = this.view.getBigInt64(this.pos, true);
          this.pos += 8;
          break;
        default: {
          let len = 0;
          let mul = 1;
          for (;;) {
            const c = buf[this.pos++];
            len += (c & 0x7f) * mul;
            if (c < 0x80) break;
            mul *= 128;
          }
          out[i] = tag === T_TEXT ? decodeUtf8(buf, this.pos, this.pos + len) : buf.slice(this.pos, this.pos + len);
          this.pos += len;
        }
      }
    }
    return true;
  }
}

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

/** A 32-bit hash of a GROUP BY hash key (see convert.ts hashKey), salted per partitioning level. */
export function partitionHash(k: unknown, level: number): number {
  let h = (0x811c9dc5 ^ Math.imul(level + 1, 0x9e3779b1)) >>> 0;
  if (typeof k === 'string') {
    for (let i = 0; i < k.length; i++) h = Math.imul(h ^ k.charCodeAt(i), 0x01000193);
  } else if (typeof k === 'number') {
    f64[0] = Object.is(k, -0) ? 0 : k;
    h = Math.imul(h ^ u32[0], 0x01000193);
    h = Math.imul(h ^ u32[1], 0x01000193);
  } else if (typeof k === 'bigint') {
    const s = k.toString();
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  }
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  return h >>> 0;
}

/** Thrown by a fused GROUP BY loop whose groups outgrow work_mem: the operator starts over spilling. */
export const SpillRestart = new Error('spill restart');
