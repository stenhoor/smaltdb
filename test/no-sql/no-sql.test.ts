/**
 * The engine with no SQL (ADR 0017): no language is registered in this project (vitest.no-sql.config.ts), so anything
 * here that reached SQL would fail. It runs the engine through plans, the client and worker server, scheduled work,
 * ALTER TABLE once the engine's own tables exist, parallel readers, and the plugins pinned in packed.json, with a
 * language that has no parser and keeps its views as JSON.
 */
import external from '@smaltdb/external';
import { registerFile } from '@smaltdb/external/client';
import { exportCSV, exportJSON, importCSV, importJSON } from '@smaltdb/io/client';
import io from '@smaltdb/io';
import { afterEach, describe, expect, it } from 'vitest';
import * as client from '../../src/client/index.js';
import { Database } from '../../src/engine/database.js';
import { plan as p } from '../../src/engine/index.js';
import { registerLanguage, registeredLanguage } from '../../src/engine/plan/language.js';
import type { ColumnDef, SchemaOp, Source } from '../../src/engine/plan/schema.js';
import type { PlanStatementInput } from '../../src/engine/plan/statement.js';
import { EngineServer, type ReaderPool } from '../../src/engine/server.js';
import { Collation } from '../../src/engine/values.js';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';
import type { Request, Response } from '../../src/shared/protocol.js';

/** Views only: a view is JSON naming a table and its columns. No parser, no source editor. */
registerLanguage({
  name: 'frames',
  bindView(source, ctx) {
    const f = JSON.parse(source.text) as { table: string; columns: string[] };
    const t = ctx.table(f.table);
    if (!t) throw new Error(`no such table: ${f.table}`);
    const at = f.columns.map((c) => t.columns.findIndex((x) => x.name === c));
    return { kind: 'query', plan: p.project(p.scan(t.name, at), at.map((_, i) => p.col(0, i, 'any'))), columns: f.columns.map((name) => ({ name, type: 'any', collation: Collation.Binary, affinity: 'NONE' })) } as never;
  },
  viewReferences: (s) => [{ name: (JSON.parse(s.text) as { table: string }).table }],
  viewDefinition: (s) => s.text,
});
const frames = (table: string, columns: string[]): Source => ({ language: 'frames', text: JSON.stringify({ table, columns }) });

const col = (name: string, type: ColumnDef['type'], more: Partial<ColumnDef> = {}): ColumnDef => ({ name, declaredType: type, type, notNull: false, collation: 'binary', ...more });
const pk = [{ kind: 'primaryKey' as const, columns: [{ column: 0, desc: false, collation: 'binary' as const }] }];
const createTable = (name: string, columns: ColumnDef[], more: Partial<Extract<SchemaOp, { op: 'createTable' }>['table']> = {}): SchemaOp => ({
  op: 'createTable',
  table: { name, columns, keys: pk, checks: [], foreignKeys: [], storage: 'row', ...more },
  temp: false,
  ifNotExists: false,
});
const matview = (name: string, source: Source, options = {}): SchemaOp => ({ op: 'createView', name, temp: false, ifNotExists: false, materialized: true, options, source });
const refresh = (view: string, ifChanged = false): PlanStatementInput => ({ kind: 'maintenance', action: 'refresh', view, concurrently: false, withData: true, ifChanged });
const run = (d: Database, s: PlanStatementInput) => d.preparePlan(s).run();
const schema = (d: Database, op: SchemaOp) => run(d, { kind: 'schema', op });
const rows = (d: Database, s: PlanStatementInput) => d.queryPlan(s).rows;
const insert = (d: Database, table: string, values: number[][]) => run(d, { kind: 'write', plan: p.append(table, p.values(values.map((r) => r.map((v) => p.lit(v)))), values[0].map((_, i) => i)) });

it('no SQL language is registered here', () => {
  expect(registeredLanguage('sql')).toBeUndefined();
});

