/**
 * A language's plans may hold operations the planner plans only after rewriting them (sample, pivot, explode, as-of
 * joins, …), as plan statements may (ADR 0022): the engine rewrites them on receipt.
 */
import { afterEach, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { registerLanguage } from '../src/engine/index.js';
import { type LanguageStatement, registeredLanguage } from '../src/engine/plan/language.js';
import type { PlanOp } from '../src/engine/plan/ops.js';

const sql = registeredLanguage('sql')!;
afterEach(() => registerLanguage(sql));

it("a language's sample is planned", () => {
  // SQL, with every query's plan wrapped in a sample of 2 rows.
  const wrap = (st: LanguageStatement): LanguageStatement =>
    Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
      bind: (ctx: Parameters<LanguageStatement['bind']>[0]) => {
        const b = st.bind(ctx) as { kind: string; plan: PlanOp };
        if (b.kind !== 'query') return b;
        return { ...b, plan: { op: 'sample', input: b.plan, count: { k: 'lit', value: 2, type: 'int' }, replace: false, seed: 1 } };
      },
    });
  registerLanguage({ ...sql, parseOne: (text: string) => wrap(sql.parseOne!(text)), parse: (text: string) => sql.parse!(text).map(wrap) });
  const d = Database.openMemory();
  d.exec('CREATE TABLE t(i INTEGER)');
  d.exec('INSERT INTO t VALUES (1), (2), (3), (4), (5)');
  expect(d.query('SELECT i FROM t').rows).toHaveLength(2);
});

it("a call's declared type stands where the function can't tell its own (struct_field)", async () => {
  const d = Database.openMemory();
  const type = 'struct<name text, tags list<text>>';
  const col = { name: 's', declaredType: type, type: 'STRUCT', notNull: false, collation: 'binary' } as const;
  await d.queryPlanAsync({ kind: 'schema', op: { op: 'createTable', table: { name: 't', columns: [col], keys: [], checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false } } as never);
  await d.queryPlanAsync({ kind: 'write', plan: { op: 'append', table: 't', db: 'main', input: { op: 'values', rows: [], types: [type], columns: [[{ name: 'a', tags: ['x', 'y'] }]] }, columns: [0], upserts: [] } } as never);
  // The tags field, declared list<text> on the call, read as a list: its JSON text and its length.
  const field = { k: 'call', fn: 'struct_field', args: [{ k: 'col', input: 0, index: 0, depth: 0, type, collation: 'binary' }, { k: 'lit', value: 1, type: 'int' }], type: 'list<text>' };
  const r = (await d.queryPlanAsync({ kind: 'query', plan: { op: 'project', input: { op: 'scan', table: 't', columns: [0] }, exprs: [{ k: 'call', fn: 'cast_text', args: [field], type: 'text' }, { k: 'call', fn: 'list_len', args: [field], type: 'int' }] } } as never)) as { rows: unknown[][] };
  expect(r.rows).toEqual([['["x","y"]', 2]]);
});
