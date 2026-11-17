/**
 * ADR 0033 step 6, part 1 (decision 17): a transaction's author and message, recorded with its commit id and time in
 * `smalt_commits`, from any language (plan statements here; the client's `db.transaction(fn, { author, message })`
 * sends them on its `begin`).
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const tx = (db: Database, s: Record<string, unknown>) => db.queryPlan({ kind: 'transaction', ...s } as unknown as PlanStatementInput);
const commits = (db: Database) => db.query('SELECT id, author, message FROM smalt_commits ORDER BY id').rows;

function fresh(): Database {
  const db = Database.openMemory();
  db.exec('CREATE TABLE t(x)');
  return db;
}

describe('smalt_commits', () => {
  it("records a commit's id, time, author and message, as the header stamps them", () => {
    const db = fresh();
    const before = Date.now();
    tx(db, { action: 'begin', mode: 'deferred', author: 'ada', message: 'first rows' });
    db.exec('INSERT INTO t VALUES (1)');
    tx(db, { action: 'commit' });
    const [row] = db.query('SELECT id, time, author, message FROM smalt_commits').rows;
    expect(row).toEqual([db.pager.commitId, db.pager.commitTime, 'ada', 'first rows']);
    expect(db.pager.commitTime).toBeGreaterThanOrEqual(before);
  });

  it("takes them from begin or commit, commit's winning", () => {
    const db = fresh();
    tx(db, { action: 'begin', mode: 'deferred', author: 'ada', message: 'draft' });
    db.exec('INSERT INTO t VALUES (1)');
    tx(db, { action: 'commit', message: 'final' });
    tx(db, { action: 'begin', mode: 'deferred' });
    db.exec('INSERT INTO t VALUES (2)');
    tx(db, { action: 'commit', author: 'charles' });
    expect(commits(db).map((r) => r.slice(1))).toEqual([
      ['ada', 'final'],
      ['charles', null],
    ]);
  });

  it('records nothing for a commit without them, a commit that changed nothing, or a rollback', () => {
    const db = fresh();
    db.exec('BEGIN; INSERT INTO t VALUES (1); COMMIT');
    tx(db, { action: 'begin', mode: 'deferred', author: 'ada' });
    tx(db, { action: 'commit' });
    tx(db, { action: 'begin', mode: 'deferred', author: 'ada' });
    db.exec('INSERT INTO t VALUES (2)');
    tx(db, { action: 'rollback' });
    expect(db.catalog.table('smalt_commits')).toBeUndefined();
    // The next one is recorded, and its metadata isn't the rolled-back transaction's.
    tx(db, { action: 'begin', mode: 'deferred', message: 'kept' });
    db.exec('INSERT INTO t VALUES (3)');
    tx(db, { action: 'commit' });
    expect(commits(db).map((r) => r.slice(1))).toEqual([[null, 'kept']]);
  });

  it('ids grow with every commit, recorded or not, and a rollback may leave a gap', () => {
    const db = fresh();
    const commit = (author: string) => {
      tx(db, { action: 'begin', mode: 'deferred', author });
      db.exec('INSERT INTO t VALUES (1)');
      tx(db, { action: 'commit' });
    };
    commit('a');
    db.exec('INSERT INTO t VALUES (2)');
    commit('b');
    const [a, b] = commits(db).map((r) => r[0] as number);
    expect(b).toBe(a! + 2);
  });

  it('survives reopening, and only the engine writes it', () => {
    const vfs = new MemoryVfs();
    const open = () => Database.openFile(vfs.openSync('a.db'), {}, vfs.openSync('a.db-wal'));
    let db = open();
    db.exec('CREATE TABLE t(x)');
    tx(db, { action: 'begin', mode: 'deferred', author: 'ada', message: 'm' });
    db.exec('INSERT INTO t VALUES (1)');
    tx(db, { action: 'commit' });
    db.close();
    db = open();
    expect(commits(db).map((r) => r.slice(1))).toEqual([['ada', 'm']]);
    expect(() => db.exec("INSERT INTO smalt_commits VALUES (99, 0, 'x', 'y')")).toThrow(/may not be modified/);
    expect(() => db.exec('DELETE FROM smalt_commits')).toThrow(/may not be modified/);
    db.close();
  });

  it('refuses an author or message that is not text', () => {
    const db = fresh();
    expect(() => tx(db, { action: 'begin', mode: 'deferred', author: 7 })).toThrow(/author must be text/);
  });
});
