/**
 * The date and time operations (ADR 0019, section 4): building from parts, parsing and formatting, parts, truncation,
 * calendar offsets, strict casts, and the result types of arithmetic on temporal values. Values are the integers of
 * `src/shared/temporal.ts`: days for `date`, µs for `datetime`, `time` and `duration`.
 */
import { SmaltError } from '../errors.js';
import type { SqlValue } from '../values.js';
import type { StaticType } from './convert.js';
import type { CompiledArg, ScalarFunction } from './functions.js';
import {
  type TemporalType,
  civilFromDays,
  daysFromCivil,
  daysInMonth,
  isTemporal,
  parseDate,
  parseDatetime,
  splitDays,
} from '../../shared/temporal.js';
import { zoneOffsetMs } from './zones.js';

const US_PER_DAY = 86_400_000_000;
const BIG_US_PER_DAY = 86_400_000_000n;
const US_PER_HOUR = 3_600_000_000;
const US_PER_MINUTE = 60_000_000;
const US_PER_SECOND = 1_000_000;

const mismatch = (message: string): SmaltError => new SmaltError('SMALT_MISMATCH', message);
const outOfRange = (message: string): SmaltError => new SmaltError('SMALT_RANGE', message);

/** µs of `days` and `rest` µs: a number when exact, else a bigint. */
function exactUs(days: number, rest: number): number | bigint {
  const us = days * US_PER_DAY + rest;
  return Number.isSafeInteger(us) ? us : BigInt(days) * BIG_US_PER_DAY + BigInt(rest);
}

/** `a + b` µs, exact. */
function addUs(a: number | bigint, b: number | bigint): number | bigint {
  if (typeof a === 'number' && typeof b === 'number') {
    const s = a + b;
    if (Number.isSafeInteger(s)) return s;
  }
  const s = BigInt(a) + BigInt(b);
  return s >= BigInt(Number.MIN_SAFE_INTEGER) && s <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(s) : s;
}

/** An integer argument, as a number. */
function intArg(v: SqlValue, fn: string, what: string): number {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'bigint') {
    if (v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(v);
    throw outOfRange(`${fn}: ${what} ${v} is out of range`);
  }
  throw mismatch(`${fn}: ${what} must be an integer`);
}

/** A value of a temporal column: an integer. */
function temporalValue(v: SqlValue, fn: string): number | bigint {
  if (typeof v === 'number' || typeof v === 'bigint') return v;
  throw mismatch(`${fn} takes a date or time value, not ${typeof v === 'string' ? 'text' : 'a blob'}`);
}

/** Days and µs within the day of `v`, a value of temporal type `t`. */
function dayParts(t: TemporalType, v: number | bigint): { days: number; rest: number } {
  if (t === 'date') return { days: Number(v), rest: 0 };
  if (t === 'time') return { days: 0, rest: Number(v) };
  return splitDays(v);
}

/** A value of type `t` from days and µs within the day. */
function fromDayParts(t: TemporalType, days: number, rest: number): number | bigint {
  if (t === 'date') return days;
  if (t === 'time') return rest;
  return exactUs(days, rest);
}

const listTypes = (ts: readonly string[]): string => (ts.length === 1 ? ts[0]! : `${ts.slice(0, -1).join(', ')} or ${ts[ts.length - 1]}`);

/** The temporal type of `name`'s argument, which must be one of `accepts`. */
function argKind(name: string, t: StaticType, accepts: readonly TemporalType[]): TemporalType {
  if (isTemporal(t) && accepts.includes(t)) return t;
  throw mismatch(`${name} takes ${listTypes(accepts)}, not ${t}`);
}

/**
 * A scalar function over arguments evaluated eagerly. `make` sees the compiled arguments (their types) and returns
 * the implementation, which receives the argument values.
 */
