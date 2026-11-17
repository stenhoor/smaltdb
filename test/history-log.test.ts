/**
 * Version history, method (b) (ADR 0033 step 6, part 3): a table created with `history: 'log'` appends each change to
 * `smalt_log_<t>`, and `asOf` rebuilds a past state from the current rows and the log. Both methods are checked
 * against a model: random inserts, updates (also of the rowid), deletes, REPLACEs and rollbacks, in transactions and
 * not, then every commit read back with `asOf` from both a `versions` table and a `log` table.
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
        columns: [column('id', 'INTEGER'), column('v', 'TEXT')],
        keys: [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }], ofColumn: 0 }],
        checks: [],
        foreignKeys: [],
      },
    },
  }) as unknown as PlanStatementInput;
const asOf = (db: Database, table: string, commit: number) =>
  [...db.queryPlan({ kind: 'query', plan: { op: 'scan', table, columns: [0, 1], asOf: { commit: { k: 'lit', value: commit, type: 'int' } } } } as unknown as PlanStatementInput).rows].sort(
    (x, y) => Number(x[0]) - Number(y[0]),
  );

describe('both methods against a model', () => {
  for (let seed = 1; seed <= 4; seed++) {
    it(`random history ${seed}: every commit reads back as it was, by both methods`, () => {
      let x = seed * 7919;
      const rnd = (n: number) => ((x = (Math.imul(x, 1103515245) + 12345) >>> 0) >>> 8) % n;
      const db = Database.openMemory();
      db.queryPlan(create('a', 'versions'));
      db.queryPlan(create('b', 'log'));
      const model = new Map<number, string>();
      const states: [number, [number, string][]][] = [[db.pager.commitId, []]];
      const snapshot = () => [...model.entries()].sort((p, q) => p[0] - q[0]);
      // Each step's SQL runs on both tables; `apply` changes the model the same way.
      const both = (sql: string) => db.exec(`${sql.replaceAll('$t', 'a')}; ${sql.replaceAll('$t', 'b')}`);
      for (let step = 0; step < 60; step++) {
        const inTx = rnd(3) === 0;
        const ops = inTx ? 1 + rnd(4) : 1;
        const pending = new Map(model);
        if (inTx) db.exec('BEGIN');
        for (let k = 0; k < ops; k++) {
          const id = 1 + rnd(8);
          const v = `v${step}.${k}`;
          switch (rnd(5)) {
            case 0:
              if (!pending.has(id)) (both(`INSERT INTO $t VALUES (${id}, '${v}')`), pending.set(id, v));
              break;
            case 1:
              if (pending.has(id)) (both(`UPDATE $t SET v = '${v}' WHERE id = ${id}`), pending.set(id, v));
              break;
            case 2:
              if (pending.has(id)) (both(`DELETE FROM $t WHERE id = ${id}`), pending.delete(id));
              break;
            case 3: {
              const to = 1 + rnd(8);
              if (pending.has(id) && !pending.has(to)) {
                both(`UPDATE $t SET id = ${to} WHERE id = ${id}`);
                pending.set(to, pending.get(id)!);
                pending.delete(id);
              }
              break;
            }
            default:
              both(`INSERT OR REPLACE INTO $t VALUES (${id}, '${v}')`);
              pending.set(id, v);
          }
        }
        if (inTx && rnd(4) === 0) {
          db.exec('ROLLBACK');
          continue;
        }
        if (inTx) db.exec('COMMIT');
        model.clear();
        for (const [k, v] of pending) model.set(k, v);
        states.push([db.pager.commitId, snapshot()]);
      }
      // The run did something: many commits, and both histories hold changes.
      expect(states.length).toBeGreaterThan(30);
      expect(db.query('SELECT (SELECT count(*) FROM smalt_versions_a) > 10, (SELECT count(*) FROM smalt_log_b) > 30').rows).toEqual([[1, 1]]);
      for (const [commit, rows] of states) {
        expect(asOf(db, 'a', commit), `versions @${commit}`).toEqual(rows);
        expect(asOf(db, 'b', commit), `log @${commit}`).toEqual(rows);
      }
    });
  }
});

describe('the log', () => {
  it('appends each change with the row before it, and a rowid change as a delete and an insert', () => {
    const db = Database.openMemory();
    db.queryPlan(create('t', 'log'));
    db.exec("INSERT INTO t VALUES (1, 'a'); UPDATE t SET v = 'b'; UPDATE t SET id = 2; DELETE FROM t");
    const log = db.query('SELECT "$op", "$rowid", id, v FROM smalt_log_t ORDER BY rowid').rows;
    expect(log).toEqual([
      [0, 1, null, null],
      [1, 1, 1, 'a'],
      [2, 1, 1, 'b'],
      [0, 2, null, null],
      [2, 2, 2, 'b'],
    ]);
    // Each change carries its commit; the commits are recorded.
    const commits = db.query('SELECT DISTINCT "$commit" FROM smalt_log_t ORDER BY 1').rows.map((r) => r[0]);
    expect(db.query('SELECT id FROM smalt_commits ORDER BY id').rows.map((r) => r[0])).toEqual(commits);
  });

  it('survives reopening, is the engine\'s, and goes with its table', () => {
    const vfs = new MemoryVfs();
    const open = () => Database.openFile(vfs.openSync('a.db'), {}, vfs.openSync('a.db-wal'));
    let db = open();
    db.queryPlan(create('t', 'log'));
    db.exec("INSERT INTO t VALUES (1, 'a')");
    const c1 = db.pager.commitId;
    db.exec("UPDATE t SET v = 'b'");
    db.close();
    db = open();
    expect(asOf(db, 't', c1)).toEqual([[1, 'a']]);
    expect(() => db.exec('DELETE FROM smalt_log_t')).toThrow(/may not be modified/);
    // ALTER TABLE works on it, and its log follows (test/history-alter.test.ts).
    db.exec('ALTER TABLE t ADD COLUMN w');
    db.exec('DROP TABLE t');
    expect(db.catalog.table('smalt_log_t')).toBeUndefined();
    db.close();
  });

  it('a table can\'t have a column named as the log\'s', () => {
    const db = Database.openMemory();
    const bad = create('t', 'log') as unknown as { op: { table: { columns: unknown[] } } };
    bad.op.table.columns = [column('id', 'INTEGER'), column('$op', 'INTEGER')];
    expect(() => db.queryPlan(bad as unknown as PlanStatementInput)).toThrow(/has a name history uses/);
  });
});
