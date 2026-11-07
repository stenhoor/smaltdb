/**
 * The validator checks everything it is given (ADR 0016 section 9): sources against their real width, schema
 * operations field by field, and no input given as plan data makes the planner crash. Mutations of valid plans are
 * generated from a seed: each must run, or fail with a SmaltError, never a JavaScript error from inside the engine.
 *
 *   PLAN_MUTATIONS=20000 PLAN_SEED=7 npx vitest run test/plan-validate-complete.test.ts
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { SmaltError } from '../src/engine/errors.js';
import * as p from '../src/engine/plan/build.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import { rng } from './helpers.js';

const source = { language: 'test', text: '' };
const column = (name: string, type = 'INTEGER', more: Record<string, unknown> = {}) => ({ name, declaredType: type, type, notNull: false, collation: 'binary', ...more });
const tableDef = (more: Record<string, unknown> = {}) => ({ name: 't', columns: [column('a'), column('b', 'TEXT')], keys: [], checks: [], foreignKeys: [], storage: 'row', ...more });
const createTable = (table: Record<string, unknown> = tableDef(), more: Record<string, unknown> = {}) =>
  ({ kind: 'schema', op: { op: 'createTable', temp: false, ifNotExists: false, table, source, ...more } }) as unknown as PlanStatementInput;
const schema = (op: Record<string, unknown>) => ({ kind: 'schema', op: { source, ...op } }) as unknown as PlanStatementInput;

function fails(db: Database, stmt: PlanStatementInput, msg: RegExp): void {
  let err: unknown;
  try {
    db.queryPlan(stmt);
  } catch (e) {
    err = e;
  }
  expect(err, `expected ${msg}`).toBeInstanceOf(SmaltError);
  expect((err as SmaltError).code).toBe('SMALT_PLAN');
  expect((err as Error).message).toMatch(msg);
}

function withTable(): Database {
  const db = Database.openMemory();
  db.queryPlan(createTable());
  return db;
}

describe('sources are checked against their width', () => {
  it('a virtual table or table function with too few or too many types is refused', () => {
    const db = withTable();
    const info = (n: number) => ({ op: 'source', kind: 'virtual', name: 'columns', schema: 'information_schema', args: [], types: Array(n).fill('any') }) as never;
    const width = db.queryPlan({ op: 'source', kind: 'function', name: 'pragma_table_info', args: [p.lit('t')], types: Array(6).fill('any') } as never).columns.length;
    expect(width).toBe(6);
    fails(db, info(12), /information_schema\.columns has \d+ column\(s\), but 12 type\(s\) are given/);
    fails(db, { op: 'source', kind: 'function', name: 'pragma_table_info', args: [p.lit('t')], types: ['any', 'any'] } as never, /pragma_table_info\(\) has 6 column\(s\), but 2/);
    const n = Number(/has (\d+) column/.exec((() => { try { db.queryPlan(info(1)); } catch (e) { return (e as Error).message; } return ''; })())![1]);
    expect(db.queryPlan(info(n)).rows.length).toBeGreaterThan(0);
  });
});

describe('schema operations given as plan data are validated', () => {
  it('accepts a valid table, index, alteration and drop', () => {
    const db = withTable();
    db.queryPlan(schema({ op: 'createIndex', ifNotExists: false, index: { name: 'ta', table: 't', columns: [{ column: 0, desc: false, collation: 'binary' }], unique: false } }));
    db.queryPlan({ kind: 'write', plan: p.append('t', p.values([[p.lit(1), p.lit('x')]]), [0, 1]) });
    expect(db.queryPlan(p.scan('t', [0, 1])).rows).toEqual([[1, 'x']]);
    db.queryPlan(schema({ op: 'drop', objectType: 'index', name: 'ta', ifExists: false }));
  });

  it('refuses tables that are not well formed', () => {
    const db = Database.openMemory();
    fails(db, createTable(tableDef({ columns: [] })), /table\.columns: a table needs at least one column/);
    fails(db, createTable(tableDef({ columns: [column('a'), column('A')] })), /table\.columns\[1\]: duplicate column name "A"/);
    fails(db, createTable(tableDef({ columns: [column('a', 'int')] })), /columns\[0\]\.type: unknown storage type "int"/);
    fails(db, createTable(tableDef({ columns: [column('a', 'INTEGER', { collation: 'latin1' })] })), /unknown collation "latin1"/);
    fails(db, createTable(tableDef({ storage: 'heap' })), /unknown storage "heap"/);
    fails(db, createTable(tableDef({ keys: [{ kind: 'primaryKey', columns: [{ column: 5, desc: false, collation: 'binary' }] }] })), /keys\[0\]\.columns\[0\]\.column: no column 5/);
    const pk = { kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }] };
    fails(db, createTable(tableDef({ keys: [pk, pk] })), /keys\[1\]: a table has at most one primary key/);
    fails(db, createTable(tableDef({ checks: [{ text: 'c', expr: p.call('cmp_gt', [p.col(0, 5, 'int'), p.lit(0)], 'int') }] })), /checks\[0\]\.expr\.args\[0\]/);
    fails(db, createTable(tableDef({ columns: [column('a', 'INTEGER', { default: { text: 'a', expr: p.col(0, 0, 'int'), value: null } })] })), /default\.expr/);
    fails(db, createTable(tableDef({ foreignKeys: [{ columns: [9], table: 'u', onDelete: 'NO ACTION', onUpdate: 'NO ACTION', deferrable: false, isDeferrable: false }] })), /foreignKeys\[0\]\.columns\[0\]: no column 9/);
    fails(db, createTable(tableDef(), { source: { text: '' } }), /source\.language: expected a name/);
  });

  it('refuses indexes, alterations, views and drops that are not well formed', () => {
    const db = withTable();
    const idx = (index: Record<string, unknown>) => schema({ op: 'createIndex', ifNotExists: false, index: { name: 'i', table: 't', columns: [{ column: 0, desc: false, collation: 'binary' }], unique: false, ...index } });
    fails(db, idx({ table: 'nope' }), /no such table: nope/);
    fails(db, idx({ columns: [{ column: 4, desc: false, collation: 'binary' }] }), /index\.columns\[0\]\.column: no column 4/);
    fails(db, idx({ columns: [{ column: -1, desc: false, collation: 'binary' }] }), /an expression column needs its expression/);
    fails(db, idx({ where: { text: 'w', expr: p.col(0, 7, 'int') } }), /index\.where\.expr/);
    fails(db, schema({ op: 'alterTable', table: 't', action: { kind: 'shuffle' } }), /action\.kind: unknown action "shuffle"/);
    fails(db, schema({ op: 'alterTable', table: 'nope', action: { kind: 'renameTable', newName: 'x' } }), /no such table: nope/);
    fails(db, schema({ op: 'createView', name: '', temp: false, ifNotExists: false, materialized: false }), /createView\.name: expected a name/);
    fails(db, schema({ op: 'drop', objectType: 'sequence', name: 't', ifExists: false }), /unknown object type "sequence"/);
    fails(db, schema({ op: 'vacuumAll' }), /unknown schema operation "vacuumAll"/);
  });
});

/** Valid statements to mutate: queries over two tables, a source, a write and schema operations. */
function seeds(): PlanStatementInput[] {
  const a = p.col(0, 0, 'int');
  const b = p.col(0, 1, 'text');
  const t = p.scan('t', [0, 1]);
  const u = p.scan('u', [0, 1]);
  return [
    p.filter(t, p.call('cmp_gt', [a, p.lit(1)], 'int')),
    p.project(p.sort(t, [p.desc(a)]), [b, p.call('mul', [a, p.lit(2)], 'int')]),
    p.limit(p.join('left', t, u, p.call('cmp_eq', [a, p.col(1, 0, 'int')], 'int')), 3),
    p.aggregate(t, [b], [p.agg('sum', [a], 'int'), p.agg('count', [], 'int', { star: true })]),
    p.distinct(p.setop('unionAll', p.project(t, [a]), p.project(u, [p.col(0, 0, 'int')]), 1), 1),
    p.filter(t, p.exists(p.filter(u, p.call('cmp_eq', [p.col(0, 0, 'int'), p.col(0, 0, 'int', 'binary', 1)], 'int')))),
    { op: 'source', kind: 'function', name: 'pragma_table_info', args: [p.lit('t')], types: Array(6).fill('any') } as never,
    { kind: 'write', plan: p.append('u', p.values([[p.lit(9), p.lit('z')]]), [0, 1]) },
    createTable(tableDef({ name: 'v' })),
    schema({ op: 'createIndex', ifNotExists: true, index: { name: 'ub', table: 'u', columns: [{ column: 1, desc: true, collation: 'nocase' }], unique: false } }),
  ];
}

