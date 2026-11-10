/**
 * The date and time operations (ADR 0019 step 2): parts, building from parts, parse and format, truncation, calendar
 * offsets, strict casts, and the result types of arithmetic on temporal values. Each runs with and without code
 * generation (the suite's SMALT_NO_CODEGEN run) and through the plan codec (SMALT_PLAN_ROUNDTRIP).
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { plan as p } from '../src/engine/index.js';
import type { PlanExpr } from '../src/engine/plan/expr.js';
import type { PlanType } from '../src/engine/plan/types.js';
import { daysFromCivil } from '../src/shared/temporal.js';

const DAY = 86_400_000_000;
const db = Database.openMemory();
const days = (y: number, m: number, d: number) => daysFromCivil(y, m, d);
const us = (y: number, m: number, d: number, h = 0, mi = 0, s = 0, f = 0) => days(y, m, d) * DAY + ((h * 60 + mi) * 60 + s) * 1e6 + f;

const date = (y: number, m: number, d: number) => p.lit(days(y, m, d), 'date');
const datetime = (y: number, m: number, d: number, h = 0, mi = 0, s = 0, f = 0) => p.lit(us(y, m, d, h, mi, s, f), 'datetime');
const time = (h: number, mi = 0, s = 0, f = 0) => p.lit(((h * 60 + mi) * 60 + s) * 1e6 + f, 'time');
const text = (s: string) => p.lit(s, 'text');
const int = (n: number) => p.lit(n, 'int');

/** The value of `fn(args)`, declared `type`, as results give it. */
function call(fn: string, args: PlanExpr[], type: PlanType): unknown {
  return db.queryPlan(p.project(p.values([[]]), [p.call(fn, args, type)])).rows[0]![0];
}

/** Values of `fn(x, …rest)` over a column of `xs` of type `t` (so code generation sees a column, not a constant). */
function over(fn: string, t: PlanType, xs: (number | null)[], rest: PlanExpr[], type: PlanType): unknown[] {
  const rows = db.queryPlan(p.project(p.fromColumns([xs as never], [t]), [p.call(fn, [p.col(0, 0, t), ...rest], type)])).rows;
  return rows.map((r) => r[0]);
}

describe('parts', () => {
  it('of dates and datetimes, and of times', () => {
    const ts = datetime(2026, 11, 7, 13, 4, 5, 678_901);
    expect(['year', 'month', 'day', 'weekday', 'day_of_year'].map((f) => call(f, [ts], 'int'))).toEqual([2026, 11, 7, 6, 311]);
    expect(['year', 'month', 'day', 'weekday', 'day_of_year'].map((f) => call(f, [date(2024, 12, 31)], 'int'))).toEqual([2024, 12, 31, 2, 366]);
    expect(['hour', 'minute', 'second', 'microsecond'].map((f) => call(f, [ts], 'int'))).toEqual([13, 4, 5, 678_901]);
    expect(['hour', 'minute', 'second', 'microsecond'].map((f) => call(f, [time(23, 59, 58, 1)], 'int'))).toEqual([23, 59, 58, 1]);
    // Before 1970: the day and clock still count forward from midnight.
    expect(['year', 'hour', 'second'].map((f) => call(f, [p.lit(-1, 'datetime')], 'int'))).toEqual([1969, 23, 59]);
    expect(call('year', [p.lit(null, 'date')], 'int')).toBeNull();
  });

  it('agree with JS Date over columns of values', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -62_135_596_800_000, max: 253_402_300_799_999 }), { minLength: 1, maxLength: 20 }), (ms) => {
        const xs = ms.map((m) => m * 1000);
        const js = ms.map((m) => new Date(m));
        expect(over('year', 'datetime', xs, [], 'int')).toEqual(js.map((x) => x.getUTCFullYear()));
        expect(over('month', 'datetime', xs, [], 'int')).toEqual(js.map((x) => x.getUTCMonth() + 1));
        expect(over('weekday', 'datetime', xs, [], 'int')).toEqual(js.map((x) => x.getUTCDay() || 7));
        expect(over('hour', 'datetime', xs, [], 'int')).toEqual(js.map((x) => x.getUTCHours()));
        expect(over('second', 'datetime', xs, [], 'int')).toEqual(js.map((x) => x.getUTCSeconds()));
      }),
      { numRuns: 200 },
    );
  });

  it('take the types they are defined on', () => {
    expect(() => call('hour', [date(2026, 1, 1)], 'int')).toThrow(/hour takes datetime or time, not date/);
    expect(() => call('year', [int(3)], 'int')).toThrow(/year takes date or datetime, not int/);
    expect(db.catalog.resultType('year', ['date'])).toBe('int');
  });
});

