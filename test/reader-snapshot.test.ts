import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

/** A writer and a snapshot reader sharing the same files (as parallel reader workers do). */
async function setup() {
  const vfs = new MemoryVfs();
  const w = await Database.open(vfs, 'db', { sharedHandles: true, walAutoCheckpointBytes: 1 << 30 });
  w.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v INT, s TEXT)');
  w.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 3000) INSERT INTO t SELECT i, i, hex(i) FROM n");
  const r = await Database.openReader(vfs, 'db');
  return { vfs, w, r };
}

const sum = (db: Database): unknown => db.query('SELECT count(*), sum(v) FROM t').rows[0];

describe('reader snapshots', () => {
  it('see commits only after refreshSnapshot', async () => {
    const { w, r } = await setup();
    expect(sum(r)).toEqual([3000, 4501500]);
    w.exec('UPDATE t SET v = v + 1 WHERE id <= 100');
    expect(sum(r)).toEqual([3000, 4501500]);
    r.refreshSnapshot();
    expect(sum(r)).toEqual([3000, 4501600]);
  });

  it('keep an open cursor on its snapshot while the writer commits', async () => {
    const { w, r } = await setup();
    const c = r.prepare('SELECT v FROM t ORDER BY id').cursor();
    const first = c.next();
    w.exec('UPDATE t SET v = -1');
    w.exec('DELETE FROM t WHERE id > 1500');
    let n = 1;
    let total = first![0] as number;
    for (let row = c.next(); row !== null; row = c.next()) {
      n++;
      total += row[0] as number;
    }
    expect([n, total]).toEqual([3000, 4501500]);
    r.refreshSnapshot();
    expect(sum(r)).toEqual([1500, -1500]);
  });

  it('pick up schema changes', async () => {
    const { w, r } = await setup();
    w.exec('CREATE TABLE u(x); INSERT INTO u VALUES (42); CREATE INDEX t_v ON t(v)');
    expect(() => r.query('SELECT x FROM u')).toThrow(/no such table/);
    r.refreshSnapshot();
    expect(r.query('SELECT x FROM u').rows).toEqual([[42]]);
    expect(r.query('SELECT count(*) FROM t WHERE v BETWEEN 10 AND 19').rows).toEqual([[10]]);
  });

  it('survive checkpoints (a new log generation drops the cache)', async () => {
    const { w, r } = await setup();
    w.exec('UPDATE t SET v = 0 WHERE id <= 1000');
    r.refreshSnapshot();
    expect(sum(r)).toEqual([3000, 4501500 - 500500]);
    w.checkpoint();
    w.exec('UPDATE t SET v = 7 WHERE id <= 10');
    r.refreshSnapshot();
    expect(sum(r)).toEqual([3000, 4501500 - 500500 + 70]);
    expect(r.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('a checkpoint gate holds checkpoints back', async () => {
    const { w } = await setup();
    let readers = 1;
    w.setCheckpointGate(() => readers === 0);
    w.exec('UPDATE t SET v = v + 1');
    const pager = (w as unknown as { pager: { walSize: number } }).pager;
    const before = pager.walSize;
    w.checkpoint();
    expect(pager.walSize).toBe(before);
    readers = 0;
    w.checkpoint();
    expect(pager.walSize).toBe(0);
  });

  it('cannot write', async () => {
    const { r } = await setup();
    expect(() => r.exec('INSERT INTO t VALUES (99999, 1, 1)')).toThrow(/read-only/);
    expect(sum(r)).toEqual([3000, 4501500]);
  });
});
