import { type Adapter, importUrl, valueFor } from '../adapter.js';

/** Official SQLite WASM build with the opfs-sahpool VFS (its fastest OPFS option; no COOP/COEP needed). */
export class SqliteAdapter implements Adapter {
  readonly name: string;
  readonly config: string;
  private db: any;
  private pool: any;
  private version = '';

  constructor(private readonly journalMode: 'DELETE' | 'TRUNCATE' | 'PERSIST' = 'TRUNCATE') {
    this.name = 'SQLite WASM';
    this.config = `opfs-sahpool VFS, locking_mode=EXCLUSIVE, journal_mode=${journalMode}, synchronous=FULL, 64 MiB cache, prepared statements`;
  }

  async open(): Promise<void> {
    const mod = await importUrl('/nm/@sqlite.org/sqlite-wasm/dist/index.mjs');
    const sqlite3 = await mod.default({ print: () => {}, printErr: () => {} });
    this.version = sqlite3.version.libVersion;
    this.pool = await sqlite3.installOpfsSAHPoolVfs({ name: 'bench-sahpool', directory: '/sqlite-bench', clearOnInit: true });
    this.db = new this.pool.OpfsSAHPoolDb('/bench.db');
    this.db.exec(`PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=${this.journalMode}; PRAGMA synchronous=FULL; PRAGMA cache_size=-65536;`);
    this.db.exec('CREATE TABLE t(k INTEGER PRIMARY KEY, v TEXT)');
  }

  get libVersion(): string {
    return this.version;
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

  async scanCount(): Promise<number> {
    return this.db.selectValue('SELECT count(*) FROM t');
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

  async close(): Promise<void> {
    this.db.close();
    await this.pool.wipeFiles();
  }
}
