/**
 * Lists and structs (ADR 0020 step 1): `list<T>` and `struct<…>` plan types whose values are blobs of index-key
 * components, so they compare, sort and group element by element; LIST and STRUCT storage; values in from JS arrays and
 * objects; results as JS arrays and objects, in process and through the client.
 */
import fc from 'fast-check';
import { afterEach, describe, expect, it } from 'vitest';
import * as client from '../src/client/index.js';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { ColumnDef } from '../src/engine/plan/schema.js';
import { EngineServer } from '../src/engine/server.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { Request, Response } from '../src/shared/protocol.js';
import { decodeNested, encodeNested, isPlanTypeName, parseNested } from '../src/shared/nested.js';

const PT = 'struct<x real, y real>';
/** id, tags list<text>, pt struct<x real, y real>, hist list<struct<d date, ok bool>>, nested list<list<int>>. */
const frame = (): PlanOp =>
  p.fromColumns(
    [
      [1, 2, 3, 4],
      [['a', 'b'], [], null, ['c']],
      [{ x: 1, y: 2.5 }, [3, null], null, { y: -1 }],
      [[{ d: '2026-11-07', ok: true }], [{ d: null, ok: false }, null], null, []],
      [[[1], [2, 3]], [[]], null, [[-4]]],
    ] as never,
    ['int', 'list<text>', PT, 'list<struct<d date, ok bool>>', 'list<list<int>>'],
  );
const ROWS = [
  [1, ['a', 'b'], { x: 1, y: 2.5 }, [{ d: '2026-11-07', ok: true }], [[1], [2, 3]]],
  [2, [], { x: 3, y: null }, [{ d: null, ok: false }, null], [[]]],
  [3, null, null, null, null],
  [4, ['c'], { x: null, y: -1 }, [], [[-4]]],
];
const TYPES = ['int', 'list<text>', PT, 'list<struct<d date, ok bool>>', 'list<list<int>>'];

describe('types', () => {
  it('parse and check', () => {
    expect(parseNested('list<int>')).toEqual({ kind: 'list', of: 'int' });
    expect(parseNested('struct<a int, b list<struct<c text, d date>>>')).toEqual({
      kind: 'struct',
      fields: [
        { name: 'a', type: 'int' },
        { name: 'b', type: 'list<struct<c text, d date>>' },
      ],
    });
    for (const bad of ['list<>', 'list<foo>', 'list<int', 'struct<>', 'struct<a>', 'struct<a int, a text>', 'struct<1a int>', 'list<int>>']) expect(isPlanTypeName(bad), bad).toBe(false);
    expect(() => Database.openMemory().queryPlan(p.fromColumns([[[1]]] as never, ['list<foo>' as never]))).toThrow(/unknown type "list<foo>"/);
  });
});

describe('the encoding', () => {
  const cmp = (a: Uint8Array, b: Uint8Array) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    return Math.sign(a.length - b.length);
  };
  const lex = (a: readonly number[], b: readonly number[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! < b[i]! ? -1 : 1;
    return Math.sign(a.length - b.length);
  };

  it('orders lists element by element, a shorter list first', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ noNaN: true, noDefaultInfinity: true }), { maxLength: 5 }), fc.array(fc.double({ noNaN: true, noDefaultInfinity: true }), { maxLength: 5 }), (a, b) => {
        const ea = encodeNested('list<real>', a);
        const eb = encodeNested('list<real>', b);
        // -0 and 0 are one value.
        expect(cmp(ea, eb)).toBe(lex(a.map((x) => x + 0), b.map((x) => x + 0)));
        expect(decodeNested('list<real>', ea)).toEqual(a.map((x) => x + 0));
      }),
      { numRuns: 1000 },
    );
  });

  it('nests: a list of lists orders by its lists', () => {
    const e = (v: number[][]) => encodeNested('list<list<int>>', v);
    expect(cmp(e([[1]]), e([[1, 0]]))).toBe(-1);
    expect(cmp(e([[1, 0]]), e([[2]]))).toBe(-1);
    expect(cmp(e([[]]), e([[], []]))).toBe(-1);
    expect(cmp(e([]), e([[]]))).toBe(-1);
    expect(decodeNested('list<list<int>>', e([[1, 2], [], [3]]))).toEqual([[1, 2], [], [3]]);
  });

  it('refuses values that are not of the type', () => {
    expect(() => encodeNested('list<int>', 'x')).toThrow(/is an array/);
    expect(() => encodeNested('list<date>', ['soon'])).toThrow(/cannot read "soon" as a date/);
    expect(() => encodeNested('struct<a int>', { b: 1 })).toThrow(/has no field b/);
    expect(() => encodeNested('struct<a int, b int>', [1])).toThrow(/has 2 fields, not 1/);
    expect(() => encodeNested('list<bool>', [2])).toThrow(/a bool is true or false/);
  });
});

