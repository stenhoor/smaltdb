/**
 * Version history, method (a) (ADR 0033 step 6, part 2): a table created with `history: 'versions'` keeps its earlier
 * row versions, and a scan with `asOf` reads it as it was after a commit, or at a time. Writes come from any language
 * (SQL here) and plans; the history is written in the same transaction.
 */
import { describe, expect, it, vi } from 'vitest';
import { Database } from '../src/engine/database.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import { FEATURE_HISTORY } from '../src/engine/storage/format.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const column = (name: string, type: string) => ({ name, declaredType: type, type, notNull: false, collation: 'binary' });
const createT = (extra: Record<string, unknown> = {}) =>
  ({
    kind: 'schema',
    op: {
      op: 'createTable',
      temp: false,
      ifNotExists: false,
      table: {
        name: 't',
        storage: 'row',
        history: 'versions',
        columns: [column('id', 'INTEGER'), column('v', 'TEXT'), column('n', 'REAL')],
        keys: [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], ofColumn: 0 }],
        checks: [],
        foreignKeys: [],
        ...extra,
      },
    },
  }) as unknown as PlanStatementInput;
const lit = (value: unknown) => ({ k: 'lit', value, type: 'int' });
/** t's rows as of commit `c` (or time `time`), sorted by id. */
const asOf = (db: Database, at: { commit: number } | { time: number }, columns = [0, 1]) => {
  const a = 'commit' in at ? { commit: lit(at.commit) } : { time: lit(at.time) };
  const rows = db.queryPlan({ kind: 'query', plan: { op: 'scan', table: 't', columns, asOf: a } } as unknown as PlanStatementInput).rows;
  return [...rows].sort((x, y) => Number(x[0]) - Number(y[0]));
};
const commit = (db: Database, sql: string): number => {
  db.exec(sql);
  return db.pager.commitId;
};

function fresh(): Database {
  const db = Database.openMemory();
  db.queryPlan(createT());
  return db;
}

describe('reading a table as of a commit', () => {
  it('gives the rows as each commit left them: inserts, updates and deletes', () => {
    const db = fresh();
    const before = db.pager.commitId;
    const c1 = commit(db, "INSERT INTO t VALUES (1, 'a', 1), (2, 'b', 2)");
    const c2 = commit(db, "UPDATE t SET v = 'a2' WHERE id = 1");
    const c3 = commit(db, 'DELETE FROM t WHERE id = 2');
    const c4 = commit(db, "INSERT INTO t VALUES (3, 'c', 3)");
    expect(asOf(db, { commit: before })).toEqual([]);
    expect(asOf(db, { commit: c1 })).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(asOf(db, { commit: c2 })).toEqual([
      [1, 'a2'],
      [2, 'b'],
    ]);
    expect(asOf(db, { commit: c3 })).toEqual([[1, 'a2']]);
    expect(asOf(db, { commit: c4 })).toEqual([
      [1, 'a2'],
      [3, 'c'],
    ]);
    // The current state, and later commits, read as the table does.
    expect(asOf(db, { commit: c4 + 100 })).toEqual(db.query('SELECT id, v FROM t ORDER BY id').rows);
  });

  it('keeps the column types, and reads the rowid (-1) and any columns', () => {
    const db = fresh();
    const c1 = commit(db, "INSERT INTO t VALUES (7, 'x', 1.5)");
    commit(db, 'UPDATE t SET n = 2.5');
    const r = db.queryPlan({ kind: 'query', plan: { op: 'scan', table: 't', columns: [2, -1], asOf: { commit: lit(c1) } } } as unknown as PlanStatementInput);
    expect(r.rows).toEqual([[1.5, 7]]);
    expect(r.columnTypes).toEqual(['real', 'int']);
  });

  it('follows a row whose id changes, and one replaced by INSERT OR REPLACE', () => {
    const db = fresh();
    const c1 = commit(db, "INSERT INTO t VALUES (1, 'a', 0)");
    const c2 = commit(db, 'UPDATE t SET id = 5');
    const c3 = commit(db, "INSERT OR REPLACE INTO t VALUES (5, 'r', 0)");
    expect(asOf(db, { commit: c1 })).toEqual([[1, 'a']]);
    expect(asOf(db, { commit: c2 })).toEqual([[5, 'a']]);
    expect(asOf(db, { commit: c3 })).toEqual([[5, 'r']]);
  });

  it('keeps one version per commit: changes inside a transaction were never committed', () => {
    const db = fresh();
    const c1 = commit(db, "INSERT INTO t VALUES (1, 'a', 0)");
    const c2 = commit(db, "BEGIN; UPDATE t SET v = 'b'; UPDATE t SET v = 'c'; INSERT INTO t VALUES (2, 'tmp', 0); DELETE FROM t WHERE id = 2; COMMIT");
    expect(asOf(db, { commit: c1 })).toEqual([[1, 'a']]);
    expect(asOf(db, { commit: c2 })).toEqual([[1, 'c']]);
    expect(db.query('SELECT count(*) FROM smalt_versions_t').rows).toEqual([[1]]);
  });

  it('a rolled-back transaction leaves no history, and a failed statement none of its own', () => {
    const db = fresh();
    const c1 = commit(db, "INSERT INTO t VALUES (1, 'a', 0)");
    db.exec("BEGIN; UPDATE t SET v = 'gone'; ROLLBACK");
    expect(() => db.exec("INSERT INTO t VALUES (2, 'b', 0), (1, 'dup', 0)")).toThrow(/UNIQUE|PRIMARY/);
    expect(db.query('SELECT count(*) FROM smalt_versions_t').rows).toEqual([[0]]);
    expect(db.query('SELECT count(*) FROM smalt_since_t').rows).toEqual([[1]]);
    expect(asOf(db, { commit: c1 + 10 })).toEqual([[1, 'a']]);
  });

  it('deleting every row keeps each row\'s version (no truncation past history)', () => {
    const db = fresh();
    const c1 = commit(db, "INSERT INTO t VALUES (1, 'a', 0), (2, 'b', 0)");
    commit(db, 'DELETE FROM t');
    expect(asOf(db, { commit: c1 })).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
  });
});