describe('building from parts', () => {
  it('make_date and make_datetime', () => {
    expect(call('make_date', [int(2024), int(2), int(29)], 'date')).toBe('2024-02-29');
    expect(call('make_datetime', [int(2026), int(11), int(7)], 'datetime')).toBe('2026-11-07 00:00:00');
    expect(call('make_datetime', [int(2026), int(11), int(7), int(9), int(5), int(3), int(250_000)], 'datetime')).toBe('2026-11-07 09:05:03.250');
    expect(call('make_date', [int(2026), p.lit(null, 'int'), int(1)], 'date')).toBeNull();
    expect(() => call('make_date', [int(2025), int(2), int(29)], 'date')).toThrow(/2025-2-29 is not a date/);
    expect(() => call('make_datetime', [int(2026), int(1), int(1), int(24)], 'datetime')).toThrow(/not a time of day/);
    expect(() => call('make_date', [p.lit(2026.5, 'real'), int(1), int(1)], 'date')).toThrow(/year must be an integer/);
  });
});

describe('parse and format', () => {
  it('parse the result text, or with a format; NULL when it does not match', () => {
    expect(call('parse_date', [text('2026-11-07')], 'date')).toBe('2026-11-07');
    expect(call('parse_date', [text('07/11/26')], 'date')).toBeNull();
    expect(call('parse_date', [text('07/11/26'), text('%d/%m/%y')], 'date')).toBe('2026-11-07');
    expect(call('parse_date', [text('7 Nov 2026'), text('%d %b %Y')], 'date')).toBe('2026-11-07');
    expect(call('parse_date', [text('2026-311'), text('%Y-%j')], 'date')).toBe('2026-11-07');
    expect(call('parse_date', [text('2026-02-30'), text('%F')], 'date')).toBeNull();
    expect(call('parse_datetime', [text('2026-11-07T12:30')], 'datetime')).toBe('2026-11-07 12:30:00');
    expect(call('parse_datetime', [text('November 7, 2026 1:05:09.5 PM'), text('%B %d, %Y %I:%M:%S.%f %p')], 'datetime')).toBe('2026-11-07 13:05:09.500');
    expect(call('parse_datetime', [text('12/31/1969 12:00 am'), text('%m/%d/%Y %I:%M %p')], 'datetime')).toBe('1969-12-31 00:00:00');
    expect(() => call('parse_date', [text('11-07'), text('%m-%d')], 'date')).toThrow(/has no year/);
    expect(() => call('parse_date', [text('x'), text('%Q')], 'date')).toThrow(/unknown directive %Q/);
  });

  it('format with strftime directives', () => {
    const ts = datetime(2026, 11, 7, 13, 4, 5, 678_901);
    expect(call('format_temporal', [ts, text('%A %e %B %Y, %I:%M %p (%j, day %u) %f %%')], 'text')).toBe('Saturday  7 November 2026, 01:04 PM (311, day 6) 678901 %');
    expect(call('format_temporal', [date(2026, 11, 7), text('%F %a %b %y %w')], 'text')).toBe('2026-11-07 Sat Nov 26 6');
    expect(call('format_temporal', [time(0, 1, 2), text('%T %I%p')], 'text')).toBe('00:01:02 12AM');
    expect(() => call('format_temporal', [date(2026, 1, 1), text('%H')], 'text')).toThrow(/a date has none/);
    expect(() => call('format_temporal', [time(1), text('%Y')], 'text')).toThrow(/a time has none/);
  });

  it('format and parse are inverses for every datetime', () => {
    fc.assert(
      fc.property(fc.integer({ min: -62_135_596_800_000_000, max: 253_402_300_799_999_999 }), (x) => {
        const f = '%Y/%m/%d %H.%M.%S.%f';
        const t = call('format_temporal', [p.lit(x, 'datetime'), text(f)], 'text') as string;
        expect(db.queryPlan(p.project(p.values([[]]), [p.call('parse_datetime', [text(t), text(f)], 'datetime')])).rows[0]![0]).toBe(
          db.queryPlan(p.project(p.values([[]]), [p.lit(x, 'datetime')])).rows[0]![0],
        );
      }),
      { numRuns: 300 },
    );
  });
});

