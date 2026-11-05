import { Database, type Statement } from '../../../src/engine/database.js';
import '../../../src/engine/sql/register.js';
import { OpfsVfs } from '../../../src/engine/vfs/opfs.js';
import type { Vfs } from '../../../src/engine/vfs/types.js';
import { ANALYTIC_DDL, type Adapter, analyticRow, valueFor } from '../adapter.js';

/** smaltdb through its SQL layer, hosted in the benchmark worker and called synchronously (like SQLite). */
export class SmaltdbAdapter implements Adapter {
  readonly name: string;
  readonly config: string;
  readonly atomicCommits = true;

  /**
   * `memory`: an in-memory database (no OPFS, no WAL, no checksums) for CPU-only comparisons. `vfs`: files on
   * another VFS than OPFS (the Node harness passes a file-system VFS), described by `storage`.
   */
  constructor(
    readonly memory = false,
    vfs?: Vfs,
    storage = 'OPFS sync handles',
  ) {
    this.name = memory ? 'smaltdb (:memory:)' : 'smaltdb';
    this.config = memory
      ? 'in-memory database (in-memory undo images, no WAL, no checksums), 8 KiB pages, prepared statements'
      : `${storage}, WAL (auto-checkpoint 4 MiB), 8 KiB pages, 64 MiB cache, flush per commit, prepared statements`;
    this.vfs = vfs ?? new OpfsVfs({ rootDir: 'smaltdb-bench' });
  }

  get persistent(): boolean {
    return !this.memory;
  }
  private readonly vfs: Vfs;
  private db!: Database;
  private insert!: Statement;
  private readonly opts = { pageSize: 8192, cacheSizeBytes: 64 * 1024 * 1024 };

  async open(): Promise<void> {
    if (this.memory) this.db = Database.openMemory(this.opts);
    else {
      await this.vfs.delete('bench.db');
      await this.vfs.delete('bench.db-wal');
      this.db = await Database.open(this.vfs, 'bench.db', this.opts);
    }
    this.db.exec('CREATE TABLE t(k INTEGER PRIMARY KEY, v TEXT)');
    this.insert = this.db.prepare('INSERT INTO t(k, v) VALUES (?, ?)');
  }

  async reopen(): Promise<void> {
    this.db.close();
    this.db = await Database.open(this.vfs, 'bench.db', this.opts);
    this.insert = this.db.prepare('INSERT INTO t(k, v) VALUES (?, ?)');
  }

  async bulkInsert(n: number): Promise<void> {
    this.db.exec('BEGIN');
    const params: [number, string] = [0, ''];
    for (let k = 0; k < n; k++) {
      params[0] = k;
      params[1] = valueFor(k);
      this.insert.run(params);
    }
    this.db.exec('COMMIT');
  }

  async pointLookups(keys: Int32Array): Promise<number> {
    const st = this.db.prepare('SELECT v FROM t WHERE k = ?');
    let found = 0;
    const p: [number] = [0];
    for (let i = 0; i < keys.length; i++) {
      p[0] = keys[i];
      const c = st.cursor(p);
      if (c.next() !== null) found++;
      c.close();
    }
    return found;
  }

  async scanValues(): Promise<number> {
    const c = this.db.prepare('SELECT v FROM t').cursor();
    let total = 0;
    for (let row = c.next(); row !== null; row = c.next()) total += (row[0] as string).length;
    return total;
  }

  async smallTxns(start: number, count: number): Promise<void> {
    for (let i = 0; i < count; i++) this.insert.run([start + i, valueFor(start + i)]);
  }

  async loadAnalytic(n: number): Promise<void> {
    this.db.exec(ANALYTIC_DDL);
    const st = this.db.prepare('INSERT INTO a VALUES (?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    for (let i = 1; i <= n; i++) st.run(analyticRow(i));
    this.db.exec('COMMIT');
  }

  async loadRows(ddl: string, table: string, n: number, row: (i: number) => (number | string)[], indexes: string[] = []): Promise<void> {
    this.db.exec(ddl);
    for (const ix of indexes) this.db.exec(ix);
    const st = this.db.prepare(`INSERT INTO ${table} VALUES (${row(1).map(() => '?').join(', ')})`);
    this.db.exec('BEGIN');
    for (let i = 1; i <= n; i++) st.run(row(i));
    this.db.exec('COMMIT');
  }

  async lookups(sql: string, keys: (number | string)[]): Promise<number> {
    const st = this.db.prepare(sql);
    const p: [number | string] = [0];
    let sum = 0;
    for (const k of keys) {
      p[0] = k;
      const c = st.cursor(p);
      const row = c.next();
      c.close();
      if (row && row[0] !== null) sum += Number(row[0]);
    }
    return sum;
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async query(sql: string): Promise<unknown[][]> {
    return this.db.query(sql).rows;
  }

  async projection(name: string, select: string): Promise<void> {
    this.db.exec(`CREATE MATERIALIZED VIEW ${name} WITH (storage = 'columnar') AS ${select}`);
  }

  async refreshProjection(name: string): Promise<void> {
    this.db.exec(`REFRESH MATERIALIZED VIEW ${name}`);
  }

  async close(): Promise<void> {
    this.db.close();
    if (this.memory) return;
    await this.vfs.delete('bench.db');
    await this.vfs.delete('bench.db-wal');
  }
}
