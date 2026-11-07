/**
 * Dates and times (ADR 0019): the integers their values are while a plan runs, and the text results give them as.
 * Shared by the engine (in-process results, parsing) and the client (results through the worker).
 *
 * | type | value | text |
 * |---|---|---|
 * | `date` | days since 1970-01-01 | `2026-11-07` |
 * | `datetime` | µs since 1970-01-01 00:00:00 | `2026-11-07 12:00:00`, with `.123` or `.123456` when it has a fraction |
 * | `time` | µs since midnight | `12:00:00` (and a fraction) |
 * | `duration` | µs | ISO 8601: `P1DT2H3M4.5S`, `-PT1S`, `PT0S` |
 *
 * The calendar is the proleptic Gregorian one. A year outside 0000–9999 has a sign and at least four digits
 * (`+10000-01-01`, `-0001-12-31`), as ISO 8601's expanded years. Values beyond 2^53 are bigints, exact.
 */
import type { SqlValue } from '../engine/values.js';

export type TemporalType = 'date' | 'datetime' | 'time' | 'duration';

const US_PER_DAY = 86_400_000_000;
const BIG_US_PER_DAY = 86_400_000_000n;

export const isTemporal = (t: string): t is TemporalType => t === 'date' || t === 'datetime' || t === 'time' || t === 'duration';

/** The civil date of `days` since 1970-01-01 (H. Hinnant's algorithm). */
export function civilFromDays(days: number): { y: number; m: number; d: number } {
  const z = days + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return { y: yoe + era * 400 + (m <= 2 ? 1 : 0), m, d };
}

