import { type Adapter, valueFor } from '../adapter.js';

/** DuckDB-WASM (EH build) with an OPFS-backed database file. */
export class DuckdbAdapter implements Adapter {
  readonly name = 'DuckDB-WASM';
  config = 'eh build, OPFS database file, prepared statements, multi-row INSERT batches of 1000 for bulk load';
  private db: any;
  private conn: any;
  private worker!: Worker;

  async open(): Promise<void> {
    // Bundled (its ESM build imports apache-arrow by bare specifier); worker and wasm load from /nm/.
    const duckdb = await import('@duckdb/duckdb-wasm');
    this.worker = new Worker('/nm/@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js');
    this.db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), this.worker);
    await this.db.instantiate(new URL('/nm/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm', location.href).href);
    try {
      await this.db.open({ path: 'opfs://duckdb-bench.db', accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
    } catch (e) {
      this.config = `in-memory (OPFS open failed: ${(e as Error).message})`;
    }
    this.conn = await this.db.connect();
    await this.conn.query('DROP TABLE IF EXISTS t');
    await this.conn.query('CREATE TABLE t(k INTEGER PRIMARY KEY, v VARCHAR)');
  }

  async bulkInsert(n: number): Promise<void> {
    await this.conn.query('BEGIN TRANSACTION');
    for (let start = 0; start < n; start += 1000) {
      const rows: string[] = [];
      for (let k = start; k < Math.min(n, start + 1000); k++) rows.push(`(${k},'${valueFor(k)}')`);
      await this.conn.query(`INSERT INTO t VALUES ${rows.join(',')}`);
    }
    await this.conn.query('COMMIT');
    await this.conn.query('CHECKPOINT');
  }

  async pointLookups(keys: Int32Array): Promise<number> {
    const st = await this.conn.prepare('SELECT v FROM t WHERE k = ?');
    let found = 0;
    for (let i = 0; i < keys.length; i++) {
      const r = await st.query(keys[i]);
      if (r.numRows > 0) found++;
    }
    await st.close();
    return found;
  }

  async scanCount(): Promise<number> {
    const r = await this.conn.query('SELECT count(*)::INTEGER AS n FROM t');
    return r.getChild('n').get(0);
  }

  async scanValues(): Promise<number> {
    const r = await this.conn.query('SELECT v FROM t');
    const col = r.getChild('v');
    let total = 0;
    for (let i = 0; i < r.numRows; i++) total += col.get(i).length;
    return total;
  }

  async smallTxns(start: number, count: number): Promise<void> {
    const st = await this.conn.prepare('INSERT INTO t VALUES (?, ?)');
    for (let i = 0; i < count; i++) await st.query(start + i, valueFor(start + i));
    await st.close();
  }

  async close(): Promise<void> {
    await this.conn.query('DROP TABLE t');
    await this.conn.close();
    await this.db.terminate();
    this.worker.terminate();
  }
}
