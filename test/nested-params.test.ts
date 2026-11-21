/**
 * Parameters of a list, struct or map type (ADR 0020, "Parameters"): a parameter a plan reads as one is bound with a JS
 * array or object, as a column of `values` of that type takes one, so a statement prepared once takes other lists and
 * maps each time it runs. In process, on the morsel path, and through the client.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as client from '../src/client/index.js';
import { Database, PlanStatement } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { ColumnDef } from '../src/engine/plan/schema.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';
import type { PlanType } from '../src/engine/plan/types.js';
import { EngineServer } from '../src/engine/server.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { Request, Response } from '../src/shared/protocol.js';

const PT = 'struct<x real, y real>';
const PROPS = 'map<text, any>';
const ONE_ROW: PlanOp = p.values([[]], []);
/** A query of one row: `exprs`, typed as given. */
const one = (exprs: readonly PlanExpr[], types: readonly PlanType[]): PlanStatementInput => ({ kind: 'query', plan: p.project(ONE_ROW, exprs), columns: types.map((type, i) => ({ name: `c${i}`, type })) });
/** The statement that gives back parameter 0, read as `type`. */
const echo = (type: PlanType): PlanStatementInput => one([p.param(0, type)], [type]);

/** A type, a JS value bound to a parameter of it, and what the parameter then holds (as results give it). */
const CASES: [PlanType, unknown, unknown][] = [
  ['list<int>', [1, 2, 3], [1, 2, 3]],
  ['list<int>', [], []],
  ['list<text>', ['a', null, 'b'], ['a', null, 'b']],
  ['list<list<int>>', [[1], [], [2, 3]], [[1], [], [2, 3]]],
  ['list<bool>', [true, false, null], [true, false, null]],
  [PT, { x: 1, y: 2.5 }, { x: 1, y: 2.5 }],
  // A struct by position, and with a field left out.
  [PT, [3, null], { x: 3, y: null }],
  [PT, { y: -1 }, { x: null, y: -1 }],
  ['list<struct<d date, ok bool>>', [{ d: '2026-11-07', ok: true }, null], [{ d: '2026-11-07', ok: true }, null]],
  [PROPS, { b: 1, a: 'x', c: true, d: [1, 'z', false], e: { f: null, g: 1.5 } }, { a: 'x', b: 1, c: true, d: [1, 'z', false], e: { f: null, g: 1.5 } }],
  [PROPS, {}, {}],
  ['map<text, int>', new Map([['k', 1], ['j', 2]]), { j: 2, k: 1 }],
  ['map<text, list<int>>', { a: [1, 2], b: [] }, { a: [1, 2], b: [] }],
  // Under `any`, booleans, lists and maps keep their kinds (ADR 0039).
  ['list<any>', [true, 1, 'a', null, [1, [2]], { a: true }], [true, 1, 'a', null, [1, [2]], { a: true }]],
];

