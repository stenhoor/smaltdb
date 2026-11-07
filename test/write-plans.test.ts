/** Writes compile from their plans alone (ADR 0015 step 6a): the front end resolves the target, columns and conflict action. */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { sqlLanguage } from '@smaltworks/smaltql';
import type { BindContext } from '../src/engine/plan/bind-context.js';
import { validatePlan } from '../src/engine/plan/validate.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

async function setup() {
  const db = await Database.open(new MemoryVfs(), 'db');
  db.exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, a INT, b TEXT);
    CREATE TABLE r(a INT, b TEXT);
    CREATE VIEW va AS SELECT a, count(*) AS n FROM t GROUP BY a;
    INSERT INTO t VALUES (1, 10, 'x'), (2, 20, 'y'), (3, 10, 'z')`);
  const catalog = (db as unknown as { bindContext(): BindContext }).bindContext();
  const write = (sql: string) => sqlLanguage.parseOne!(sql).bind(catalog) as { plan: PlanOp };
  return { db, catalog, write };
}

describe('write plans', () => {
  it('carry the target, columns and conflict action the front end resolved', async () => {
    const { db, write } = await setup();
    const tables = { tableColumns: (n: string) => db.getTable(n)?.columns.length };
    const ins = write("INSERT OR REPLACE INTO t(b, id) VALUES ('q', 9)").plan;
    expect(ins).toMatchObject({ op: 'append', table: 't', db: 'main', columns: [2, 0], onConflict: 'replace' });
    expect(write("INSERT INTO r(rowid, a) VALUES (5, 1)").plan).toMatchObject({ op: 'append', table: 'r', columns: [-1, 0] });
    expect(write('INSERT INTO t DEFAULT VALUES').plan).toMatchObject({ op: 'append', columns: [], input: null });
    expect(write("UPDATE OR IGNORE t SET b = 'w' WHERE a = 10").plan).toMatchObject({ op: 'update', table: 't', onConflict: 'ignore' });
    expect(write('DELETE FROM t WHERE a = 10').plan).toMatchObject({ op: 'delete', table: 't' });
    for (const q of ["INSERT OR REPLACE INTO t(b, id) VALUES ('q', 9)", "UPDATE OR IGNORE t SET b = 'w'", 'DELETE FROM t']) expect(() => validatePlan(write(q).plan, tables), q).not.toThrow();
  });

  it('refuse what may not be written, with the same errors', async () => {
    const { write } = await setup();
    expect(() => write('INSERT INTO va VALUES (1, 2)')).toThrow('cannot modify va because it is a view');
    expect(() => write('DELETE FROM nope')).toThrow('no such table: nope');
    expect(() => write('INSERT INTO t(zz) VALUES (1)')).toThrow('table t has no column named zz');
    expect(() => write('INSERT INTO t(rowid) VALUES (1)')).toThrow('table t has no column named rowid');
    expect(() => write('INSERT INTO t(a) DEFAULT VALUES')).toThrow('0 values for 1 columns');
    expect(() => write('DELETE FROM t ORDER BY a LIMIT 1')).toThrow('DELETE ... ORDER BY/LIMIT is not supported');
  });

  it('read a snapshot when INSERT … SELECT reads its target through a view, a subquery or a CTE', async () => {
    const { db } = await setup();
    db.exec('INSERT INTO t(a, b) SELECT a + n, b FROM (SELECT a, b, (SELECT count(*) FROM t) AS n FROM t)');
    expect(db.query('SELECT count(*) FROM t').rows).toEqual([[6]]);
    const count = (q: string): number => db.query(q).rows[0][0] as number;
    const groups = count('SELECT count(*) FROM va');
    db.exec("INSERT INTO t(a, b) SELECT a, 'v' FROM va");
    expect(count('SELECT count(*) FROM t')).toBe(6 + groups);
    const before = count('SELECT count(*) FROM t');
    db.exec('WITH c AS (SELECT a FROM t) INSERT INTO t(a) SELECT a FROM c');
    expect(count('SELECT count(*) FROM t')).toBe(2 * before);
  });
});
