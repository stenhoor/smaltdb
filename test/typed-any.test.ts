/**
 * Typed values under `any` (ADR 0039): a bool, list, struct or map in an `any` place (a map<text, any> value, a
 * list<any> element, an `any` column) keeps its type. Values in from JavaScript, the builders (`list_of`, `map_of`,
 * `map_merge`), storage in rows, columnar chunks and index keys, order and grouping, JSON text, `any_*` functions,
 * and results in process and through the worker.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as client from '../src/client/index.js';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { ColumnDef } from '../src/engine/plan/schema.js';
import type { PlanType } from '../src/engine/plan/types.js';
import { EngineServer } from '../src/engine/server.js';
import { decodeKey, encodeKey } from '../src/engine/storage/key-codec.js';
import { TypedValue, compareValues, typedBool } from '../src/engine/values.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { Request, Response } from '../src/shared/protocol.js';

const M = 'map<text, any>' as PlanType;
const L = 'list<any>' as PlanType;
const PROPS = { active: true, off: false, n: 1, s: 'x', tags: ['a', 'b'], nested: { flag: true, xs: [1, [2, false]] } };

const one = (db: Database, e: PlanExpr): unknown => db.queryPlan(p.project(p.values([[p.lit(1)]]), [e])).rows[0]![0];
const fromProps = (rows: unknown[]): PlanOp => p.fromColumns([rows] as never, [M]);

describe('values in and results', () => {
  it('a map<text, any> keeps booleans, lists and maps as they were given, nested too', () => {
    const db = Database.openMemory();
    expect(db.queryPlan(fromProps([PROPS])).rows).toEqual([[PROPS]]);
  });

  it('map_get gives each value with its kind, and any_type names it', () => {
    const db = Database.openMemory();
    const at = (k: string) => p.call('map_get', [p.col(0, 0, M), p.lit(k)], 'any');
    const get = (k: string) => db.queryPlan(p.project(fromProps([PROPS]), [at(k)])).rows[0]![0];
    const typeOf = (k: string) => db.queryPlan(p.project(fromProps([PROPS]), [p.call('any_type', [at(k)], 'text')])).rows[0]![0];
    expect(get('active')).toBe(true);
    expect(get('off')).toBe(false);
    expect(get('tags')).toEqual(['a', 'b']);
    expect(get('nested')).toEqual({ flag: true, xs: [1, [2, false]] });
    expect(['active', 'n', 's', 'tags', 'nested', 'missing'].map(typeOf)).toEqual(['bool', 'int', 'text', 'list<any>', 'map<text, any>', 'null']);
  });

  it('JavaScript booleans, arrays and objects stay plain where the type is not any', () => {
    const db = Database.openMemory();
    expect(db.queryPlan(p.fromColumns([[{ a: true }]] as never, ['map<text, bool>' as PlanType])).rows).toEqual([[{ a: true }]]);
    expect(db.queryPlan(p.fromColumns([[[1, 2]]] as never, ['list<int>' as PlanType])).rows).toEqual([[[1, 2]]]);
  });
});

describe('the builders', () => {
  it('list_of and map_of keep the type of a bool or a nested value when the elements are any', () => {
    const db = Database.openMemory();
    const t = p.lit(1, 'bool');
    const xs = p.call('list_of', [p.lit(1), p.lit(2)], 'list<int>' as PlanType);
    expect(one(db, p.call('list_of', [t, p.lit('a'), xs], L))).toEqual([true, 'a', [1, 2]]);
    expect(one(db, p.call('map_of', [p.lit('a'), t, p.lit('b'), xs, p.lit('c'), p.lit(1.5)], M))).toEqual({ a: true, b: [1, 2], c: 1.5 });
    // When the elements share a type, nothing is wrapped: the list is a list<bool>.
    expect(one(db, p.call('list_of', [t, p.lit(0, 'bool')], 'list<bool>' as PlanType))).toEqual([true, false]);
  });

  it('map_merge of maps of different types keeps each value\'s type', () => {
    const db = Database.openMemory();
    const a = p.call('map_of', [p.lit('a'), p.lit(1, 'bool')], 'map<text, bool>' as PlanType);
    const b = p.call('map_of', [p.lit('b'), p.lit(2)], 'map<text, int>' as PlanType);
    expect(one(db, p.call('map_merge', [a, b], M))).toEqual({ a: true, b: 2 });
  });
});

describe('the any_* functions', () => {
  it('any_bool, any_list and any_map read a value back with a static type; other values give NULL', () => {
    const db = Database.openMemory();
    const at = (k: string) => p.call('map_get', [p.col(0, 0, M), p.lit(k)], 'any');
    const r = db.queryPlan(
      p.project(fromProps([PROPS]), [
        p.call('any_bool', [at('active')], 'bool'),
        p.call('any_bool', [at('n')], 'bool'),
        p.call('list_len', [p.call('any_list', [at('tags')], L)], 'int'),
        p.call('any_list', [at('s')], L),
        p.call('map_get', [p.call('any_map', [at('nested')], M), p.lit('flag')], 'any'),
        p.call('any_map', [at('tags')], M),
      ]),
    ).rows;
    expect(r).toEqual([[true, null, 2, null, true, null]]);
  });

  it('any_list keeps the kind of a typed list\'s elements, and any_map reads a struct by field name', () => {
    const db = Database.openMemory();
    const bools = p.call('list_of', [p.lit(1, 'bool'), p.lit(0, 'bool')], 'list<bool>' as PlanType);
    const inAny = p.call('list_get', [p.call('list_of', [bools, p.lit('x')], L), p.lit(0)], 'any');
    expect(one(db, p.call('list_get', [p.call('any_list', [inAny], L), p.lit(0)], 'any'))).toBe(true);
    const st = p.call('struct_of', [p.lit(1), p.lit(1, 'bool')], 'struct<f0 int, f1 bool>' as PlanType);
    const stAny = p.call('list_get', [p.call('list_of', [st, p.lit('x')], L), p.lit(0)], 'any');
    expect(one(db, p.call('any_map', [stAny], M))).toEqual({ f0: 1, f1: true });
  });

  it('cast to text prints typed values as JSON', () => {
    const db = Database.openMemory();
    const at = (k: string) => p.call('cast_text', [p.call('map_get', [p.col(0, 0, M), p.lit(k)], 'any')], 'text');
    expect(db.queryPlan(p.project(fromProps([PROPS]), [at('active'), at('tags'), at('nested'), p.call('cast_text', [p.col(0, 0, M)], 'text')])).rows).toEqual([
      ['true', '["a","b"]', '{"flag":true,"xs":[1,[2,false]]}', '{"active":true,"n":1,"nested":{"flag":true,"xs":[1,[2,false]]},"off":false,"s":"x","tags":["a","b"]}'],
    ]);
  });
});

describe('order, equality and grouping', () => {
  it('a typed value sorts after blobs, by type then bytes, and never equals a blob of its bytes', () => {
    const blob = Uint8Array.of(1);
    const t = typedBool(true);
    expect(compareValues(t, blob)).toBe(1);
    expect(compareValues(typedBool(false), t)).toBe(-1);
    expect(compareValues(new TypedValue('list<any>', []), t)).toBe(1);
    // The key encoding sorts as compareValues does.
    const keys = [t, blob, typedBool(false), 'z', 3, null, new TypedValue('list<any>', [])].map((v) => [v, encodeKey([v])] as const);
    const byKey = [...keys].sort((a, b) => compareValues(a[1], b[1])).map((x) => x[0]);
    const byValue = [...keys].sort((a, b) => compareValues(a[0], b[0])).map((x) => x[0]);
    expect(byKey).toEqual(byValue);
    // And decodes to the same values, the type kept.
    const back = decodeKey(encodeKey([t, blob]));
    expect(back[0]).toBeInstanceOf(TypedValue);
    expect((back[0] as TypedValue).type).toBe('bool');
    expect(back[1]).not.toBeInstanceOf(TypedValue);
  });

  it('a typed bool is its truth value where a condition is tested', () => {
    const db = Database.openMemory();
    const rows = p.fromColumns([[1, 2, 3], [{ a: true }, { a: false }, { a: 1 }]] as never, ['int', M] as never);
    const r = db.queryPlan(p.project(p.filter(rows, p.call('map_get', [p.col(0, 1, M), p.lit('a')], 'any')), [p.col(0, 0, 'int')]));
    expect(r.rows).toEqual([[1], [3]]);
  });

  it('true, 1 and a blob of 0x01 are three groups', () => {
    const db = Database.openMemory();
    const rows = fromProps([{ v: true }, { v: 1 }, { v: true }, { v: false }]);
    const v = p.call('map_get', [p.col(0, 0, M), p.lit('v')], 'any');
    const r = db.queryPlan(p.sort(p.aggregate(p.project(rows, [v]), [p.col(0, 0, 'any')], [p.agg('count', [], 'int', { star: true })]), [p.asc(p.col(0, 0, 'any'))])).rows;
    expect(r).toEqual([
      [1, 1],
      [false, 1],
      [true, 2],
    ]);
  });
});

const col = (name: string, type: ColumnDef['type'], declaredType: string = type): ColumnDef => ({ name, declaredType, type, notNull: false, collation: 'binary' });
const create = (storage: 'row' | 'columnar') =>
  ({
    kind: 'schema',
    op: {
      op: 'createTable',
      table: { name: 'n', columns: [col('id', 'INTEGER'), col('props', 'MAP', M), col('v', 'ANY', 'any')], keys: [], checks: [], foreignKeys: [], storage },
      temp: false,
      ifNotExists: false,
    },
  }) as const;

describe('storage', () => {
  for (const storage of ['row', 'columnar'] as const) {
    it(`${storage}: maps of any and any columns keep typed values, through reopening`, () => {
      const vfs = new MemoryVfs();
      const open = () => Database.openFile(vfs.openSync('a.db'), {}, vfs.openSync('a.db-wal'));
      let db = open();
      db.queryPlan(create(storage));
      const v = p.call('map_get', [p.col(0, 1, M), p.lit('tags')], 'any');
      const input = p.project(p.fromColumns([[1, 2], [PROPS, { tags: [true] }]] as never, ['int', M] as never), [p.col(0, 0, 'int'), p.col(0, 1, M), v]);
      db.queryPlan({ kind: 'write', plan: p.append('n', input, [0, 1, 2]) });
      if (storage === 'columnar') db.exec('PRAGMA compact(n)');
      db.close();
      db = open();
      const rows = db.queryPlan(p.sort(p.scan('n', [0, 1, 2]), [p.asc(p.col(0, 0, 'int'))])).rows;
      expect(rows).toEqual([
        [1, PROPS, ['a', 'b']],
        [2, { tags: [true] }, [true]],
      ]);
      db.close();
    });
  }

  it('an index on an any column keeps typed values apart and finds them', () => {
    const db = Database.openMemory();
    db.queryPlan(create('row'));
    const input = p.project(p.fromColumns([[1, 2, 3], [{ v: true }, { v: 1 }, { v: [1] }]] as never, ['int', M] as never), [p.col(0, 0, 'int'), p.lit(null), p.call('map_get', [p.col(0, 1, M), p.lit('v')], 'any')]);
    db.queryPlan({ kind: 'write', plan: p.append('n', input, [0, 1, 2]) });
    db.exec('CREATE INDEX nv ON n(v)');
    expect(db.query('SELECT id FROM n ORDER BY v').rows.map((r) => r[0])).toEqual([2, 1, 3]);
    expect(db.query('SELECT count(DISTINCT v) FROM n').rows).toEqual([[3]]);
  });
});

describe('through the worker', () => {
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
  let c: client.Database | undefined;
  afterEach(async () => {
    await c?.close();
    c = undefined;
  });

  it('typed values in an any column and inside maps reach the client as JavaScript values', async () => {
    c = await client.open(':memory:', { storage: 'memory', worker: new FakeWorker() as unknown as Worker });
    const plan = p.project(fromProps([PROPS]), [p.col(0, 0, M), p.call('map_get', [p.col(0, 0, M), p.lit('active')], 'any'), p.call('map_get', [p.col(0, 0, M), p.lit('nested')], 'any')]);
    expect([...(await c.queryPlan(plan, [], { rowMode: 'array' }))]).toEqual([[PROPS, true, PROPS.nested]]);
  });
});
