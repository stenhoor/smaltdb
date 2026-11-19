/**
 * Reading one key of a map without decoding the rest (ADR 0038): `map_get` and `map_contains_key` walk the map's
 * components (`skipComponent`) and decode only the value found (`decodeComponent`), and `struct_field` decodes only its
 * field. A generated scan checks a WHERE conjunct's map key, and a comparison of its value with a literal, on the
 * stored bytes before decoding the row (`mapProbe`). Every kind of value, typed values under `any` (ADR 0039), missing
 * keys, empty maps, keys that are prefixes of others, non-ASCII keys and NULLs, against what decoding the whole map gives.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { traceGeneratedCode } from '../src/engine/exec/codegen.js';
import { MapCompare, findMapKey, mapProbe } from '../src/engine/exec/nested-ops.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { ColumnDef, StorageType } from '../src/engine/plan/schema.js';
import type { PlanType } from '../src/engine/plan/types.js';
import { compareSameKind, decodeComponent, decodeKey, encodeKey, skipComponent } from '../src/engine/storage/key-codec.js';
import { type SqlValue, TypedValue, typedBool } from '../src/engine/values.js';

const M = 'map<text, any>' as PlanType;

/** One of every kind of component, the number encodings' edge cases included. */
const VALUES: SqlValue[] = [
  null,
  0,
  -0,
  1,
  -1,
  127,
  128,
  -128,
  2 ** 31,
  -(2 ** 31),
  2 ** 53 - 1,
  -(2 ** 53 - 1),
  2n ** 60n + 1n,
  -(2n ** 60n) - 1n,
  0.5,
  -0.5,
  Math.PI,
  -Math.PI,
  1e300,
  -1e300,
  1e-300,
  -1e-300,
  5e-324,
  -5e-324,
  2 ** 64,
  -(2 ** 64),
  Infinity,
  -Infinity,
  NaN,
  '',
  'a',
  'ab',
  'a\0b',
  '\0',
  'é',
  '日本語',
  '😀',
  '﻿bom',
  'x'.repeat(100),
  'ü'.repeat(40),
  new Uint8Array(0),
  Uint8Array.of(0, 1, 0, 255, 0),
  Uint8Array.of(1, 2, 3),
  typedBool(true),
  typedBool(false),
  new TypedValue('list<any>', encodeKey([1, 'a', null])),
  new TypedValue('map<text, any>', encodeKey(['k', Uint8Array.of(0)])),
];

describe('components one at a time', () => {
  it('skipComponent finds where each component ends, and decodeComponent gives what decodeKey does', () => {
    const bytes = encodeKey(VALUES);
    const whole = decodeKey(bytes);
    let pos = 0;
    for (let i = 0; i < VALUES.length; i++) {
      const end = skipComponent(bytes, pos);
      expect(end).toBe(pos + encodeKey([VALUES[i]!]).length);
      expect(decodeComponent(bytes, pos)).toEqual(whole[i]);
      pos = end;
    }
    expect(pos).toBe(bytes.length);
    expect(whole).toEqual(VALUES.map((v) => (Object.is(v, -0) ? 0 : v)));
  });

  it('compareSameKind orders numbers and text as their values do, and leaves other kinds out', () => {
    const numbers: SqlValue[] = [-Infinity, -1e300, -(2n ** 60n) - 1n, -1, -0.5, -1e-300, 0, 1e-300, 0.5, 1, 2 ** 53 - 1, 2n ** 60n + 1n, 1e300, Infinity];
    const texts = ['', '\0', 'a', 'a\0b', 'ab', 'é', '日本語', '😀'];
    for (const xs of [numbers, texts])
      for (let i = 0; i < xs.length; i++)
        for (let j = 0; j < xs.length; j++) expect(Math.sign(compareSameKind(encodeKey([xs[i]!]), 0, encodeKey([xs[j]!])))).toBe(Math.sign(i - j));
    expect(compareSameKind(encodeKey([1]), 0, encodeKey([1.0]))).toBe(0);
    expect(compareSameKind(encodeKey([1]), 0, encodeKey(['1']))).toBeNaN();
    expect(compareSameKind(encodeKey([NaN]), 0, encodeKey([1]))).toBeNaN();
    expect(compareSameKind(encodeKey([typedBool(true)]), 0, encodeKey([1]))).toBeNaN();
    expect(compareSameKind(encodeKey([null]), 0, encodeKey([1]))).toBeNaN();
  });
});

