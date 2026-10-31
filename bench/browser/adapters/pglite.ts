import { type Adapter, importUrl, valueFor } from '../adapter.js';

/** PGlite (Postgres compiled to WASM), OPFS access-handle-pool storage. */
export class PgliteAdapter implements Adapter {
  readonly name = 'PGlite';
  config = 'opfs-ahp storage, parameterized queries, lookups in one read-only txn, multi-row INSERT batches of 1000 for bulk load';
  private db: any;

  async open(): Promise<void> {
    const { PGlite } = await importUrl('/nm/@electric-sql/pglite/dist/index.js');
    try {
      this.db = await PGlite.create('opfs-ahp://pglite-bench');
    } catch (e) {
      this.config = `memory storage (opfs-ahp failed: ${(e as Error).message})`;
      this.db = await PGlite.create();
    }
    await this.db.exec('DROP TABLE IF EXISTS t; CREATE TABLE t(k INTEGER PRIMARY KEY, v TEXT)');
  }

  async bulkInsert(n: number): Promise<void> {
    await this.db.exec('BEGIN');
    for (let start = 0; start < n; start += 1000) {
      const rows: string[] = [];
      for (let k = start; k < Math.min(n, start + 1000); k++) rows.push(`(${k},'${valueFor(k)}')`);
      await this.db.exec(`INSERT INTO t(k, v) VALUES ${rows.join(',')}`);
    }
    await this.db.exec('COMMIT');
  }

  async pointLookups(keys: Int32Array): Promise<number> {
    // One read-only transaction around the batch (autocommit adds ~0.7 ms per query with opfs-ahp).
    let found = 0;
    await this.db.exec('BEGIN READ ONLY');
    for (let i = 0; i < keys.length; i++) {
      const r = await this.db.query('SELECT v FROM t WHERE k = $1', [keys[i]]);
      if (r.rows.length) found++;
    }
    await this.db.exec('COMMIT');
    return found;
  }

  async scanCount(): Promise<number> {
    const r = await this.db.query('SELECT count(*)::int AS n FROM t');
    return r.rows[0].n;
  }

  async scanValues(): Promise<number> {
    const r = await this.db.query('SELECT v FROM t', [], { rowMode: 'array' });
    let total = 0;
    for (const row of r.rows) total += row[0].length;
    return total;
  }

  async smallTxns(start: number, count: number): Promise<void> {
    for (let i = 0; i < count; i++) await this.db.query('INSERT INTO t(k, v) VALUES ($1, $2)', [start + i, valueFor(start + i)]);
  }

  async close(): Promise<void> {
    await this.db.exec('DROP TABLE t');
    await this.db.close();
  }
}