function op(
  name: string,
  min: number,
  max: number,
  result: (args: readonly Pick<CompiledArg, 'type'>[]) => StaticType,
  make: (args: CompiledArg[]) => (vals: SqlValue[]) => SqlValue,
): [string, ScalarFunction] {
  return [
    name,
    {
      minArgs: min,
      maxArgs: max,
      deterministic: true,
      resultType: (args) => result(args),
      compile(args) {
        const impl = make(args);
        const fns = args.map((a) => a.fn);
        const n = fns.length;
        const buf: SqlValue[] = new Array(n).fill(null);
        return {
          type: result(args),
          fn: (r) => {
            for (let i = 0; i < n; i++) buf[i] = fns[i]!(r);
            return impl(buf);
          },
        };
      },
    },
  ];
}

const sameType = (args: readonly Pick<CompiledArg, 'type'>[]): StaticType => args[0]!.type;

// ------------------------------------------------------------------ parts

const ON_DATES: readonly TemporalType[] = ['date', 'datetime'];
const ON_CLOCKS: readonly TemporalType[] = ['datetime', 'time'];

/** ISO weekday of a day count: Monday is 1, Sunday 7 (1970-01-01 was a Thursday). */
const isoWeekday = (days: number): number => ((((days + 3) % 7) + 7) % 7) + 1;

function part(name: string, accepts: readonly TemporalType[], f: (days: number, rest: number) => number): [string, ScalarFunction] {
  return op(name, 1, 1, () => 'int', ([a]) => {
    if (a!.type === 'null') return () => null;
    const t = argKind(name, a!.type, accepts);
    return ([v]) => {
      if (v === null) return null;
      const { days, rest } = dayParts(t, temporalValue(v, name));
      return f(days, rest);
    };
  });
}

const PARTS: [string, ScalarFunction][] = [
  part('year', ON_DATES, (d) => civilFromDays(d).y),
  part('month', ON_DATES, (d) => civilFromDays(d).m),
  part('day', ON_DATES, (d) => civilFromDays(d).d),
  part('weekday', ON_DATES, (d) => isoWeekday(d)),
  part('day_of_year', ON_DATES, (d) => d - daysFromCivil(civilFromDays(d).y, 1, 1) + 1),
  part('hour', ON_CLOCKS, (_d, us) => Math.floor(us / US_PER_HOUR)),
  part('minute', ON_CLOCKS, (_d, us) => Math.floor(us / US_PER_MINUTE) % 60),
  part('second', ON_CLOCKS, (_d, us) => Math.floor(us / US_PER_SECOND) % 60),
  part('microsecond', ON_CLOCKS, (_d, us) => us % US_PER_SECOND),
];

// ------------------------------------------------------------------ building from parts

function civilDays(fn: string, y: number, m: number, d: number): number {
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) throw outOfRange(`${fn}: ${y}-${m}-${d} is not a date`);
  return daysFromCivil(y, m, d);
}

function clockUs(fn: string, h: number, mi: number, s: number, us: number): number {
  if (h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 59 || us < 0 || us > 999_999) {
    throw outOfRange(`${fn}: ${h}:${mi}:${s}.${us} is not a time of day`);
  }
  return ((h * 60 + mi) * 60 + s) * US_PER_SECOND + us;
}

const CLOCK_NAMES = ['hour', 'minute', 'second', 'microsecond'];

const BUILD: [string, ScalarFunction][] = [
  op('make_date', 3, 3, () => 'date', () => (v) => {
    if (v[0] === null || v[1] === null || v[2] === null) return null;
    return civilDays('make_date', intArg(v[0], 'make_date', 'year'), intArg(v[1], 'make_date', 'month'), intArg(v[2], 'make_date', 'day'));
  }),
  op('make_datetime', 3, 7, () => 'datetime', () => (v) => {
    if (v.some((x) => x === null)) return null;
    const days = civilDays('make_datetime', intArg(v[0]!, 'make_datetime', 'year'), intArg(v[1]!, 'make_datetime', 'month'), intArg(v[2]!, 'make_datetime', 'day'));
    const c = [0, 0, 0, 0];
    for (let i = 3; i < v.length; i++) c[i - 3] = intArg(v[i]!, 'make_datetime', CLOCK_NAMES[i - 3]!);
    return exactUs(days, clockUs('make_datetime', c[0]!, c[1]!, c[2]!, c[3]!));
  }),
];

