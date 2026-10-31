import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import { CrashVfs } from './crash-vfs.js';
import { rng } from './helpers.js';

const SNAP = 'SELECT id, k, v, length(big) FROM t ORDER BY id';

function openFrom(images: Map<string, Uint8Array>): Database {
  const vfs = new MemoryVfs();
  for (const [path, bytes] of images) {
    const f = vfs.openSync(path);
    f.write(bytes, 0);
    f.truncate(bytes.length);
  }
  return Database.openFile(vfs.openSync('c.db'), { pageSize: 1024 }, vfs.openSync('c.db-wal'));
}

function workload(seed: number): { vfs: CrashVfs; commits: { end: number; snap: string }[] } {
  const vfs = new CrashVfs();
  const opts = { pageSize: 1024, walAutoCheckpointBytes: 24 * 1024, cacheSizeBytes: 64 * 1024 };
  const db = Database.openFile(vfs.openSync('c.db'), opts, vfs.openSync('c.db-wal'));
  const commits: { end: number; snap: string }[] = [];
  const record = (): void => {
    commits.push({ end: vfs.log.length, snap: JSON.stringify(db.query(SNAP).rows) });
  };
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, k INT UNIQUE, v TEXT, big TEXT); CREATE INDEX t_v ON t(v)');
  record();
  const r = rng(seed);
  for (let txn = 0; txn < 40; txn++) {
    db.exec('BEGIN');
    const n = 1 + Math.floor(r() * 15);
    for (let i = 0; i < n; i++) {
      const op = r();
      const id = Math.floor(r() * 80);
      if (op < 0.6) db.run('INSERT OR REPLACE INTO t VALUES (?, ?, ?, ?)', [id, Math.floor(r() * 200), 'v'.repeat(Math.floor(r() * 60)), 'b'.repeat(Math.floor(r() * (r() < 0.2 ? 4000 : 100)))]);
      else if (op < 0.8) db.run('UPDATE t SET v = v || ? WHERE id = ?', ['x', id]);
      else db.run('DELETE FROM t WHERE id = ?', [id]);
    }
    if (r() < 0.15) {
      db.exec('ROLLBACK');
      continue;
    }
    db.exec('COMMIT');
    record();
    if (r() < 0.1) db.checkpoint();
  }
  db.close();
  commits.push({ end: vfs.log.length, snap: commits[commits.length - 1].snap });
  return { vfs, commits };
}

describe('crash safety (WAL)', () => {
  for (const seed of Array.from({ length: Number(process.env.CRASH_SEEDS ?? 2) }, (_, i) => i + 1)) {
    it(`every crash point recovers a committed state (seed ${seed})`, () => {
      const { vfs, commits } = workload(seed);
      const total = vfs.log.length;
      expect(total).toBeGreaterThan(100);
      let checked = 0;
      const first = commits[0].end; // before the schema exists there is nothing to verify
      for (let k = first; k <= total; k++) {
        // Commits whose call returned before the crash point must survive.
        let c = 0;
        while (c + 1 < commits.length && commits[c + 1].end <= k) c++;
        const allowed = new Set([commits[c].snap, commits[Math.min(c + 1, commits.length - 1)].snap]);
        for (const mode of ['prefix', 'torn', 'lost-unflushed'] as const) {
          if (mode === 'torn' && (k >= total || vfs.log[k].kind !== 'write')) continue;
          const db = openFrom(vfs.imageAt(k, mode));
          const integrity = db.query('PRAGMA integrity_check').rows;
          const snap = JSON.stringify(db.query(SNAP).rows);
          db.close();
          if (integrity[0][0] !== 'ok' || !allowed.has(snap)) {
            throw new Error(`crash before op ${k}/${total} (${mode}, ${vfs.log[k]?.kind} ${vfs.log[k]?.file}): integrity=${JSON.stringify(integrity)} committed=${c} state matches: ${[...allowed].map((a) => a === snap)}`);
          }
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(200);
      console.info(`seed ${seed}: ${total} storage ops, ${commits.length} commits, ${checked} crash states verified`);
    }, 120_000);
  }

  it('without a WAL, crashes can corrupt the database (documents why the WAL exists)', () => {
    const vfs = new CrashVfs();
    const db = Database.openFile(vfs.openSync('n.db'), { pageSize: 1024, journalMode: 'off' });
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)');
    const start = vfs.log.length;
    db.exec('BEGIN');
    for (let i = 0; i < 300; i++) db.run('INSERT INTO t VALUES (?, ?)', [i, 'x'.repeat(50)]);
    db.exec('COMMIT');
    let broken = 0;
    for (let k = start; k < vfs.log.length; k++) {
      const images = vfs.imageAt(k, 'prefix');
      const mem = new MemoryVfs();
      const f = mem.openSync('n.db');
      f.write(images.get('n.db')!, 0);
      try {
        const d = Database.openFile(f, {});
        const ok = d.query('PRAGMA integrity_check').rows[0][0] === 'ok';
        const n = Number(d.query('SELECT count(*) FROM t').rows[0][0]);
        if (!ok || (n !== 0 && n !== 300)) broken++;
      } catch {
        broken++;
      }
    }
    expect(broken).toBeGreaterThan(0);
  });
});
