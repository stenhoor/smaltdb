/**
 * The ADR 0017 re-review: what the engine does with objects whose language is not registered (a file written with SQL,
 * opened by an application without smaltql) or that a language without some parts made. Nothing a statement of its own
 * runs may need that language: only reading or editing the objects themselves.
 *
 * A file written with SQL is made here by a stand-in language named `sql`, registered in a fresh module instance
 * (`vi.resetModules`), so the instance that reopens the file has no language at all.
 */
import external from '@smaltdb/external';
import { describe, expect, it, vi } from 'vitest';
import type { Database as DatabaseT } from '../../src/engine/database.js';
import type { SmaltLanguage } from '../../src/engine/plan/language.js';
import type { ColumnDef, SchemaOp, Source } from '../../src/engine/plan/schema.js';
import type { PlanStatementInput } from '../../src/engine/plan/statement.js';
import type { ReaderPool } from '../../src/engine/server.js';
import type { Request, Response } from '../../src/shared/protocol.js';
import { MemoryVfs } from '../../src/engine/vfs/memory.js';

/** A fresh engine: its own language registry, with nothing registered. */
async function engine() {
  vi.resetModules();
  const { Database } = await import('../../src/engine/database.js');
  const { plan: p } = await import('../../src/engine/index.js');
  const { registerLanguage } = await import('../../src/engine/plan/language.js');
  const { EngineServer } = await import('../../src/engine/server.js');
  const { Collation } = await import('../../src/engine/values.js');
  /** Views as JSON naming a table and its columns; `parts` picks which optional parts it has. */
  const language = (name: string, parts: { references?: boolean; definition?: boolean } = {}): SmaltLanguage => ({
    name,
    bindView(source, ctx) {
      const f = JSON.parse(source.text) as { table: string; columns: string[] };
      const t = ctx.table(f.table);
      if (!t) throw new Error(`no such table: ${f.table}`);
      const at = f.columns.map((c) => t.columns.findIndex((x) => x.name === c));
      return { kind: 'query', plan: p.project(p.scan(t.name, at), at.map((_, i) => p.col(0, i, 'any'))), columns: f.columns.map((n) => ({ name: n, type: 'any', collation: Collation.Binary, affinity: 'NONE' })) } as never;
    },
    ...(parts.references !== false ? { viewReferences: (s: Source) => [{ name: (JSON.parse(s.text) as { table: string }).table }] } : {}),
    ...(parts.definition !== false ? { viewDefinition: (s: Source) => s.text } : {}),
  });
  const run = (d: DatabaseT, s: PlanStatementInput) => d.preparePlan(s).run();
  const rows = (d: DatabaseT, s: PlanStatementInput) => d.queryPlan(s).rows;
  return { Database, p, registerLanguage, EngineServer, language, run, rows };
}

