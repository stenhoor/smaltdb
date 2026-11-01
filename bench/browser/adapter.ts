/**
 * Common workload interface for engine comparisons. All engines store the same tables:
 *   t(k INTEGER PRIMARY KEY, v TEXT)                         OLTP-style, v is a 32-character string
 *   a(id INTEGER PRIMARY KEY, b INT, c REAL, d INT, e TEXT)   analytical
 * Every engine runs in its own dedicated worker and persists to OPFS.
 */
export interface Adapter {
  readonly name: string;
  /** Human-readable configuration (VFS, journal mode, durability) reported with results. */
  readonly config: string;
  /** Whether a commit survives a crash atomically (fairness: compare like with like). */
  readonly atomicCommits: boolean;
  open(): Promise<void>;
  /** Close and reopen the same database files, so later reads start with a cold engine cache. */
  reopen(): Promise<void>;
  /** Insert rows k = 0..n-1 into t in a single transaction and commit durably. */
  bulkInsert(n: number): Promise<void>;
  /** Look up each key in t; return how many were found. */
  pointLookups(keys: Int32Array): Promise<number>;
  /** Full scan of t reading every value; return the total value length. */
  scanValues(): Promise<number>;
  /** `count` single-row insert transactions into t (keys start..start+count-1), each committed durably. */
  smallTxns(start: number, count: number): Promise<void>;
  /** Load the analytical table `a` with n rows (see analyticRow) in one transaction. */
  loadAnalytic(n: number): Promise<void>;
  /** Create a table (`ddl`), then `indexes` (if any), and load rows row(1..n) into it in one transaction. */
  loadRows(ddl: string, table: string, n: number, row: (i: number) => (number | string)[], indexes?: string[]): Promise<void>;
  /**
   * Run a one-parameter query (`?`, may appear as `?1` several times) once per key with a prepared
   * statement; each run returns one row. Returns the sum of the first column (a checksum).
   */
  lookups(sql: string, keys: (number | string)[]): Promise<number>;
  /** Execute a statement without results (e.g. CREATE INDEX). */
  exec(sql: string): Promise<void>;
  /** Run a read-only query and return its rows as value arrays. */
  query(sql: string): Promise<unknown[][]>;
  close(): Promise<void>;
}

export function valueFor(k: number): string {
  return ('value-' + k).padEnd(32, '.');
}

/** Deterministic analytical row i (1-based): [id, b, c, d, e]. */
export function analyticRow(i: number): [number, number, number, number, string] {
  return [i, i % 1000, ((i * 7919) % 1000) + 0.5, i % 100, 'x' + (i % 50)];
}

export const ANALYTIC_DDL = 'CREATE TABLE a(id INTEGER PRIMARY KEY, b INT, c REAL, d INT, e TEXT)';

/** Analytical queries (results are compared across engines). */
export const ANALYTIC_QUERIES: Record<string, string> = {
  'filter + sum': 'SELECT sum(b) FROM a WHERE c > 500',
  'group by (100 groups)': 'SELECT d, count(*), avg(c), max(b) FROM a GROUP BY d',
  'arith filter + aggregate': 'SELECT sum(b * 2 + d), avg(c * 1.1) FROM a WHERE b % 7 = 3 AND c < 900',
};

/** Multi-row VALUES batches for engines without a fast prepared-insert path. */
export function analyticValues(from: number, to: number): string {
  const rows: string[] = [];
  for (let i = from; i <= to; i++) {
    const [id, b, c, d, e] = analyticRow(i);
    rows.push(`(${id},${b},${c},${d},'${e}')`);
  }
  return rows.join(',');
}

/** Multi-row VALUES list for rows from..to of a row generator (strings quoted). */
export function valuesSql(from: number, to: number, row: (i: number) => (number | string)[]): string {
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`(${row(i).map((v) => (typeof v === 'string' ? `'${v.replace(/'/g, "''")}'` : String(v))).join(',')})`);
  return out.join(',');
}

/** Dynamic import that bundlers leave alone (competitor libraries are served from /nm/). */
export const importUrl = (url: string): Promise<any> => import(/* @vite-ignore */ url);