/** A map's bytes as the engine makes them: entries sorted by key. */
const mapBytes = (o: Record<string, SqlValue>): Uint8Array =>
  encodeKey(
    Object.keys(o)
      .sort((a, b) => (Buffer.from(a) < Buffer.from(b) ? -1 : 1))
      .flatMap((k) => [k, o[k]!]),
  );

describe('finding a key in a map', () => {
  const KEYS = ['', 'a', 'ab', 'abc', 'b', 'a\0', 'é', 'z', '日本', '😀'];
  const o: Record<string, SqlValue> = {};
  KEYS.forEach((k, i) => (o[k] = VALUES[(i * 5) % VALUES.length]!));
  const m = mapBytes(o);

  it('finds every key, keys that are prefixes of others included, and nothing else', () => {
    for (const k of KEYS) {
      const at = findMapKey(m, 0, m.length, encodeKey([k]));
      expect(at).toBeGreaterThan(0);
      expect(decodeComponent(m, at)).toEqual(o[k]);
    }
    for (const k of ['aa', 'abcd', 'a\0\0', ' ', 'zz', '￿', 'é ', 'A']) expect(findMapKey(m, 0, m.length, encodeKey([k]))).toBe(-1);
    expect(findMapKey(new Uint8Array(0), 0, 0, encodeKey(['a']))).toBe(-1);
  });

  it('mapProbe rules a row out only when the key is missing or its value of the literal kind fails the comparison', () => {
    const n = mapBytes({ age: 30, name: 'Bo', flag: typedBool(true), big: 2n ** 60n, nan: NaN });
    const probe = (k: string, op: MapCompare = MapCompare.None, lit: SqlValue | undefined = undefined) => mapProbe(n, 0, n.length, encodeKey([k]), op, lit === undefined ? null : encodeKey([lit]));
    expect(probe('age')).toBe(true);
    expect(probe('nope')).toBe(false);
    expect(probe('age', MapCompare.Eq, 30)).toBe(true);
    expect(probe('age', MapCompare.Eq, 30.0)).toBe(true);
    expect(probe('age', MapCompare.Eq, 31)).toBe(false);
    expect(probe('age', MapCompare.Ne, 30)).toBe(false);
    expect(probe('age', MapCompare.Gt, 29.5)).toBe(true);
    expect(probe('age', MapCompare.Gt, 30)).toBe(false);
    expect(probe('age', MapCompare.Ge, 30)).toBe(true);
    expect(probe('age', MapCompare.Lt, 30)).toBe(false);
    expect(probe('age', MapCompare.Le, 30)).toBe(true);
    expect(probe('big', MapCompare.Gt, 2 ** 60)).toBe(false);
    expect(probe('big', MapCompare.Eq, 2n ** 60n)).toBe(true);
    // Values of another kind than the literal's, and NaN, are left to the conjunct.
    expect(probe('age', MapCompare.Eq, '30')).toBe(true);
    expect(probe('name', MapCompare.Eq, 1)).toBe(true);
    expect(probe('flag', MapCompare.Eq, 0)).toBe(true);
    expect(probe('nan', MapCompare.Lt, 1)).toBe(true);
    expect(probe('name', MapCompare.Eq, 'Bo')).toBe(true);
    expect(probe('name', MapCompare.Eq, 'B')).toBe(false);
    expect(probe('name', MapCompare.Eq, 'Bob')).toBe(false);
    expect(probe('name', MapCompare.Gt, 'B')).toBe(true);
    expect(probe('name', MapCompare.Lt, 'B')).toBe(false);
  });
});