// ------------------------------------------------------------------ formatting

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const pad = (n: number, w: number): string => String(n).padStart(w, '0');
const yearText = (y: number): string => (y >= 0 && y <= 9999 ? pad(y, 4) : (y < 0 ? '-' : '+') + pad(Math.abs(y), 4));

type Piece = (days: number, rest: number) => string;

/** Directives that read the date, and those that read the time of day. */
const DATE_DIRECTIVES: Readonly<Record<string, Piece>> = {
  Y: (d) => yearText(civilFromDays(d).y),
  y: (d) => pad(((civilFromDays(d).y % 100) + 100) % 100, 2),
  m: (d) => pad(civilFromDays(d).m, 2),
  d: (d) => pad(civilFromDays(d).d, 2),
  e: (d) => String(civilFromDays(d).d).padStart(2, ' '),
  j: (d) => pad(d - daysFromCivil(civilFromDays(d).y, 1, 1) + 1, 3),
  a: (d) => WEEKDAYS[isoWeekday(d) - 1]!.slice(0, 3),
  A: (d) => WEEKDAYS[isoWeekday(d) - 1]!,
  b: (d) => MONTHS[civilFromDays(d).m - 1]!.slice(0, 3),
  B: (d) => MONTHS[civilFromDays(d).m - 1]!,
  u: (d) => String(isoWeekday(d)),
  w: (d) => String(isoWeekday(d) % 7),
  F: (d) => `${DATE_DIRECTIVES.Y!(d, 0)}-${DATE_DIRECTIVES.m!(d, 0)}-${DATE_DIRECTIVES.d!(d, 0)}`,
};
const CLOCK_DIRECTIVES: Readonly<Record<string, Piece>> = {
  H: (_d, us) => pad(Math.floor(us / US_PER_HOUR), 2),
  I: (_d, us) => pad(((Math.floor(us / US_PER_HOUR) + 11) % 12) + 1, 2),
  M: (_d, us) => pad(Math.floor(us / US_PER_MINUTE) % 60, 2),
  S: (_d, us) => pad(Math.floor(us / US_PER_SECOND) % 60, 2),
  f: (_d, us) => pad(us % US_PER_SECOND, 6),
  p: (_d, us) => (us < 12 * US_PER_HOUR ? 'AM' : 'PM'),
  T: (d, us) => `${CLOCK_DIRECTIVES.H!(d, us)}:${CLOCK_DIRECTIVES.M!(d, us)}:${CLOCK_DIRECTIVES.S!(d, us)}`,
};

const FORMATTERS = new Map<string, Piece>();

/** `fmt` compiled for values of type `t`. */
function formatter(fmt: string, t: TemporalType): Piece {
  const key = `${t}\u0000${fmt}`;
  const cached = FORMATTERS.get(key);
  if (cached) return cached;
  const pieces: (string | Piece)[] = [];
  let lit = '';
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i]!;
    if (c !== '%') {
      lit += c;
      continue;
    }
    const d = fmt[++i];
    if (d === '%') {
      lit += '%';
      continue;
    }
    const onDate = d === undefined ? undefined : DATE_DIRECTIVES[d];
    const onClock = d === undefined ? undefined : CLOCK_DIRECTIVES[d];
    if (!onDate && !onClock) throw mismatch(`format_temporal: unknown directive %${d ?? ''} in '${fmt}'`);
    if (onDate && t === 'time') throw mismatch(`format_temporal: %${d} needs a date, and a time has none`);
    if (onClock && t === 'date') throw mismatch(`format_temporal: %${d} needs a time of day, and a date has none`);
    if (lit) pieces.push(lit);
    lit = '';
    pieces.push((onDate ?? onClock)!);
  }
  if (lit) pieces.push(lit);
  const f: Piece = (days, rest) => {
    let out = '';
    for (const p of pieces) out += typeof p === 'string' ? p : p(days, rest);
    return out;
  };
  if (FORMATTERS.size > 256) FORMATTERS.clear();
  FORMATTERS.set(key, f);
  return f;
}