/** `x` with one field changed: a number off by a little or a lot, a string replaced, a list shortened, a field dropped. */
function mutate(x: unknown, r: () => number): unknown {
  const nodes: { parent: Record<string, unknown> | unknown[]; key: string | number }[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach((c, i) => (nodes.push({ parent: v, key: i }), walk(c)));
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) nodes.push({ parent: v as Record<string, unknown>, key: k }), walk((v as Record<string, unknown>)[k]);
  };
  const copy = structuredClone(x);
  walk(copy);
  const { parent, key } = nodes[Math.floor(r() * nodes.length)];
  const old = (parent as Record<string | number, unknown>)[key];
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  let next: unknown;
  if (typeof old === 'number') next = pick([old + 1, old - 1, -1, 99, 2 ** 40, 0.5, NaN]);
  else if (typeof old === 'string') next = pick(['', 'nope', 'int', 'INTEGER', 'nocase', 'cmp_eq', 'inner']);
  else if (typeof old === 'boolean') next = !old;
  else if (Array.isArray(old)) next = pick([old.slice(1), [...old, old[0]], []]);
  else next = pick([null, undefined, 1, 'x', {}]);
  if (next === undefined && !Array.isArray(parent)) delete (parent as Record<string, unknown>)[key as string];
  else (parent as Record<string | number, unknown>)[key] = next;
  return copy;
}

describe('no plan input makes the engine crash', () => {
  it('generated mutations of valid statements run or fail with a SmaltError', () => {
    const seed = Number(process.env.PLAN_SEED ?? 1);
    const count = Number(process.env.PLAN_MUTATIONS ?? 3000);
    const r = rng(seed);
    const base = seeds();
    const crashes: string[] = [];
    let failed = 0;
    for (let i = 0; i < count && crashes.length < 5; i++) {
      const db = Database.openMemory();
      db.queryPlan(createTable());
      db.queryPlan(createTable(tableDef({ name: 'u', columns: [column('x'), column('y', 'TEXT')] })));
      const stmt = mutate(base[Math.floor(r() * base.length)], r) as PlanStatementInput;
      try {
        db.queryPlan(stmt);
      } catch (e) {
        if (e instanceof SmaltError) failed++;
        else crashes.push(`${(e as Error)?.name}: ${(e as Error)?.message}\n  ${JSON.stringify(stmt, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v))}`);
      }
    }
    expect(crashes.join('\n\n')).toBe('');
    expect(failed).toBeGreaterThan(count / 10);
  }, 120_000);
});