describe('in process', () => {
  it('values from columns: JS arrays and objects; results as JS arrays and objects', () => {
    const r = Database.openMemory().queryPlan(frame());
    expect(r.rows).toEqual(ROWS);
    expect(r.columnTypes).toEqual(TYPES);
  });

  it('sort, group and compare as their values', () => {
    const db = Database.openMemory();
    const lists = p.fromColumns([[[2], [1, 5], [1], [], null, [1, 5]]] as never, ['list<int>']);
    expect(db.queryPlan(p.sort(lists, [p.asc(p.col(0, 0, 'list<int>' as never))])).rows.map((r) => r[0])).toEqual([null, [], [1], [1, 5], [1, 5], [2]]);
    expect(db.queryPlan(p.aggregate(lists, [p.col(0, 0, 'list<int>' as never)], [p.agg('count', [], 'int', { star: true })])).rows.length).toBe(5);
    const eq = p.filter(lists, p.call('cmp_eq', [p.col(0, 0, 'list<int>' as never), p.col(0, 0, 'list<int>' as never)], 'bool'));
    expect(db.queryPlan(eq).rows.length).toBe(5);
  });
});

const col = (name: string, type: ColumnDef['type'], declaredType: string = type): ColumnDef => ({ name, declaredType, type, notNull: false, collation: 'binary' });
const createT = (storage: 'row' | 'columnar') =>
  ({
    kind: 'schema',
    op: {
      op: 'createTable',
      table: {
        name: 'ev',
        columns: [col('id', 'INTEGER'), col('tags', 'LIST', 'list<text>'), col('pt', 'STRUCT', PT), col('hist', 'LIST', 'list<struct<d date, ok bool>>'), col('nested', 'LIST', 'list<list<int>>')],
        keys: [],
        checks: [],
        foreignKeys: [],
        storage,
      },
      temp: false,
      ifNotExists: false,
    },
  }) as const;
const scan = () => p.sort(p.scan('ev', [0, 1, 2, 3, 4]), [p.asc(p.col(0, 0, 'int'))]);

describe('storage', () => {
  for (const storage of ['row', 'columnar'] as const) {
    it(`${storage}: LIST and STRUCT keep their values and types`, () => {
      const db = Database.openMemory();
      db.queryPlan(createT(storage));
      db.queryPlan({ kind: 'write', plan: p.append('ev', frame(), [0, 1, 2, 3, 4]) });
      if (storage === 'columnar') db.exec('PRAGMA compact(ev)');
      const r = db.queryPlan(scan());
      expect(r.rows).toEqual(ROWS);
      expect(r.columnTypes).toEqual(TYPES);
      expect(db.catalog.table('ev')!.columns.map((c) => [c.type, c.storageType])).toEqual([
        ['int', 'INTEGER'],
        ['list<text>', 'LIST'],
        [PT, 'STRUCT'],
        ['list<struct<d date, ok bool>>', 'LIST'],
        ['list<list<int>>', 'LIST'],
      ]);
    });
  }

  it('a LIST column needs a list type; a write refuses what is not one', () => {
    const db = Database.openMemory();
    const bad = { ...createT('row'), op: { ...createT('row').op, table: { ...createT('row').op.table, name: 'x', columns: [col('a', 'LIST', 'int')] } } };
    expect(() => db.queryPlan(bad as never)).toThrow(/a LIST column's declared type is a list<…> type, not "int"/);
    db.queryPlan(createT('row'));
    expect(() => db.queryPlan({ kind: 'write', plan: p.append('ev', p.values([[p.lit(1), p.lit('a,b'), p.lit(null), p.lit(null), p.lit(null)]]), [0, 1, 2, 3, 4]) })).toThrow(
      expect.objectContaining({ code: 'SMALT_CONSTRAINT_DATATYPE' }),
    );
  });

  it('survives reopening the file', () => {
    const vfs = new MemoryVfs();
    const open = () => Database.openFile(vfs.openSync('t.db'), {}, vfs.openSync('t.db-wal'));
    let db = open();
    db.queryPlan(createT('row'));
    db.queryPlan({ kind: 'write', plan: p.append('ev', frame(), [0, 1, 2, 3, 4]) });
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
    for (const db of opened.splice(0)) await db.close();
  });

  it('gives JS arrays and objects in every row mode and in streams', async () => {
    const db = await client.open(':memory:', { storage: 'memory', worker: new FakeWorker() as unknown as Worker });
    opened.push(db);
    expect([...(await db.queryPlan(frame(), [], { rowMode: 'array' }))]).toEqual(ROWS);
    const columnar = (await db.queryPlan(frame(), [], { rowMode: 'columnar' })) as unknown as { data: Record<string, unknown> };
    expect([...(Object.values(columnar.data)[1] as unknown[])]).toEqual([['a', 'b'], [], null, ['c']]);
    const streamed: unknown[] = [];
    for await (const b of db.streamPlan(frame(), [], { batchSize: 3, rowMode: 'array' })) streamed.push(...b);
    expect(streamed).toEqual(ROWS);
  });
});
