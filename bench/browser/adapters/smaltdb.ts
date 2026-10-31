import { Database, type Statement } from '../../../src/engine/database.js';
import { OpfsVfs } from '../../../src/engine/vfs/opfs.js';
import { type Adapter, valueFor } from '../adapter.js';

/**
 * smaltdb through its SQL layer (parser, planner, executor), hosted in the benchmark worker and
 * called synchronously, exactly like the SQLite adapter. Prepared statements throughout.
 */
export class SmaltdbAdapter implements Adapter {
  readonly name = 'smaltdb (M1, SQL)';
  readonly config = 'OPFS sync handle, 8 KiB pages, 64 MiB cache, synchronous=full (flush per commit), prepared statements, no WAL yet';
  private vfs = new OpfsVfs({ rootDir: 'smaltdb-bench' });
  private db!: Database;
  private insert!: Statement;

  async open(): Promise<void> {
    await this.vfs.delete('bench.db');
    this.db = await Database.open(this.vfs, 'bench.db', { pageSize: 8192, cacheSizeBytes: 64 * 1024 * 1024 });
    this.db.exec('CREATE TABLE t(k INTEGER PRIMARY KEY, v TEXT)');
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

  async scanCount(): Promise<number> {
    return this.db.query('SELECT count(*) FROM t').rows[0][0] as number;
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

  async close(): Promise<void> {
    this.db.close();
    await this.vfs.delete('bench.db');
  }
}
