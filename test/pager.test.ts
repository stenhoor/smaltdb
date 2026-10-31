import { describe, expect, it } from 'vitest';
import { CorruptionError } from '../src/engine/errors.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import { Pager } from '../src/engine/storage/pager.js';
import { openMemoryPager } from './helpers.js';

describe('Pager', () => {
  it('initializes a new database and reopens it', () => {
    const { pager, reopen } = openMemoryPager({ pageSize: 4096 });
    expect(pager.pageSize).toBe(4096);
    expect(pager.usableSize).toBe(4092);
    expect(pager.pageCount).toBe(1);
    pager.catalogRoot = 7;
    pager.commit();
    pager.close();
    const p2 = reopen();
    expect(p2.pageSize).toBe(4096);
    expect(p2.catalogRoot).toBe(7);
    expect(p2.changeCounter).toBe(2);
  });

  it('rejects files that are not smaltdb databases', async () => {
    const vfs = new MemoryVfs();
    const f = await vfs.open('x');
    f.write(new TextEncoder().encode('SQLite format 3\0'.padEnd(200, 'x')), 0);
    expect(() => Pager.open(f)).toThrow(/not a smaltdb database/);
  });

  it('persists committed pages and discards rolled-back ones', () => {
    const { pager, reopen } = openMemoryPager({ pageSize: 1024 });
    const a = pager.allocate();
    a.bytes[100] = 42;
    const pa = a.pgno;
    pager.release(a);
    pager.commit();

    const b = pager.get(pa);
    pager.markDirty(b);
    b.bytes[100] = 99;
    pager.release(b);
    const c = pager.allocate();
    pager.release(c);
    expect(pager.pageCount).toBe(3);
    pager.rollback();
    expect(pager.pageCount).toBe(2);
    const b2 = pager.get(pa);
    expect(b2.bytes[100]).toBe(42);
    pager.release(b2);
    pager.close();

    const p2 = reopen();
    const b3 = p2.get(pa);
    expect(b3.bytes[100]).toBe(42);
    p2.release(b3);
  });

  it('reuses freed pages through the freelist (including trunk overflow)', () => {
    const { pager, reopen } = openMemoryPager({ pageSize: 512 });
    const pages: number[] = [];
    for (let i = 0; i < 400; i++) {
      const f = pager.allocate();
      pages.push(f.pgno);
      pager.release(f);
    }
    pager.commit();
    expect(pager.pageCount).toBe(401);
    for (const p of pages) pager.free(p);
    expect(pager.freelistCount).toBe(400);
    pager.commit();
    pager.close();

    const p2 = reopen();
    expect(p2.freelistCount).toBe(400);
    const seen = new Set<number>();
    for (let i = 0; i < 400; i++) {
      const f = p2.allocate();
      seen.add(f.pgno);
      p2.release(f);
    }
    expect(seen.size).toBe(400);
    expect(p2.pageCount).toBe(401); // no growth: everything came from the freelist
    expect(p2.freelistCount).toBe(0);
  });

  it('evicts clean pages under a small cache and grows only when everything is dirty', () => {
    const { pager } = openMemoryPager({ pageSize: 512, cacheSizeBytes: 16 * 512 });
    const pgnos: number[] = [];
    for (let i = 0; i < 100; i++) {
      const f = pager.allocate();
      f.bytes[50] = i;
      pgnos.push(f.pgno);
      pager.release(f);
    }
    expect(pager.stats.overflowFrames).toBeGreaterThan(0); // 100 dirty pages > 16 frames
    pager.commit();
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 100; i++) {
        const f = pager.get(pgnos[i]);
        expect(f.bytes[50]).toBe(i);
        pager.release(f);
      }
    }
    expect(pager.stats.evictions).toBeGreaterThan(0);
    expect(pager.pinnedCount()).toBe(0);
  });

  it('detects page corruption via checksums', async () => {
    const vfs = new MemoryVfs();
    const { pager } = openMemoryPager({ pageSize: 1024 }, vfs);
    const f = pager.allocate();
    f.bytes[200] = 1;
    const pg = f.pgno;
    pager.release(f);
    pager.commit();
    pager.close();
    const raw = vfs.openSync('test.db');
    raw.write(new Uint8Array([0xee]), pg * 1024 + 300);
    const p2 = Pager.open(raw);
    expect(() => p2.get(pg)).toThrow(CorruptionError);
  });

  it('flushes on commit only when syncOnCommit is set', () => {
    const vfs = new MemoryVfs();
    const { pager } = openMemoryPager({ syncOnCommit: false }, vfs);
    const before = vfs.stats.flushes;
    const f = pager.allocate();
    pager.release(f);
    pager.commit();
    expect(vfs.stats.flushes).toBe(before);
  });
});

describe('Pager read-ahead', () => {
  it('prefetches neighbouring pages and still verifies them on first use', () => {
    const vfs = new MemoryVfs();
    const { pager } = openMemoryPager({ pageSize: 1024 }, vfs);
    const pages: number[] = [];
    for (let i = 0; i < 64; i++) {
      const f = pager.allocate();
      f.bytes[10] = i;
      pages.push(f.pgno);
      pager.release(f);
    }
    pager.commit();
    pager.close();
    // Corrupt one page that will be prefetched as a neighbour of page 9.
    const raw = vfs.openSync('test.db');
    raw.write(new Uint8Array([0x99]), 12 * 1024 + 500);
    const p2 = Pager.open(raw, { readAheadBytes: 16 * 1024 });
    const a = p2.get(9);
    expect(a.bytes[10]).toBe(8);
    p2.release(a);
    expect(p2.stats.prefetched).toBeGreaterThan(0);
    const readsBefore = p2.stats.reads;
    const b = p2.get(10); // served from the prefetched extent
    expect(b.bytes[10]).toBe(9);
    p2.release(b);
    expect(p2.stats.reads).toBe(readsBefore);
    expect(() => p2.get(12)).toThrow(CorruptionError);
    expect(p2.pinnedCount()).toBe(0);
  });
});