// ------------------------------------------------------------------ parsing

interface Fields {
  y?: number;
  m?: number;
  d?: number;
  j?: number;
  H?: number;
  I?: number;
  M?: number;
  S?: number;
  f?: number;
  pm?: boolean;
}

interface Parser {
  re: RegExp;
  sets: ((f: Fields, s: string) => boolean)[];
  hasYear: boolean;
}

const monthByName = (s: string, len?: number): number | undefined => {
  const l = s.toLowerCase();
  const i = MONTHS.findIndex((m) => (len ? m.slice(0, len) : m).toLowerCase() === l);
  return i < 0 ? undefined : i + 1;
};

/** Each directive: the pattern it matches, and how its text sets the fields (false: not a valid value). */
const PARSE_DIRECTIVES: Readonly<Record<string, [string, ((f: Fields, s: string) => boolean) | null]>> = {
  Y: ['([+-]?\\d{1,6})', (f, s) => ((f.y = Number(s)), true)],
  y: ['(\\d{2})', (f, s) => ((f.y = Number(s) < 69 ? 2000 + Number(s) : 1900 + Number(s)), true)],
  m: ['(\\d{1,2})', (f, s) => ((f.m = Number(s)), true)],
  d: ['(\\d{1,2})', (f, s) => ((f.d = Number(s)), true)],
  e: [' ?(\\d{1,2})', (f, s) => ((f.d = Number(s)), true)],
  j: ['(\\d{1,3})', (f, s) => ((f.j = Number(s)), true)],
  H: ['(\\d{1,2})', (f, s) => ((f.H = Number(s)), true)],
  I: ['(\\d{1,2})', (f, s) => ((f.I = Number(s)), true)],
  M: ['(\\d{1,2})', (f, s) => ((f.M = Number(s)), true)],
  S: ['(\\d{1,2})', (f, s) => ((f.S = Number(s)), true)],
  f: ['(\\d{1,9})', (f, s) => ((f.f = Number((s + '00000').slice(0, 6))), true)],
  p: ['([AaPp][Mm])', (f, s) => ((f.pm = s[0] === 'P' || s[0] === 'p'), true)],
  b: ['([A-Za-z]{3})', (f, s) => (f.m = monthByName(s, 3)) !== undefined],
  B: ['([A-Za-z]+)', (f, s) => (f.m = monthByName(s)) !== undefined],
  a: ['(?:[A-Za-z]{3})', null],
  A: ['(?:[A-Za-z]+)', null],
};

const PARSERS = new Map<string, Parser>();

function parser(fn: string, fmt: string): Parser {
  const cached = PARSERS.get(fmt);
  if (cached) return cached;
  const expanded = fmt.replace(/%F/g, '%Y-%m-%d').replace(/%T/g, '%H:%M:%S');
  let src = '^';
  const sets: Parser['sets'] = [];
  let hasYear = false;
  for (let i = 0; i < expanded.length; i++) {
    const c = expanded[i]!;
    if (c !== '%') {
      src += /\s/.test(c) ? '\\s+' : c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
      continue;
    }
    const d = expanded[++i];
    if (d === '%') {
      src += '%';
      continue;
    }
    const spec = d === undefined ? undefined : PARSE_DIRECTIVES[d];
    if (!spec) throw mismatch(`${fn}: unknown directive %${d ?? ''} in '${fmt}'`);
    if (d === 'Y' || d === 'y') hasYear = true;
    src += spec[0];
    if (spec[1]) sets.push(spec[1]);
  }
  const p: Parser = { re: new RegExp(src + '$'), sets, hasYear };
  if (!hasYear) throw mismatch(`${fn}: the format '${fmt}' has no year (%Y or %y)`);
  if (PARSERS.size > 256) PARSERS.clear();
  PARSERS.set(fmt, p);
  return p;
}

