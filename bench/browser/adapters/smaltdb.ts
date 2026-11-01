import { Database, type Statement } from '../../../src/engine/database.js';
import { OpfsVfs } from '../../../src/engine/vfs/opfs.js';
import { ANALYTIC_DDL, type Adapter, analyticRow, valueFor } from '../adapter.js';

/** smaltdb through its SQL layer, hosted in the benchmark worker and called synchronously (like SQLite). */
export class SmaltdbAdapter implements Adapter {
  readonly name = 'smaltdb';
  readonly config = 'OPFS sync handles, WAL (auto-checkpoint 4 MiB), 8 KiB pages, 64 MiB cache, flush per commit, prepared statements';
  readonly atomicCommits = true;
  private vfs = new OpfsVfs({ rootDir: 'smaltdb-bench' });
  private db!: Database;
  private insert!: Statement;
  private readonly opts = { pageSize: 8192, cacheSizeBytes: 64 * 1024 * 1024 };

  async open(): Promise<void> {
    await this.vfs.delete('bench.db');
    await this.vfs.delete('bench.db-wal');
    this.db = await Database.open(this.vfs, 'bench.db', this.opts);
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

  async loadRows(ddl: string, table: string, n: number, row: (i: number) => (number | string)[]): Promise<void> {
    this.db.exec(ddl);
    const st = this.db.prepare(`INSERT INTO ${table} VALUES (${row(1).map(() => '?').join(', ')})`);
    this.db.exec('BEGIN');
    for (let i = 1; i <= n; i++) st.run(row(i));
    this.db.exec('COMMIT');
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async query(sql: string): Promise<unknown[][]> {
    return this.db.query(sql).rows;
  }

  async close(): Promise<void> {
    this.db.close();
    await this.vfs.delete('bench.db');
    await this.vfs.delete('bench.db-wal');
  }
}
