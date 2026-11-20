/**
 * Comparisons within one kind (`cmp_lt_kind`, `cmp_le_kind`, `cmp_gt_kind`, `cmp_ge_kind`): two numbers, neither NaN,
 * or two texts by their bytes; NULL for anything else. Here against what JavaScript gives for the same values, as an
 * operation on values of every kind, and as a WHERE conjunct on a map's key, which a generated scan decides on the
 * map's stored bytes (`mapProbe`) without running the conjunct or decoding the map.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { traceGeneratedCode } from '../src/engine/exec/codegen.js';
import { MapCompare, mapProbe } from '../src/engine/exec/nested-ops.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanOp } from '../src/engine/plan/ops.js';
import type { ColumnDef, StorageType } from '../src/engine/plan/schema.js';
import type { PlanType } from '../src/engine/plan/types.js';
import { encodeKey } from '../src/engine/storage/key-codec.js';

const M = 'map<text, any>' as PlanType;
const FNS = ['cmp_lt_kind', 'cmp_le_kind', 'cmp_gt_kind', 'cmp_ge_kind'] as const;
type Fn = (typeof FNS)[number];

/** A value's kind as the operation sees it: a number that isn't NaN, text, or neither. */
const kind = (v: unknown): 'number' | 'text' | null => (typeof v === 'bigint' || (typeof v === 'number' && !Number.isNaN(v)) ? 'number' : typeof v === 'string' ? 'text' : null);

/** What the operation gives for two JavaScript values: JavaScript compares a number with a bigint exactly, and text here by its UTF-8 bytes. */
function want(fn: Fn, x: unknown, y: unknown): boolean | null {
  const k = kind(x);
  if (k === null || k !== kind(y)) return null;
  const c = k === 'text' ? Buffer.compare(Buffer.from(x as string, 'utf8'), Buffer.from(y as string, 'utf8')) : (x as number) < (y as number) ? -1 : (x as number) > (y as number) ? 1 : 0;
  return fn === 'cmp_lt_kind' ? c < 0 : fn === 'cmp_le_kind' ? c <= 0 : fn === 'cmp_gt_kind' ? c > 0 : c >= 0;
}

/** A result as true, false or null, whether the plan declared it bool or int. */
const truth = (v: unknown): boolean | null => (v === null ? null : v === true || v === 1);

const call = (fn: string, a: PlanExpr, b: PlanExpr): PlanExpr => p.call(fn, [a, b], 'bool');

/** Values of every kind, as they come in from JavaScript under `any`. */
const VALUES: unknown[] = [
  null,
  0,
  -0,
  1,
  -1,
  30,
  30.5,
  2 ** 53,
  2n ** 60n,
  2n ** 60n + 1n,
  -(2n ** 60n),
  1e300,
  -1e300,
  5e-324,
  Infinity,
  -Infinity,
  NaN,
  '',
  'a',
  'ab',
  'B',
  '30',
  'é',
  // U+FFFF sorts before U+1F600 by UTF-8 bytes, and after it by UTF-16 code units.
  '￿',
  '😀',
  true,
  false,
  [1, 2],
  { k: 1 },
  Uint8Array.of(1, 2),
];

