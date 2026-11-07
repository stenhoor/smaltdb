/**
 * The logical catalog (ADR 0016 section 7): tables, views, functions and settings in plan terms, the same in process,
 * while binding and on the client, plus the engine's help for building plans (result types, expression types,
 * constant evaluation).
 */
import { describe, expect, it } from 'vitest';
import { Database, plan as p } from '../src/engine/index.js';
import { EngineServer } from '../src/engine/server.js';
import type { BindContext } from '../src/engine/plan/bind-context.js';
import type { CatalogData } from '../src/engine/plan/catalog.js';
import { comparisonRule, describeTableDef, engineFunctions } from '../src/engine/language-support.js';
import type { TableDef } from '../src/engine/plan/schema.js';
import type { Request, Response } from '../src/shared/protocol.js';
import { until } from './helpers/wait.js';

function db(): Database {
  const d = Database.openMemory();
  d.exec(`
    CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT COLLATE NOCASE NOT NULL, score REAL DEFAULT 0, tag VARCHAR(10) UNIQUE, n);
    CREATE INDEX t_score ON t(score DESC) WHERE score > 0;
    CREATE TABLE pair(a INT, b INT, PRIMARY KEY (a, b));
    CREATE TABLE c(day INT, ms REAL) WITH (storage = 'columnar');
    CREATE VIEW v(x) AS SELECT id FROM t;
    CREATE MATERIALIZED VIEW mv AS SELECT count(*) AS n FROM t;
  `);
  return d;
}

describe('tables and views', () => {
  it('describes columns in plan terms, with keys, indexes and storage', () => {
    const t = db().catalog.table('T')!;
    expect(t).toMatchObject({ kind: 'table', name: 't', schema: 'main', storage: 'row', strict: true });
    expect(t.columns.map((c) => [c.name, c.type, c.storageType, c.declaredType, c.collation, c.notNull, c.rowid, c.hasDefault])).toEqual([
      ['id', 'int', 'INTEGER', 'INTEGER', 'binary', true, true, false],
      ['name', 'text', 'TEXT', 'TEXT', 'nocase', true, false, false],
      ['score', 'real', 'REAL', 'REAL', 'binary', false, false, true],
      ['tag', 'text', 'TEXT', 'VARCHAR(10)', 'binary', false, false, false],
      ['n', 'any', 'ANY', '', 'binary', false, false, false],
    ]);
    expect(t.keys).toEqual([
      { kind: 'primaryKey', columns: [0] },
      { kind: 'unique', columns: [3] },
    ]);
    expect(t.indexes.find((i) => i.name === 't_score')).toEqual({ name: 't_score', columns: [{ column: 2, desc: true, collation: 'binary' }], unique: false, partial: true });
  });

  it('lists composite keys, columnar tables, materialized views and views', () => {
    const d = db();
    expect(d.catalog.table('pair')!.keys).toEqual([{ kind: 'primaryKey', columns: [0, 1] }]);
    expect(d.catalog.table('c')!.storage).toBe('columnar');
    expect(d.catalog.table('mv')!.kind).toBe('materializedView');
    expect(d.catalog.tables().map((t) => t.name).sort()).toEqual(['c', 'mv', 'pair', 't']);
    expect(d.catalog.view('v')).toMatchObject({ name: 'v', schema: 'main', language: 'sql', columns: ['x'] });
    expect(d.catalog.view('v')!.text).toMatch(/SELECT id FROM t/);
  });

  it('follows schema changes, and finds a TEMP table before the main one it shadows', () => {
    const d = db();
    expect(d.catalog.table('w')).toBeUndefined();
    d.exec('CREATE TABLE w(a TEXT)');
    expect(d.catalog.table('w')!.columns[0].type).toBe('text');
    d.exec('CREATE TEMP TABLE w(b INT); CREATE TEMP VIEW tv AS SELECT 1');
    expect(d.catalog.table('w')).toMatchObject({ schema: 'temp', columns: [{ name: 'b' }] });
    expect(d.catalog.table('w', 'main')).toMatchObject({ schema: 'main', columns: [{ name: 'a' }] });
    expect(d.catalog.view('tv')!.schema).toBe('temp');
    d.exec('DROP TABLE t');
    expect(d.catalog.table('t')).toBeUndefined();
  });

  it('maps declared types as the engine stores them', () => {
    expect(['INT', 'BIGINT', 'VARCHAR(5)', 'BLOB', 'DOUBLE', 'DECIMAL(10,2)', 'BOOLEAN', '', 'ANY'].map((t) => p.declaredType(t))).toEqual([
      { storageType: 'INTEGER', type: 'int', affinity: 'INTEGER' },
      { storageType: 'INTEGER', type: 'int', affinity: 'INTEGER' },
      { storageType: 'TEXT', type: 'text', affinity: 'TEXT' },
      { storageType: 'BLOB', type: 'blob', affinity: 'BLOB' },
      { storageType: 'REAL', type: 'real', affinity: 'REAL' },
      { storageType: 'NUMERIC', type: 'any', affinity: 'NUMERIC' },
      { storageType: 'NUMERIC', type: 'any', affinity: 'NUMERIC' },
      { storageType: 'ANY', type: 'any', affinity: 'BLOB' },
      { storageType: 'ANY', type: 'any', affinity: 'BLOB' },
    ]);
  });
});