/** Days and µs within the day of `text` read with `fmt`, or null if it doesn't match or isn't a valid date and time. */
function parseWith(fn: string, text: string, fmt: string): { days: number; rest: number } | null {
  const p = parser(fn, fmt);
  const m = p.re.exec(text.trim());
  if (!m) return null;
  const f: Fields = {};
  for (let i = 0; i < p.sets.length; i++) if (!p.sets[i]!(f, m[i + 1]!)) return null;
  const y = f.y!;
  let days: number;
  if (f.j !== undefined) {
    const len = daysInMonth(y, 2) === 29 ? 366 : 365;
    if (f.j < 1 || f.j > len) return null;
    days = daysFromCivil(y, 1, 1) + f.j - 1;
  } else {
    const mo = f.m ?? 1;
    const d = f.d ?? 1;
    if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
    days = daysFromCivil(y, mo, d);
  }
  let h = f.H ?? 0;
  if (f.I !== undefined) {
    if (f.I < 1 || f.I > 12) return null;
    h = f.pm === undefined ? f.I : (f.I % 12) + (f.pm ? 12 : 0);
  } else if (f.pm !== undefined && f.H !== undefined) {
    if (f.H < 1 || f.H > 12) return null;
    h = (f.H % 12) + (f.pm ? 12 : 0);
  }
  const mi = f.M ?? 0;
  const s = f.S ?? 0;
  if (h > 23 || mi > 59 || s > 59) return null;
  return { days, rest: ((h * 60 + mi) * 60 + s) * US_PER_SECOND + (f.f ?? 0) };
}

const asText = (v: SqlValue): string | null => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'bigint' ? String(v) : null);

const PARSE: [string, ScalarFunction][] = [
  op('parse_date', 1, 2, () => 'date', () => (v) => {
    if (v[0] === null || (v.length > 1 && v[1] === null)) return null;
    const text = asText(v[0]!);
    if (text === null) return null;
    if (v.length === 1) return parseDate(text);
    return parseWith('parse_date', text, String(v[1]))?.days ?? null;
  }),
  op('parse_datetime', 1, 2, () => 'datetime', () => (v) => {
    if (v[0] === null || (v.length > 1 && v[1] === null)) return null;
    const text = asText(v[0]!);
    if (text === null) return null;
    if (v.length === 1) return parseDatetime(text);
    const p = parseWith('parse_datetime', text, String(v[1]));
    return p === null ? null : exactUs(p.days, p.rest);
  }),
  op('format_temporal', 2, 2, () => 'text', ([a]) => {
    if (a!.type === 'null') return () => null;
    const t = argKind('format_temporal', a!.type, ['date', 'datetime', 'time']);
    return ([v, fmt]) => {
      if (v === null || fmt === null) return null;
      const { days, rest } = dayParts(t, temporalValue(v, 'format_temporal'));
      return formatter(String(fmt), t)(days, rest);
    };
  }),
];

// ------------------------------------------------------------------ truncation and offsets

const CLOCK_UNITS: Readonly<Record<string, number>> = {
  hour: US_PER_HOUR,
  minute: US_PER_MINUTE,
  second: US_PER_SECOND,
  millisecond: 1000,
  microsecond: 1,
};
const DATE_UNITS = ['year', 'quarter', 'month', 'week', 'day'];

function truncDays(days: number, unit: string): number {
  if (unit === 'day') return days;
  if (unit === 'week') return days - isoWeekday(days) + 1;
  const { y, m } = civilFromDays(days);
  if (unit === 'year') return daysFromCivil(y, 1, 1);
  if (unit === 'quarter') return daysFromCivil(y, m - ((m - 1) % 3), 1);
  return daysFromCivil(y, m, 1);
}

/** Calendar months, days and µs to move by. */
interface Offset {
  months: number;
  days: number;
  us: number;
}

const OFFSET_UNITS: Readonly<Record<string, (o: Offset, n: number) => void>> = {
  y: (o, n) => (o.months += 12 * n),
  q: (o, n) => (o.months += 3 * n),
  mo: (o, n) => (o.months += n),
  w: (o, n) => (o.days += 7 * n),
  d: (o, n) => (o.days += n),
  h: (o, n) => (o.us += n * US_PER_HOUR),
  m: (o, n) => (o.us += n * US_PER_MINUTE),
  s: (o, n) => (o.us += n * US_PER_SECOND),
  ms: (o, n) => (o.us += n * 1000),
  us: (o, n) => (o.us += n),
};

