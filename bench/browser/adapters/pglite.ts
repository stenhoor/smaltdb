import { ANALYTIC_DDL, type Adapter, analyticValues, importUrl, valueFor, valuesSql } from '../adapter.js';
import { JOIN_TABLES } from '../../shared/joins.js';

/** PGlite (Postgres compiled to WASM), OPFS access-handle-pool storage. */
export class PgliteAdapter implements Adapter {
  readonly name = 'PGlite';
  readonly atomicCommits = true;
  config = 'opfs-ahp storage, parameterized queries, lookups in one read-only txn, 1000-row INSERT batches';
  private db: any;
  private PGlite: any;

  async open(): Promise<void> {
    this.PGlite = (await importUrl('/nm/@electric-sql/pglite/dist/index.js')).PGlite;
    this.db = await this.PGlite.create('opfs-ahp://pglite-bench');
    await this.db.exec('DROP TABLE IF EXISTS t; DROP TABLE IF EXISTS a; CREATE TABLE t(k INTEGER PRIMARY KEY, v TEXT)');
  }

  async reopen(): Promise<void> {
    await this.db.close();
    this.db = await this.PGlite.create('opfs-ahp://pglite-bench');
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
    let found = 0;
    await this.db.exec('BEGIN READ ONLY');
    for (let i = 0; i < keys.length; i++) {
      const r = await this.db.query('SELECT v FROM t WHERE k = $1', [keys[i]]);
      if (r.rows.length) found++;
    }
    await this.db.exec('COMMIT');
    return found;
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

  async loadAnalytic(n: number): Promise<void> {
    await this.db.exec(ANALYTIC_DDL.replace('c REAL', 'c DOUBLE PRECISION'));
    await this.db.exec('BEGIN');
    for (let from = 1; from <= n; from += 1000) await this.db.exec(`INSERT INTO a VALUES ${analyticValues(from, Math.min(n, from + 999))}`);
    await this.db.exec('COMMIT');
  }

  async loadRows(ddl: string, table: string, n: number, row: (i: number) => (number | string)[]): Promise<void> {
    await this.db.exec(`DROP TABLE IF EXISTS ${table}; ${ddl.replace(/ REAL\b/g, ' DOUBLE PRECISION')}`);
    await this.db.exec('BEGIN');
    for (let from = 1; from <= n; from += 1000) await this.db.exec(`INSERT INTO ${table} VALUES ${valuesSql(from, Math.min(n, from + 999), row)}`);
    await this.db.exec('COMMIT');
  }

  async exec(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async query(sql: string): Promise<unknown[][]> {
    // Postgres integer division/avg types differ from SQLite; cast to match SQLite's results.
    const pg = sql.replace('avg(c)', 'avg(c)::float8').replace('avg(c * 1.1)', 'avg(c * 1.1)::float8').replace('sum(b * 2 + d)', 'sum(b * 2 + d)::int8');
    const r = await this.db.query(pg, [], { rowMode: 'array' });
    return r.rows;
  }

  async close(): Promise<void> {
    await this.db.exec(['DROP TABLE t; DROP TABLE IF EXISTS a', ...JOIN_TABLES.map((t) => `DROP TABLE IF EXISTS ${t}`)].join('; '));
    await this.db.close();
  }
}