describe('functions', () => {
  const c = Database.openMemory().catalog;

  it('describes operations, named functions, aggregates and window functions', () => {
    expect(c.function('cmp_eq')).toMatchObject({ name: 'cmp_eq', kind: 'scalar', minArgs: 2, maxArgs: 2, deterministic: true, result: 'int', traits: { compare: '=' } });
    expect(c.function('cmp_eq')!.operation).toBe(true);
    expect(c.function('sql.eq')).toBeUndefined();
    expect(c.function('upper')).toMatchObject({ kind: 'scalar', minArgs: 1, maxArgs: 1, deterministic: true, result: 'text' });
    expect(c.function('upper')!.operation).toBeUndefined();
    expect(c.function('coalesce')!.maxArgs).toBeNull();
    expect(c.function('random')!.deterministic).toBe(false);
    expect(c.function('date')).toMatchObject({ deterministic: false, dateTime: true }); // reads the clock for 'now'
    expect(c.function('random')!.dateTime).toBeUndefined();
    expect(c.function('sum')).toMatchObject({ kind: 'aggregate', minArgs: 1, maxArgs: 1 });
    expect(c.function('row_number')).toMatchObject({ kind: 'window', minArgs: 0, maxArgs: 0, result: 'int' });
    expect(c.function('cume_dist')!.result).toBe('real');
    expect(c.function('no_such_function')).toBeUndefined();
    const names = c.functions().map((f) => f.name);
    expect(names).toEqual([...names].sort());
    const keys = c.functions().map((f) => `${f.name}/${f.kind}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(names).not.toContain('sql.eq');
    // min and max are a scalar (of several arguments) and an aggregate.
    expect(c.function('max')!.kind).toBe('scalar');
    expect(c.function('max', 'aggregate')).toMatchObject({ kind: 'aggregate', maxArgs: 1 });
    expect(c.function('upper', 'aggregate')).toBeUndefined();
  });

  it('are the same for every database, and without one (smaltdb/language engineFunctions)', () => {
    expect(engineFunctions.functions()).toEqual(c.functions());
    expect(engineFunctions.function('max', 'aggregate')).toEqual(c.function('max', 'aggregate'));
    expect(engineFunctions.resultType('div_float', ['int', 'int'])).toBe('real');
  });

  it('gives result types for argument types', () => {
    expect(c.resultType('add', ['int', 'int'])).toBe('int');
    expect(c.resultType('div_float', ['int', 'int'])).toBe('real');
    expect(c.resultType('upper', ['text'])).toBe('text');
    expect(c.resultType('avg', ['int'])).toBe('real');
    expect(c.resultType('lag', [{ type: 'text', collation: 'nocase' }])).toBe('text');
    expect(c.resultType('nope', [])).toBeUndefined();
  });
});

describe('help for building plans', () => {
  const c = Database.openMemory().catalog;

  it('evaluates constant expressions, and nothing else', () => {
    expect(c.constant(p.call('add', [p.lit(1), p.lit(2)], 'int'))).toEqual({ value: 3 });
    expect(c.constant(p.call('upper', [p.lit('a')], 'text'))).toEqual({ value: 'A' });
    expect(c.constant(p.lit(null))).toEqual({ value: null });
    expect(c.constant(p.call('add', [p.col(0, 0, 'int'), p.lit(2)], 'int'))).toBeNull();
    expect(c.constant(p.call('add', [p.param(0), p.lit(2)], 'int'))).toBeNull();
    expect(c.constant(p.call('random', [], 'int'))).toBeNull();
  });

  it('gives the type the engine computes', () => {
    expect(c.typeOf(p.call('upper', [p.lit('a')], 'any'))).toBe('text');
    expect(c.typeOf(p.call('div_float', [p.col(0, 0, 'int'), p.lit(2)], 'any'))).toBe('real');
    expect(c.typeOf(p.col(0, 0, 'text'))).toBe('text');
    expect(c.typeOf(p.scalar(p.values([[p.lit(1)]]), 'int'))).toBe('int');
  });

  it('describes an expression as the engine computes it: type, collation and affinity', () => {
    const name = { ...p.col(0, 1, 'text'), carries: { collation: 'nocase', from: 'column' }, affinity: 'TEXT' } as const;
    expect(c.describe(name)).toEqual({ type: 'text', carries: { collation: 'nocase', from: 'column' }, affinity: 'TEXT' });
    // A cast keeps its operand's collation; a function's result carries none.
    expect(c.describe(p.cast('cast_text', name, 'text'))).toEqual({ type: 'text', carries: { collation: 'nocase', from: 'column' } });
    expect(c.describe(p.call('upper', [name], 'any'))).toEqual({ type: 'text' });
    expect(c.describe(p.lit(1))).toEqual({ type: 'int' });
  });

  it('reports the settings, and follows them', () => {
    const d = Database.openMemory();
    expect(d.catalog.settings()).toMatchObject({ foreignKeys: expect.any(Boolean), workMem: expect.any(Number), matviewRewrite: false, parallelAggregates: true });
    d.exec('PRAGMA matview_rewrite = on; PRAGMA work_mem = 1048576');
    expect(d.catalog.settings()).toMatchObject({ matviewRewrite: true, workMem: 1048576 });
  });
});

describe('the same catalog everywhere', () => {
  it('as plain data, on BindContext and through the worker protocol', async () => {
    const d = db();
    const data = d.catalog.snapshot();
    expect(structuredClone(data)).toEqual(data);
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    expect((d as unknown as { bindContext(): BindContext }).bindContext().catalog.table('t')).toEqual(d.catalog.table('t'));

    const log: { session: string; msg: Response }[] = [];
    const server = new EngineServer((session, msg) => log.push({ session, msg }), { open: () => db(), watchSession: () => undefined });
    server.receive(EngineServer.LOCAL, { id: 1, op: 'open', name: ':memory:', storage: 'memory' } as Request);
    server.receive('tab', { id: 2, op: 'catalog' } as Request);
    await until('the catalog', () => log.some((m) => m.msg.id === 2));
    const reply = log.find((m) => m.msg.id === 2)!.msg as { kind: string; value: CatalogData };
    expect(reply.kind).toBe('ok');
    expect(reply.value.tables.map((t) => t.name).sort()).toEqual(['c', 'mv', 'pair', 't']);
    expect(reply.value.functions.find((f) => f.name === 'cmp_eq')!.traits).toEqual({ compare: '=', inline: '=' });
  });
});

describe('tables while binding', () => {
  it('BindContext gives tables as the catalog describes them, system tables included, refusing what may not be written or indexed', () => {
    const d = db();
    const ctx = (d as unknown as { bindContext(): BindContext }).bindContext();
    expect(ctx.table('t')).toEqual(d.catalog.table('t'));
    expect(ctx.table('t')!.source).toEqual({ language: 'sql', text: expect.stringMatching(/^CREATE TABLE t\(/) });
    expect(ctx.table('sqlite_schema')!.kind).toBe('system');
    expect(ctx.writeTable('t').name).toBe('t');
    expect(() => ctx.writeTable('v')).toThrow(/cannot modify v because it is a view/);
    expect(() => ctx.writeTable('sqlite_schema')).toThrow();
    expect(ctx.indexTable('t').name).toBe('t');
    expect(() => ctx.indexTable('c')).toThrow(/columnar/);
    expect(d.catalog.table('mv')!.source).toEqual({ language: 'sql', text: expect.stringMatching(/SELECT count\(\*\)/) });
  });

  it('counts a TEMP table found with table() or writeTable() as a memory object the statement reads', () => {
    const d = db();
    d.exec('CREATE TEMP TABLE scratch(a INT)');
    const binding = (lookup: (ctx: BindContext) => unknown) => ({ text: '', paramCount: 0, paramNames: [], bind: (ctx: BindContext) => (lookup(ctx), { kind: 'transaction' }) }) as never;
    expect(d.bindsMemoryObjects(binding((ctx) => ctx.table('scratch')))).toBe(true);
    expect(d.bindsMemoryObjects(binding((ctx) => ctx.writeTable('scratch')))).toBe(true);
    expect(d.bindsMemoryObjects(binding((ctx) => ctx.table('t')))).toBe(false);
  });

  it('follows CREATE INDEX on a table it described', () => {
    const d = db();
    const ctx = (d as unknown as { bindContext(): BindContext }).bindContext();
    expect(ctx.table('pair')!.indexes.map((i) => i.name)).not.toContain('pair_b');
    d.exec('CREATE INDEX pair_b ON pair(b)');
    expect(ctx.table('pair')!.indexes.map((i) => i.name)).toContain('pair_b');
  });

  it('describes a table definition as CREATE TABLE will make it', () => {
    const col = (name: string, type: string, more: object = {}) => ({ name, declaredType: type, type: p.declaredType(type).storageType, notNull: false, collation: 'binary', ...more });
    const defs: TableDef[] = [
      { name: 'a', columns: [col('id', 'INTEGER'), col('s', 'TEXT', { collation: 'nocase', notNull: true })], keys: [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }] }], checks: [], foreignKeys: [], storage: 'row' },
      { name: 'b', columns: [col('x', 'INT'), col('y', 'VARCHAR(4)')], keys: [{ kind: 'primaryKey', columns: [{ column: 0, desc: false, collation: 'binary' }, { column: 1, desc: false, collation: 'binary' }] }, { kind: 'unique', columns: [{ column: 1, desc: false, collation: 'binary' }] }], checks: [], foreignKeys: [], storage: 'row' },
      { name: 'c', columns: [col('n', ''), col('r', 'REAL', { default: { text: '0', value: 0, expr: p.lit(0) } })], keys: [], checks: [], foreignKeys: [], storage: 'columnar' },
    ] as TableDef[];
    const d = Database.openMemory();
    for (const def of defs) {
      const source = { language: 'plan', text: def.name };
      d.queryPlan({ kind: 'schema', op: { op: 'createTable', temp: false, ifNotExists: false, table: def, source } } as never);
      const made = d.catalog.table(def.name)!;
      const { indexes: _a, ...described } = describeTableDef(def, source);
      const { indexes: _b, ...actual } = made;
      expect(described, def.name).toEqual(actual);
    }
  });
});

describe('comparison rules', () => {
  it('give the collation and the conversions a comparison of these operands uses', () => {
    const intCol = { type: 'int' as const, affinity: 'INTEGER' as const, carries: { collation: 'binary' as const, from: 'column' as const } };
    const textCol = { type: 'text' as const, affinity: 'TEXT' as const, carries: { collation: 'nocase' as const, from: 'column' as const } };
    const textLit = { type: 'text' as const };
    expect(comparisonRule(intCol, textLit)).toEqual({ collation: 'binary', left: null, right: 'affinity_numeric' });
    expect(comparisonRule(textLit, intCol)).toEqual({ collation: 'binary', left: 'affinity_numeric', right: null });
    expect(comparisonRule(textCol, { type: 'int' })).toEqual({ collation: 'nocase', left: null, right: 'affinity_text' });
    expect(comparisonRule(intCol, textCol)).toEqual({ collation: 'binary', left: null, right: 'affinity_numeric' });
    // An explicit collation wins; TEXT affinity still converts an operand with none.
    expect(comparisonRule(textCol, { type: 'text', carries: { collation: 'rtrim', from: 'explicit' } })).toEqual({ collation: 'rtrim', left: null, right: 'affinity_text' });
    expect(comparisonRule(textLit, textLit)).toEqual({ collation: 'binary', left: null, right: null });
  });
});
