/**
 * Errors that say where they came from (ADR 0016 section 10): constraint failures carry which constraint, table and
 * columns as fields, and an error carries the `origin` of the plan node it arose in (the innermost one that has an
 * origin), in process and through the client.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as client from '../src/client/index.js';
import { Database } from '../src/engine/database.js';
import { SmaltError } from '../src/engine/errors.js';
import { plan as p } from '../src/engine/index.js';
import { planFromJSON, planToJSON } from '../src/engine/plan/codec.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import { EngineServer } from '../src/engine/server.js';
import type { Request, Response } from '../src/shared/protocol.js';

function errorOf(f: () => unknown): SmaltError {
  try {
    f();
  } catch (e) {
    if (e instanceof SmaltError) return e;
    throw e;
  }
  throw new Error('expected an error');
}

function db(): Database {
  const d = Database.openMemory();
  d.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE parent(id INTEGER PRIMARY KEY, code TEXT NOT NULL, a INT, b INT, CONSTRAINT ab UNIQUE (a, b), CONSTRAINT positive CHECK (a > 0));
    CREATE TABLE child(id INTEGER PRIMARY KEY, pid INT REFERENCES parent(id) ON DELETE RESTRICT);
    INSERT INTO parent VALUES (1, 'x', 1, 1);
    INSERT INTO child VALUES (1, 1);
  `);
  return d;
}

describe('constraint failures carry their fields', () => {
  it('NOT NULL, UNIQUE, PRIMARY KEY, CHECK, foreign keys and column types', () => {
    const d = db();
    expect(errorOf(() => d.exec("INSERT INTO parent VALUES (2, NULL, 2, 2)"))).toMatchObject({ code: 'SMALT_CONSTRAINT_NOTNULL', constraint: 'notNull', table: 'parent', columns: ['code'] });
    expect(errorOf(() => d.exec("INSERT INTO parent VALUES (2, 'y', 1, 1)"))).toMatchObject({ code: 'SMALT_CONSTRAINT_UNIQUE', constraint: 'unique', table: 'parent', columns: ['a', 'b'], constraintName: 'ab' });
    expect(errorOf(() => d.exec("INSERT INTO parent VALUES (1, 'y', 3, 3)"))).toMatchObject({ code: 'SMALT_CONSTRAINT_PRIMARYKEY', constraint: 'primaryKey', table: 'parent', columns: ['id'] });
    expect(errorOf(() => d.exec("INSERT INTO parent VALUES (3, 'y', -1, 3)"))).toMatchObject({ code: 'SMALT_CONSTRAINT_CHECK', constraint: 'check', table: 'parent', constraintName: 'positive' });
    expect(errorOf(() => d.exec('DELETE FROM parent WHERE id = 1'))).toMatchObject({ code: 'SMALT_CONSTRAINT_FOREIGNKEY', constraint: 'foreignKey', table: 'child', columns: ['pid'] });
    expect(errorOf(() => d.exec('INSERT INTO child VALUES (2, 99)'))).toMatchObject({ code: 'SMALT_CONSTRAINT_FOREIGNKEY', constraint: 'foreignKey' });
    expect(errorOf(() => d.exec("INSERT INTO parent VALUES (4, 'y', 'many', 4)"))).toMatchObject({ code: 'SMALT_CONSTRAINT_DATATYPE', constraint: 'datatype', table: 'parent', columns: ['a'] });
    // Errors that are not about a constraint have none of these fields.
    expect(errorOf(() => d.exec('SELECT * FROM nope'))).toMatchObject({ constraint: undefined, table: undefined, origin: undefined });
  });
});

describe('errors carry the origin of the node they arose in', () => {
  const rows = p.values([[p.lit('abc')], [p.lit('(')]], ['text']);
  /** regex_match(row's text, row's text): the second row's pattern is invalid. */
  const badRegex = (origin?: unknown): PlanExpr => ({ ...p.call('regex_match', [p.lit('x'), p.col(0, 0, 'text')], 'int'), ...(origin !== undefined ? { origin } : {}) }) as PlanExpr;

  it('an expression with an origin', () => {
    const e = errorOf(() => Database.openMemory().queryPlan(p.project(rows, [badRegex({ line: 3, col: 7 })])));
    expect(e.message).toMatch(/invalid regular expression/);
    expect(e.origin).toEqual({ line: 3, col: 7 });
  });

  it('the innermost node with an origin, through nodes without one and through generated code', () => {
    const inner = badRegex('inner');
    const outer = { ...p.call('cmp_eq', [p.call('add', [inner, p.lit(1)], 'int'), p.lit(2)], 'int'), origin: 'outer' } as PlanExpr;
    expect(errorOf(() => Database.openMemory().queryPlan(p.filter(rows, outer))).origin).toBe('inner');
    // Without an inner origin, the enclosing node's.
    const plain = { ...p.call('cmp_eq', [p.call('add', [badRegex(), p.lit(1)], 'int'), p.lit(2)], 'int'), origin: 'outer' } as PlanExpr;
    expect(errorOf(() => Database.openMemory().queryPlan(p.filter(rows, plain))).origin).toBe('outer');
    expect(errorOf(() => Database.openMemory().queryPlan(p.project(rows, [plain]))).origin).toBe('outer');
  });

  it('an error found while the plan is compiled', () => {
    const constantBad = { ...p.call('regex_match', [p.lit('x'), p.lit('(')], 'int'), origin: ['span', 4, 9] } as PlanExpr;
    expect(errorOf(() => Database.openMemory().queryPlan(p.project(rows, [constantBad]))).origin).toEqual(['span', 4, 9]);
  });

  it("a write operation's, for its constraint failures", () => {
    const d = db();
    const insert = { ...p.append('parent', p.values([[p.lit(5), p.lit(null), p.lit(5), p.lit(5)]]), [0, 1, 2, 3]), origin: 'insert at 12' } as PlanOp;
    expect(errorOf(() => d.queryPlan({ kind: 'write', plan: insert }))).toMatchObject({ constraint: 'notNull', columns: ['code'], origin: 'insert at 12' });
  });

  it('origins are plain data, carried as JSON, and change no results', () => {
    const d = Database.openMemory();
    const q = p.project(p.values([[p.lit(2)]], ['int']), [{ ...p.call('mul', [p.col(0, 0, 'int'), p.lit(3)], 'int'), origin: { file: 'a.ts', at: [1, 2] } } as PlanExpr]);
    expect(d.queryPlan(q).rows).toEqual([[6]]);
    expect(planFromJSON(planToJSON(q))).toEqual(q);
    // The validator refuses what is not plain data (called directly: such values would not survive JSON anyway).
    const catalog = { tableColumns: () => undefined };
    const bad = (origin: unknown) => errorOf(() => p.validatePlan(p.project(p.values([[p.lit(1)]], ['int']), [{ ...p.lit(1), origin } as PlanExpr]), catalog));
    expect(bad(() => 1)).toMatchObject({ code: 'SMALT_PLAN', message: expect.stringMatching(/origin: expected plain data/) });
    expect(bad(Number.NaN).code).toBe('SMALT_PLAN');
    expect(bad(new Date()).code).toBe('SMALT_PLAN');
    expect(errorOf(() => p.validatePlan({ ...p.values([[p.lit(1)]], ['int']), origin: [undefined] } as unknown as PlanOp, catalog)).code).toBe('SMALT_PLAN');
  });
});

