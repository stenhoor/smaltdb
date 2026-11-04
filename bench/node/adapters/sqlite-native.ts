import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
// node:sqlite is Node's built-in binding to the native SQLite library (no npm dependency).
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { ANALYTIC_DDL, type Adapter, analyticRow, valueFor } from '../../browser/adapter.js';

/** `MEMORY`: :memory:. `WAL-FULL`: WAL, fsync per commit (smaltdb's durability). `WAL-NORMAL`: WAL, fsync at checkpoints only. */
export type NativeMode = 'MEMORY' | 'WAL-FULL' | 'WAL-NORMAL';

/**
 * Native SQLite through node:sqlite, with the WASM adapter's settings: exclusive locking, 64 MiB cache, a
 * prepared statement per workload. The "most aggressive" comparison: compiled C, no WebAssembly, no browser.
 */
export class SqliteNativeAdapter implements Adapter {
  readonly name: string;
  readonly config: string;
  readonly atomicCommits = true;
  readonly persistent: boolean;
  private db!: DatabaseSync;
  private readonly file: string;

  constructor(
    private readonly mode: NativeMode,
    private readonly dir: string,
  ) {
    this.persistent = mode !== 'MEMORY';
    const sync = mode === 'WAL-FULL' ? 'FULL' : 'NORMAL';
    this.name = this.persistent ? `SQLite native (WAL, synchronous=${sync})` : 'SQLite native (:memory:)';
    this.config = this.persistent
      ? `node:sqlite, file on disk, locking_mode=EXCLUSIVE, journal_mode=WAL, synchronous=${sync}${sync === 'NORMAL' ? ' (last commits may be lost on power failure)' : ''}, 64 MiB cache, prepared statements`
      : 'node:sqlite, :memory: database, 64 MiB cache, prepared statements';
    this.file = join(dir, 'native.db');
  }

  /** The SQLite library version (read at open: the runner asks after close). */
  libVersion = '';

  private openDb(): void {
    if (!this.persistent) {
      this.db = new DatabaseSync(':memory:');
      this.db.exec('PRAGMA cache_size=-65536;');
      return;
    }
    this.db = new DatabaseSync(this.file);
    const sync = this.mode === 'WAL-FULL' ? 'FULL' : 'NORMAL';
    this.db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=${sync}; PRAGMA cache_size=-65536;`);
    const st = this.db.prepare('PRAGMA journal_mode');
    st.setReturnArrays(true);
    const mode = String((st.get() as unknown as unknown[])[0]).toUpperCase();
    if (mode !== 'WAL') throw new Error(`SQLite refused journal_mode=WAL (got ${mode})`);
  }

  private prep(sql: string): StatementSync {
    const st = this.db.prepare(sql);
    st.setReturnArrays(true);
    return st;
  }

  private wipe(): void {
    for (const f of ['native.db', 'native.db-wal', 'native.db-shm', 'native.db-journal']) rmSync(join(this.dir, f), { force: true });
  }

  async open(): Promise<void> {
    if (this.persistent) {
      mkdirSync(this.dir, { recursive: true });
      this.wipe();
    }
    this.openDb();
    this.libVersion = String((this.prep('SELECT sqlite_version()').get() as unknown as unknown[])[0]);
    this.db.exec('CREATE TABLE t(k INTEGER PRIMARY KEY, v TEXT)');
  }

  async reopen(): Promise<void> {
    this.db.close();
    this.openDb();
  }

  async bulkInsert(n: number): Promise<void> {
    const st = this.prep('INSERT INTO t(k, v) VALUES (?, ?)');
    this.db.exec('BEGIN');
    for (let k = 0; k < n; k++) st.run(k, valueFor(k));
    this.db.exec('COMMIT');
  }

  async pointLookups(keys: Int32Array): Promise<number> {
    const st = this.prep('SELECT v FROM t WHERE k = ?');
    let found = 0;
    for (let i = 0; i < keys.length; i++) if (st.get(keys[i]) !== undefined) found++;
    return found;
  }

  async scanValues(): Promise<number> {
    const st = this.prep('SELECT v FROM t');
    let total = 0;
    for (const row of st.iterate() as Iterable<unknown[]>) total += (row[0] as string).length;
    return total;
  }

  async smallTxns(start: number, count: number): Promise<void> {
    const st = this.prep('INSERT INTO t(k, v) VALUES (?, ?)');
    for (let i = 0; i < count; i++) st.run(start + i, valueFor(start + i)); // autocommit
  }

  async loadAnalytic(n: number): Promise<void> {
    this.db.exec(ANALYTIC_DDL);
    const st = this.prep('INSERT INTO a VALUES (?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    for (let i = 1; i <= n; i++) st.run(...analyticRow(i));
    this.db.exec('COMMIT');
  }

  async loadRows(ddl: string, table: string, n: number, row: (i: number) => (number | string)[], indexes: string[] = []): Promise<void> {
    this.db.exec(ddl);
    for (const ix of indexes) this.db.exec(ix);
    const st = this.prep(`INSERT INTO ${table} VALUES (${row(1).map(() => '?').join(', ')})`);
    this.db.exec('BEGIN');
    for (let i = 1; i <= n; i++) st.run(...row(i));
    this.db.exec('COMMIT');
  }

  async lookups(sql: string, keys: (number | string)[]): Promise<number> {
    const st = this.prep(sql);
    let sum = 0;
    for (const k of keys) {
      const r = st.get(k) as unknown as unknown[] | undefined;
      if (r && r[0] !== null) sum += Number(r[0]);
    }
    return sum;
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async query(sql: string): Promise<unknown[][]> {
    return this.prep(sql).all() as unknown as unknown[][];
  }

  async close(): Promise<void> {
    this.db.close();
    if (this.persistent) this.wipe();
  }
}