describe('the engine through plans', () => {
  it('tables, constraints, storage, transactions, settings, maintenance and introspection', async () => {
    const vfs = new MemoryVfs();
    const d = await Database.open(vfs, 'db');
    const positive = { text: 'id > 0', expr: p.call('cmp_gt', [p.col(0, 0, 'int'), p.lit(0)], 'int') };
    schema(d, createTable('parent', [col('id', 'INTEGER'), col('name', 'TEXT', { default: { text: "'x'", expr: p.lit('x'), value: 'x' } })], { checks: [positive] }));
    schema(d, createTable('child', [col('id', 'INTEGER'), col('pid', 'INTEGER')], { foreignKeys: [{ columns: [1], table: 'parent', onDelete: 'CASCADE', onUpdate: 'NO ACTION', deferrable: false, isDeferrable: false }] }));
    schema(d, createTable('cols', [col('id', 'INTEGER'), col('v', 'REAL')], { storage: 'columnar' }));
    run(d, { kind: 'setting', name: 'foreign_keys', value: p.lit(1) });
    insert(d, 'parent', [[1], [2]]);
    insert(d, 'child', [[10, 1], [11, 2]]);
    expect(() => insert(d, 'parent', [[-1]])).toThrow(/check/i);
    expect(() => insert(d, 'child', [[12, 99]])).toThrow(/foreign key/i);
    run(d, { kind: 'write', plan: p.remove('parent', p.filter(p.scan('parent', [-1, 0]), p.call('cmp_eq', [p.col(0, 1, 'int'), p.lit(1)], 'int')), 0) });
    expect(rows(d, p.scan('child', [0]))).toEqual([[11]]);
    run(d, { kind: 'write', plan: p.append('cols', p.fromColumns([new Int32Array([1, 2]), new Float64Array([0.5, 1.5])], ['int', 'real']), [0, 1]) });
    run(d, { kind: 'setting', name: 'compact', value: p.lit('cols') });
    expect(rows(d, p.aggregate(p.scan('cols', [1]), [], [p.agg('sum', [p.col(0, 0, 'real')], 'real')]))).toEqual([[2]]);
    run(d, { kind: 'transaction', action: 'begin', mode: 'deferred' });
    insert(d, 'parent', [[5]]);
    run(d, { kind: 'transaction', action: 'rollback' });
    expect(rows(d, p.scan('parent', [0]))).toEqual([[2]]);
    run(d, { kind: 'maintenance', action: 'analyze' });
    expect(rows(d, { kind: 'explain', mode: 'plan', query: { kind: 'query', plan: p.scan('child', [0]) } } as PlanStatementInput).length).toBeGreaterThan(0);
    expect(d.catalog.tables().map((t) => t.name)).toEqual(['parent', 'child', 'cols']);
    // The engine's own tables carry its description, not SQL text.
    const texts = rows(d, { op: 'scan', table: 'sqlite_schema', columns: [1, 4] } as never) as [string, string | null][];
    for (const [name, text] of texts.filter(([n]) => n.startsWith('smalt_'))) expect(text, name).not.toMatch(/^CREATE/);
    d.close();
    const again = await Database.open(vfs, 'db');
    expect(rows(again, p.scan('child', [0, 1]))).toEqual([[11, 2]]);
    again.close();
  });

  it('views and materialized views from a language with no parser', async () => {
    const d = Database.openMemory();
    schema(d, createTable('t', [col('id', 'INTEGER'), col('v', 'INTEGER')]));
    insert(d, 't', [[1, 10], [2, 20]]);
    schema(d, { op: 'createView', name: 'v', temp: false, ifNotExists: false, materialized: false, source: frames('t', ['v']) });
    expect(rows(d, p.scan('v', [0]))).toEqual([[10], [20]]);
    schema(d, matview('mv', frames('t', ['id'])));
    insert(d, 't', [[3, 30]]);
    expect(run(d, refresh('mv')).changes).toBe(3);
    // IF CHANGED as a plan: the view's sources are checked, as for SQL (ADR 0017 decision 3).
    insert(d, 't', [[4, 40]]);
    expect((await d.queryPlanAsync(refresh('mv', true))).changes).toBe(4);
    expect((await d.queryPlanAsync(refresh('mv', true))).changes).toBe(0);
    expect(rows(d, p.scan('mv', [0]))).toEqual([[1], [2], [3], [4]]);
  });

  it('ALTER TABLE once the engine has made its own tables', () => {
    const d = Database.openMemory();
    schema(d, createTable('t', [col('id', 'INTEGER'), col('v', 'INTEGER')]));
    // ANALYZE, a columnar table and a materialized view each make a system table.
    run(d, { kind: 'maintenance', action: 'analyze' });
    schema(d, createTable('c', [col('id', 'INTEGER')], { storage: 'columnar' }));
    schema(d, createTable('u', [col('id', 'INTEGER')]));
    schema(d, matview('mv', frames('u', ['id'])));
    // ALTER TABLE asks each object's language to edit its text, and frames has no editor: drop the view (its system
    // table stays), so that only the engine's own tables remain to be considered.
    schema(d, { op: 'drop', objectType: 'materialized view', name: 'mv', ifExists: false });
    expect(d.catalog.tables().map((t) => t.name)).not.toContain('mv');
    schema(d, { op: 'alterTable', table: 't', action: { kind: 'renameColumn', column: 'v', newName: 'w' } });
    schema(d, { op: 'alterTable', table: 't', action: { kind: 'renameTable', newName: 't2' } });
    schema(d, { op: 'alterTable', table: 't2', action: { kind: 'dropColumn', column: 'w' } });
    expect(d.catalog.table('t2')!.columns.map((c) => c.name)).toEqual(['id']);
  });

  it('parallel aggregates for plans', () => {
    const d = Database.openMemory();
    schema(d, createTable('t', [col('id', 'INTEGER'), col('g', 'INTEGER'), col('n', 'INTEGER')]));
    run(d, { kind: 'write', plan: p.append('t', p.fromColumns([Int32Array.from({ length: 5000 }, (_, i) => i + 1), Int32Array.from({ length: 5000 }, (_, i) => i % 7), Int32Array.from({ length: 5000 }, (_, i) => i)], ['int', 'int', 'int']), [0, 1, 2]) });
    const q = p.sort(p.aggregate(p.scan('t', [1, 2]), [p.col(0, 0, 'int')], [p.agg('count', [], 'int', { star: true }), p.agg('sum', [p.col(0, 1, 'int')], 'int')]), [p.asc(p.col(0, 0, 'int'))]);
    const merged = d.queryMorsels(d.preparePlan(q), undefined, 4, 0);
    expect(merged).not.toBeNull();
    expect(merged!.rows).toEqual(rows(d, q));
  });

  it('external tables record their language, through the pinned plugins', async () => {
    const d = await Database.open(new MemoryVfs(), 'db', { plugins: [external, io] });
    await registerFile(d, 'x.csv', 'a,b\n1,x\n2,y\n');
    const ext = (name: string, source?: Source): PlanStatementInput => ({ kind: 'schema', op: { op: 'createExternalTable', name, ifNotExists: false, columns: [{ name: 'a', declaredType: 'INTEGER', constrained: false }, { name: 'b', declaredType: 'TEXT', constrained: false }], options: { location: 'file:x.csv' }, ...(source ? { source } : {}) } });
    run(d, ext('e1', { language: 'frames', text: '{"external":"x.csv"}' }));
    run(d, ext('e2'));
    expect(d.catalog.table('e1')!.source).toEqual({ language: 'frames', text: '{"external":"x.csv"}' });
    expect(d.catalog.table('e2')!.source).toBeUndefined();
    expect((await d.queryPlanAsync({ op: 'source', kind: 'external', name: 'e2', args: [], types: ['int', 'text'] } as never)).rows).toEqual([[1, 'x'], [2, 'y']]);
  });
  it('@smaltdb/io imports and exports through plans (ADR 0017 decision 7)', async () => {
    const d = Database.openMemory({ plugins: [io] });
    expect(await importCSV(d, 'm', 'a,b\n1,x\n2,y\n', { create: true })).toEqual({ rows: 2 });
    expect(await importJSON(d, 'm', '[{"a":3,"b":"z"}]')).toEqual({ rows: 1 });
    expect(d.catalog.table('m')!.source).toBeUndefined();
    const q: PlanStatementInput = { kind: 'query', plan: p.project(p.scan('m', [0, 1]), [p.col(0, 0, 'int'), p.col(0, 1, 'text')]), columns: [{ name: 'a' }, { name: 'b' }] };
    expect(await exportCSV(d, q)).toBe('a,b\n1,x\n2,y\n3,z\n');
    expect(await exportJSON(d, q, [], { format: 'ndjson' })).toBe('{"a":1,"b":"x"}\n{"a":2,"b":"y"}\n{"a":3,"b":"z"}\n');
    // A failing import rolls back as a whole.
    await expect(importCSV(d, 'm', 'a,b\n4,w\n5\n')).rejects.toThrow(/CSV line 3/);
    expect(rows(d, q).length).toBe(3);
  });
});

