/**
 * ADR 0033 step 6, part 4a: ALTER TABLE on a table that keeps history. Its versions or log follow the change, so
 * reading it as of an earlier commit still works: a renamed table keeps its history (and horizon), an added column reads
 * NULL in versions from before it, a renamed column keeps its past values, and a dropped one loses them.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const column = (name: string, type: string) => ({ name, declaredType: type, type, notNull: false, collation: 'binary' });
const create = (name: string, history: string) =>
  ({
    kind: 'schema',
    op: {
      op: 'createTable',
      temp: false,
      ifNotExists: false,
      table: {
        name,
        storage: 'row',
        history,
        columns: [column('id', 'INTEGER'), column('v', 'TEXT'), column('w', 'TEXT')],
        keys: [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], ofColumn: 0 }],
        checks: [],
        foreignKeys: [],
      },
    },
  }) as unknown as PlanStatementInput;
const asOf = (db: Database, table: string, commit: number, columns: number[]) =>
  [...db.queryPlan({ kind: 'query', plan: { op: 'scan', table, columns, asOf: { commit: { k: 'lit', value: commit, type: 'int' } } } } as unknown as PlanStatementInput).rows].sort(
    (x, y) => Number(x[0]) - Number(y[0]),
  );

describe.each(['versions', 'log'])('ALTER TABLE on a table that keeps %s history', (method) => {
  function fresh(): { db: Database; c1: number; c2: number } {
    const db = Database.openMemory();
    db.queryPlan(create('t', method));
    db.exec("INSERT INTO t VALUES (1, 'a', 'x')");
    const c1 = db.pager.commitId;
    db.exec("UPDATE t SET v = 'b'");
    return { db, c1, c2: db.pager.commitId };
  }

  it('RENAME TO keeps its history, and its horizon', () => {
    const { db, c1, c2 } = fresh();
    db.queryPlan({ kind: 'maintenance', action: 'forget', before: { commit: { k: 'lit', value: c1, type: 'int' } } } as unknown as PlanStatementInput);
    db.exec('ALTER TABLE t RENAME TO u');
    expect(asOf(db, 'u', c1, [0, 1])).toEqual([[1, 'a']]);
    expect(asOf(db, 'u', c2, [0, 1])).toEqual([[1, 'b']]);
    expect(() => asOf(db, 'u', c1 - 1, [0, 1])).toThrow(/history before commit/);
    db.exec("UPDATE u SET v = 'c'");
    expect(asOf(db, 'u', c2, [0, 1])).toEqual([[1, 'b']]);
    // The old name is free again, history and all.
    db.queryPlan(create('t', method));
    db.exec("INSERT INTO t VALUES (9, 'new', 'x')");
    expect(db.query('SELECT id FROM t').rows).toEqual([[9]]);
  });

  it('ADD COLUMN: earlier versions read NULL in it; later ones keep it', () => {
    const { db, c1 } = fresh();
    db.exec("ALTER TABLE t ADD COLUMN z TEXT DEFAULT 'd'");
    const c3 = db.pager.commitId;
    db.exec("UPDATE t SET z = 'set'");
    expect(asOf(db, 't', c1, [0, 1, 3])).toEqual([[1, 'a', null]]);
    expect(asOf(db, 't', c3, [0, 1, 3])).toEqual([[1, 'b', 'd']]);
    expect(asOf(db, 't', c3 + 10, [0, 3])).toEqual([[1, 'set']]);
  });

  it('RENAME COLUMN keeps its past values', () => {
    const { db, c1 } = fresh();
    db.exec('ALTER TABLE t RENAME COLUMN v TO vv');
    db.exec("UPDATE t SET vv = 'c'");
    expect(asOf(db, 't', c1, [0, 1])).toEqual([[1, 'a']]);
    expect(db.query('SELECT vv FROM t').rows).toEqual([['c']]);
  });

  it('DROP COLUMN drops its past values too; the others keep theirs', () => {
    const { db, c1 } = fresh();
    db.exec('ALTER TABLE t DROP COLUMN w');
    expect(asOf(db, 't', c1, [0, 1])).toEqual([[1, 'a']]);
    db.exec("UPDATE t SET v = 'c'");
    expect(asOf(db, 't', db.pager.commitId - 1, [0, 1])).toEqual([[1, 'b']]);
  });

  it('the history survives reopening after an ALTER', () => {
    const vfs = new MemoryVfs();
    const open = () => Database.openFile(vfs.openSync('a.db'), {}, vfs.openSync('a.db-wal'));
    let db = open();
    db.queryPlan(create('t', method));
    db.exec("INSERT INTO t VALUES (1, 'a', 'x')");
    const c1 = db.pager.commitId;
    db.exec('ALTER TABLE t RENAME TO u; ALTER TABLE u ADD COLUMN z');
    db.exec("UPDATE u SET v = 'b', z = 1");
    db.close();
    db = open();
    expect(asOf(db, 'u', c1, [0, 1, 3])).toEqual([[1, 'a', null]]);
    db.close();
  });
});