/** Maps of every kind of value under `any`, in from JavaScript. */
const ROWS: (Record<string, unknown> | null)[] = [
  { name: 'Ada', born: 1815, title: null },
  {},
  null,
  { '': 'empty key', a: 1, ab: 2, abc: 3, b: 4 },
  { é: 'e acute', 日本: 'Japan', '😀': 'smile', 'a\0': 'nul' },
  { flag: true, off: false, tags: ['x', ['y', true]], nested: { k: 1, deep: { z: null } }, blob: Uint8Array.of(0, 1, 0) },
  { n: -0.5, big: 2n ** 60n + 1n, huge: 1e300, tiny: -1e-300, inf: Infinity, nan: NaN, zero: 0, neg: -12345 },
  { long: 'x'.repeat(300), name: 'Bo 1', age: 30 },
  { name: 'Bo 1', age: '30' },
  { name: 'bo 1', age: 31.5 },
  // Rows too long for a leaf cell: their values overflow, so generated scans decode them the generic way.
  { age: 30, name: 'Bo 1', title: null, text: 'y'.repeat(9000) },
  { text: 'y'.repeat(9000), title: 'Dr' },
];
const KEYS = ['name', 'born', 'title', '', 'a', 'ab', 'abc', 'abcd', 'b', 'é', '日本', '😀', 'a\0', 'flag', 'off', 'tags', 'nested', 'blob', 'n', 'big', 'huge', 'tiny', 'inf', 'nan', 'zero', 'neg', 'long', 'age', 'missing', 'zzz'];

/** What a JavaScript key lookup gives for map_get (NaN as itself, booleans and lists as given). */
const expected = (row: Record<string, unknown> | null, k: string): unknown => (row === null ? null : Object.hasOwn(row, k) ? row[k] : null);

const column = (name: string, type: StorageType, declaredType: string): ColumnDef => ({ name, declaredType, type, notNull: false, collation: 'binary' });

