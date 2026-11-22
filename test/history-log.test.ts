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

describe('asOf a commit given as a subquery', () => {
  it.each(['versions', 'log'])('%s: the commit may be any expression, a subquery too', (method) => {
    const db = Database.openMemory();
    db.queryPlan(create('t', method));
    db.exec("INSERT INTO t VALUES (1, 'a'); UPDATE t SET v = 'b'");
    const first = { k: 'subquery', mode: 'scalar', type: 'int', collation: 'binary', plan: { op: 'aggregate', input: { op: 'scan', table: 'smalt_commits', columns: [0] }, keys: [], aggs: [{ fn: 'min', args: [{ k: 'col', input: 0, index: 0, depth: 0, type: 'int', collation: 'binary' }], star: false, distinct: false, collation: 'binary', type: 'int' }], carry: [] } };
    const r = db.queryPlan({ kind: 'query', plan: { op: 'scan', table: 't', columns: [0, 1], asOf: { commit: first } } } as unknown as PlanStatementInput).rows;
    expect(r).toEqual([[1, 'a']]);
  });
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

describe("a table written by a statement's internal plans", () => {
  /** `emp(id, boss)` keeps history, and its rows go with their row of `boss` (ON DELETE CASCADE). */
  const emp = (history: string): PlanStatementInput => {
    const t = create('emp', history) as unknown as { op: { table: { columns: unknown[]; foreignKeys: unknown[] } } };
    t.op.table.columns = [column('id', 'INTEGER'), column('boss', 'INTEGER')];
    t.op.table.foreignKeys = [{ columns: [1], table: 'boss', onDelete: 'CASCADE', onUpdate: 'NO ACTION', deferrable: false, isDeferrable: false }];
    return t as unknown as PlanStatementInput;
  };

  for (const history of ['log', 'versions']) {
    it(`${history}: every change the plans make is kept`, () => {
      const db = Database.openMemory();
      db.exec('CREATE TABLE boss(id INTEGER PRIMARY KEY)');
      db.queryPlan(emp(history));
      db.exec('INSERT INTO boss VALUES (1), (2), (3)');
      db.exec('INSERT INTO emp VALUES (11, 1), (12, 2), (13, 3), (14, 3)');
      const full = db.pager.commitId;
      const kept = (): number => Number(db.query(`SELECT count(*) FROM smalt_${history}_emp`).rows[0]![0]);
      const before = kept();
      // Each boss deleted takes its row of emp in a plan of its own, inside the one statement; then two more go.
      db.exec('DELETE FROM boss WHERE id IN (1, 2)');
      const two = db.pager.commitId;
      db.exec('DELETE FROM emp WHERE id = 13');
      db.exec('DELETE FROM emp WHERE id = 14');
      expect(kept()).toBe(before + 4);
      expect(asOf(db, 'emp', full)).toEqual([[11, 1], [12, 2], [13, 3], [14, 3]]);
      expect(asOf(db, 'emp', two)).toEqual([[13, 3], [14, 3]]);
      expect(db.query('SELECT count(*) FROM emp').rows).toEqual([[0]]);
    });
  }

  /** The same table, its rows going with the row of `emp` itself that their `boss` names. */
  const reports = (history: string): PlanStatementInput => {
    const t = emp(history) as unknown as { op: { table: { foreignKeys: { table: string }[] } } };
    t.op.table.foreignKeys[0]!.table = 'emp';
    return t as unknown as PlanStatementInput;
  };

  for (const history of ['log', 'versions']) {
    it(`${history}: and every change they make to the table their statement is writing`, () => {
      const db = Database.openMemory();
      db.queryPlan(reports(history));
      // 11 and 12 report to 1, 111 to 11, 21 to 2; no one reports to 3.
      db.exec('INSERT INTO emp VALUES (1, NULL), (2, NULL), (3, NULL), (11, 1), (12, 1), (21, 2), (111, 11)');
      const full = db.pager.commitId;
      const kept = (): number => Number(db.query(`SELECT count(*) FROM smalt_${history}_emp`).rows[0]![0]);
      const before = kept();
      // The statement deletes 1 and 2 through its writer; the rows under them go in plans of their own, which take
      // other writers of the table, since the statement's is in use.
      db.exec('DELETE FROM emp WHERE id IN (1, 2)');
      const one = db.pager.commitId;
      db.exec('DELETE FROM emp WHERE id = 3');
      expect(kept()).toBe(before + 7);
      expect(asOf(db, 'emp', full)).toEqual([[1, null], [2, null], [3, null], [11, 1], [12, 1], [21, 2], [111, 11]]);
      expect(asOf(db, 'emp', one)).toEqual([[3, null]]);
      expect(db.query('SELECT count(*) FROM emp').rows).toEqual([[0]]);
    });
  }
});

describe('an index made on a history table', () => {
  for (const history of ['log', 'versions']) {
    it(`${history}: holds the changes made after it, and is not written once it is dropped`, () => {
      const db = Database.openMemory();
      db.queryPlan(create('t', history));
      const past = `smalt_${history}_t`;
      db.exec("INSERT INTO t VALUES (1, 'a')");
      db.exec("UPDATE t SET v = 'b'");
      db.exec(`CREATE INDEX past_rows ON ${past}("$rowid")`);
      db.exec("UPDATE t SET v = 'c'");
      expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
      db.exec('DROP INDEX past_rows');
      db.exec("UPDATE t SET v = 'd'");
      expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
      // The insert and the three updates in the log; the three versions the updates closed.
      expect(Number(db.query(`SELECT count(*) FROM ${past}`).rows[0]![0])).toBe(history === 'log' ? 4 : 3);
    });
  }
});