describe('reading a table as of a time', () => {
  it('reads it as of the last commit at or before the time; before the first, empty', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(1_000_000);
      const db = fresh();
      vi.setSystemTime(2_000_000);
      commit(db, "INSERT INTO t VALUES (1, 'a', 0)");
      vi.setSystemTime(3_000_000);
      commit(db, "UPDATE t SET v = 'b'");
      expect(asOf(db, { time: 2_500_000 })).toEqual([[1, 'a']]);
      expect(asOf(db, { time: 2_000_000 })).toEqual([[1, 'a']]);
      expect(asOf(db, { time: 1_999_999 })).toEqual([]);
      expect(asOf(db, { time: 3_000_000 })).toEqual([[1, 'b']]);
      // Every commit that wrote history is in smalt_commits, with the time the header got.
      expect(db.query('SELECT time FROM smalt_commits ORDER BY id').rows).toEqual([[2_000_000], [3_000_000]]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('the table', () => {
  it('needs the history feature, and its history survives reopening', () => {
    const vfs = new MemoryVfs();
    const open = () => Database.openFile(vfs.openSync('a.db'), {}, vfs.openSync('a.db-wal'));
    let db = open();
    db.queryPlan(createT());
    expect(db.pager.requiredFeatures & FEATURE_HISTORY).toBe(FEATURE_HISTORY);
    const c1 = commit(db, "INSERT INTO t VALUES (1, 'a', 0)");
    commit(db, "UPDATE t SET v = 'b'");
    db.close();
    db = open();
    expect(asOf(db, { commit: c1 })).toEqual([[1, 'a']]);
    commit(db, "UPDATE t SET v = 'c'");
    expect(db.query('SELECT count(*) FROM smalt_versions_t').rows).toEqual([[2]]);
    db.close();
  });

  it('its history tables are the engine\'s: not written or dropped by users, and dropped with it', () => {
    const db = fresh();
    commit(db, "INSERT INTO t VALUES (1, 'a', 0)");
    expect(() => db.exec('DELETE FROM smalt_since_t')).toThrow(/may not be modified/);
    expect(() => db.exec('INSERT INTO smalt_versions_t VALUES (1, 1, 2, 1, 1, 1)')).toThrow(/may not be modified/);
    expect(() => db.exec('DROP TABLE smalt_versions_t')).toThrow(/may not be dropped/);
    // ALTER TABLE works on it, and its history follows (test/history-alter.test.ts).
    db.exec('ALTER TABLE t ADD COLUMN w');
    db.exec('DROP TABLE t');
    expect(db.catalog.table('smalt_since_t')).toBeUndefined();
    expect(db.catalog.table('smalt_versions_t')).toBeUndefined();
  });

  it('is a row table in main, with no column named as history\'s', () => {
    const db = Database.openMemory();
    expect(() => db.queryPlan(createT({ storage: 'columnar', keys: [] }))).toThrow(/history is kept for row tables in main, not columnar/);
    expect(() => db.queryPlan({ ...(createT() as object), op: { ...(createT() as { op: object }).op, temp: true } } as unknown as PlanStatementInput)).toThrow(/not TEMP/);
    expect(() => db.queryPlan(createT({ columns: [column('id', 'INTEGER'), column('$from', 'INTEGER')] }))).toThrow(/has a name history uses/);
    expect(() => db.queryPlan(createT({ history: 'forever' }))).toThrow(/unknown history/);
  });

  it('asOf needs a table that keeps history, and a commit or a time', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE plain(x)');
    const scan = (asOf: unknown, table = 'plain') => () => db.queryPlan({ kind: 'query', plan: { op: 'scan', table, columns: [0], asOf } } as unknown as PlanStatementInput);
    expect(scan({ commit: lit(1) })).toThrow(/table plain keeps no history/);
    db.queryPlan(createT());
    expect(scan({}, 't')).toThrow(/expected \{ commit \} or \{ time \}/);
    expect(scan({ commit: lit(1), time: lit(1) }, 't')).toThrow(/expected \{ commit \} or \{ time \}/);
  });

  it('a table without history writes nothing more', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE plain(x); INSERT INTO plain VALUES (1); UPDATE plain SET x = 2');
    expect(db.catalog.table('smalt_commits')).toBeUndefined();
    expect(db.pager.requiredFeatures & FEATURE_HISTORY).toBe(0);
  });
});
