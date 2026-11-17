/**
 * The map type (ADR 0038 step 1): `map<text, V>` as a plan type whose values are blobs of their entries sorted by key,
 * so equal maps have equal bytes and compare, sort, group and hash as values; MAP storage; values in from JS objects and
 * Maps; results as JS objects, in process and through the client; JSON text; conversions between map types.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as client from '../src/client/index.js';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { ColumnDef } from '../src/engine/plan/schema.js';
import { EngineServer } from '../src/engine/server.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { Request, Response } from '../src/shared/protocol.js';
import { compareCodePoints, decodeNested, encodeNested, isPlanTypeName, parseNested } from '../src/shared/nested.js';

const PROPS = 'map<text, any>';
const TAGS = 'map<text, list<int>>';
const DATES = 'map<text, date>';
const frame = (): PlanOp =>
  p.fromColumns(
    [
      [1, 2, 3, 4],
      [{ name: 'Ada', born: 1815 }, {}, null, { 'é': 'x', a: 1.5 }],
      [{ b: [1, 2], a: [] }, { x: null }, null, {}],
      [{ start: '2026-11-17' }, {}, null, { end: null }],
    ] as never,
    ['int', PROPS, TAGS, DATES] as never,
  );
const ROWS = [
  [1, { born: 1815, name: 'Ada' }, { a: [], b: [1, 2] }, { start: '2026-11-17' }],
  [2, {}, { x: null }, {}],
  [3, null, null, null],
  [4, { a: 1.5, 'é': 'x' }, {}, { end: null }],
];

describe('types', () => {
  it('parse map<text, V> and refuse other key types', () => {
    expect(parseNested('map<text, int>')).toEqual({ kind: 'map', of: 'int' });
    expect(parseNested('map<text, map<text, list<struct<a int>>>>')).toEqual({ kind: 'map', of: 'map<text, list<struct<a int>>>' });
    for (const bad of ['map<>', 'map<text>', 'map<int, text>', 'map<text, foo>', 'map<text, int', 'map<text, int, int>']) expect(isPlanTypeName(bad), bad).toBe(false);
  });
});

describe('the encoding', () => {
  it('is canonical: equal maps have equal bytes, whatever the order their keys came in', () => {
    const a = encodeNested(PROPS, { b: 2, a: 1, c: 'x' });
    const b = encodeNested(PROPS, new Map<string, unknown>([['c', 'x'], ['a', 1], ['b', 2]]));
    expect(b).toEqual(a);
    expect(decodeNested(PROPS, a)).toEqual({ a: 1, b: 2, c: 'x' });
    expect(Object.keys(decodeNested(PROPS, a) as object)).toEqual(['a', 'b', 'c']);
  });

  it('orders keys by code point (UTF-8 byte order), not by UTF-16 code unit', () => {
    // U+FF5E is after U+1F600's first UTF-16 code unit (0xD83D) by code unit, but before the code point.
    const keys = ['😀', '～', 'a', 'é', ''];
    expect([...keys].sort(compareCodePoints)).toEqual(['', 'a', 'é', '～', '😀']);
    expect(Object.keys(decodeNested(PROPS, encodeNested(PROPS, Object.fromEntries(keys.map((k) => [k, 1])))) as object)).toEqual(['', 'a', 'é', '～', '😀']);
  });

  it('keeps a key named __proto__ as a key', () => {
    const v = decodeNested(PROPS, encodeNested(PROPS, JSON.parse('{"__proto__": 1, "a": 2}'))) as Record<string, unknown>;
    expect(Object.getPrototypeOf(v)).toBe(Object.prototype);
    expect(Object.keys(v)).toEqual(['__proto__', 'a']);
    expect(v['__proto__' as keyof typeof v]).toBe(1);
  });

  it('refuses what is not a map of the type', () => {
    expect(() => encodeNested(PROPS, [1, 2], 'm')).toThrow(/a map<text, any> is an object or a Map, not an array/);
    expect(() => encodeNested(PROPS, new Map([[1, 2]]), 'm')).toThrow(/keys are text, not number/);
    expect(() => encodeNested('map<text, int>', { a: 'x' }, 'm')).toThrow(/m\.a: a int element cannot hold "x"/);
  });
});

describe('in plans', () => {
  it('values from columns: JS objects; results as JS objects, with their types', () => {
    const r = Database.openMemory().queryPlan(frame());
    expect(r.rows).toEqual(ROWS);
    expect(r.columnTypes).toEqual(['int', PROPS, TAGS, DATES]);
  });

  it('group and compare as their values (equal maps are one group)', () => {
    const db = Database.openMemory();
    const maps = p.fromColumns([[{ a: 1, b: 2 }, { b: 2, a: 1 }, { a: 1 }, null]] as never, ['map<text, int>'] as never);
    expect(db.queryPlan(p.aggregate(maps, [p.col(0, 0, 'map<text, int>' as never)], [p.agg('count', [], 'int', { star: true })])).rows.length).toBe(3);
  });

  it('cast to text gives JSON object text, and map types convert as their values do', () => {
    const db = Database.openMemory();
    const m = p.fromColumns([[{ b: 2.5, a: 'x', c: null }]] as never, ['map<text, any>'] as never);
    expect(db.queryPlan(p.project(m, [p.call('cast_text', [p.col(0, 0, 'map<text, any>' as never)], 'text')])).rows).toEqual([['{"a":"x","b":2.5,"c":null}']]);
    const n = p.fromColumns([[{ b: [1, 2], a: [] }]] as never, [TAGS] as never);
    expect(db.queryPlan(p.project(n, [p.call('cast_text', [p.col(0, 0, TAGS as never)], 'text')])).rows).toEqual([['{"a":[],"b":[1,2]}']]);
    expect(p.conversion('map<text, int>' as never, 'map<text, num>' as never)).toEqual({ loss: 'none' });
    expect(p.conversion('map<text, int>' as never, 'list<int>' as never)).toBeUndefined();
  });
});

const col = (name: string, type: ColumnDef['type'], declaredType: string = type): ColumnDef => ({ name, declaredType, type, notNull: false, collation: 'binary' });
const createT = (storage: 'row' | 'columnar') =>
  ({
    kind: 'schema',
    op: {
      op: 'createTable',
      table: { name: 'n', columns: [col('id', 'INTEGER'), col('props', 'MAP', PROPS), col('tags', 'MAP', TAGS), col('dates', 'MAP', DATES)], keys: [], checks: [], foreignKeys: [], storage },
      temp: false,
      ifNotExists: false,
    },
  }) as const;
const scan = () => p.sort(p.scan('n', [0, 1, 2, 3]), [p.asc(p.col(0, 0, 'int'))]);

describe('storage', () => {
  for (const storage of ['row', 'columnar'] as const) {
    it(`${storage}: MAP keeps its values and types`, () => {
      const db = Database.openMemory();
      db.queryPlan(createT(storage));
      db.queryPlan({ kind: 'write', plan: p.append('n', frame(), [0, 1, 2, 3]) });
      if (storage === 'columnar') db.exec('PRAGMA compact(n)');
      const r = db.queryPlan(scan());
      expect(r.rows).toEqual(ROWS);
      expect(r.columnTypes).toEqual(['int', PROPS, TAGS, DATES]);
      expect(db.catalog.table('n')!.columns.map((c) => [c.type, c.storageType])).toEqual([
        ['int', 'INTEGER'],
        [PROPS, 'MAP'],
        [TAGS, 'MAP'],
        [DATES, 'MAP'],
      ]);
    });
  }

  it('a MAP column needs a map type; a write refuses what is not one', () => {
    const db = Database.openMemory();
    const bad = { ...createT('row'), op: { ...createT('row').op, table: { ...createT('row').op.table, name: 'x', columns: [col('a', 'MAP', 'list<int>')] } } };
    expect(() => db.queryPlan(bad as never)).toThrow(/a MAP column's declared type is a map<…> type, not "list<int>"/);
    db.queryPlan(createT('row'));
    expect(() => db.queryPlan({ kind: 'write', plan: p.append('n', p.values([[p.lit(1), p.lit('a'), p.lit(null), p.lit(null)]]), [0, 1, 2, 3]) })).toThrow(
      expect.objectContaining({ code: 'SMALT_CONSTRAINT_DATATYPE' }),
    );
  });

  it('survives reopening the file', () => {
    const vfs = new MemoryVfs();
    const open = () => Database.openFile(vfs.openSync('t.db'), {}, vfs.openSync('t.db-wal'));
    let db = open();
    db.queryPlan(createT('row'));
    db.queryPlan({ kind: 'write', plan: p.append('n', frame(), [0, 1, 2, 3]) });
    db.close();
    db = open();
    expect(db.queryPlan(scan()).rows).toEqual(ROWS);
    db.close();
  });
});

describe('through the client', () => {
  class FakeWorker {
    onmessage: ((e: { data: Response }) => void) | null = null;
    onerror: unknown = null;
    private readonly server = new EngineServer((_s, msg) => setTimeout(() => this.onmessage?.({ data: structuredClone(msg) })), { open: () => Database.openMemory(), refreshTimer: false });
    postMessage(req: Request, transfer: Transferable[] = []): void {
      const r = structuredClone(req, { transfer });
      setTimeout(() => this.server.receive(EngineServer.LOCAL, r));
    }
    terminate(): void {}
  }
  (globalThis as { Worker?: unknown }).Worker ??= FakeWorker;
  const opened: client.Database[] = [];
  afterEach(async () => {
    for (const d of opened.splice(0)) await d.close();
  });

  it('gives JS objects', async () => {
    const db = await client.open(':memory:', { storage: 'memory', worker: new FakeWorker() as unknown as Worker });
    opened.push(db);
    expect([...(await db.queryPlan(frame(), [], { rowMode: 'array' }))]).toEqual(ROWS);
  });
});
