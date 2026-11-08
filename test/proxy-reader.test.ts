/**
 * Readers that read the owner's files through it (ADR 0021 step 1, vfs/proxy.ts). In the browser a reader waits
 * with Atomics.wait while the owner answers from another worker; here the owner answers in the same thread, when the
 * reader wakes it, which exercises the same channel.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import { OwnedVfs, ProxyServer, ProxyVfs, createChannel } from '../src/engine/vfs/proxy.js';
import { BLOCK, SharedCache } from '../src/engine/vfs/shared-cache.js';

/** An owner and a reader of its files over a channel with `dataBytes` of data area, and a shared cache if `cached`. */
async function setup(dataBytes?: number, cached = false) {
  const files = new OwnedVfs(new MemoryVfs());
  const w = await Database.open(files, 'db', { walAutoCheckpointBytes: 1 << 30 });
  w.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v INT, s TEXT)');
  w.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) INSERT INTO t SELECT i, i, hex(i) FROM n");
  const cache = cached ? SharedCache.create(4 * 1024 * 1024) : undefined;
  const server = new ProxyServer(files, 'db', cache);
  server.walCommitted = () => w.walCommittedBytes();
  const channel = createChannel(dataBytes);
  server.add(channel);
  const local = new MemoryVfs();
  const reader = async (spillPath: string) => Database.openReader(new ProxyVfs(channel, 'db', () => server.service(), local, cache ?? null), 'db', { spillPath });
  const r = await reader('db-spill-r1');
  return { files, w, r, server, local, reader };
}

const sum = (db: Database): unknown => db.query('SELECT count(*), sum(v) FROM t').rows[0];

