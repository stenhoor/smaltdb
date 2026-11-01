// A page that exposes the client API to the test harness, which drives several pages (tabs) of one
// browser context against the same database (multi-tab leader election and failover).
import { type Database, open } from '../../src/client/index.js';

let db: Database | null = null;
const api = {
  async open(name: string): Promise<boolean> {
    db = await open(name, { worker: new URL('./smaltdb-worker.js', location.href) });
    return db.isLeader;
  },
  isLeader: (): boolean => db!.isLeader,
  async exec(sql: string, params?: unknown[]): Promise<number> {
    return (await db!.exec(sql, params as never)).changes;
  },
  async query(sql: string): Promise<unknown[][]> {
    return [...(await db!.query(sql, undefined, { rowMode: 'array' }))];
  },
  /** Start a query and report when it settles (to observe waiting). */
  startQuery(sql: string): void {
    const w = window as unknown as { __pending?: { done: boolean; rows?: unknown; error?: string } };
    w.__pending = { done: false };
    db!.query(sql, undefined, { rowMode: 'array' }).then(
      (rows) => (w.__pending = { done: true, rows: [...rows] }),
      (e) => (w.__pending = { done: true, error: String(e?.code ?? e) }),
    );
  },
  async close(): Promise<void> {
    await db?.close();
    db = null;
  },
};
(window as unknown as { tab: typeof api }).tab = api;
(window as unknown as { tabReady: boolean }).tabReady = true;
