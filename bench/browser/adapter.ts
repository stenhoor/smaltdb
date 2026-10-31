/**
 * Common workload interface for engine comparisons. All engines store the same table:
 *   t(k INTEGER PRIMARY KEY, v TEXT)  with v a 32-character string.
 * Every engine runs in its own dedicated worker and persists to OPFS where it supports it.
 */
export interface Adapter {
  readonly name: string;
  /** Human-readable configuration (VFS, journal mode, durability) reported with results. */
  readonly config: string;
  open(): Promise<void>;
  /** Insert rows k = 0..n-1 in a single transaction and commit durably. */
  bulkInsert(n: number): Promise<void>;
  /** Look up each key; return how many were found. */
  pointLookups(keys: Int32Array): Promise<number>;
  /** Full scan counting rows. */
  scanCount(): Promise<number>;
  /** Full scan reading every value; return the total value length. */
  scanValues(): Promise<number>;
  /** `count` single-row insert transactions (keys start..start+count-1), each committed durably. */
  smallTxns(start: number, count: number): Promise<void>;
  close(): Promise<void>;
}

export function valueFor(k: number): string {
  return ('value-' + k).padEnd(32, '.');
}

/** Dynamic import that bundlers leave alone (competitor libraries are served from /nm/). */
export const importUrl = (url: string): Promise<any> => import(/* @vite-ignore */ url);