describe('a parameter read as a list, struct or map', () => {
  it('takes a JS array or object and holds that value', () => {
    const db = Database.openMemory();
    for (const [type, given, want] of CASES) {
      const r = db.queryPlan(echo(type), [given as never]);
      expect(r.rows, `${type} given ${JSON.stringify(given)}`).toEqual([[want]]);
      expect(r.columnTypes).toEqual([type]);
    }
  });

  it('is the value a column of values of that type holds: equal to it, and the same bytes in a table', () => {
    const db = Database.openMemory();
    for (const [type, given] of CASES) {
      // The same JS value as a column of `values` and as a parameter: one row, and they are equal.
      const same = p.filter(p.fromColumns([[given]] as never, [type]), p.call('cmp_eq', [p.col(0, 0, type), p.param(0, type)], 'bool'));
      expect(db.queryPlan({ kind: 'query', plan: same }, [given as never]).rows.length, `${type} given ${JSON.stringify(given)}`).toBe(1);
    }
  });

  it('NULL and undefined are NULL', () => {
    const db = Database.openMemory();
    for (const type of ['list<int>', PT, PROPS] as PlanType[]) {
      expect(db.queryPlan(echo(type), [null]).rows).toEqual([[null]]);
      expect(db.queryPlan(echo(type), [undefined]).rows).toEqual([[null]]);
      expect(db.queryPlan(one([p.isNull(p.param(0, type))], ['bool']), [null]).rows).toEqual([[true]]);
    }
  });

  it('a prepared statement takes another value each run, and so does a plan run again', () => {
    const db = Database.openMemory();
    const st = db.preparePlan(one([p.call('list_len', [p.param(0, 'list<int>')], 'int'), p.param(0, 'list<int>')], ['int', 'list<int>']));
    expect(st.paramCount).toBe(1);
    for (const list of [[1], [], [5, 6, 7], [9]]) expect(st.result([list]).rows).toEqual([[list.length, list]]);
    expect(st.all([[4, 4]])).toEqual([[2, expect.anything()]]);
    for (const m of [{ a: 1 }, { a: 2, b: 'x' }, {}]) expect(db.queryPlan(echo(PROPS), [m]).rows).toEqual([[m]]);
  });

  it('is read by the list, struct and map operations', () => {
    const db = Database.openMemory();
    const list = p.param(0, 'list<int>');
    const r = db.queryPlan(
      one(
        [
          p.call('list_get', [list, p.lit(1)], 'int'),
          p.call('list_len', [list], 'int'),
          p.call('list_contains', [list, p.lit(30)], 'bool'),
          p.call('list_contains', [list, p.lit(31)], 'bool'),
          p.call('struct_field', [p.param(1, PT), p.lit(1)], 'real'),
          p.call('map_get', [p.param(2, PROPS), p.lit('name')], 'any'),
          p.call('map_get', [p.param(2, PROPS), p.lit('none')], 'any'),
          p.call('list_get', [p.param(3, 'list<any>'), p.lit(0)], 'any'),
        ],
        ['int', 'int', 'bool', 'bool', 'real', 'any', 'any', 'any'],
      ),
      [[10, 20, 30], { x: 1, y: 2.5 }, { name: 'Ada', born: 1815 }, [{ k: [true] }]],
    );
    expect(r.rows).toEqual([[20, 3, true, false, 2.5, 'Ada', null, { k: [true] }]]);
  });

  it('sits among other parameters, and may be read more than once', () => {
    const db = Database.openMemory();
    const list = p.param(1, 'list<text>');
    const st = db.preparePlan(one([p.param(0, 'int'), p.call('list_len', [list], 'int'), p.call('list_get', [list, p.param(0, 'int')], 'text'), p.param(2, 'text')], ['int', 'int', 'text', 'text']));
    expect(st.paramCount).toBe(3);
    expect(st.result([1, ['a', 'b', 'c'], 'z']).rows).toEqual([[1, 3, 'b', 'z']]);
    expect(st.result([0, ['q'], true as never]).rows).toEqual([[0, 1, 'q', 1]]);
  });
});

const col = (name: string, type: ColumnDef['type'], declaredType: string = type): ColumnDef => ({ name, declaredType, type, notNull: false, collation: 'binary' });
const createT = (name: string, columns: ColumnDef[], storage: 'row' | 'columnar' = 'row'): PlanStatementInput =>
  ({ kind: 'schema', op: { op: 'createTable', table: { name, columns, keys: [], checks: [], foreignKeys: [], storage }, temp: false, ifNotExists: false } }) as never;

