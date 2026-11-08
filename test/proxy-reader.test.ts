/**
 * Readers that read the owner's files through it (ADR 0021 step 1, vfs/proxy.ts). In the browser a reader waits
 * with Atomics.wait while the owner answers from another worker; here the owner answers in the same thread, when the
 * reader wakes it, which exercises the same channel.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import { OwnedVfs, ProxyServer, ProxyVfs, createChannel } from '../src/engine/vfs/proxy.js';

/** An owner and a reader of its files over a channel with `dataBytes` of data area. */
async function setup(dataBytes?: number) {
  const files = new OwnedVfs(new MemoryVfs());
  const w = await Database.open(files, 'db', { walAutoCheckpointBytes: 1 << 30 });
  w.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v INT, s TEXT)');
  w.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) INSERT INTO t SELECT i, i, hex(i) FROM n");
  const server = new ProxyServer(files, 'db');
  const channel = createChannel(dataBytes);
  server.add(channel);
  const local = new MemoryVfs();
  const r = await Database.openReader(new ProxyVfs(channel, 'db', () => server.service(), local), 'db', { spillPath: 'db-spill-r1' });
  return { files, w, r, server, local };
}

const sum = (db: Database): unknown => db.query('SELECT count(*), sum(v) FROM t').rows[0];

// The default data area, and one smaller than a page, so every read is split into several round trips.
for (const dataBytes of [undefined, 1000]) {
  describe(`proxied readers (data area ${dataBytes ?? 'default'})`, () => {
    it('read the snapshot, and see commits after refreshSnapshot', async () => {
      const { w, r, server } = await setup(dataBytes);
      expect(sum(r)).toEqual([3000, 4501500]);
      expect(server.answered).toBeGreaterThan(0);
      w.exec('UPDATE t SET v = v + 1 WHERE id <= 100');
      expect(sum(r)).toEqual([3000, 4501500]);
      r.refreshSnapshot();
      expect(sum(r)).toEqual([3000, 4501600]);
    });

    it('keep an open cursor on its snapshot while the owner commits', async () => {
      const { w, r } = await setup(dataBytes);
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
      const { w, r } = await setup(dataBytes);
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
      const { r } = await setup(dataBytes);
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
