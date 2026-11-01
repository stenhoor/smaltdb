import { ANALYTIC_DDL, type Adapter, analyticRow, importUrl, valueFor } from '../adapter.js';

export type SqliteJournal = 'TRUNCATE' | 'WAL' | 'OFF';

/**
 * Official SQLite WASM build with the opfs-sahpool VFS (its fastest OPFS option; no COOP/COEP needed),
 * exclusive locking (sahpool is single-connection anyway), synchronous=FULL, prepared statements.
 */
export class SqliteAdapter implements Adapter {
  readonly name: string;
  readonly config: string;
  readonly atomicCommits: boolean;
  private db: any;
  private pool: any;
  private version = '';

  constructor(private readonly journal: SqliteJournal) {
    this.name = `SQLite WASM (journal ${journal})`;
    this.atomicCommits = journal !== 'OFF';
    this.config = `opfs-sahpool VFS, locking_mode=EXCLUSIVE, journal_mode=${journal}, synchronous=FULL, 64 MiB cache, prepared statements`;
  }

  get libVersion(): string {
    return this.version;
  }

  private openDb(): void {
    this.db = new this.pool.OpfsSAHPoolDb('/bench.db');
    this.db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=${this.journal}; PRAGMA synchronous=FULL; PRAGMA cache_size=-65536;`);
    const mode = String(this.db.selectValue('PRAGMA journal_mode')).toUpperCase();
    if (mode !== this.journal) throw new Error(`SQLite refused journal_mode=${this.journal} (got ${mode})`);
  }

  async open(): Promise<void> {
    const mod = await importUrl('/nm/@sqlite.org/sqlite-wasm/dist/index.mjs');
    const sqlite3 = await mod.default({ print: () => {}, printErr: () => {} });
    this.version = sqlite3.version.libVersion;
    this.pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'bench-sahpool', directory: '/sqlite-bench', clearOnInit: true });
    this.openDb();
    this.db.exec('CREATE TABLE t(k INTEGER PRIMARY KEY, v TEXT)');
  }

  async reopen(): Promise<void> {
    this.db.close();
    this.openDb();
  }

  async bulkInsert(n: number): Promise<void> {
    const st = this.db.prepare('INSERT INTO t(k, v) VALUES (?, ?)');
    this.db.exec('BEGIN');
    for (let k = 0; k < n; k++) st.bind([k, valueFor(k)]).stepReset();
    this.db.exec('COMMIT');
    st.finalize();
  }

  async pointLookups(keys: Int32Array): Promise<number> {
    const st = this.db.prepare('SELECT v FROM t WHERE k = ?');
    let found = 0;
    for (let i = 0; i < keys.length; i++) {
      st.bind([keys[i]]);
      if (st.step()) {
        st.get(0);
        found++;
      }
      st.reset();
    }
    st.finalize();
    return found;
  }

  async scanValues(): Promise<number> {
    const st = this.db.prepare('SELECT v FROM t');
    let total = 0;
    while (st.step()) total += (st.get(0) as string).length;
    st.finalize();
    return total;
  }

  async smallTxns(start: number, count: number): Promise<void> {
    const st = this.db.prepare('INSERT INTO t(k, v) VALUES (?, ?)');
    for (let i = 0; i < count; i++) st.bind([start + i, valueFor(start + i)]).stepReset(); // autocommit
    st.finalize();
  }

  async loadAnalytic(n: number): Promise<void> {
    this.db.exec(ANALYTIC_DDL);
    const st = this.db.prepare('INSERT INTO a VALUES (?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    for (let i = 1; i <= n; i++) st.bind(analyticRow(i)).stepReset();
    this.db.exec('COMMIT');
    st.finalize();
  }

  async loadRows(ddl: string, table: string, n: number, row: (i: number) => (number | string)[]): Promise<void> {
    this.db.exec(ddl);
    const st = this.db.prepare(`INSERT INTO ${table} VALUES (${row(1).map(() => '?').join(', ')})`);
    this.db.exec('BEGIN');
    for (let i = 1; i <= n; i++) st.bind(row(i)).stepReset();
    this.db.exec('COMMIT');
    st.finalize();
  }

  async exec(sql: string): Promise<void> {
    this.db.exec(sql);
  }

  async query(sql: string): Promise<unknown[][]> {
    return this.db.selectArrays(sql);
  }

  async close(): Promise<void> {
    this.db.close();
    await this.pool.wipeFiles();
  }
}