describe('truncation and offsets', () => {
  it('trunc_temporal to a unit', () => {
    const ts = datetime(2026, 11, 7, 13, 4, 5, 678_901);
    const units = ['year', 'quarter', 'month', 'week', 'day', 'hour', 'minute', 'second', 'millisecond'];
    expect(units.map((u) => call('trunc_temporal', [ts, text(u)], 'datetime'))).toEqual([
      '2026-01-01 00:00:00',
      '2026-10-01 00:00:00',
      '2026-11-01 00:00:00',
      '2026-11-02 00:00:00',
      '2026-11-07 00:00:00',
      '2026-11-07 13:00:00',
      '2026-11-07 13:04:00',
      '2026-11-07 13:04:05',
      '2026-11-07 13:04:05.678',
    ]);
    expect(call('trunc_temporal', [date(2026, 11, 8), text('week')], 'date')).toBe('2026-11-02');
    expect(call('trunc_temporal', [time(13, 4, 5), text('hour')], 'time')).toBe('13:00:00');
    expect(over('trunc_temporal', 'datetime', [-1], [text('day')], 'datetime')).toEqual(['1969-12-31 00:00:00']);
    expect(() => call('trunc_temporal', [date(2026, 1, 1), text('hour')], 'date')).toThrow(/a date has no hours/);
    expect(() => call('trunc_temporal', [ts, text('fortnight')], 'datetime')).toThrow(/unknown unit 'fortnight'/);
  });

  it('offset_by: calendar months keep the day, or the last day of a shorter month', () => {
    expect(call('offset_by', [date(2026, 1, 31), text('1mo')], 'date')).toBe('2026-02-28');
    expect(call('offset_by', [date(2024, 2, 29), text('1y')], 'date')).toBe('2025-02-28');
    expect(call('offset_by', [date(2026, 3, 31), text('-1mo')], 'date')).toBe('2026-02-28');
    expect(call('offset_by', [date(2026, 11, 7), text('1q2w')], 'date')).toBe('2027-02-21');
    expect(call('offset_by', [date(2026, 11, 7), text('48h')], 'date')).toBe('2026-11-09');
    expect(call('offset_by', [datetime(2026, 1, 31, 23, 30), text('1mo1h')], 'datetime')).toBe('2026-03-01 00:30:00');
    expect(call('offset_by', [datetime(2026, 1, 1), text('-1us')], 'datetime')).toBe('2025-12-31 23:59:59.999999');
    expect(call('offset_by', [datetime(2026, 1, 1), p.lit(90 * 60e6, 'duration')], 'datetime')).toBe('2026-01-01 01:30:00');
    expect(() => call('offset_by', [date(2026, 1, 1), text('1h')], 'date')).toThrow(/whole days/);
    expect(() => call('offset_by', [date(2026, 1, 1), text('1 month')], 'date')).toThrow(/is not an offset/);
    expect(() => call('offset_by', [time(1), text('1h')], 'time')).toThrow(/takes date or datetime, not time/);
  });
});