describe('through the client', () => {
  class FakeWorker {
    onmessage: ((e: { data: Response }) => void) | null = null;
    onerror: unknown = null;
    private readonly server = new EngineServer((_session, msg) => setTimeout(() => this.onmessage?.({ data: structuredClone(msg) })), {
      open: () => Database.openMemory(),
      refreshTimer: false,
    });
    postMessage(req: Request): void {
      const r = structuredClone(req);
      setTimeout(() => this.server.receive(EngineServer.LOCAL, r));
    }
    terminate(): void {}
  }
  (globalThis as { Worker?: unknown }).Worker ??= FakeWorker;
  const opened: client.Database[] = [];
  afterEach(async () => {
    for (const d of opened.splice(0)) await d.close();
  });

  it('SmaltdbError carries the fields and the origin', async () => {
    const d = await client.open(':memory:', { storage: 'memory', worker: new FakeWorker() as unknown as Worker });
    opened.push(d);
    await d.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
    await d.exec("INSERT INTO t VALUES (1, 'a')");
    const e = await d.exec("INSERT INTO t VALUES (2, 'a')").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(client.SmaltdbError);
    expect(e).toMatchObject({ code: 'SMALT_CONSTRAINT_UNIQUE', constraint: 'unique', table: 't', columns: ['name'] });
    const bad = { ...p.call('regex_match', [p.lit('x'), p.col(0, 0, 'text')], 'int'), origin: { call: 'str.contains', at: 41 } } as PlanExpr;
    const e2 = await d.queryPlan(p.project(p.values([[p.lit('(')]], ['text']), [bad])).catch((x: unknown) => x);
    expect(e2).toMatchObject({ origin: { call: 'str.contains', at: 41 } });
  });
});
