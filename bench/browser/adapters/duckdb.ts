import { ANALYTIC_DDL, type Adapter, analyticValues, valueFor, valuesSql } from '../adapter.js';
import { JOIN_TABLES } from '../../shared/joins.js';

/** DuckDB-WASM (EH build) with an OPFS-backed database file. */
export class DuckdbAdapter implements Adapter {
  readonly name = 'DuckDB-WASM';
  readonly atomicCommits = true;
  config = 'eh build, OPFS database file, prepared statements, 1000-row INSERT batches; reopen unsupported (cold rows are warm)';
  private db: any;
  private conn: any;
  private worker!: Worker;

  private async openDb(): Promise<void> {
    // Bundled (its ESM build imports apache-arrow by bare specifier); worker and wasm load from /nm/.
    const duckdb = await import('@duckdb/duckdb-wasm');
    this.worker = new Worker('/nm/@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js');
    this.db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), this.worker);
    await this.db.instantiate(new URL('/nm/@duckdb/duckdb-wasm/dist/duckdb-eh.wasm', location.href).href);
    await this.db.open({ path: 'opfs://duckdb-bench.db', accessMode: duckdb.DuckDBAccessMode.READ_WRITE });
    this.conn = await this.db.connect();
  }

  async open(): Promise<void> {
    await this.openDb();
    await this.conn.query('DROP TABLE IF EXISTS t');
    await this.conn.query('DROP TABLE IF EXISTS a');
    await this.conn.query('CREATE TABLE t(k INTEGER PRIMARY KEY, v VARCHAR)');
  }

  /**
   * Not supported: with duckdb-wasm's OPFS mode, tables written in this session were gone after
   * terminate + re-open (even after CHECKPOINT). Its "cold" rows are therefore warm-cache numbers.
   */
  async reopen(): Promise<void> {}

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
    for (let i = 0; i < keys.length; i++) if ((await st.query(keys[i])).numRows > 0) found++;
    await st.close();
    return found;
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

  async loadAnalytic(n: number): Promise<void> {
    await this.conn.query(ANALYTIC_DDL.replace('c REAL', 'c DOUBLE'));
    await this.conn.query('BEGIN TRANSACTION');
    for (let from = 1; from <= n; from += 1000) await this.conn.query(`INSERT INTO a VALUES ${analyticValues(from, Math.min(n, from + 999))}`);
    await this.conn.query('COMMIT');
    await this.conn.query('CHECKPOINT');
  }

  async loadRows(ddl: string, table: string, n: number, row: (i: number) => (number | string)[], indexes: string[] = []): Promise<void> {
    await this.conn.query(`DROP TABLE IF EXISTS ${table}`);
    await this.conn.query(ddl.replace(/ REAL\b/g, ' DOUBLE'));
    for (const ix of indexes) await this.conn.query(ix);
    await this.conn.query('BEGIN TRANSACTION');
    for (let from = 1; from <= n; from += 1000) await this.conn.query(`INSERT INTO ${table} VALUES ${valuesSql(from, Math.min(n, from + 999), row)}`);
    await this.conn.query('COMMIT');
    await this.conn.query('CHECKPOINT');
  }

  async lookups(sql: string, keys: (number | string)[]): Promise<number> {
    // DuckDB numbers parameters by position: repeat the key for each occurrence.
    const n = (sql.match(/\?1?/g) ?? []).length;
    const st = await this.conn.prepare(sql.replace(/\?1/g, '?'));
    let sum = 0;
    for (const k of keys) {
      const r = await st.query(...new Array(n).fill(k));
      const v = r.numRows ? r.getChildAt(0).get(0) : null;
      if (v !== null && v !== undefined) sum += Number(String(v).replace(/"/g, ''));
    }
    await st.close();
    return sum;
  }

  async exec(sql: string): Promise<void> {
    await this.conn.query(sql);
  }

  async query(sql: string): Promise<unknown[][]> {
    const r = await this.conn.query(sql);
    const names = r.schema.fields.map((f: { name: string }) => f.name);
    const out: unknown[][] = [];
    // HUGEINT results (e.g. sum of INTEGER) arrive as Arrow objects that stringify with quotes.
    const plain = (v: unknown): unknown => (v !== null && typeof v === 'object' && !(v instanceof Uint8Array) ? Number(String(v).replace(/"/g, '')) : v);
    for (let i = 0; i < r.numRows; i++) out.push(names.map((n: string) => plain(r.getChild(n).get(i))));
    return out;
  }

  async close(): Promise<void> {
    await this.conn.query('DROP TABLE t');
    await this.conn.query('DROP TABLE IF EXISTS a');
    for (const t of [...JOIN_TABLES, 'ix']) await this.conn.query(`DROP TABLE IF EXISTS ${t}`);
    await this.conn.close();
    await this.db.terminate();
    this.worker.terminate();
  }
}