describe('the operation', () => {
  const db = Database.openMemory();
  const xs: unknown[] = [];
  const ys: unknown[] = [];
  for (const x of VALUES) for (const y of VALUES) (xs.push(x), ys.push(y));
  /** Values as a column of `any`: each the one entry of a map, which takes every kind in from JavaScript. */
  const held = (values: readonly unknown[]): unknown[] => values.map((v) => ({ v }));
  const value = (column: number): PlanExpr => p.call('map_get', [p.col(0, column, M), p.lit('v')], 'any');

  it('compares two numbers, or two texts by their bytes, and is NULL for anything else', () => {
    const rows = db.queryPlan(
      p.project(
        p.fromColumns([held(xs), held(ys)] as never, [M, M]),
        FNS.map((fn) => call(fn, value(0), value(1))),
      ),
    ).rows;
    expect(rows).toHaveLength(VALUES.length ** 2);
    rows.forEach((r, i) => FNS.forEach((fn, j) => expect(truth(r[j]), `${fn}(${String(xs[i])}, ${String(ys[i])})`).toBe(want(fn, xs[i], ys[i]))));
    // The cases the table rests on, written out.
    const one = (fn: Fn, x: unknown, y: unknown): boolean | null => truth(db.queryPlan(p.project(p.fromColumns([held([x]), held([y])] as never, [M, M]), [call(fn, value(0), value(1))])).rows[0]![0]);
    expect(one('cmp_lt_kind', 1, 2)).toBe(true);
    expect(one('cmp_lt_kind', 30, 30.5)).toBe(true);
    expect(one('cmp_ge_kind', 2n ** 60n + 1n, 2 ** 60)).toBe(true);
    expect(one('cmp_gt_kind', 2n ** 60n, 2 ** 60)).toBe(false);
    expect(one('cmp_lt_kind', 1, 'a')).toBeNull();
    expect(one('cmp_gt_kind', 'a', 1)).toBeNull();
    expect(one('cmp_le_kind', NaN, NaN)).toBeNull();
    expect(one('cmp_lt_kind', 1, NaN)).toBeNull();
    expect(one('cmp_lt_kind', '￿', '😀')).toBe(true);
    expect(one('cmp_le_kind', true, true)).toBeNull();
    expect(one('cmp_le_kind', null, 1)).toBeNull();
  });

  it('gives a literal and a parameter what it gives a value', () => {
    for (const fn of FNS)
      for (const y of [30, 30.5, 'a', NaN, null, 2n ** 60n]) {
        const typed: PlanType = typeof y === 'string' ? 'text' : y === null ? 'any' : Number.isInteger(y) || typeof y === 'bigint' ? 'int' : 'real';
        const source = p.fromColumns([held(VALUES)] as never, [M]);
        const lit = db.queryPlan(p.project(source, [call(fn, value(0), p.lit(y as never)), call(fn, p.lit(y as never), value(0))])).rows;
        const param = db.queryPlan(p.project(source, [call(fn, value(0), p.param(0, typed)), call(fn, p.param(0, typed), value(0))]), [y as never]).rows;
        VALUES.forEach((x, i) => {
          expect(truth(lit[i]![0]), `${fn}(${String(x)}, ${String(y)})`).toBe(want(fn, x, y));
          expect(truth(lit[i]![1])).toBe(want(fn, y, x));
          expect(truth(param[i]![0])).toBe(want(fn, x, y));
          expect(truth(param[i]![1])).toBe(want(fn, y, x));
        });
      }
  });

  it('takes no collation but BINARY', () => {
    const source = p.fromColumns([['a', 'B']] as never, ['text']);
    const withCollation = (collation: string): PlanExpr => ({ ...call('cmp_lt_kind', p.col(0, 0, 'text'), p.lit('b')), collation }) as PlanExpr;
    expect(db.queryPlan(p.project(source, [withCollation('binary')])).rows.map((r) => truth(r[0]))).toEqual([true, true]);
    expect(() => db.queryPlan(p.project(source, [withCollation('nocase')]))).toThrow('takes no collation');
  });
});

/** Maps whose `age` and `name` are of every kind, some missing, in rows short and too long for a leaf cell. */
const ROWS: (Record<string, unknown> | null)[] = [
  { age: 30, name: 'Bo' },
  { age: 30.5, name: 'bo' },
  { age: '30', name: 5 },
  { age: NaN, name: 'B' },
  { age: null, name: null },
  {},
  null,
  { age: true, name: false },
  { age: [1, 2], name: { k: 1 } },
  { age: 2n ** 60n + 1n },
  { age: Infinity, name: '' },
  { age: -Infinity, name: 'é' },
  { age: -0, name: '￿' },
  { age: 0, name: '😀' },
  { age: 31, a: 1, ab: 2, zzz: 3 },
  { name: 'Bo', other: 'x'.repeat(300) },
  // Too long for a leaf cell: a generated scan decodes these the generic way, and runs the conjunct on them.
  { age: 29, name: 'Bo', text: 'y'.repeat(9000) },
  { text: 'y'.repeat(9000), age: 'old' },
];

const column = (name: string, type: StorageType, declaredType: string): ColumnDef => ({ name, declaredType, type, notNull: false, collation: 'binary' });