const OFFSETS = new Map<string, Offset>();

/** An offset written as text: `1mo`, `-2d`, `1y2mo`, `3h30m` (y, q, mo, w, d, h, m, s, ms, us). */
function offsetOf(text: string): Offset {
  const cached = OFFSETS.get(text);
  if (cached) return cached;
  const t = text.trim();
  const neg = t.startsWith('-');
  const body = neg || t.startsWith('+') ? t.slice(1) : t;
  const o: Offset = { months: 0, days: 0, us: 0 };
  const re = /(\d+)(mo|ms|us|y|q|w|d|h|m|s)/y;
  let at = 0;
  while (at < body.length) {
    re.lastIndex = at;
    const m = re.exec(body);
    if (!m) throw mismatch(`offset_by: '${text}' is not an offset (such as '1mo', '-2d' or '3h30m')`);
    OFFSET_UNITS[m[2]!]!(o, Number(m[1]));
    at = re.lastIndex;
  }
  if (body.length === 0) throw mismatch(`offset_by: '${text}' is not an offset (such as '1mo', '-2d' or '3h30m')`);
  if (neg) {
    o.months = -o.months;
    o.days = -o.days;
    o.us = -o.us;
  }
  if (OFFSETS.size > 256) OFFSETS.clear();
  OFFSETS.set(text, o);
  return o;
}