describe('in statements over tables', () => {
  for (const storage of ['row', 'columnar'] as const) {
    it(`${storage}: one row of parameters is written to LIST, STRUCT and MAP columns, each run its own row`, () => {
      const db = Database.openMemory();
      db.queryPlan(createT('ev', [col('id', 'INTEGER'), col('tags', 'LIST', 'list<text>'), col('pt', 'STRUCT', PT), col('props', 'MAP', PROPS)], storage));
      const insert = db.preparePlan({
        kind: 'write',
        plan: p.append('ev', p.values([[p.param(0, 'int'), p.param(1, 'list<text>'), p.param(2, PT), p.param(3, PROPS)]], ['int', 'list<text>', PT, PROPS]), [0, 1, 2, 3]),
      });
      const rows: unknown[][] = [
        [1, ['a', 'b'], { x: 1, y: 2 }, { name: 'Ada', tags: ['x'], ok: true }],
        [2, [], [3, null], {}],
        [3, null, null, null],
        [4, ['c'], { y: -1 }, { n: 1.5 }],
      ];
      for (const row of rows) expect(insert.run(row as never).changes).toBe(1);
      if (storage === 'columnar') db.exec('PRAGMA compact(ev)');
      const r = db.queryPlan(p.sort(p.scan('ev', [0, 1, 2, 3]), [p.asc(p.col(0, 0, 'int'))]));
      expect(r.rows).toEqual([
        [1, ['a', 'b'], { x: 1, y: 2 }, { name: 'Ada', tags: ['x'], ok: true }],
        [2, [], { x: 3, y: null }, {}],
        [3, null, null, null],
        [4, ['c'], { x: null, y: -1 }, { n: 1.5 }],
      ]);
      expect(r.columnTypes).toEqual(['int', 'list<text>', PT, PROPS]);
      // What a parameter wrote is what a column of values writes: the rows compare equal.
      db.queryPlan(createT('ev2', [col('id', 'INTEGER'), col('tags', 'LIST', 'list<text>'), col('pt', 'STRUCT', PT), col('props', 'MAP', PROPS)], storage));
      const columns = [0, 1, 2, 3].map((c) => rows.map((row) => row[c]));
      db.queryPlan({ kind: 'write', plan: p.append('ev2', p.fromColumns(columns as never, ['int', 'list<text>', PT, PROPS]), [0, 1, 2, 3]) });
      const differ = p.setop('except', p.scan('ev', [0, 1, 2, 3]), p.scan('ev2', [0, 1, 2, 3]), 4);
      expect(db.queryPlan({ kind: 'query', plan: differ }).rows).toEqual([]);
    });
  }

  it('an update sets a map column from a parameter, and a filter compares one with a parameter', () => {
    const db = Database.openMemory();
    db.queryPlan(createT('n', [col('id', 'INTEGER'), col('props', 'MAP', PROPS)]));
    db.queryPlan({ kind: 'write', plan: p.append('n', p.fromColumns([[1, 2, 3], [{ a: 1 }, { a: 2 }, { b: 'x' }]] as never, ['int', PROPS]), [0, 1]) });
    const merge = db.preparePlan({
      kind: 'write',
      plan: p.update('n', p.filter(p.scan('n', [-1, 0, 1]), p.call('cmp_eq', [p.col(0, 1, 'int'), p.param(0, 'int')], 'bool')), 0, [{ column: 1, value: p.call('map_merge', [p.col(0, 2, PROPS), p.param(1, PROPS)], PROPS) }]),
    });
    expect(merge.run([2, { a: 20, c: [true] }]).changes).toBe(1);
    expect(merge.run([3, {}]).changes).toBe(1);
    expect(merge.run([9, { z: 1 }]).changes).toBe(0);
    const props = () => db.queryPlan(p.sort(p.scan('n', [0, 1]), [p.asc(p.col(0, 0, 'int'))])).rows;
    expect(props()).toEqual([[1, { a: 1 }], [2, { a: 20, c: [true] }], [3, { b: 'x' }]]);
    const equal = db.preparePlan({ kind: 'query', plan: p.project(p.filter(p.scan('n', [0, 1]), p.call('cmp_eq', [p.col(0, 1, PROPS), p.param(0, PROPS)], 'bool')), [p.col(0, 0, 'int')]) });
    expect(equal.all([{ c: [true], a: 20 }])).toEqual([[2]]);
    expect(equal.all([{ a: 1 }])).toEqual([[1]]);
    expect(equal.all([{ a: 2 }])).toEqual([]);
  });

  it("a filter over a table's rows reads a list parameter: in generated code and without it", () => {
    for (const codegen of [true, false]) {
      const before = process.env.SMALT_NO_CODEGEN;
      if (!codegen) process.env.SMALT_NO_CODEGEN = '1';
      try {
        const db = Database.openMemory();
        db.queryPlan(createT('t', [col('id', 'INTEGER'), col('g', 'INTEGER')]));
        const ids = Array.from({ length: 3000 }, (_, i) => i);
        db.queryPlan({ kind: 'write', plan: p.append('t', p.fromColumns([ids, ids.map((i) => i % 7)] as never, ['int', 'int']), [0, 1]) });
        const wanted = p.param(0, 'list<int>');
        const st = db.preparePlan({
          kind: 'query',
          plan: p.sort(p.project(p.filter(p.scan('t', [0, 1]), p.and(p.call('list_contains', [wanted, p.col(0, 0, 'int')], 'bool'), p.call('cmp_lt', [p.col(0, 1, 'int'), p.param(1, 'int')], 'bool'))), [p.col(0, 0, 'int')]), [p.asc(p.col(0, 0, 'int'))]),
        });
        for (const [list, below] of [[[5, 2999, 12, 700, -1], 6], [[], 7], [ids.filter((i) => i % 500 === 3), 4]] as [number[], number][]) {
          const want = list.filter((i) => i >= 0 && i < 3000 && i % 7 < below).sort((a, b) => a - b).map((i) => [i]);
          expect(st.all([list, below]), `codegen ${codegen}`).toEqual(want);
        }
      } finally {
        if (before === undefined) delete process.env.SMALT_NO_CODEGEN;
        else process.env.SMALT_NO_CODEGEN = before;
      }
    }
  });

  it('a subquery and a join read it', () => {
    const db = Database.openMemory();
    db.queryPlan(createT('t', [col('id', 'INTEGER'), col('tags', 'LIST', 'list<text>')]));
    db.queryPlan({ kind: 'write', plan: p.append('t', p.fromColumns([[1, 2, 3], [['a'], ['a', 'b'], []]] as never, ['int', 'list<text>']), [0, 1]) });
    // The rows whose tags are the parameter's, counted in a scalar subquery of a row that also gives the parameter back.
    const tags = p.param(0, 'list<text>');
    const count = p.scalar(p.aggregate(p.filter(p.scan('t', [0, 1]), p.call('cmp_eq', [p.col(0, 1, 'list<text>'), tags], 'bool')), [], [p.agg('count', [], 'int', { star: true })]), 'int');
    const st = db.preparePlan(one([count, tags], ['int', 'list<text>']));
    expect(st.all([['a', 'b']])).toEqual([[1, ['a', 'b']]]);
    expect(st.all([[]])).toEqual([[1, []]]);
    expect(st.all([['z']])).toEqual([[0, ['z']]]);
    // A join of the table with one row of the parameter.
    const joined = p.project(p.filter(p.join('cross', p.scan('t', [0, 1]), p.values([[tags]], ['list<text>'])), p.call('cmp_eq', [p.col(0, 1, 'list<text>'), p.col(0, 2, 'list<text>')], 'bool')), [p.col(0, 0, 'int')]);
    expect(db.queryPlan({ kind: 'query', plan: joined }, [['a']]).rows).toEqual([[1]]);
  });

  it('partial aggregates over rowid ranges take it as the statement does', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.queryPlan(createT('t', [col('id', 'INTEGER'), col('g', 'INTEGER')]));
    const ids = Array.from({ length: 40_000 }, (_, i) => i);
    db.queryPlan({ kind: 'write', plan: p.append('t', p.fromColumns([ids, ids.map((i) => i % 11)] as never, ['int', 'int']), [0, 1]) });
    const groups = p.param(0, 'list<int>');
    const st = db.preparePlan({
      kind: 'query',
      plan: p.aggregate(p.filter(p.scan('t', [0, 1]), p.call('list_contains', [groups, p.col(0, 1, 'int')], 'bool')), [p.col(0, 1, 'int')], [p.agg('count', [], 'int', { star: true })]),
    });
    expect(st).toBeInstanceOf(PlanStatement);
    for (const list of [[1, 4, 9], [], [10]]) {
      const want = [...st.all([list])].sort((a, b) => (a[0] as number) - (b[0] as number));
      expect(want.map((r) => r[0])).toEqual([...list].sort((a, b) => a - b));
      const parts = db.queryMorsels(st, [list] as never, 4);
      expect(parts, 'the statement runs as partial aggregates').not.toBeNull();
      expect([...parts!.rows].sort((a, b) => (a[0] as number) - (b[0] as number))).toEqual(want);
    }
  });
});