/** A database with table t(id, props map<text, any>) holding ROWS. */
function stored(): Database {
  const db = Database.openMemory();
  db.queryPlan({ kind: 'schema', op: { op: 'createTable', table: { name: 't', columns: [column('id', 'INTEGER', 'INTEGER'), column('props', 'MAP', M)], keys: [], checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false } });
  db.queryPlan({ kind: 'write', plan: p.append('t', p.fromColumns([ROWS.map((_, i) => i), ROWS] as never, ['int', M]), [0, 1]) });
  return db;
}

describe('map_get and map_contains_key', () => {
  const db = stored();
  const props = p.col(0, 1, M);
  const scan = (): PlanOp => p.scan('t', [0, 1]);

  it('give each key of each map, from a table and from values in', () => {
    for (const source of [scan(), p.project(p.fromColumns([ROWS.map((_, i) => i), ROWS] as never, ['int', M]), [p.col(0, 0, 'int'), props])]) {
      const exprs = KEYS.flatMap((k) => [p.call('map_get', [props, p.lit(k)], 'any'), p.call('map_contains_key', [props, p.lit(k)], 'bool')]);
      const rows = db.queryPlan(p.project(source, exprs)).rows;
      ROWS.forEach((row, i) =>
        KEYS.forEach((k, j) => {
          expect(rows[i]![2 * j], `${i} ${JSON.stringify(k)}`).toEqual(expected(row, k));
          expect(rows[i]![2 * j + 1]).toBe(row === null ? null : Object.hasOwn(row, k));
        }),
      );
    }
  });

  it('give NULL for a NULL key, and a key read from a column', () => {
    const r = db.queryPlan(p.project(scan(), [p.call('map_get', [props, p.lit(null)], 'any'), p.call('map_contains_key', [props, p.lit(null)], 'bool')])).rows;
    expect(r.every((x) => x[0] === null && x[1] === null)).toBe(true);
    const byKey = p.fromColumns([[...KEYS, ...KEYS]] as never, ['text']);
    const one = p.project(p.values([[p.lit(1)]]), [p.call('map_of', [p.lit('a'), p.lit(1), p.lit('ab'), p.lit(2)], M)]);
    const got = db.queryPlan(p.project(p.join('cross', byKey, one), [p.call('map_get', [p.col(0, 1, M), p.col(0, 0, 'text')], 'int')])).rows.map((x) => x[0]);
    expect(got).toEqual([...KEYS, ...KEYS].map((k) => (k === 'a' ? 1 : k === 'ab' ? 2 : null)));
  });

  it('agree with the elements cache: a map just decoded whole is searched there', () => {
    const exprs = [p.call('map_len', [props], 'int'), ...KEYS.map((k) => p.call('map_get', [props, p.lit(k)], 'any')), ...KEYS.map((k) => p.call('map_contains_key', [props, p.lit(k)], 'bool'))];
    const rows = db.queryPlan(p.project(scan(), exprs)).rows;
    ROWS.forEach((row, i) => {
      expect(rows[i]![0]).toBe(row === null ? null : Object.keys(row).length);
      KEYS.forEach((k, j) => {
        expect(rows[i]![1 + j]).toEqual(expected(row, k));
        expect(rows[i]![1 + KEYS.length + j]).toBe(row === null ? null : Object.hasOwn(row, k));
      });
    });
  });

  it('struct_field decodes only its field', () => {
    const S = 'struct<a int, b text, c list<int>, d real>' as PlanType;
    const s = p.call('struct_of', [p.lit(-7), p.lit('é\0'), p.call('list_of', [p.lit(1), p.lit(2)], 'list<int>' as PlanType), p.lit(0.25)], S);
    const r = db.queryPlan(p.project(p.values([[p.lit(1)]]), [0, 1, 2, 3].map((i) => p.call('struct_field', [s, p.lit(i)], 'any')))).rows[0];
    expect(r).toEqual([-7, 'é\0', expect.anything(), 0.25]);
  });
});

describe('WHERE on a map key in a generated scan', () => {
  const db = stored();
  const props = p.col(0, 1, M);
  const get = (k: string): PlanExpr => p.call('map_get', [props, p.lit(k)], 'any');
  const cmp = (fn: string, a: PlanExpr, b: PlanExpr, collation?: 'nocase'): PlanExpr => ({ ...p.call(fn, [a, b], 'bool'), ...(collation ? { collation } : {}) }) as PlanExpr;
  const OPS = ['cmp_eq', 'cmp_ne', 'cmp_lt', 'cmp_le', 'cmp_gt', 'cmp_ge'];
  const LITS: SqlValue[] = [30, 30.0, 31.5, 1815, -1, 0, 'Bo 1', 'bo 1', 'Ada', '30', 'A', 'z'];
  const preds: PlanExpr[] = [];
  for (const k of ['name', 'age', 'born', 'nope', 'title', 'nan', 'big', 'flag'])
    for (const fn of OPS)
      for (const v of LITS) {
        preds.push(cmp(fn, get(k), p.lit(v)));
        preds.push(cmp(fn, p.lit(v), get(k)));
      }
  preds.push(
    cmp('cmp_eq', get('name'), p.lit('bo 1'), 'nocase'),
    p.not(p.isNull(get('age'))),
    { k: 'isNull', arg: get('title'), not: true } as PlanExpr,
    p.isNull(get('age')),
    p.call('map_contains_key', [props, p.lit('age')], 'bool'),
    p.call('map_contains_key', [props, p.lit('')], 'bool'),
    p.not(p.call('map_contains_key', [props, p.lit('age')], 'bool')),
    p.and(p.call('map_contains_key', [props, p.lit('name')], 'bool'), cmp('cmp_gt', get('age'), p.lit(30))),
    p.caseWhen([{ when: p.call('map_contains_key', [props, p.lit('age')], 'bool'), then: cmp('cmp_ge', get('age'), p.lit(30)) }], 'bool'),
    p.caseWhen([{ when: p.call('map_contains_key', [props, p.lit('age')], 'bool'), then: cmp('cmp_ge', get('age'), p.lit(30)) }], 'bool', p.lit(1)),
    p.or(cmp('cmp_eq', get('name'), p.lit('Ada')), cmp('cmp_eq', get('age'), p.lit(30))),
  );

  it('keeps the rows evaluating the conjunct keeps, checking the stored bytes first', () => {
    traceGeneratedCode(true);
    try {
      for (const pred of preds) {
        // The same conjunct evaluated row by row in a projection, which no generated scan reads ahead of.
        const want = db.queryPlan(p.project(p.scan('t', [0, 1]), [p.col(0, 0, 'int'), pred])).rows.filter((r) => r[1] === 1 || (r[1] as unknown) === true).map((r) => r[0]);
        const got = db.queryPlan(p.project(p.filter(p.scan('t', [0, 1]), pred), [p.col(0, 0, 'int')])).rows.map((r) => r[0]);
        expect(got, JSON.stringify(pred)).toEqual(want);
        const n = db.queryPlan(p.aggregate(p.filter(p.scan('t', [0, 1]), pred), [], [p.agg('count', [], 'int', { star: true })])).rows[0]![0];
        expect(n).toBe(want.length);
      }
    } finally {
      expect(traceGeneratedCode(false).some((s) => s.includes('H.mapProbe('))).toBe(true);
    }
  });

  it('checks the stored map before decoding the row', () => {
    traceGeneratedCode(true);
    db.queryPlan(p.aggregate(p.filter(p.scan('t', [0, 1]), cmp('cmp_eq', get('name'), p.lit('Bo 1'))), [], [p.agg('count', [], 'int', { star: true })]));
    const src = traceGeneratedCode(false).join('\n');
    expect(src).toMatch(/H\.mapProbe\(b, .*, K\[\d+\], 1, K\[\d+\]\)\) continue;/);
    expect(src.indexOf('H.mapProbe(')).toBeLessThan(src.indexOf('H.tagged('));
  });

  it('leaves a conjunct the probe decides to the rows it did not see, and then does not decode the map', () => {
    const db = stored();
    for (const pred of [p.call('map_contains_key', [props, p.lit('age')], 'bool'), p.not(p.isNull(get('title'))), { k: 'isNull', arg: get('age'), not: true } as PlanExpr]) {
      traceGeneratedCode(true);
      const n = db.queryPlan(p.aggregate(p.filter(p.scan('t', [0, 1]), pred), [], [p.agg('count', [], 'int', { star: true })])).rows[0]![0];
      const src = traceGeneratedCode(false).join('\n');
      expect(src).toMatch(/if \(sw\) \{ const v = K\[\d+\]\(r\); if \(v === null \|\| v == 0\) continue; \}/);
      expect(src).not.toContain('H.tagged(');
      const want = db.queryPlan(p.project(p.scan('t', [0, 1]), [pred])).rows.filter((r) => r[0] === 1 || (r[0] as unknown) === true).length;
      expect(n).toBe(want);
    }
  });
});