describe('the client and worker server', () => {
  class FakeWorker {
    onmessage: ((e: { data: Response }) => void) | null = null;
    onerror: unknown = null;
    readonly offered: string[] = [];
    readonly server: EngineServer;
    constructor(readers = false) {
      const pool: ReaderPool = {
        // Records what the server would hand a reader, and declines it: the owner answers.
        dispatch: (_s, req) => (this.offered.push(req.op === 'queryPlan' ? (JSON.parse(req.plan) as { kind?: string }).kind ?? 'query' : 'sql'), false),
        forward: () => false,
      };
      this.server = new EngineServer((_s, msg) => setTimeout(() => this.onmessage?.({ data: structuredClone(msg) })), { open: () => Database.openMemory({ plugins: [io] }), refreshTimer: false, ...(readers ? { readers: pool } : {}) });
    }
    postMessage(req: Request): void {
      const r = structuredClone(req);
      setTimeout(() => this.server.receive(EngineServer.LOCAL, r));
    }
    terminate(): void {}
  }
  (globalThis as { Worker?: unknown }).Worker ??= FakeWorker;
  const opened: client.Database[] = [];
  afterEach(async () => {
    for (const db of opened.splice(0)) await db.close();
  });
  async function open(readers = false): Promise<{ db: client.Database; worker: FakeWorker }> {
    const worker = new FakeWorker(readers);
    const db = await client.open(':memory:', { storage: 'memory', worker: worker as unknown as Worker });
    opened.push(db);
    await db.queryPlan({ kind: 'schema', op: createTable('t', [col('id', 'INTEGER')]) });
    return { db, worker };
  }

  it('transactions of plans commit and roll back (ADR 0017 decision 1)', async () => {
    const { db } = await open();
    const r = await db.transaction((tx) => tx.queryPlan({ kind: 'write', plan: p.append('t', p.values([[p.lit(1)]]), [0]) }));
    expect(r.changes).toBe(1);
    await expect(
      db.transaction(async (tx) => {
        await tx.queryPlan({ kind: 'write', plan: p.append('t', p.values([[p.lit(2)]]), [0]) });
        throw new Error('undo');
      }),
    ).rejects.toThrow('undo');
    expect([...(await db.queryPlan(p.scan('t', [0]), [], { rowMode: 'array' }))]).toEqual([[1]]);
  });

  it('@smaltdb/io through the client', async () => {
    const { db } = await open();
    expect(await importJSON(db, 'j', '[{"n":1},{"n":2}]', { create: true })).toEqual({ rows: 2 });
    expect(await exportCSV(db, { kind: 'query', plan: p.scan('j', [0]), columns: [{ name: 'n' }] })).toBe('n\n1\n2\n');
  });

  it('scheduled refreshes run as plans (ADR 0017 decision 2)', async () => {
    const { db, worker } = await open();
    await db.queryPlan({ kind: 'schema', op: matview('mv', frames('t', ['id']), { refresh_every: 1 }) });
    await db.queryPlan({ kind: 'write', plan: p.append('t', p.values([[p.lit(7)]]), [0]) });
    worker.server.refreshTick(Date.now() + 10_000);
    const status = async () => [...(await db.queryPlan({ op: 'source', kind: 'virtual', name: 'materialized_views', schema: 'information_schema', args: [], types: Array(11).fill('any') } as never, [], { rowMode: 'array' }))][0];
    for (let i = 0; i < 100 && [...(await db.queryPlan(p.scan('mv', [0]), [], { rowMode: 'array' }))].length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect([...(await db.queryPlan(p.scan('mv', [0]), [], { rowMode: 'array' }))]).toEqual([[7]]);
    expect((await status())[10]).toBeNull(); // last_refresh_error
  });

  it('readers are offered queries only, never transaction statements', async () => {
    const worker = new FakeWorker(true);
    const server = worker.server;
    const replies: Response[] = [];
    worker.onmessage = (e) => replies.push(e.data);
    const plan = (stmt: PlanStatementInput) => JSON.stringify(stmt);
    let id = 1;
    const send = (req: Omit<Extract<Request, { op: 'queryPlan' }>, 'id'> | { op: string; [k: string]: unknown }) => server.receive(EngineServer.LOCAL, { id: id++, ...req } as Request);
    send({ op: 'open', name: ':memory:', storage: 'memory' });
    await new Promise((r) => setTimeout(r, 20));
    // Several requests in one tick, so the queue is not empty when each is dispatched.
    const q = { op: 'queryPlan', plan: plan({ kind: 'query', plan: p.values([[p.lit(1)]], ['int']) } as PlanStatementInput), planVersion: 1 } as const;
    send(q);
    send({ op: 'queryPlan', plan: plan({ kind: 'transaction', action: 'begin', mode: 'deferred' }), planVersion: 1 });
    send({ op: 'queryPlan', plan: plan({ kind: 'setting', name: 'work_mem' }), planVersion: 1 });
    send({ op: 'queryPlan', plan: plan({ kind: 'transaction', action: 'rollback' }), planVersion: 1 });
    send({ op: 'queryPlan', plan: plan({ kind: 'explain', mode: 'plan', query: { kind: 'query', plan: p.values([[p.lit(1)]], ['int']) } } as PlanStatementInput), planVersion: 1 });
    send(q);
    send(q);
    await new Promise((r) => setTimeout(r, 50));
    expect(worker.offered.length).toBeGreaterThan(0);
    expect(worker.offered).not.toContain('transaction');
    expect(worker.offered).not.toContain('setting');
    // EXPLAIN reads only data: readers may answer it, with the owner's settings.
    expect(worker.offered).toContain('explain');
    expect(replies.filter((m) => m.kind === 'error')).toEqual([]);
  });
});
