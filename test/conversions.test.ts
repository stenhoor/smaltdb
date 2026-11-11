/**
 * The conversion table (ADR 0027, decision 3): every pair of simple plan types, lists and structs element by element,
 * and each operation it names run through the engine on a value of the old type.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanType } from '../src/engine/plan/types.js';
import type { SqlValue } from '../src/engine/values.js';

const SIMPLE: PlanType[] = ['int', 'real', 'num', 'bool', 'text', 'blob', 'date', 'datetime', 'time', 'duration', 'any'];

/** Every pair that converts, as `from>to: fn` (`keep`: the value as it is), `!` after it when it can lose. */
const EXPECTED = [
  'int>real: cast_real!', 'int>num: keep', 'int>text: cast_text', 'int>any: keep',
  'real>int: cast_integer_strict!', 'real>num: keep', 'real>text: cast_text', 'real>any: keep',
  'num>int: cast_integer_strict!', 'num>real: cast_real_strict!', 'num>text: cast_text', 'num>any: keep',
  'bool>int: keep', 'bool>real: cast_real', 'bool>num: keep', 'bool>text: cast_text', 'bool>any: keep',
  'text>int: cast_integer_strict!', 'text>real: cast_real_strict!', 'text>num: cast_numeric!', 'text>blob: cast_blob',
  'text>date: cast_date!', 'text>datetime: cast_datetime!', 'text>time: cast_time!', 'text>any: keep',
  'blob>any: keep',
  'date>text: cast_text', 'date>datetime: cast_datetime', 'date>any: cast_text',
  'datetime>text: cast_text', 'datetime>date: cast_date!', 'datetime>time: cast_time!', 'datetime>any: cast_text',
  'time>text: cast_text', 'time>any: cast_text',
  'duration>text: cast_text', 'duration>any: cast_text',
  'any>num: cast_numeric!', 'any>text: cast_text!', 'any>blob: cast_blob!',
];

const show = (from: PlanType, to: PlanType): string | undefined => {
  const c = p.conversion(from, to);
  return c && `${from}>${to}: ${c.fn ?? 'keep'}${c.loss === 'possible' ? '!' : ''}`;
};

describe('the conversion table', () => {
  it('names a conversion for exactly the expected pairs of simple types', () => {
    const got: string[] = [];
    for (const from of SIMPLE) for (const to of SIMPLE) if (from !== to) { const s = show(from, to); if (s) got.push(s); }
    expect(got.sort()).toEqual([...EXPECTED].sort());
  });

  it('keeps a type as it is, and converts NULL to anything', () => {
    for (const t of [...SIMPLE, 'list<int>', 'struct<a int>'] as PlanType[]) {
      expect(p.conversion(t, t)).toEqual({ loss: 'none' });
      expect(p.conversion('null', t)).toEqual({ loss: 'none' });
    }
  });

  it('is lossless only where ADR 0027 says', () => {
    expect(p.isLossless('int', 'num')).toBe(true);
    expect(p.isLossless('date', 'datetime')).toBe(true);
    expect(p.isLossless('text', 'blob')).toBe(true);
    expect(p.isLossless('bool', 'int')).toBe(true);
    for (const t of SIMPLE) if (t !== 'any') expect(p.isLossless(t, 'any'), t).toBe(true);
    expect(p.isLossless('int', 'real')).toBe(false);
    expect(p.isLossless('real', 'int')).toBe(false);
    expect(p.isLossless('duration', 'int')).toBe(false);
    for (const t of ['date', 'datetime', 'time', 'duration'] as PlanType[]) expect(p.isLossless('text', t)).toBe(false);
    expect(p.isLossless('any', 'text')).toBe(false);
  });

  it('converts lists and structs to text, and element by element to each other', () => {
    expect(p.conversion('list<date>', 'text')).toEqual({ loss: 'none', fn: 'cast_text' });
    expect(p.conversion('struct<a int, b text>', 'any')).toEqual({ loss: 'none', fn: 'cast_text' });
    expect(p.conversion('list<int>', 'list<num>')).toEqual({ loss: 'none' });
    expect(p.conversion('list<list<int>>', 'list<list<any>>')).toEqual({ loss: 'none' });
    expect(p.conversion('struct<a int, b bool>', 'struct<a num, b int>')).toEqual({ loss: 'none' });
    // An element that needs a cast, a lossy element, a renamed or missing field, a list as a struct: none.
    expect(p.conversion('list<int>', 'list<text>')).toBeUndefined();
    expect(p.conversion('list<int>', 'list<real>')).toBeUndefined();
    expect(p.conversion('struct<a int>', 'struct<b int>')).toBeUndefined();
    expect(p.conversion('struct<a int, b int>', 'struct<a int>')).toBeUndefined();
    expect(p.conversion('list<int>', 'struct<a int>')).toBeUndefined();
    expect(p.conversion('list<int>', 'blob')).toBeUndefined();
    expect(p.conversion('int', 'list<int>')).toBeUndefined();
  });
});

/** A value of each simple type, and what each lossless operation makes of it. */
const SAMPLE: Partial<Record<PlanType, SqlValue>> = {
  int: 42,
  real: 2.5,
  num: 7,
  bool: 1,
  text: '2026-11-11',
  date: '2026-11-11',
  datetime: '2026-11-11 10:30:00',
  time: '10:30:00',
  duration: 'PT1H30M',
};
const LOSSLESS_RESULT: Record<string, SqlValue> = {
  'int>text': '42',
  'real>text': '2.5',
  'num>text': '7',
  'bool>real': 1,
  'bool>text': '1',
  'text>blob': new TextEncoder().encode('2026-11-11'),
  'date>text': '2026-11-11',
  'date>datetime': '2026-11-11 00:00:00',
  'date>any': '2026-11-11',
  'datetime>text': '2026-11-11 10:30:00',
  'datetime>any': '2026-11-11 10:30:00',
  'time>text': '10:30:00',
  'time>any': '10:30:00',
  'duration>text': 'PT1H30M',
  'duration>any': 'PT1H30M',
};

describe('the operations it names', () => {
  const db = Database.openMemory();
  for (const from of SIMPLE) {
    const v = SAMPLE[from];
    if (v === undefined) continue;
    for (const to of SIMPLE) {
      const c = p.conversion(from, to);
      if (from === to || !c?.fn || c.loss !== 'none') continue;
      it(`${from} → ${to} with ${c.fn}`, () => {
        const source = p.fromColumns([[v]], [from]);
        const r = db.queryPlan(p.project(source, [p.call(c.fn!, [p.col(0, 0, from)], to)]));
        expect(r.rows[0]![0]).toEqual(LOSSLESS_RESULT[`${from}>${to}`]);
      });
    }
  }
});