describe('what is refused', () => {
  const refused = (f: () => unknown, code: string, message: RegExp) => {
    let thrown: unknown;
    try {
      f();
    } catch (e) {
      thrown = e;
    }
    expect(thrown, String(message)).toMatchObject({ code });
    expect((thrown as Error).message).toMatch(message);
  };

  it('a value that is no array or object: SMALT_MISMATCH, naming the parameter', () => {
    const db = Database.openMemory();
    const list = db.preparePlan(one([p.param(0, 'int'), p.param(1, 'list<int>')], ['int', 'list<int>']));
    refused(() => list.all([1, 5]), 'SMALT_MISMATCH', /^parameter \?2: a list<int> is bound with an array, not 5$/);
    refused(() => list.all([1, 'a,b']), 'SMALT_MISMATCH', /^parameter \?2: a list<int> is bound with an array, not "a,b"$/);
    refused(() => list.all([1, true]), 'SMALT_MISMATCH', /not true$/);
    refused(() => list.all([1, 5n]), 'SMALT_MISMATCH', /not 5$/);
    // Bytes are not taken for a list: the plan reads the parameter as one.
    refused(() => list.all([1, new Uint8Array([1, 2])]), 'SMALT_MISMATCH', /^parameter \?2: a list<int> is bound with an array, not a blob$/);
    refused(() => list.all([1, new Float64Array([1, 2]) as never]), 'SMALT_MISMATCH', /not a blob$/);
    refused(() => list.all([1, new Date(0) as never]), 'SMALT_MISMATCH', /not a Date$/);
    const map = db.preparePlan(echo(PROPS));
    refused(() => map.all([7]), 'SMALT_MISMATCH', /^parameter \?1: a map<text, any> is bound with an object or a Map, not 7$/);
    refused(() => db.queryPlan(echo(PT), ['x']), 'SMALT_MISMATCH', /^parameter \?1: a struct<x real, y real> is bound with an object or an array, not "x"$/);
    // Nothing was bound by a refused run: the statement runs again.
    expect(list.all([1, [2]])).toEqual([[1, [2]]]);
  });

  it('an array or object that is no value of the type: SMALT_MISMATCH, naming where', () => {
    const db = Database.openMemory();
    refused(() => db.queryPlan(echo('list<int>'), [['a']]), 'SMALT_MISMATCH', /^parameter \?1\[0\]: a int element cannot hold "a"$/);
    refused(() => db.queryPlan(echo('list<int>'), [{ a: 1 }]), 'SMALT_MISMATCH', /^parameter \?1: a list<int> is an array, not object$/);
    refused(() => db.queryPlan(echo(PT), [[1, 2, 3]]), 'SMALT_MISMATCH', /^parameter \?1: a struct<x real, y real> has 2 fields, not 3$/);
    refused(() => db.queryPlan(echo(PT), [{ x: 1, z: 2 }]), 'SMALT_MISMATCH', /^parameter \?1: struct<x real, y real> has no field z$/);
    refused(() => db.queryPlan(echo(PROPS), [[1, 2]]), 'SMALT_MISMATCH', /^parameter \?1: a map<text, any> is an object or a Map, not an array$/);
    refused(() => db.queryPlan(echo('map<text, int>'), [{ k: 'v' }]), 'SMALT_MISMATCH', /^parameter \?1\.k: a int element cannot hold "v"$/);
  });

  it('a parameter read as two types, one of them a list, struct or map: SMALT_PLAN', () => {
    const db = Database.openMemory();
    const two = (a: PlanType, b: PlanType) => one([p.isNull(p.param(0, a)), p.isNull(p.param(0, b))], ['bool', 'bool']);
    refused(() => db.preparePlan(two('list<int>', 'int')), 'SMALT_PLAN', /parameter 0 is read as a list<int> and as a int/);
    refused(() => db.preparePlan(two('any', PROPS)), 'SMALT_PLAN', /parameter 0 is read as a any and as a map<text, any>/);
    refused(() => db.queryPlan(two('list<int>', 'list<any>'), [[1]]), 'SMALT_PLAN', /parameter 0 is read as a list<int> and as a list<any>/);
    // Two types that are neither stay as they were: a parameter is whatever value is bound.
    expect(db.queryPlan(two('int', 'text'), [1]).rows).toEqual([[false, false]]);
    expect(db.queryPlan(two(PROPS, PROPS), [{}]).rows).toEqual([[false, false]]);
  });

  it('a parameter of any other type takes no array or object, as before', () => {
    const db = Database.openMemory();
    for (const type of ['any', 'int', 'text', 'blob'] as PlanType[]) {
      refused(() => db.queryPlan(echo(type), [[1, 2]]), 'SMALT_MISMATCH', /unsupported parameter type/);
      refused(() => db.queryPlan(echo(type), [{ a: 1 }]), 'SMALT_MISMATCH', /unsupported parameter type/);
    }
    // And still takes every value it took.
    expect(db.queryPlan(echo('any'), [new Uint8Array([1, 2])]).rows).toEqual([[new Uint8Array([1, 2])]]);
    refused(() => db.queryPlan(echo('list<int>'), []), 'SMALT_RANGE', /statement expects 1 parameter\(s\), got 0/);
    refused(() => db.queryPlan(echo('list<int>'), { a: [1] } as never), 'SMALT_RANGE', /positional/);
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
  const open = async () => {
    const db = await client.open(':memory:', { storage: 'memory', worker: new FakeWorker() as unknown as Worker });
    opened.push(db);
    return db;
  };

  it('arrays, objects and Maps cross to the worker and bind there', async () => {
    const db = await open();
    for (const [type, given, want] of CASES) {
      expect([...(await db.queryPlan(echo(type), [given as never], { rowMode: 'array' }))], `${type} given ${JSON.stringify(given)}`).toEqual([[want]]);
    }
  });

  it('a prepared plan, a stream and a transaction take them', async () => {
    const db = await open();
    await db.queryPlan(createT('n', [col('id', 'INTEGER'), col('props', 'MAP', PROPS)]));
    const insert = await db.preparePlan({ kind: 'write', plan: p.append('n', p.values([[p.param(0, 'int'), p.param(1, PROPS)]], ['int', PROPS]), [0, 1]) });
    expect(insert.paramCount).toBe(2);
    expect((await insert.run([1, { name: 'Ada' }])).changes).toBe(1);
    await db.transaction(async (tx) => {
      await tx.statement(insert).run([2, { name: 'Bo', tags: ['x'] }]);
      await tx.queryPlan({ kind: 'write', plan: p.append('n', p.values([[p.param(0, 'int'), p.param(1, PROPS)]], ['int', PROPS]), [0, 1]) }, [3, new Map([['k', true]])]);
    });
    const named = await db.preparePlan({ kind: 'query', plan: p.project(p.filter(p.scan('n', [0, 1]), p.call('cmp_eq', [p.col(0, 1, PROPS), p.param(0, PROPS)], 'bool')), [p.col(0, 0, 'int')]) });
    expect([...(await named.query([{ tags: ['x'], name: 'Bo' }], { rowMode: 'array' }))]).toEqual([[2]]);
    const streamed: unknown[] = [];
    for await (const b of named.stream([{ k: true }], { rowMode: 'array' })) streamed.push(...b);
    expect(streamed).toEqual([[3]]);
    const all: unknown[] = [];
    for await (const b of db.streamPlan(p.sort(p.scan('n', [0, 1]), [p.asc(p.col(0, 0, 'int'))]), [], { rowMode: 'array' })) all.push(...b);
    expect(all).toEqual([[1, { name: 'Ada' }], [2, { name: 'Bo', tags: ['x'] }], [3, { k: true }]]);
  });

  it("a refusal comes back as the engine's error", async () => {
    const db = await open();
    await expect(db.queryPlan(echo('list<int>'), [5])).rejects.toMatchObject({ code: 'SMALT_MISMATCH', message: 'parameter ?1: a list<int> is bound with an array, not 5' });
    await expect(db.queryPlan(echo('list<int>'), [['a']])).rejects.toMatchObject({ code: 'SMALT_MISMATCH' });
    expect([...(await db.queryPlan(echo('list<int>'), [[1]], { rowMode: 'array' }))]).toEqual([[[1]]]);
  });
});