/**
 * `map_get(col, 'key')` read through FROM plans (planner.ts `keyReads`, prototype): the key's value is read from the
 * stored row into a register of its own, without the map, and rows that pass through joins carry it. Against what
 * decoding the whole map gives, on every key of every row (overflowing rows included).
 */
describe('map keys read through FROM plans', () => {
  const db = stored();
  const props = p.col(0, 1, M);
  /** t's rows through a FROM plan of their own (a LIMIT keeps it one). */
  const inner = (): PlanOp => p.limit(p.project(p.scan('t', [0, 1]), [p.col(0, 0, 'int'), props]), 1000);
  const traced = <T>(f: () => T): { out: T; code: string } => {
    traceGeneratedCode(true);
    try {
      const out = f();
      return { out, code: traceGeneratedCode(false).join('\n') };
    } finally {
      traceGeneratedCode(false);
    }
  };

  it('gives each key of each map, and reads it from the row', () => {
    const { out: rows, code } = traced(() => db.queryPlan(p.project(inner(), [p.col(0, 0, 'int'), ...KEYS.map((k) => p.call('map_get', [props, p.lit(k)], 'any'))])).rows);
    expect(code).toContain('H.mapKey(');
    ROWS.forEach((row, i) => KEYS.forEach((k, j) => expect(rows[i]![1 + j], `${i} ${JSON.stringify(k)}`).toEqual(expected(row, k))));
  });

  it('on either side of a join, a LEFT join that finds nothing included', () => {
    const ID = [0, 3, 5, 7, 9, 11, 42];
    const ids = p.fromColumns([ID] as never, ['int']);
    const K = ['name', 'age', 'tags', 'missing'];
    const vals = (i: number | null) => K.map((k) => (i === null ? null : expected(ROWS[i]!, k)));
    for (const kind of ['inner', 'left'] as const) {
      // t's rows as the join's right side (a hash join builds them), and as its left.
      for (const tLeft of [false, true]) {
        const on = p.call('cmp_eq', [p.col(0, 0, 'int'), p.col(1, 0, 'int')], 'bool');
        const join = tLeft ? p.join(kind, inner(), ids, on) : p.join(kind, ids, inner(), on);
        const [tId, idsId, m] = tLeft ? [p.col(0, 0, 'int'), p.col(0, 2, 'int'), p.col(0, 1, M)] : [p.col(0, 1, 'int'), p.col(0, 0, 'int'), p.col(0, 2, M)];
        const { out: rows, code } = traced(() => db.queryPlan(p.project(join, [tId, idsId, ...K.map((k) => p.call('map_get', [m, p.lit(k)], 'any'))])).rows);
        expect(code, `${kind} ${tLeft}: the keys are read from the row`).toContain('H.mapKey(');
        const inT = (i: number) => i < ROWS.length;
        const want =
          kind === 'inner'
            ? ID.filter(inT).map((i) => [i, i, ...vals(i)])
            : tLeft
              ? ROWS.map((_, i) => [i, ID.includes(i) ? i : null, ...vals(i)])
              : ID.map((j) => [inT(j) ? j : null, j, ...vals(inT(j) ? j : null)]);
        const order = (r: unknown[][]) => [...r].sort((a, b) => ((a[0] ?? a[1]) as number) - ((b[0] ?? b[1]) as number));
        expect(order(rows), `${kind} ${tLeft ? 't left' : 't right'}`).toEqual(order(want));
      }
    }
  });

  it('through a FROM plan that sorts its rows (read with the map), and in a GROUP BY', () => {
    const sorted = p.sort(p.project(p.scan('t', [0, 1]), [p.col(0, 0, 'int'), props]), [{ ...p.asc(p.col(0, 0, 'int')), desc: true }]);
    const rows = db.queryPlan(p.project(sorted, [p.col(0, 0, 'int'), p.call('map_get', [props, p.lit('name')], 'any')])).rows;
    expect(rows).toEqual(ROWS.map((r, i) => [i, expected(r, 'name')]).reverse());
    const grouped = db.queryPlan(p.aggregate(inner(), [p.call('map_get', [props, p.lit('name')], 'any')], [p.agg('count', [], 'int', { star: true })])).rows;
    const counts = new Map<unknown, number>();
    for (const r of ROWS) counts.set(expected(r, 'name'), (counts.get(expected(r, 'name')) ?? 0) + 1);
    expect(new Map(grouped.map((r) => [r[0], r[1]]))).toEqual(counts);
  });
});
