/**
 * ADR 0033 step 0, the file format's part: the header's required-feature bits (an engine refuses a file that needs
 * features it doesn't know) and the durable commit id and commit time that version history will use.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { SmaltError } from '../src/engine/errors.js';
import { crc32c } from '../src/engine/storage/crc32c.js';
import { DH_COMMIT_ID, DH_REQUIRED_FEATURES, KNOWN_FEATURES } from '../src/engine/storage/format.js';
import { Pager } from '../src/engine/storage/pager.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import { openMemoryPager } from './helpers.js';

/** Rewrite page 0 of a closed database file, with its checksum (the last 4 bytes of the page). */
function patchHeader(vfs: MemoryVfs, pageSize: number, patch: (v: DataView) => void): void {
  const raw = vfs.openSync('test.db');
  const page = new Uint8Array(pageSize);
  raw.read(page, 0);
  patch(new DataView(page.buffer));
  const off = pageSize - 4;
  new DataView(page.buffer).setUint32(off, crc32c(page, 0, off), true);
  raw.write(page, 0);
}

describe('commit id and commit time', () => {
  it('count every commit, survive a reopen, and keep counting', () => {
    const vfs = new MemoryVfs();
    const { pager } = openMemoryPager({ pageSize: 1024 }, vfs);
    const start = pager.commitId;
    expect(start).toBeGreaterThanOrEqual(1); // creating the database is a commit
    const before = Date.now();
    for (let i = 0; i < 3; i++) {
      pager.catalogRoot = i + 1;
      pager.commit();
    }
    expect(pager.commitId).toBe(start + 3);
    expect(pager.commitTime).toBeGreaterThanOrEqual(before);
    expect(pager.commitTime).toBeLessThanOrEqual(Date.now());
    pager.close();
    const p2 = Pager.open(vfs.openSync('test.db'));
    expect(p2.commitId).toBe(start + 3);
    p2.catalogRoot = 9;
    p2.commit();
    expect(p2.commitId).toBe(start + 4);
    p2.close();
  });

  it('a commit with nothing to write is no commit', () => {
    const { pager } = openMemoryPager({ pageSize: 1024 });
    const id = pager.commitId;
    pager.commit();
    expect(pager.commitId).toBe(id);
  });

  it("don't wrap where the 32-bit change counter does", () => {
    const vfs = new MemoryVfs();
    const { pager } = openMemoryPager({ pageSize: 1024 }, vfs);
    pager.close();
    patchHeader(vfs, 1024, (v) => {
      v.setUint32(DH_COMMIT_ID, 0xffff_ffff, true);
      v.setUint32(DH_COMMIT_ID + 4, 0, true);
    });
    const p2 = Pager.open(vfs.openSync('test.db'));
    p2.catalogRoot = 3;
    p2.commit();
    expect(p2.commitId).toBe(0x1_0000_0000);
    p2.close();
  });

  it('are kept by in-memory databases and through SQL and plans', () => {
    const db = Database.openMemory();
    const id = db.pager.commitId;
    db.exec('CREATE TABLE t(x)');
    db.exec('INSERT INTO t VALUES (1)');
    db.exec('BEGIN; INSERT INTO t VALUES (2); INSERT INTO t VALUES (3); COMMIT');
    expect(db.pager.commitId).toBe(id + 3);
    db.close();
  });
});

describe('required features', () => {
  it('new files require no features (property graphs and history, the known bits, are required only once used)', () => {
    expect(KNOWN_FEATURES).toBe(0x3);
    const { pager } = openMemoryPager({ pageSize: 1024 });
    expect(pager.requiredFeatures).toBe(0);
  });

  it('a file that needs a feature this engine does not know is refused with SMALT_FORMAT', () => {
    const vfs = new MemoryVfs();
    const { pager } = openMemoryPager({ pageSize: 1024 }, vfs);
    pager.close();
    patchHeader(vfs, 1024, (v) => v.setUint32(DH_REQUIRED_FEATURES, 0x4, true));
    let err: unknown;
    try {
      Pager.open(vfs.openSync('test.db'));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SmaltError);
    expect((err as SmaltError).code).toBe('SMALT_FORMAT');
    expect((err as Error).message).toMatch(/needs features this engine doesn't support \(feature bits 0x4\)/);
  });
});