describe('casts', () => {
  it('cast_date and cast_datetime are strict', () => {
    expect(call('cast_date', [text('2026-11-07')], 'date')).toBe('2026-11-07');
    expect(call('cast_date', [datetime(1969, 12, 31, 23)], 'date')).toBe('1969-12-31');
    expect(call('cast_date', [int(0)], 'date')).toBe('1970-01-01');
    expect(call('cast_datetime', [date(2026, 11, 7)], 'datetime')).toBe('2026-11-07 00:00:00');
    expect(call('cast_datetime', [text('2026-11-07 12:00:00.5')], 'datetime')).toBe('2026-11-07 12:00:00.500');
    expect(call('cast_datetime', [int(1_000_000)], 'datetime')).toBe('1970-01-01 00:00:01');
    expect(call('cast_date', [p.lit(null, 'text')], 'date')).toBeNull();
    expect(() => call('cast_date', [text('2026-02-30')], 'date')).toThrow(/'2026-02-30' is not a date/);
    expect(() => call('cast_datetime', [text('soon')], 'datetime')).toThrow(/'soon' is not a date and time/);
    expect(() => call('cast_date', [p.lit(1.5, 'real')], 'date')).toThrow(/not a whole number/);
    expect(() => call('cast_date', [time(1)], 'date')).toThrow(/not time/);
  });

  it('cast_time: a time of day from text, a datetime or µs; strict', () => {
    expect(call('cast_time', [text('12:30:00')], 'time')).toBe('12:30:00');
    expect(call('cast_time', [text('08:05')], 'time')).toBe('08:05:00');
    expect(call('cast_time', [datetime(2026, 11, 7, 13, 4, 5)], 'time')).toBe('13:04:05');
    expect(call('cast_time', [datetime(1969, 12, 31, 23, 59)], 'time')).toBe('23:59:00');
    expect(call('cast_time', [int(1_500_000)], 'time')).toBe('00:00:01.500');
    expect(call('cast_time', [p.lit(null, 'text')], 'time')).toBeNull();
    expect(() => call('cast_time', [text('noon')], 'time')).toThrow(/'noon' is not a time/);
    expect(() => call('cast_time', [int(86_400_000_000)], 'time')).toThrow(/not within a day/);
    expect(() => call('cast_time', [date(2026, 1, 1)], 'time')).toThrow(/not date/);
  });

  it('cast_text gives the result text', () => {
    expect(call('cast_text', [datetime(2026, 11, 7, 12, 0, 0, 500_000)], 'text')).toBe('2026-11-07 12:00:00.500');
    expect(call('cast_text', [p.lit(DAY + 1e6, 'duration')], 'text')).toBe('P1DT1S');
  });
});

describe('arithmetic', () => {
  /** `fn(a, b)` with the type the engine gives it, and its value. */
  function typed(fn: string, a: PlanExpr, b: PlanExpr): [PlanType, unknown] {
    const e = p.call(fn, [a, b], 'any');
    const t = db.catalog.typeOf(e as never);
    return [t, call(fn, [a, b], t)];
  }

  for (const sub of ['sub', 'sub_checked']) {
    it(`${sub}: differences are durations`, () => {
      expect(typed(sub, datetime(2026, 11, 7, 12), datetime(2026, 11, 6))).toEqual(['duration', 'P1DT12H']);
      expect(typed(sub, time(12), time(13, 30))).toEqual(['duration', '-PT1H30M']);
      // date - date: the days as µs.
      expect(typed(sub, date(2026, 11, 7), date(2026, 1, 1))).toEqual(['duration', 'P310D']);
      expect(typed(sub, date(9999, 1, 1), date(-9999, 1, 1))[0]).toBe('duration');
      expect(over(sub, 'date', [days(2026, 1, 2), null], [date(2026, 1, 1)], 'duration')).toEqual(['P1D', null]);
      expect(typed(sub, datetime(2026, 1, 1), p.lit(1, 'duration'))).toEqual(['datetime', '2025-12-31 23:59:59.999999']);
    });
  }

  it('datetime ± duration is a datetime; durations scale by integers', () => {
    expect(typed('add', datetime(2026, 1, 1), p.lit(DAY, 'duration'))).toEqual(['datetime', '2026-01-02 00:00:00']);
    expect(typed('add_checked', p.lit(DAY, 'duration'), datetime(2026, 1, 1))).toEqual(['datetime', '2026-01-02 00:00:00']);
    expect(typed('mul', p.lit(60e6, 'duration'), int(90))).toEqual(['duration', 'PT1H30M']);
    expect(typed('div_trunc', p.lit(DAY, 'duration'), int(4))).toEqual(['duration', 'PT6H']);
    // Anything else is arithmetic on the integers.
    expect(typed('add', date(1970, 1, 1), int(1))).toEqual(['int', 1]);
  });

  it('date differences agree over columns, generated or not', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -3_000_000, max: 3_000_000 }), { minLength: 1, maxLength: 10 }), (xs) => {
        const got = over('sub', 'date', xs, [p.lit(0, 'date')], 'int');
        expect(got).toEqual(xs.map((x) => (Number.isSafeInteger(x * DAY) ? x * DAY : BigInt(x) * BigInt(DAY))));
      }),
      { numRuns: 100 },
    );
  });
});
