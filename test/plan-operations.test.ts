/**
 * Operations for languages whose meaning differs from SQLite's (ADR 0016 section 1, step 4): float and floor division,
 * floor modulo, rounding half to even, Unicode case mapping and regular expressions, named for what they do. Values
 * here were checked against Python's `//`, `%` and `round` (which the floor operations and half-to-even rounding
 * follow) over a grid of integers, 64-bit edges, floats and negative zero.
 */
import { describe, expect, it } from 'vitest';
import { Database, plan as p } from '../src/engine/index.js';
import type { PlanType } from '../src/engine/plan/types.js';
import type { SqlValue } from '../src/engine/values.js';

const db = Database.openMemory();
/** `fn` of literal arguments, through a plan. */
function op(fn: string, ...args: [SqlValue, PlanType?][]): SqlValue {
  return db.queryPlan(p.project(p.values([[p.lit(0)]]), [p.call(fn, args.map(([v, t]) => p.lit(v, t)), 'any')])).rows[0][0] as SqlValue;
}
const int = (v: number | bigint): [SqlValue, PlanType] => [v, 'int'];
const real = (v: number): [SqlValue, PlanType] => [v, 'real'];
const text = (v: string): [SqlValue, PlanType] => [v, 'text'];
const nul: [SqlValue, PlanType] = [null, 'null'];

describe('division and remainder', () => {
  it('div_float always divides as floats', () => {
    expect(op('div_float', int(7), int(2))).toBe(3.5);
    expect(op('div_float', int(-7), int(2))).toBe(-3.5);
    expect(op('div_float', int(1), int(0))).toBe(Infinity);
    expect(op('div_float', int(-1), int(0))).toBe(-Infinity);
    expect(op('div_float', int(0), int(0))).toBe(null); // NaN, until NaN is a value (ADR 0016 section 3)
    expect(op('div_float', nul, int(2))).toBe(null);
    expect(op('div_trunc', int(7), int(2))).toBe(3); // SQL's division, for comparison
  });

  it('div_floor rounds toward negative infinity, as an integer for integers', () => {
    expect([op('div_floor', int(7), int(2)), op('div_floor', int(-7), int(2)), op('div_floor', int(7), int(-2)), op('div_floor', int(-7), int(-2))]).toEqual([3, -4, -4, 3]);
    expect(op('div_floor', int(2n ** 63n - 1n), int(2))).toBe(4611686018427387903n);
    expect(op('div_floor', int(-(2n ** 63n)), int(3))).toBe(-3074457345618258603n);
    expect(op('div_floor', real(7.5), real(2))).toBe(3);
    expect(op('div_floor', real(-7.5), real(2))).toBe(-4);
    expect(op('div_floor', int(1), int(0))).toBe(null);
    expect(op('div_floor', real(1), real(0))).toBe(null);
  });

  it('mod_floor takes the sign of the divisor', () => {
    expect([op('mod_floor', int(7), int(2)), op('mod_floor', int(-7), int(2)), op('mod_floor', int(7), int(-2)), op('mod_floor', int(-7), int(-2))]).toEqual([1, 1, -1, -1]);
    expect(op('mod_trunc', int(-7), int(2))).toBe(-1); // SQL's remainder, for comparison
    expect(op('mod_floor', real(-7.5), real(2))).toBe(0.5);
    expect(op('mod_floor', real(7.5), real(-2))).toBe(-0.5);
    expect(op('mod_floor', int(2n ** 63n - 1n), int(10))).toBe(7);
    expect(op('mod_floor', int(1), int(0))).toBe(null);
  });
});

describe('rounding', () => {
  it('round_half_even rounds halves to even, on the exact binary value', () => {
    expect([0.5, 1.5, 2.5, 3.5, -2.5].map((x) => op('round_half_even', real(x)))).toEqual([0, 2, 2, 4, -2]);
    expect(op('round_half_even', real(0.125), int(2))).toBe(0.12);
    expect(op('round_half_even', real(0.375), int(2))).toBe(0.38);
    expect(op('round_half_even', real(2.675), int(2))).toBe(2.67); // 2.675 is stored as 2.67499999…
    expect(op('round_half_even', real(1.25), int(1))).toBe(1.2);
    expect(op('round_half_even', real(1e20), int(2))).toBe(1e20);
    expect(op('round_half_even', real(7), int(3))).toBe(7);
    expect(op('round_half_even', nul)).toBe(null);
  });

  it('round_half_away is round, halves away from zero', () => {
    expect([0.5, 1.5, 2.5, -2.5].map((x) => op('round_half_away', real(x)))).toEqual([1, 2, 3, -3]);
    expect(op('round_half_away', real(0.125), int(2))).toBe(op('round', real(0.125), int(2)));
  });
});

describe('text', () => {
  it('lower_unicode and upper_unicode map every script, not ASCII only', () => {
    expect(op('upper_unicode', text('straße'))).toBe('STRASSE');
    expect(op('lower_unicode', text('ÀÉÎ ΣΑΣ'))).toBe('àéî σας');
    expect(op('upper', text('é'))).toBe('é'); // the ASCII-only functions are unchanged
    expect(op('lower_unicode', nul)).toBe(null);
  });

  it('length counts code points', () => {
    expect(op('length', text('a😀b'))).toBe(3);
  });

  it('regular expressions: match, find, replace, replace all', () => {
    expect(op('regex_match', text('order 42'), text('\\d+'))).toBe(1);
    expect(op('regex_match', text('order'), text('\\d+'))).toBe(0);
    expect(op('regex_match', text('ABC'), text('^abc$'), text('i'))).toBe(1);
    expect(op('regex_find', text('a1b22c333'), text('\\d{2,}'))).toBe('22');
    expect(op('regex_find', text('abc'), text('\\d'))).toBe(null);
    expect(op('regex_replace', text('a-b-c'), text('-'), text('+'))).toBe('a+b-c');
    expect(op('regex_replace_all', text('a-b-c'), text('-'), text('+'))).toBe('a+b+c');
    expect(op('regex_replace_all', text('2026-11-06'), text('(\\d+)-(\\d+)-(\\d+)'), text('$3/$2/$1'))).toBe('06/11/2026');
    expect(op('regex_find', text('😀x'), text('^.'))).toBe('😀'); // Unicode mode: one code point
    expect(op('regex_match', nul, text('a'))).toBe(null);
  });

  it('an invalid pattern or flag is an error', () => {
    expect(() => op('regex_match', text('a'), text('('))).toThrow(/invalid regular expression "\("/);
    expect(() => op('regex_match', text('a'), text('a'), text('g'))).toThrow(/invalid regular expression flags/);
  });
});

describe('languages share them', () => {
  it('SQL can call them as named functions', () => {
    expect(db.query("SELECT div_float(7, 2), div_floor(-7, 2), mod_floor(-7, 2), round_half_even(2.5), regex_find('x12', '\\d+')").rows).toEqual([[3.5, -4, 1, 2, '12']]);
  });
});