/** `days` moved by `months`, keeping the day of the month, or the last day of a shorter month. */
function addMonths(days: number, months: number): number {
  if (months === 0) return days;
  const { y, m, d } = civilFromDays(days);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = total - ny * 12 + 1;
  return daysFromCivil(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

const MOVE: [string, ScalarFunction][] = [
  op('trunc_temporal', 2, 2, sameType, ([a]) => {
    if (a!.type === 'null') return () => null;
    const t = argKind('trunc_temporal', a!.type, ['date', 'datetime', 'time']);
    return ([v, u]) => {
      if (v === null || u === null) return null;
      const unit = String(u);
      const clock = CLOCK_UNITS[unit];
      const onDate = DATE_UNITS.includes(unit);
      if (clock === undefined && !onDate) throw mismatch(`trunc_temporal: unknown unit '${unit}' (year, quarter, month, week, day, hour, minute, second, millisecond or microsecond)`);
      if (t === 'date' && !onDate) throw mismatch(`trunc_temporal: a date has no ${unit}s`);
      if (t === 'time' && onDate) throw mismatch(`trunc_temporal: a time has no ${unit}s`);
      const { days, rest } = dayParts(t, temporalValue(v, 'trunc_temporal'));
      return onDate ? fromDayParts(t, truncDays(days, unit), 0) : fromDayParts(t, days, rest - (rest % clock!));
    };
  }),
  op('offset_by', 2, 2, sameType, ([a, b]) => {
    if (a!.type === 'null') return () => null;
    const t = argKind('offset_by', a!.type, ['date', 'datetime']);
    const byDuration = b!.type === 'duration';
    return ([v, by]) => {
      if (v === null || by === null) return null;
      const x = temporalValue(v, 'offset_by');
      let o: Offset;
      let extra: number | bigint = 0;
      if (byDuration) {
        if (typeof by !== 'number' && typeof by !== 'bigint') throw mismatch('offset_by: a duration must be an integer');
        o = { months: 0, days: 0, us: 0 };
        extra = by;
      } else {
        if (typeof by !== 'string') throw mismatch("offset_by moves by a duration or by text such as '1mo'");
        o = offsetOf(by);
        extra = o.us;
      }
      if (t === 'date') {
        const e = BigInt(extra);
        if (e % BIG_US_PER_DAY !== 0n) throw mismatch('offset_by: a date moves by whole days');
        return addMonths(Number(x), o.months) + o.days + Number(e / BIG_US_PER_DAY);
      }
      const { days, rest } = splitDays(x);
      return addUs(exactUs(addMonths(days, o.months) + o.days, rest), extra);
    };
  }),
];

// ------------------------------------------------------------------ strict casts

const quoted = (s: string): string => `'${s.length > 40 ? `${s.slice(0, 40)}…` : s}'`;

function integerOf(v: number | bigint, fn: string): number | bigint {
  if (typeof v === 'bigint') return v;
  if (Number.isInteger(v)) return v;
  throw mismatch(`${fn}: ${v} is not a whole number`);
}

function daysOf(v: SqlValue): number {
  if (typeof v === 'string') {
    const d = parseDate(v);
    if (d === null) throw mismatch(`cast_date: ${quoted(v)} is not a date`);
    return d;
  }
  if (typeof v === 'number' || typeof v === 'bigint') {
    const n = integerOf(v, 'cast_date');
    if (typeof n === 'bigint') throw outOfRange(`cast_date: ${n} days is out of range`);
    return n;
  }
  throw mismatch('cast_date takes text or a number, not a blob');
}

function usOf(v: SqlValue): number | bigint {
  if (typeof v === 'string') {
    const us = parseDatetime(v);
    if (us === null) throw mismatch(`cast_datetime: ${quoted(v)} is not a date and time`);
    return us;
  }
  if (typeof v === 'number' || typeof v === 'bigint') return integerOf(v, 'cast_datetime');
  throw mismatch('cast_datetime takes text or a number, not a blob');
}

const CASTS: [string, ScalarFunction][] = [
  op('cast_date', 1, 1, () => 'date', ([a]) => {
    const t = a!.type;
    if (t === 'time' || t === 'duration') throw mismatch(`cast_date takes a date, datetime, text or a number, not ${t}`);
    if (t === 'date') return ([v]) => v;
    if (t === 'datetime') return ([v]) => (v === null ? null : splitDays(temporalValue(v, 'cast_date')).days);
    return ([v]) => (v === null ? null : daysOf(v));
  }),
  op('cast_datetime', 1, 1, () => 'datetime', ([a]) => {
    const t = a!.type;
    if (t === 'time' || t === 'duration') throw mismatch(`cast_datetime takes a date, datetime, text or a number, not ${t}`);
    if (t === 'datetime') return ([v]) => v;
    if (t === 'date') return ([v]) => (v === null ? null : exactUs(Number(temporalValue(v, 'cast_datetime')), 0));
    return ([v]) => (v === null ? null : usOf(v));
  }),
];

// ------------------------------------------------------------------ time zones

/** ms (floored) of µs since the epoch. */
const msOf = (v: number | bigint): number => (typeof v === 'number' ? Math.floor(v / 1000) : Number(v / 1000n - (v % 1000n < 0n ? 1n : 0n)));

/** The offset of `zone` at the UTC instant `us`, in µs. */
const offsetUs = (zone: string, us: number | bigint): number => zoneOffsetMs(zone, msOf(us)) * 1000;

const zoneName = (v: SqlValue, fn: string): string => {
  if (typeof v === 'string') return v;
  throw mismatch(`${fn}: a time zone is text, such as 'Europe/Paris' or '+05:30'`);
};

/**
 * The UTC instant of wall-clock time `local` in `zone`. A wall-clock time that occurs twice (clocks going back) is
 * the earlier instant, or the later; one that doesn't occur (clocks going forward) moves forward by the gap
 * (`compatible`, `later`) or back (`earlier`); `reject` makes either an error.
 */
function fromZone(local: number | bigint, zone: string, how: string): number | bigint {
  const before = offsetUs(zone, addUs(local, -US_PER_DAY));
  const after = offsetUs(zone, addUs(local, US_PER_DAY));
  const fits: (number | bigint)[] = [];
  for (const o of before === after ? [before] : [before, after]) {
    const t = addUs(local, -o);
    if (offsetUs(zone, t) === o) fits.push(t);
  }
  if (fits.length === 1) return fits[0]!;
  if (how === 'reject') throw outOfRange(`from_zone: the time ${fits.length ? 'occurs twice' : 'does not occur'} in ${zone}`);
  if (fits.length === 2) {
    const [a, b] = fits[0]! < fits[1]! ? [fits[0]!, fits[1]!] : [fits[1]!, fits[0]!];
    return how === 'later' ? b : a;
  }
  // In a gap: the offset before it moves the time forward by the gap, the one after moves it back.
  return addUs(local, -(how === 'earlier' ? after : before));
}

const HOW = ['compatible', 'earlier', 'later', 'reject'];

const ZONE_OPS: [string, ScalarFunction][] = [
  op('to_zone', 2, 2, () => 'datetime', ([a]) => {
    if (a!.type === 'null') return () => null;
    argKind('to_zone', a!.type, ['datetime']);
    return ([v, z]) => {
      if (v === null || z === null) return null;
      const x = temporalValue(v, 'to_zone');
      return addUs(x, offsetUs(zoneName(z, 'to_zone'), x));
    };
  }),
  op('from_zone', 2, 3, () => 'datetime', ([a]) => {
    if (a!.type === 'null') return () => null;
    argKind('from_zone', a!.type, ['datetime']);
    return ([v, z, h]) => {
      if (v === null || z === null) return null;
      const how = h === undefined || h === null ? 'compatible' : String(h);
      if (!HOW.includes(how)) throw mismatch(`from_zone: '${how}' is not compatible, earlier, later or reject`);
      return fromZone(temporalValue(v, 'from_zone'), zoneName(z, 'from_zone'), how);
    };
  }),
  op('zone_offset', 2, 2, () => 'duration', ([a]) => {
    if (a!.type === 'null') return () => null;
    argKind('zone_offset', a!.type, ['datetime']);
    return ([v, z]) => (v === null || z === null ? null : offsetUs(zoneName(z, 'zone_offset'), temporalValue(v, 'zone_offset')));
  }),
];

/** The date and time operations, for the scalar function registry. */
export const TEMPORAL_FUNCTIONS: readonly [string, ScalarFunction][] = [...PARTS, ...BUILD, ...PARSE, ...MOVE, ...CASTS, ...ZONE_OPS];

// ------------------------------------------------------------------ arithmetic

/**
 * The result type of arithmetic operator `op` (`+`, `-`, `*`, `/`, `%`) on temporal operands, or undefined when the
 * operands make it ordinary arithmetic on integers:
 *
 * - `datetime - datetime`, `time - time` and `date - date` give a `duration` (for dates, the days as µs);
 * - `datetime ± duration` (and `duration + datetime`) gives a `datetime`;
 * - `duration ± duration`, `duration * int`, `int * duration` and `duration / int` give a `duration`.
 */
export function temporalArithType(op: string, a: StaticType, b: StaticType): StaticType | undefined {
  if (!isTemporal(a) && !isTemporal(b)) return undefined;
  switch (op) {
    case '-':
      if (a === b && (a === 'datetime' || a === 'time' || a === 'date' || a === 'duration')) return 'duration';
      if (a === 'datetime' && b === 'duration') return 'datetime';
      return undefined;
    case '+':
      if ((a === 'datetime' && b === 'duration') || (a === 'duration' && b === 'datetime')) return 'datetime';
      if (a === 'duration' && b === 'duration') return 'duration';
      return undefined;
    case '*':
      if ((a === 'duration' && b === 'int') || (a === 'int' && b === 'duration')) return 'duration';
      return undefined;
    case '/':
      return a === 'duration' && b === 'int' ? 'duration' : undefined;
    default:
      return undefined;
  }
}

/** `date - date`: the difference in days is given as µs. */
export const isDateDifference = (op: string, a: StaticType, b: StaticType): boolean => op === '-' && a === 'date' && b === 'date';

/** Days as µs, exact. */
export function daysAsUs(v: SqlValue): SqlValue {
  if (typeof v === 'number') return exactUs(v, 0);
  if (typeof v === 'bigint') return v * BIG_US_PER_DAY;
  return v;
}

/** The type arithmetic sees for an operand: a temporal value is an integer. */
export const arithOperandType = (t: StaticType): StaticType => (isTemporal(t) ? 'int' : t);