// The default data area, one smaller than a page (every read is split into several round trips), and with the shared
// block cache (step 2).
for (const [dataBytes, cached] of [[undefined, false], [1000, false], [undefined, true]] as const) {
  describe(`proxied readers (data area ${dataBytes ?? 'default'}${cached ? ', shared cache' : ''})`, () => {
    it('read the snapshot, and see commits after refreshSnapshot', async () => {
      const { w, r, server } = await setup(dataBytes, cached);
      expect(sum(r)).toEqual([3000, 4501500]);
      expect(server.answered).toBeGreaterThan(0);
      w.exec('UPDATE t SET v = v + 1 WHERE id <= 100');
      expect(sum(r)).toEqual([3000, 4501500]);
      r.refreshSnapshot();
      expect(sum(r)).toEqual([3000, 4501600]);
    });

    it('keep an open cursor on its snapshot while the owner commits', async () => {
      const { w, r } = await setup(dataBytes, cached);
      const c = r.prepare('SELECT v FROM t ORDER BY id').cursor();
      let total = c.next()![0] as number;
      w.exec('UPDATE t SET v = -1');
      w.exec('DELETE FROM t WHERE id > 1500');
      let n = 1;
      for (let row = c.next(); row !== null; row = c.next()) {
        n++;
        total += row[0] as number;
      }
      expect([n, total]).toEqual([3000, 4501500]);
      r.refreshSnapshot();
      expect(sum(r)).toEqual([1500, -1500]);
    });

    it('pick up schema changes and survive checkpoints', async () => {
      const { w, r } = await setup(dataBytes, cached);
      w.exec('CREATE TABLE u(x); INSERT INTO u VALUES (42); CREATE INDEX t_v ON t(v)');
      r.refreshSnapshot();
      expect(r.query('SELECT x FROM u').rows).toEqual([[42]]);
      expect(r.query('SELECT count(*) FROM t WHERE v BETWEEN 10 AND 19').rows).toEqual([[10]]);
      w.exec('UPDATE t SET v = 0 WHERE id <= 1000');
      w.checkpoint();
      w.exec('UPDATE t SET v = 7 WHERE id <= 10');
      r.refreshSnapshot();
      expect(sum(r)).toEqual([3000, 4501500 - 500500 + 70]);
      expect(r.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
    });

    it('cannot write', async () => {
      const { r } = await setup(dataBytes, cached);
      expect(() => r.exec('INSERT INTO t VALUES (99999, 1, 1)')).toThrow(/read-only/);
      expect(sum(r)).toEqual([3000, 4501500]);
    });
  });
}

describe('proxied reader files', () => {
  it('spill to a file of their own', async () => {
    const { w, r, local } = await setup();
    r.exec('PRAGMA work_mem = 64');
    const sql = 'SELECT s, v FROM t ORDER BY s DESC';
    expect(r.query(sql).rows).toEqual(w.query(sql).rows);
    expect(await local.exists('db-spill-r1')).toBe(true);
  });

  it('report the owner’s read errors', async () => {
    const files = new OwnedVfs(new MemoryVfs());
    const server = new ProxyServer(files, 'db');
    const channel = createChannel();
    server.add(channel);
    const vfs = new ProxyVfs(channel, 'db', () => server.service(), new MemoryVfs());
    const f = await vfs.open('db');
    expect(() => f.size()).toThrow(/SMALT_IOERR|reader: db: not open/);
    // The channel is free again afterwards.
    await files.open('db');
    expect(f.size()).toBe(0);
  });

  it('refuse a request while another is in progress', async () => {
    const files = new OwnedVfs(new MemoryVfs());
    await files.open('db');
    const channel = createChannel();
    // An owner that never answers: the reader would wait, so the wake-up throws instead, leaving REQUEST set.
    const vfs = new ProxyVfs(channel, 'db', () => {
      throw new Error('no owner');
    }, new MemoryVfs());
    const f = await vfs.open('db');
    expect(() => f.size()).toThrow('no owner');
    expect(() => f.size()).toThrow(/already in progress/);
  });
});

describe('the shared block cache', () => {
  it('serves a second reader from the blocks the first one read', async () => {
    const { w, r, server, reader } = await setup(undefined, true);
    // Enough data for many whole blocks of the log (a part block at its end is never cached).
    w.exec("WITH RECURSIVE n(i) AS (SELECT 3001 UNION ALL SELECT i + 1 FROM n WHERE i < 60000) INSERT INTO t SELECT i, 0, hex(i) FROM n");
    r.refreshSnapshot();
    expect(sum(r)).toEqual([60000, 4501500]);
    const asked = server.answered;
    const r2 = await reader('db-spill-r2');
    expect(sum(r2)).toEqual([60000, 4501500]);
    // Only what is not cached: the files' sizes (three) and the log's last part block (once: the reader keeps it).
    expect(server.answered - asked).toBeLessThanOrEqual(4);
    expect(server.cache!.stats.inserts).toBeGreaterThan(0);
  });

  it('caches the owner’s own reads of the database file', async () => {
    const files = new OwnedVfs(new MemoryVfs());
    const w = await Database.open(files, 'db', { cacheSizeBytes: 64 * 1024 });
    w.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, s TEXT)');
    w.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 30000) INSERT INTO t SELECT i, hex(i) FROM n");
    w.checkpoint(); // the data moves to the database file
    const server = new ProxyServer(files, 'db', SharedCache.create(4 * 1024 * 1024));
    // The owner's cache is too small to hold the table: a scan reads the file, and whole blocks go to the shared cache.
    w.query('SELECT count(*), max(s) FROM t');
    expect(server.cache!.stats.inserts).toBeGreaterThan(0);
  });

  it('stays correct across commits and checkpoints', async () => {
    const { w, r } = await setup(undefined, true);
    for (let round = 0; round < 5; round++) {
      w.exec(`UPDATE t SET v = v + 1 WHERE id % 5 = ${round}`);
      if (round % 2 === 1) w.checkpoint();
      r.refreshSnapshot();
      expect(r.query('SELECT sum(v) FROM t').rows).toEqual(w.query('SELECT sum(v) FROM t').rows);
    }
    expect(r.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('forgets every block when the generation moves on', () => {
    const sab = SharedCache.create(BLOCK * 16);
    const owner = new SharedCache(sab);
    const reader = new SharedCache(sab);
    const block = new Uint8Array(BLOCK).fill(7);
    owner.insert(0, 3, block);
    const out = new Uint8Array(10);
    expect(reader.read(0, 3, 100, 10, out, 0)).toBe(true);
    expect([...out]).toEqual(new Array(10).fill(7));
    expect(reader.read(1, 3, 0, 10, out, 0)).toBe(false); // another file
    owner.bump();
    expect(reader.read(0, 3, 100, 10, out, 0)).toBe(false);
  });

  it('replaces blocks within a set, keeping the most recently used', () => {
    const sab = SharedCache.create(BLOCK * 8); // one set of 8 ways
    const c = new SharedCache(sab);
    const out = new Uint8Array(1);
    for (let b = 0; b < 8; b++) c.insert(0, b, new Uint8Array(BLOCK).fill(b));
    for (let b = 0; b < 8; b++) expect(c.read(0, b, 0, 1, out, 0) && out[0] === b).toBe(true);
    c.read(0, 5, 0, 1, out, 0);
    c.insert(0, 100, new Uint8Array(BLOCK).fill(100));
    expect(c.read(0, 100, 0, 1, out, 0) && out[0] === 100).toBe(true);
    let cached = 0;
    for (let b = 0; b < 8; b++) if (c.read(0, b, 0, 1, out, 0)) cached++;
    expect(cached).toBe(7);
  });
});