/** Days since 1970-01-01 of a civil date. */
export function daysFromCivil(y: number, m: number, d: number): number {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

const daysInMonth = (y: number, m: number): number => (m === 2 ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28) : [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!);
const pad = (n: number, w: number): string => String(n).padStart(w, '0');
const year = (y: number): string => (y >= 0 && y <= 9999 ? pad(y, 4) : (y < 0 ? '-' : '+') + pad(Math.abs(y), 4));

/** `us` as whole days and the µs left in the day (0 ≤ rest < one day). */
function splitDays(us: number | bigint): { days: number; rest: number } {
  if (typeof us === 'bigint') {
    let days = us / BIG_US_PER_DAY;
    let rest = us % BIG_US_PER_DAY;
    if (rest < 0n) {
      days -= 1n;
      rest += BIG_US_PER_DAY;
    }
    return { days: Number(days), rest: Number(rest) };
  }
  let days = Math.floor(us / US_PER_DAY);
  let rest = us - days * US_PER_DAY;
  if (rest < 0) {
    days -= 1;
    rest += US_PER_DAY;
  } else if (rest >= US_PER_DAY) {
    days += 1;
    rest -= US_PER_DAY;
  }
  return { days, rest };
}

/** `HH:MM:SS`, then `.fff` or `.ffffff` when there is a fraction, for µs within a day. */
function clock(us: number): string {
  const s = Math.floor(us / 1_000_000);
  const f = us - s * 1_000_000;
  const text = `${pad(Math.floor(s / 3600), 2)}:${pad(Math.floor(s / 60) % 60, 2)}:${pad(s % 60, 2)}`;
  if (f === 0) return text;
  return f % 1000 === 0 ? `${text}.${pad(f / 1000, 3)}` : `${text}.${pad(f, 6)}`;
}

export function formatDate(days: number | bigint): string {
  const { y, m, d } = civilFromDays(Number(days));
  return `${year(y)}-${pad(m, 2)}-${pad(d, 2)}`;
}

export function formatDatetime(us: number | bigint): string {
  const { days, rest } = splitDays(us);
  return `${formatDate(days)} ${clock(rest)}`;
}

export function formatTime(us: number | bigint): string {
  return clock(Number(us));
}

export function formatDuration(us: number | bigint): string {
  let v = typeof us === 'bigint' ? us : BigInt(us);
  if (v === 0n) return 'PT0S';
  const sign = v < 0n ? '-' : '';
  if (v < 0n) v = -v;
  const days = v / BIG_US_PER_DAY;
  const rest = Number(v % BIG_US_PER_DAY);
  const h = Math.floor(rest / 3_600_000_000);
  const m = Math.floor(rest / 60_000_000) % 60;
  const us6 = rest % 60_000_000;
  const s = Math.floor(us6 / 1_000_000);
  const f = us6 % 1_000_000;
  let out = `${sign}P${days > 0n ? `${days}D` : ''}`;
  if (h || m || s || f) {
    out += 'T';
    if (h) out += `${h}H`;
    if (m) out += `${m}M`;
    if (s || f) out += f ? `${s}.${pad(f, 6).replace(/0+$/, '')}S` : `${s}S`;
  }
  return out;
}

/** A value of temporal type `t` as the text results give it; NULL stays NULL. */
export function temporalText(t: TemporalType, v: SqlValue): SqlValue {
  if (v === null || (typeof v !== 'number' && typeof v !== 'bigint')) return v;
  switch (t) {
    case 'date':
      return formatDate(v);
    case 'datetime':
      return formatDatetime(v);
    case 'time':
      return formatTime(v);
    default:
      return formatDuration(v);
  }
}

// ------------------------------------------------------------------ parsing

const DATE_RE = /^([+-]\d{4,6}|\d{4})-(\d{2})-(\d{2})/;
const CLOCK_RE = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;

function parseDays(text: string): { days: number; end: number } | null {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { days: daysFromCivil(y, mo, d), end: m[0].length };
}

function parseClock(text: string): number | null {
  const m = CLOCK_RE.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  const s = m[3] === undefined ? 0 : Number(m[3]);
  if (h > 23 || mi > 59 || s > 59) return null;
  // Fractions finer than µs are cut, as the unit is µs (ADR 0019, decision 1).
  const f = m[4] === undefined ? 0 : Number((m[4] + '000000').slice(0, 6));
  return ((h * 60 + mi) * 60 + s) * 1_000_000 + f;
}

const asInteger = (us: number): number | bigint => (Number.isSafeInteger(us) ? us : BigInt(us));

/** Days since the epoch of `YYYY-MM-DD`, or null. */
export function parseDate(text: string): number | null {
  const p = parseDays(text.trim());
  return p && p.end === text.trim().length ? p.days : null;
}

/** µs since the epoch of `YYYY-MM-DD[ T]HH:MM[:SS[.f]]` (or a date alone: midnight), or null. */
export function parseDatetime(text: string): number | bigint | null {
  const t = text.trim();
  const p = parseDays(t);
  if (!p) return null;
  if (p.end === t.length) return asInteger(p.days * US_PER_DAY);
  const sep = t[p.end];
  if (sep !== ' ' && sep !== 'T') return null;
  const c = parseClock(t.slice(p.end + 1));
  if (c === null) return null;
  const us = p.days * US_PER_DAY + c;
  return Number.isSafeInteger(us) ? us : BigInt(p.days) * BIG_US_PER_DAY + BigInt(c);
}

/** µs since midnight of `HH:MM[:SS[.f]]`, or null. */
export function parseTime(text: string): number | null {
  return parseClock(text.trim());
}

/** A JS Date as a `datetime` value: its ms as µs. */
export const datetimeFromDate = (d: Date): number => d.getTime() * 1000;

// ------------------------------------------------------------------ result forms

/**
 * How results give temporal values (ADR 0019 decision 3): `text` (the default), `date` (JS `Date` for `date` and
 * `datetime`, ms; `time` and `duration` stay text, as JS has no type for them) or `temporal` (`Temporal.PlainDate`,
 * `PlainDateTime`, `PlainTime`, `Duration`, where the runtime has `Temporal`).
 */
export type TemporalForm = 'text' | 'date' | 'temporal';

interface TemporalApi {
  PlainDate: { from(s: string): unknown };
  PlainDateTime: { from(s: string): unknown };
  PlainTime: { from(s: string): unknown };
  Duration: { from(s: string): unknown };
}

/** The text of a temporal value (as `temporalText` gives it) in `form`. */
export function temporalInForm(t: TemporalType, text: string, form: TemporalForm): unknown {
  if (form === 'text') return text;
  if (form === 'date') {
    if (t === 'date') return new Date(parseDate(text)! * 86_400_000);
    if (t === 'datetime') return new Date(Math.floor(Number(parseDatetime(text)!) / 1000));
    return text;
  }
  const api = (globalThis as { Temporal?: TemporalApi }).Temporal;
  if (!api) throw new Error('temporal: this runtime has no Temporal API; ask for text or date instead');
  switch (t) {
    case 'date':
      return api.PlainDate.from(text);
    case 'datetime':
      return api.PlainDateTime.from(text.replace(' ', 'T'));
    case 'time':
      return api.PlainTime.from(text);
    default:
      return api.Duration.from(text);
  }
}

/** `rows` (as results give them, temporal values as text) with their temporal columns in `form`. */
export function rowsInForm<R extends unknown[]>(rows: R[], types: readonly string[], form: TemporalForm | undefined): R[] {
  if (!form || form === 'text') return rows;
  const cols: [number, TemporalType][] = [];
  types.forEach((t, i) => {
    if (isTemporal(t)) cols.push([i, t]);
  });
  if (cols.length === 0) return rows;
  for (const r of rows) for (const [c, t] of cols) if (typeof r[c] === 'string') r[c] = temporalInForm(t, r[c] as string, form);
  return rows;
}
