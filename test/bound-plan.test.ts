/**
 * `boundPlan` (ADR 0022): the plan statement a language binds text to, without running it, as plan data that
 * `queryPlan` takes back.
 */
import { expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { planFromJSON, planToJSON } from '../src/engine/plan/codec.js';

function db(): Database {
  const d = Database.openMemory();
  d.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE, qty INT)');
  d.exec("INSERT INTO t VALUES (1, 'a', 3), (2, 'B', 5), (3, 'c', NULL)");
  return d;
}

it("a query's plan and its columns, in public terms, and nothing runs", () => {
  const d = db();
  const before = d.query('SELECT count(*) FROM t').rows;
  const s = d.boundPlan("SELECT name, qty * 2 AS q FROM t WHERE name = 'b' ORDER BY id") as unknown as { kind: string; plan: { op: string }; columns: { name: string; collation: string }[] };
  expect(s.kind).toBe('query');
  expect(typeof s.plan.op).toBe('string');
  expect(s.columns.map((c) => [c.name, c.collation])).toEqual([['name', 'nocase'], ['q', 'binary']]);
  expect(d.query('SELECT count(*) FROM t').rows).toEqual(before);
});

it('runs again through queryPlan, with the same rows, and survives its JSON form', () => {
  const d = db();
  const sql = "SELECT name, qty * 2 AS q FROM t WHERE name = 'b' OR qty IS NULL ORDER BY id";
  const s = d.boundPlan(sql);
  expect(d.queryPlan(s).rows).toEqual(d.query(sql).rows);
  const q = s as unknown as { kind: 'query'; plan: Parameters<typeof planToJSON>[0] };
  expect(d.queryPlan({ ...q, plan: planFromJSON(planToJSON(q.plan)) }).rows).toEqual(d.query(sql).rows);
});

it('writes, parameters, EXPLAIN and other statements', () => {
  const d = db();
  const w = d.boundPlan('INSERT INTO t(name, qty) VALUES (?, ?)') as unknown as { kind: string; plan: { op: string } };
  expect([w.kind, w.plan.op]).toEqual(['write', 'append']);
  expect(d.query('SELECT count(*) FROM t').rows).toEqual([[3]]);
  expect((d.boundPlan('EXPLAIN QUERY PLAN SELECT * FROM t') as { kind: string }).kind).toBe('explain');
  expect(d.boundPlan('CREATE TABLE u(x)')).toMatchObject({ kind: 'schema' });
  expect(d.boundPlan('BEGIN')).toMatchObject({ kind: 'transaction', action: 'begin' });
  expect(() => d.boundPlan('SELECT * FROM nope')).toThrow(/no such table/);
});
