/**
 * ADR 0033 step 6, part 4: forgetting history (decision 16) and graphs that keep history (decision 8).
 *
 * `{ kind: 'maintenance', action: 'forget', before: { commit } | { time }, table? }` drops what no read as of `before`
 * or later needs, for both methods, and records a horizon: reading as of an earlier commit is then an error.
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
const lit = (value: unknown) => ({ k: 'lit', value, type: 'int' });
const asOf = (db: Database, table: string, commit: number) =>
  [...db.queryPlan({ kind: 'query', plan: { op: 'scan', table, columns: [0, 1], asOf: { commit: lit(commit) } } } as unknown as PlanStatementInput).rows].sort(
    (x, y) => Number(x[0]) - Number(y[0]),
  );
const forget = (db: Database, before: Record<string, unknown>, table?: string) =>
  db.queryPlan({ kind: 'maintenance', action: 'forget', before, ...(table ? { table } : {}) } as unknown as PlanStatementInput);
const code = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    return (e as { code?: string }).code;
  }
  return undefined;
};

/** A table of the given method with four commits of history: [c1, c2, c3, c4]. */
function withHistory(method: string): { db: Database; c: number[] } {
  const db = Database.openMemory();
  db.queryPlan(create('t', method));
  const c: number[] = [];
  for (const sql of ["INSERT INTO t VALUES (1, 'a'), (2, 'b')", "UPDATE t SET v = 'a2' WHERE id = 1", 'DELETE FROM t WHERE id = 2', "UPDATE t SET v = 'a3' WHERE id = 1"]) {
    db.exec(sql);
    c.push(db.pager.commitId);
  }
  return { db, c };
}

describe.each(['versions', 'log'])('forgetting history (%s)', (method) => {
  const historyTable = method === 'log' ? 'smalt_log_t' : 'smalt_versions_t';
  const count = (db: Database) => db.query(`SELECT count(*) FROM ${historyTable}`).rows[0]![0] as number;

  it('keeps every read as of the horizon or later, and refuses earlier ones', () => {
    const { db, c } = withHistory(method);
    const before = c.map((x) => asOf(db, 't', x));
    const rows = count(db);
    forget(db, { commit: lit(c[2]) });
    expect(count(db)).toBeLessThan(rows);
    for (const i of [2, 3]) expect(asOf(db, 't', c[i]!)).toEqual(before[i]);
    expect(code(() => asOf(db, 't', c[1]!))).toBe('SMALT_RANGE');
    expect(() => asOf(db, 't', c[0]!)).toThrow(new RegExp(`table t: history before commit ${c[2]} was forgotten`));
    // New history is kept as before.
    db.exec("UPDATE t SET v = 'a4'");
    expect(asOf(db, 't', c[3]!)).toEqual(before[3]);
  });

  it('by time: the last commit at or before it; the horizon never moves back', () => {
    const { db, c } = withHistory(method);
    forget(db, { commit: lit(c[2]) });
    forget(db, { commit: lit(c[0]) });
    expect(code(() => asOf(db, 't', c[1]!))).toBe('SMALT_RANGE');
    forget(db, { time: lit(Date.now() + 60_000) });
    expect(code(() => asOf(db, 't', c[2]!))).toBe('SMALT_RANGE');
    expect(asOf(db, 't', c[3]!)).toEqual([[1, 'a3']]);
  });

  it('is in the transaction: rolled back, nothing is forgotten', () => {
    const { db, c } = withHistory(method);
    const rows = count(db);
    db.exec('BEGIN');
    forget(db, { commit: lit(c[3]) });
    db.exec('ROLLBACK');
    expect(count(db)).toBe(rows);
    expect(asOf(db, 't', c[0]!)).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
  });
});

describe('forget', () => {
  it('takes one table, or every table that keeps history; the horizon survives reopening', () => {
    const vfs = new MemoryVfs();
    const open = () => Database.openFile(vfs.openSync('a.db'), {}, vfs.openSync('a.db-wal'));
    let db = open();
    db.queryPlan(create('a', 'versions'));
    db.queryPlan(create('b', 'log'));
    db.exec("INSERT INTO a VALUES (1, 'x'); INSERT INTO b VALUES (1, 'x')");
    const c1 = db.pager.commitId;
    db.exec("UPDATE a SET v = 'y'; UPDATE b SET v = 'y'");
    forget(db, { commit: lit(db.pager.commitId) }, 'a');
    expect(code(() => asOf(db, 'a', c1))).toBe('SMALT_RANGE');
    expect(asOf(db, 'b', c1)).toEqual([[1, 'x']]);
    forget(db, { commit: lit(db.pager.commitId) });
    expect(code(() => asOf(db, 'b', c1))).toBe('SMALT_RANGE');
    db.close();
    db = open();
    expect(code(() => asOf(db, 'a', c1))).toBe('SMALT_RANGE');
    expect(() => db.exec('DELETE FROM smalt_history')).toThrow(/may not be modified/);
    db.close();
  });

  it('refuses a table without history, a missing one, and a malformed statement', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE plain(x)');
    expect(() => forget(db, { commit: lit(1) }, 'plain')).toThrow(/table plain keeps no history/);
    expect(() => forget(db, { commit: lit(1) }, 'nope')).toThrow(/no such table: nope/);
    expect(() => forget(db, {})).toThrow(/expected before: \{ commit \} or \{ time \}/);
  });
});

describe('a graph that keeps history', () => {
  const graph = (history: string, tables: Record<string, unknown> = {}) =>
    ({ kind: 'schema', op: { op: 'createPropertyGraph', ifNotExists: false, graph: { name: 'g', nodes: [{ label: 'Person', table: 'person', id: 'id' }], edges: [], history, ...tables } } }) as unknown as PlanStatementInput;

  it('needs its tables to keep history the same way', () => {
    const db = Database.openMemory();
    db.exec('CREATE TABLE person(id INTEGER PRIMARY KEY, v TEXT)');
    expect(() => db.queryPlan(graph('versions'))).toThrow(/table person keeps no history: the graph's tables keep versions history/);
    expect(() => db.queryPlan(graph('forever'))).toThrow(/unknown history/);
  });

  it('makes its tables on first use with history, and they read as of a commit', () => {
    const db = Database.openMemory();
    db.queryPlan(create('person', 'log'));
    db.queryPlan(graph('log'));
    db.queryPlan({ kind: 'schema', op: { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addType', type: 'KNOWS' } } } as unknown as PlanStatementInput);
    db.queryPlan({ kind: 'schema', op: { op: 'alterPropertyGraph', name: 'g', action: { kind: 'addLabelIndex' } } } as unknown as PlanStatementInput);
    // Their logs exist (the engine's tables, not listed in the catalog).
    expect(db.query('SELECT count(*) FROM smalt_log_KNOWS').rows).toEqual([[0]]);
    expect(db.query('SELECT count(*) FROM smalt_log_g_labels').rows).toEqual([[0]]);
    db.exec("INSERT INTO person VALUES (1, 'Ada'), (2, 'Charles'); INSERT INTO KNOWS(start, end) VALUES (1, 2)");
    const c1 = db.pager.commitId;
    db.exec('DELETE FROM KNOWS');
    const knows = db.queryPlan({ kind: 'query', plan: { op: 'scan', table: 'KNOWS', columns: [0, 1], asOf: { commit: lit(c1) } } } as unknown as PlanStatementInput).rows;
    expect(knows).toEqual([[1, 2]]);
    expect(db.catalog.graph('g')!.history).toBe('log');
  });
});