/** A database with table t(id, props map<text, any>) holding ROWS. */
function stored(): Database {
  const db = Database.openMemory();
  db.queryPlan({ kind: 'schema', op: { op: 'createTable', table: { name: 't', columns: [column('id', 'INTEGER', 'INTEGER'), column('props', 'MAP', M)], keys: [], checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false } });
  db.queryPlan({ kind: 'write', plan: p.append('t', p.fromColumns([ROWS.map((_, i) => i), ROWS] as never, ['int', M]), [0, 1]) });
  return db;
}

describe('WHERE on a map key in a generated scan', () => {
  const db = stored();
  const props = p.col(0, 1, M);
  const get = (k: string): PlanExpr => p.call('map_get', [props, p.lit(k)], 'any');
  const count = (pred: PlanExpr): PlanOp => p.aggregate(p.filter(p.scan('t', [0, 1]), pred), [], [p.agg('count', [], 'int', { star: true })]);
  const kept = (pred: PlanExpr): PlanOp => p.project(p.filter(p.scan('t', [0, 1]), pred), [p.col(0, 0, 'int')]);
  const KEYS = ['age', 'name', 'nope', 'a', 'text'];
  const LITS: unknown[] = [30, 30.5, 29, 0, -1, 1e300, 2n ** 60n, 'Bo', 'bo', 'B', '', '30', 'z', '￿'];
  /** The rows of ROWS whose key compares so with a value. */
  const rowsFor = (fn: Fn, k: string, v: unknown, flipped: boolean): number[] =>
    ROWS.flatMap((row, i) => {
      const x = row === null || !Object.hasOwn(row, k) ? null : row[k];
      return (flipped ? want(fn, v, x) : want(fn, x, v)) === true ? [i] : [];
    });

  it('keeps the rows the comparison is true of, whichever side the key is on', () => {
    traceGeneratedCode(true);
    let checked = 0;
    try {
      for (const k of KEYS)
        for (const fn of FNS)
          for (const v of LITS)
            for (const flipped of [false, true]) {
              const pred = flipped ? call(fn, p.lit(v as never), get(k)) : call(fn, get(k), p.lit(v as never));
              const rows = rowsFor(fn, k, v, flipped);
              expect(db.queryPlan(kept(pred)).rows.map((r) => r[0]), `${fn} ${k} ${String(v)} ${flipped}`).toEqual(rows);
              expect(db.queryPlan(count(pred)).rows[0]![0]).toBe(rows.length);
              checked++;
            }
    } finally {
      // The four comparisons as the probe's codes, either way round.
      const src = traceGeneratedCode(false).join('\n');
      for (const code of [MapCompare.KindLt, MapCompare.KindLe, MapCompare.KindGt, MapCompare.KindGe]) expect(src).toMatch(new RegExp(`H\\.mapProbe\\(b, .*, K\\[\\d+\\], ${code}, K\\[\\d+\\]\\)\\) continue;`));
    }
    expect(checked).toBe(KEYS.length * FNS.length * LITS.length * 2);
    // Some of each: rows the comparison keeps, and rows of another kind it leaves out.
    expect(rowsFor('cmp_ge_kind', 'age', 30, false)).toEqual([0, 1, 9, 10, 14]);
    expect(rowsFor('cmp_lt_kind', 'name', 'C', false)).toEqual([0, 3, 10, 15, 16]);
  });

  it('keeps them for a parameter of any type and a value of any kind', () => {
    const TYPES: PlanType[] = ['any', 'int', 'real', 'num', 'text', 'bool'];
    const BOUND: unknown[] = [...LITS, null, NaN, Infinity, -0, 1];
    traceGeneratedCode(true);
    try {
      for (const k of ['age', 'name', 'nope'])
        for (const fn of FNS)
          for (const type of TYPES)
            for (const flipped of [false, true]) {
              const pred = flipped ? call(fn, p.param(0, type), get(k)) : call(fn, get(k), p.param(0, type));
              const rows = db.preparePlan(kept(pred));
              const counted = db.preparePlan(count(pred));
              for (const v of BOUND) {
                const wanted = rowsFor(fn, k, v, flipped);
                expect(rows.result([v as never]).rows.map((r) => r[0]), `${fn} ${k} ${type} ${String(v)} ${flipped}`).toEqual(wanted);
                expect(counted.result([v as never]).rows[0]![0]).toBe(wanted.length);
              }
            }
    } finally {
      const src = traceGeneratedCode(false);
      // Whatever the parameter's type, its value is probed with when it is a number or text.
      expect(src.every((x) => !x.includes('H.probeValue(') || x.includes('H.probeValue(r[0], true, true)'))).toBe(true);
      expect(src.some((x) => x.includes('H.probeValue(r[0], true, true)'))).toBe(true);
    }
  });

  it('decides the conjunct on the stored bytes: it runs only for rows the probe did not see, and the map is not decoded', () => {
    const cases: [PlanExpr, unknown[]][] = [
      [call('cmp_gt_kind', get('age'), p.lit(29.5)), []],
      [call('cmp_le_kind', p.lit('Bo'), get('name')), []],
      [call('cmp_ge_kind', get('age'), p.param(0, 'real')), [30]],
    ];
    for (const [pred, params] of cases) {
      traceGeneratedCode(true);
      const n = db.queryPlan(count(pred), params as never).rows[0]![0];
      const src = traceGeneratedCode(false).join('\n');
      expect(src).toMatch(/if \(sw\) \{ const v = K\[\d+\]\(r\); if \(v === null \|\| v == 0\) continue; \}/);
      expect(src).not.toContain('H.tagged(');
      expect(n).toBe(db.queryPlan(p.project(p.scan('t', [0, 1]), [pred]), params as never).rows.filter((r) => truth(r[0]) === true).length);
      expect(n).toBeGreaterThan(0);
    }
  });

  it('is checked on the stored bytes where it is part of a conjunct, which then decides', () => {
    const ge = call('cmp_ge_kind', get('age'), p.lit(30));
    const preds = [
      p.caseWhen([{ when: p.call('map_contains_key', [props, p.lit('name')], 'bool'), then: ge }], 'bool'),
      p.or(ge, call('cmp_lt_kind', get('name'), p.lit('C'))),
      p.not(ge),
      p.and(ge, call('cmp_lt_kind', get('name'), p.lit('a'))),
    ];
    for (const pred of preds) {
      const each = db.queryPlan(p.project(p.scan('t', [0, 1]), [p.col(0, 0, 'int'), pred])).rows.filter((r) => truth(r[1]) === true).map((r) => r[0]);
      expect(db.queryPlan(kept(pred)).rows.map((r) => r[0]), JSON.stringify(pred)).toEqual(each);
    }
    expect(db.queryPlan(kept(preds[0]!)).rows.map((r) => r[0])).toEqual([0, 1, 10]);
    expect(db.queryPlan(kept(preds[3]!)).rows.map((r) => r[0])).toEqual([0, 10]);
  });

  it('holds for no row when there is nothing to compare with', () => {
    const st = db.preparePlan(count(call('cmp_lt_kind', get('age'), p.param(0, 'any'))));
    for (const v of [null, NaN, Uint8Array.of(1)]) expect(st.result([v as never]).rows[0]![0], String(v)).toBe(0);
    expect(st.result([31]).rows[0]![0]).toBe(rowsFor('cmp_lt_kind', 'age', 31, false).length);
    expect(rowsFor('cmp_lt_kind', 'age', 31, false)).toEqual([0, 1, 11, 12, 13, 16]);
    // A truth value bound to a parameter is its number, as everywhere in the engine.
    expect(st.result([true as never]).rows[0]![0]).toBe(rowsFor('cmp_lt_kind', 'age', 1, false).length);
  });
});

describe('the probe', () => {
  const bytes = encodeKey(['age', 30, 'big', 2n ** 60n, 'flag', true as never, 'name', 'Bo', 'nan', NaN, 'none', null]);
  const probe = (k: string, op: MapCompare, lit: unknown): boolean => mapProbe(bytes, 0, bytes.length, encodeKey([k]), op, lit === undefined ? null : encodeKey([lit as never]));

  it('passes a comparison within one kind only for a value of the literal kind that compares so', () => {
    expect(probe('age', MapCompare.KindGt, 29.5)).toBe(true);
    expect(probe('age', MapCompare.KindGt, 30)).toBe(false);
    expect(probe('age', MapCompare.KindGe, 30)).toBe(true);
    expect(probe('age', MapCompare.KindLt, 30)).toBe(false);
    expect(probe('age', MapCompare.KindLe, 30)).toBe(true);
    expect(probe('big', MapCompare.KindGt, 2 ** 53)).toBe(true);
    expect(probe('name', MapCompare.KindLt, 'C')).toBe(true);
    expect(probe('name', MapCompare.KindGe, 'Bo')).toBe(true);
    // A value of another kind, a NaN, a NULL and a missing key: where the other comparisons leave the row to the conjunct.
    for (const op of [MapCompare.KindLt, MapCompare.KindLe, MapCompare.KindGt, MapCompare.KindGe]) {
      expect(probe('age', op, '30')).toBe(false);
      expect(probe('name', op, 1)).toBe(false);
      expect(probe('flag', op, 0)).toBe(false);
      expect(probe('nan', op, 1)).toBe(false);
      expect(probe('none', op, 1)).toBe(false);
      expect(probe('nope', op, 1)).toBe(false);
      // No literal: a parameter with nothing to compare with.
      expect(probe('age', op, undefined)).toBe(false);
    }
    expect(probe('age', MapCompare.Gt, '30')).toBe(true);
  });
});
