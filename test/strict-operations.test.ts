/**
 * Checked arithmetic and strict conversions (for smaltdf's decision E): an integer overflow and a value that does not
 * convert are errors, where `add` / `sub` / `mul` give a real and the `cast_*` conversions are lenient.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';

const MAX = 9223372036854775807n;
const MIN = -9223372036854775808n;

const one = (d: Database, e: PlanExpr) => d.queryPlan({ kind: 'query', plan: p.values([[e]]), columns: [{ name: 'x' }] }).rows[0]![0];
const call = (fn: string, ...args: unknown[]) => p.call(fn, args.map((a) => p.lit(a as never)), 'any');

describe('checked arithmetic', () => {
  it('gives the same results as add / sub / mul inside the integer range', () => {
    const d = Database.openMemory();
    for (const [fn, plain] of [['add_checked', 'add'], ['sub_checked', 'sub'], ['mul_checked', 'mul']] as const) {
      for (const [a, b] of [[2, 3], [-7, 4], [2 ** 40, 2 ** 20], [1.5, 2], [3, 0.25], [null, 1], [1, null], [MAX - 1n, 0], [MIN, 0]] as const) {
        expect(one(d, call(fn, a, b)), `${fn}(${a}, ${b})`).toEqual(one(d, call(plain, a, b)));
      }
    }
  });

  it('is an error outside it, where the plain operations give a real', () => {
    const d = Database.openMemory();
    expect(typeof one(d, call('add', MAX, 1))).toBe('number');
    expect(() => one(d, call('add_checked', MAX, 1))).toThrow(expect.objectContaining({ code: 'SMALT_RANGE', message: expect.stringMatching(/integer overflow in add_checked/) }));
    expect(() => one(d, call('sub_checked', MIN, 1))).toThrow(/integer overflow in sub_checked/);
    expect(() => one(d, call('mul_checked', 2 ** 40, 2 ** 40))).toThrow(/integer overflow in mul_checked/);
    expect(one(d, call('add_checked', MAX - 1n, 1))).toBe(MAX);
    expect(one(d, call('mul_checked', 3037000499, 3037000499))).toBe(9223372030926249001n);
  });

  it('takes numbers only, and reals stay reals', () => {
    const d = Database.openMemory();
    expect(() => one(d, call('add_checked', '1', 2))).toThrow(expect.objectContaining({ code: 'SMALT_MISMATCH' }));
    // A real result is never an overflow error: it is what the plain operation gives.
    expect(one(d, call('mul_checked', 1e300, 1e300))).toEqual(one(d, call('mul', 1e300, 1e300)));
  });

  it('reads table columns, and an overflow names its row by failing the statement', () => {
    const d = Database.openMemory();
    d.queryPlan({ kind: 'schema', op: { op: 'createTable', table: { name: 't', columns: [{ name: 'a', declaredType: 'INTEGER', type: 'INTEGER', notNull: false, collation: 'binary' }], keys: [], checks: [], foreignKeys: [], storage: 'row' }, temp: false, ifNotExists: false } });
    d.queryPlan({ kind: 'write', plan: p.append('t', p.values([[p.lit(1)], [p.lit(MAX)]]), [0]) });
    const plus = (fn: string) => ({ kind: 'query' as const, plan: p.project(p.scan('t', [0]), [p.call(fn, [p.col(0, 0, 'int'), p.lit(1)], 'int')]), columns: [{ name: 'x' }] });
    expect(() => d.queryPlan(plus('add_checked'))).toThrow(/integer overflow/);
    expect(d.queryPlan(plus('add')).rows.length).toBe(2);
  });
});

describe('strict conversions', () => {
  it('cast_integer_strict: integers, truncated reals in range, and text that is an integer in full', () => {
    const d = Database.openMemory();
    const strict = (v: unknown) => one(d, p.cast('cast_integer_strict', p.lit(v as never), 'int'));
    expect(strict(12)).toBe(12);
    expect(strict(12.9)).toBe(12);
    expect(strict(-12.9)).toBe(-12);
    expect(strict(' 42 ')).toBe(42);
    expect(strict('-9223372036854775808')).toBe(MIN);
    expect(strict(null)).toBe(null);
    for (const bad of ['x', '12x', '1.5', '', '9223372036854775808']) expect(() => strict(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: expect.stringMatching(/SMALT_(MISMATCH|RANGE)/) }));
    for (const bad of [1e19, Infinity, NaN]) expect(() => strict(bad), String(bad)).toThrow(expect.objectContaining({ code: 'SMALT_RANGE' }));
    expect(() => strict(new Uint8Array([1]))).toThrow(/blob/);
    // The lenient conversion, for comparison.
    expect(one(d, p.cast('cast_integer', p.lit('x'), 'int'))).toBe(0);
  });

  it('cast_real_strict: numbers, and text that is a number in full', () => {
    const d = Database.openMemory();
    const strict = (v: unknown) => one(d, p.cast('cast_real_strict', p.lit(v as never), 'real'));
    expect(strict(3)).toBe(3);
    expect(strict('2.5')).toBe(2.5);
    expect(strict('-1e3')).toBe(-1000);
    expect(strict('.5')).toBe(0.5);
    for (const bad of ['x', '2.5x', '', '1e']) expect(() => strict(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: 'SMALT_MISMATCH' }));
  });
});

describe('operations of one argument as calls', () => {
  it('compile with their argument (a call of one used to crash reading a second)', () => {
    const d = Database.openMemory();
    expect(one(d, call('cast_integer', '12'))).toBe(12);
    expect(one(d, call('cast_integer_strict', '12'))).toBe(12);
    expect(one(d, call('cast_text', 5))).toBe('5');
    expect(() => one(d, call('cast_real_strict', 'x'))).toThrow(expect.objectContaining({ code: 'SMALT_MISMATCH' }));
  });
});