const col = (name: string): ColumnDef => ({ name, declaredType: 'INTEGER', type: 'INTEGER', notNull: false, collation: 'binary' });
const table = (name: string): PlanStatementInput => ({ kind: 'schema', op: { op: 'createTable', table: { name, columns: [col('id')], keys: [], checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false } });
const view = (name: string, language: string, on: string, more: Partial<Extract<SchemaOp, { op: 'createView' }>> = {}): PlanStatementInput => ({
  kind: 'schema',
  op: { op: 'createView', name, temp: false, ifNotExists: false, materialized: false, source: { language, text: JSON.stringify({ table: on, columns: ['id'] }) }, ...more },
});
const rename = (from: string, to: string): PlanStatementInput => ({ kind: 'schema', op: { op: 'alterTable', table: from, action: { kind: 'renameTable', newName: to } } });
const virtual = (name: string, width: number) => ({ op: 'source', kind: 'virtual', name, schema: 'information_schema', args: [], types: Array(width).fill('any') }) as never;

/** A file written with the stand-in `sql`, by `write`; returns its VFS. */
async function writtenWithSql(write: (e: Awaited<ReturnType<typeof engine>>, d: DatabaseT) => void): Promise<MemoryVfs> {
  const e = await engine();
  e.registerLanguage(e.language('sql'));
  const vfs = new MemoryVfs();
  const d = await e.Database.open(vfs, 'db');
  write(e, d);
  d.close();
  return vfs;
}

describe('objects whose language is not registered', () => {
  it('a memory materialized view does not stop the file from opening', async () => {
    const vfs = await writtenWithSql((e, d) => {
      e.run(d, table('t'));
      e.run(d, { kind: 'write', plan: e.p.append('t', e.p.values([[e.p.lit(1)]]), [0]) });
      e.run(d, view('mv', 'sql', 't', { materialized: true, options: { location: 'memory' } }));
    });
    const e = await engine();
    const d = await e.Database.open(vfs, 'db');
    expect(e.rows(d, e.p.scan('t', [0]))).toEqual([[1]]);
    // The view stays unpopulated: reading it says so.
    expect(() => e.rows(d, e.p.scan('mv', [0]))).toThrow();
    d.close();
  });

  it('writes and queries do not need a materialized view’s language; the view goes stale', async () => {
    const vfs = await writtenWithSql((e, d) => {
      e.run(d, table('t'));
      e.run(d, table('other'));
      e.run(d, view('mv', 'sql', 't', { materialized: true }));
    });
    const e = await engine();
    const d = await e.Database.open(vfs, 'db');
    const fresh = () => e.rows(d, virtual('materialized_views', 11))[0]![9];
    expect(fresh()).toBe('YES');
    // What it reads is unknown here, so any write may change it.
    e.run(d, { kind: 'write', plan: e.p.append('other', e.p.values([[e.p.lit(1)]]), [0]) });
    expect(fresh()).toBe('NO');
    e.run(d, { kind: 'schema', op: { op: 'drop', objectType: 'table', name: 'other', ifExists: false } });
    // Rewriting queries from fresh views skips a view it cannot read.
    e.run(d, { kind: 'setting', name: 'matview_rewrite', value: e.p.lit(1) } as never);
    expect(e.rows(d, e.p.scan('t', [0]))).toEqual([]);
    d.close();
  });

  it('information_schema reads with a view whose language is missing, or does not describe views', async () => {
    const vfs = await writtenWithSql((e, d) => {
      e.run(d, table('t'));
      e.run(d, view('v', 'sql', 't'));
    });
    const e = await engine();
    e.registerLanguage(e.language('bare', { definition: false }));
    const d = await e.Database.open(vfs, 'db');
    e.run(d, view('w', 'bare', 't'));
    expect(e.rows(d, virtual('tables', 5)).map((r) => r[2])).toEqual(expect.arrayContaining(['t', 'v', 'w']));
    expect(e.rows(d, virtual('views', 7)).map((r) => [r[2], r[3]])).toEqual([['v', null], ['w', null]]);
    d.close();
  });

  it('a rename needs the language only of objects that can mention the table', async () => {
    const e = await engine();
    e.registerLanguage(e.language('frames'));
    const d = e.Database.openMemory();
    e.run(d, table('a'));
    e.run(d, table('b'));
    e.run(d, view('vb', 'frames', 'b'));
    // frames has no source editor: renaming a table its view does not read leaves the view as it is.
    e.run(d, rename('a', 'a2'));
    e.run(d, { kind: 'schema', op: { op: 'alterTable', table: 'a2', action: { kind: 'renameColumn', column: 'id', newName: 'k' } } });
    expect(d.catalog.table('a2')!.columns.map((c) => c.name)).toEqual(['k']);
    // Renaming the table it reads needs its text edited, which frames cannot do.
    expect(() => e.run(d, rename('b', 'b2'))).toThrow(/frames language does not edit/);
    d.close();
  });

  it('a connection records its language, so a rename does not ask SQL about it', async () => {
    const e = await engine();
    e.registerLanguage(e.language('frames'));
    const d = e.Database.openMemory({ plugins: [external] });
    e.run(d, { kind: 'schema', op: { op: 'createConnection', name: 'c', ifNotExists: false, options: { type: 'http', url: 'https://example.com/' }, source: { language: 'frames', text: '{"connection":"c"}' } } });
    e.run(d, table('a'));
    e.run(d, rename('a', 'a2'));
    expect(d.catalog.table('a2')).toBeDefined();
    d.close();
  });

  it('a rename with an object whose language is missing fails clearly, naming it', async () => {
    const vfs = await writtenWithSql((e, d) => {
      e.run(d, table('a'));
      e.run(d, table('b'));
      e.run(d, view('vb', 'sql', 'b'));
    });
    const e = await engine();
    const d = await e.Database.open(vfs, 'db');
    // Without its language, nothing can say what the view reads.
    expect(() => e.run(d, rename('a', 'a2'))).toThrow(/needs the sql language/);
    d.close();
  });
});

describe('routing plans to readers', () => {
  it('a plan reading a TEMP view, or a view over a memory materialized view, reads memory objects', async () => {
    const e = await engine();
    e.registerLanguage(e.language('frames'));
    const d = await e.Database.open(new MemoryVfs(), 'db');
    e.run(d, table('t'));
    e.run(d, view('tv', 'frames', 't', { temp: true }));
    expect(d.preparePlan(e.p.scan('tv', [0])).usesMemoryObjects).toBe(true);
    e.run(d, view('mv', 'frames', 't', { materialized: true, options: { location: 'memory' } }));
    e.run(d, view('over', 'frames', 'mv'));
    expect(d.preparePlan(e.p.scan('over', [0])).usesMemoryObjects).toBe(true);
    e.run(d, view('plain', 'frames', 't'));
    expect(d.preparePlan(e.p.scan('plain', [0])).usesMemoryObjects).toBe(false);
    d.close();
  });

  it('a statement prepared from a plan is offered to readers, as one prepared from text is', async () => {
    const e = await engine();
    const offered: unknown[] = [];
    const replies: Response[] = [];
    const pool: ReaderPool = { dispatch: (_s, req) => (offered.push(req), false), forward: () => false };
    const server = new e.EngineServer((_s, msg) => replies.push(msg as Response), { open: () => e.Database.openMemory(), refreshTimer: false, readers: pool });
    let id = 1;
    const send = (req: Record<string, unknown>) => server.receive(e.EngineServer.LOCAL, { id: id++, ...req } as Request);
    const settle = () => new Promise((r) => setTimeout(r, 20));
    send({ op: 'open', name: ':memory:', storage: 'memory' });
    await settle();
    const plan = JSON.stringify({ kind: 'query', plan: e.p.values([[e.p.lit(1)]], ['int']) });
    send({ op: 'preparePlan', plan, planVersion: 1 });
    await settle();
    const stmt = (replies.find((r) => (r as { stmt?: number }).stmt !== undefined) as { stmt: number }).stmt;
    // Several in one tick, so others wait behind each.
    for (let i = 0; i < 3; i++) send({ op: 'stmtQuery', stmt });
    await settle();
    expect(offered.length).toBeGreaterThan(0);
    expect(offered[0]).toMatchObject({ op: 'queryPlan', plan, planVersion: 1 });
  });
});
