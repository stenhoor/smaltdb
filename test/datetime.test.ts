/**
 * Date and time functions vs SQLite (official WASM build): a table of hand-picked cases covering
 * every time-value format, modifier and strftime code, plus a seeded random generator.
 *
 * 'localtime'/'utc' cases are included: both engines use the host time zone (the WASM build's
 * localtime_r() goes through JS Date), so they agree in any zone. 'now' is checked separately.
 *
 *   DIFF_DATETIME=200000 DIFF_SEED=7 npx vitest run test/datetime.test.ts
 */
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import { rng } from './helpers.js';

type Sqlite = { exec(sql: string): void; selectArrays(sql: string): unknown[][] };
let sqlite3: { oo1: { DB: new (name: string) => Sqlite } };

beforeAll(async () => {
  sqlite3 = (await (sqliteInit as unknown as (o: object) => Promise<unknown>)({ print: () => {}, printErr: () => {} })) as never;
});

/** Exact canonical form (REALs compared bit-for-bit via their shortest round-trip text). */
function canon(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return 'i' + v.toString();
  if (typeof v === 'number') return (Number.isInteger(v) ? 'i' : 'r') + String(v);
  if (typeof v === 'string') return 's' + JSON.stringify(v);
  if (v instanceof Uint8Array) return 'x' + Buffer.from(v).toString('hex');
  return '?' + String(v);
}

interface Engines {
  lite: Sqlite;
  smalt: Database;
}

function engines(): Engines {
  const lite = new sqlite3.oo1.DB(':memory:');
  const smalt = Database.openFile(new MemoryVfs().openSync('dt.db'));
  const ddl = 'CREATE TABLE v(i INTEGER, r REAL, t TEXT, b BLOB)';
  lite.exec(ddl);
  smalt.exec(ddl);
  const row = "INSERT INTO v VALUES (1700000000, 2460000.25, '2024-02-29 13:45:30.250', CAST('2023-12-31' AS BLOB))";
  lite.exec(row);
  smalt.exec(row);
  return { lite, smalt };
}

/** Compare one expression; returns a failure description or null. */
function compare(e: Engines, expr: string, from = ''): string | null {
  const sql = `SELECT ${expr}${from}`;
  let a: string;
  let b: string;
  try {
    a = e.lite.selectArrays(sql).map((r) => r.map(canon).join('|')).join('\n');
  } catch (err) {
    a = 'ERROR';
  }
  try {
    b = e.smalt
      .query(sql)
      .rows.map((r) => r.map(canon).join('|'))
      .join('\n');
  } catch (err) {
    b = 'ERROR ' + (err as Error).message;
  }
  if (a === 'ERROR' && b.startsWith('ERROR')) return null;
  return a === b ? null : `${sql}\n  sqlite: ${a}\n  smalt:  ${b}`;
}

const FUNCS = ['date', 'time', 'datetime', 'julianday', 'unixepoch'];
const ALL_CODES = 'dDefFgGHIjJklmMpPRsSTuUVwWY%'.split('');

/** Hand-picked time values. */
const VALUES = [
  // date formats
  "'2024-03-05'", "'2024-03-05 13:04'", "'2024-03-05 13:04:05'", "'2024-03-05 13:04:05.678'", "'2024-03-05T13:04:05.678'",
  "'2024-03-05T13:04'", "'2024-03-05  13:04'", "'2024-03-05TT13:04'", "'2024-03-05 T 13:04'", "'2024-03-05t13:04'",
  "'2024-03-05 13:04:05.123456789'", "'2024-03-05 13:04:05.9999'", "'2024-03-05 13:04:05.'", "'2024-03-05 13:04:'",
  "'2024-03-05 13:04:05.5x'", "'2024-03-05 '", "'2024-03-05T'", "' 2024-03-05'", "'2024-3-05'", "'+2024-03-05'",
  // time zones
  "'2024-03-05 13:04Z'", "'2024-03-05 13:04z'", "'2024-03-05 13:04 Z '", "'2024-03-05 13:04+05:30'", "'2024-03-05 13:04 -08:00'",
  "'2024-03-05 13:04:05.5+14:59'", "'2024-03-05 13:04+15:00'", "'2024-03-05 13:04+0530'", "'2024-03-05 13:04+05:60'",
  "'2024-01-01 00:30+01:00'", "'0000-01-01 00:30+01:00'", "'9999-12-31 23:30-01:00'",
  // time only
  "'13:04'", "'13:04:05'", "'13:04:05.678'", "'13:04Z'", "'13:04:05-02:00'", "'1:04'", "'13:4'", "'25:00'", "'23:60'", "'23:59:60'",
  // 24:00
  "'24:00'", "'24:00:00'", "'24:00:00.000'", "'24:00:00.001'", "'24:00:01'", "'24:30'", "'24:00Z'", "'24:00+01:00'",
  "'2024-01-01 24:00'", "'2024-01-01 24:00+01:00'", "'2024-01-01 24:00-01:00'", "'9999-12-31 24:00-01:00'", "'9999-12-31 24:00+01:00'", "'2024-02-28 24:00'", "'2023-02-29 24:00'", "'2024-12-31 24:00'", "'9999-12-31 24:00'",
  // day-of-month overflow and range
  "'2024-02-29'", "'2023-02-29'", "'2023-02-31'", "'2024-04-31'", "'2024-01-31'", "'2024-02-30 10:00'", "'2100-02-29'", "'2000-02-29'",
  "'2024-13-01'", "'2024-00-01'", "'2024-01-00'", "'2024-01-32'", "'0000-00-01'",
  // negative / extreme years
  "'-4713-11-24 12:00'", "'-4713-11-24 11:59:59'", "'-4713-11-25'", "'-0001-03-01'", "'-1000-02-29'", "'0000-01-01'", "'0000-02-29'",
  "'9999-12-31 23:59:59.999'", "'-2024-01-01'", "'1582-10-10'", "'1969-12-31 23:59:59.5'", "'1970-01-01'",
  // numbers
  '2460000.5', '2460000', '0', '-0.0', '0.00001', '5373484.4999', '5373484.5', '-1', '1700000000', '1700000000.5', '-1700000000',
  '253402300799', '253402300800', '-210866760000', '-210866760001', '1e10', '1e400', '9223372036854775807', '-9223372036854775808',
  "'2460000.5'", "' 2460000.5 '", "'2460000.5x'", "'1e'", "'1.e3'", "'.5'", "'5.'", "'+2460000'", "'-1'", "'1e400'", "'0x10'",
  // other
  "'now '", "'abc'", "''", 'NULL', "x'323032342d30312d3031'", "x''", "'2024-01-01' || char(0) || 'xyz'",
  'i', 'r', 't', 'b',
];

const MODIFIERS = [
  "'+1 day'", "'-1 day'", "'+1 days'", "'1 day'", "'+1 DAYS'", "'+1 Day '", "'+ 1 day'", "'+1  day'", "'+1.5 days'", "'-0.25 days'",
  "'+36 hours'", "'-90 minutes'", "'+3600 seconds'", "'+0.5 seconds'", "'+1e2 seconds'", "'+1 dayss'", "'+1 fortnight'", "'+1 d'",
  "'+1 month'", "'-1 month'", "'+13 months'", "'-13 months'", "'+1.5 months'", "'-0.5 months'", "'+1 year'", "'-1 year'", "'+1.5 years'",
  "'+176545 months'", "'+176546 months'", "'+14712 years'", "'+14713 years'", "'+5373484 days'", "'+5373485 days'", "'+1e300 days'",
  "'+05:00'", "'-05:00'", "'+05:00:30'", "'+05:00:30.5'", "'+24:00'", "'+24:30'", "'-00:00:00.001'", "'+5:00'", "'05:00'", "'+05:00Z'",
  "'+0001-02-03'", "'-0001-02-03'", "'+0000-11-30'", "'+0000-12-00'", "'+0000-00-31'", "'+00001-02-03'", "'-0001-02-03 04:05'",
  "'+0001-02-03 04:05:06.5'", "'+0001-02-03 4:05'", "'+0001-02-03x'", "'0001-02-03'", "'+0001-02-03 24:00'", "'+0000-00-00 24:30'",
  "'start of month'", "'start of year'", "'start of day'", "'START OF MONTH'", "'start of week'", "'start of'",
  "'weekday 0'", "'weekday 1'", "'weekday 6'", "'weekday 7'", "'weekday 1.0'", "'weekday 1.5'", "'weekday  3'", "'weekday -1'", "'weekday -0'", "'weekday -0.0'",
  "'weekday -6'", "'weekday -7'", "'weekday  -2 '", "'weekday - 1'", "'weekday +3'", "'Weekday 2'",
  "'unixepoch'", "'julianday'", "'auto'", "'UNIXEPOCH'", "'localtime'", "'utc'", "'subsec'", "'subsecond'", "'SubSec'",
  "'ceiling'", "'floor'", "'nonsense'", "''", 'NULL', '5', '1.5',
];

const CASES: string[] = [];
for (const f of FUNCS) {
  CASES.push(`${f}()`.replace('()', "('2024-03-05 13:04:05.678')"));
  for (const v of VALUES) CASES.push(`${f}(${v})`);
  for (const m of MODIFIERS) CASES.push(`${f}('2024-01-31 13:04:05.678', ${m})`, `${f}(1700000000, ${m})`, `${f}('2023-02-29', ${m})`);
}
for (const v of VALUES) {
  CASES.push(`strftime('${ALL_CODES.map((c) => '%' + c).join(' ')}', ${v})`, `timediff(${v}, '2024-03-05 13:04:05.678')`, `timediff('2000-02-29', ${v})`);
}
for (let c = 32; c < 127; c++) {
  const ch = String.fromCharCode(c);
  if (ch === "'") continue;
  CASES.push(`strftime('a%${ch}b', '2024-03-05 13:04:05.678')`);
}
CASES.push(
  "strftime('%')", "strftime('abc')", "strftime('')", "strftime(NULL, '2024-01-01')", "strftime('%Y', NULL)", "strftime(5, '2024-01-01')",
  "strftime('%Y-%m-%d %%', '-0005-01-01')", "strftime('%s', '2024-01-01', 'subsec')", "strftime('%s', '1969-12-31 23:59:59.25', 'subsec')",
  "strftime('%J', 0.00001)", "strftime('%J', 2460000.123456789)", "strftime('%J', '2024-02-29 12:00')", "strftime('%f', '12:00:00.1235')",
  "strftime('%f', '12:00:00.1245')", "strftime('%f', '12:00:59.9999')", "strftime('%I %l %p %P', '2024-01-01 00:30')",
  "strftime('%I %l %p %P', '2024-01-01 12:30')", "strftime('%I %l %p %P', '2024-01-01 23:30')", "strftime('%g %G %V %W %U %j', '2021-01-01')",
  "strftime('%g %G %V %W %U %j', '2020-12-31')", "strftime('%g %G %V %W %U %j', '2027-01-01')", "strftime('%g %G %V %W %U %j', '2026-12-31')",
  "strftime('%g %G %V', '-0001-01-01')", "strftime('%g %G %V', '0000-01-02')", "strftime('ü%Yü', '2024-01-01')",
  'strftime(\'%Y\', \'2024-01-01\', \'+1 year\', \'start of month\', \'-1 day\', \'weekday 0\')',
  "datetime('2024-01-31', '+1 month', 'floor')", "datetime('2024-01-31', '+1 month', 'ceiling')", "datetime('2024-03-31', '-1 month', 'floor')",
  "datetime('2023-02-29', 'floor', 'floor')", "datetime('2023-01-31', '+1 month', 'start of month', 'floor')", "datetime('2023-01-31', '+1.9 month', 'floor')",
  "datetime('2023-03-31', '-0000-01-05', 'floor')", "datetime('2023-03-31', '-0000-01-00 01:00', 'floor')", "datetime('2023-02-29', 'utc', 'floor')",
  "datetime('2023-02-29', 'weekday 1', 'floor')", "datetime('2023-02-29', '+00:00', 'floor')", "datetime('2023-02-29', 'subsec', 'floor')",
  "datetime(1700000000, 'unixepoch', 'unixepoch')", "datetime(1700000000, 'start of day', 'unixepoch')", "datetime(2460000, 'auto', 'julianday')",
  "datetime(2460000, 'julianday', 'auto')", "datetime('1700000000', 'unixepoch')", "datetime(-1, 'unixepoch')", "datetime(1700000000.123, 'unixepoch', 'subsec')",
  "datetime(253402300799, 'unixepoch')", "datetime(253402300800, 'unixepoch')", "datetime(-210866760000, 'unixepoch')", "datetime(-210866760001, 'auto')",
  "datetime(1e10, 'localtime')", "datetime(1e10, 'utc')", "datetime('2024-06-01 12:00', 'localtime', 'utc')", "datetime('2024-06-01 12:00', 'utc', 'utc')",
  "datetime('2024-06-01 12:00Z', 'utc')", "datetime('2024-06-01 12:00+02:00', 'utc')", "datetime('1900-06-01 12:00', 'localtime')",
  "datetime('2100-06-01 12:00', 'localtime', 'subsec')", "datetime('2024-03-10 02:30', 'utc')", "datetime('2024-11-03 01:30', 'utc')",
  "datetime('now', 'localtime', 'localtime') = datetime('now', 'localtime')", "datetime('2024-01-01', 'start of day', 'start of month', 'start of year')",
  "unixepoch('2024-01-01 00:00:00.5', 'subsec')", "unixepoch('1969-12-31 23:59:59.5', 'subsec')",   "typeof(unixepoch('2024-01-01'))", "typeof(unixepoch('2024-01-01 00:00:00.5', 'subsec'))", "typeof(julianday('2024-01-01'))", "julianday('2024-01-01') + 0.5", "timediff('2024-03-01', '2023-01-31')",
  "timediff('2023-01-31', '2024-03-01')", "timediff('2024-03-31', '2024-02-29')", "timediff('2024-02-29', '2024-03-31')", "timediff('2024-01-01', '2024-01-01')",
  "timediff('9999-12-31 23:59:59.999', '-4713-11-24 12:00')", "timediff('-4713-11-24 12:00', '9999-12-31 23:59:59.999')", "timediff(2460000.5, 1700000000)",
  "timediff('2024-01-31 10:00', '2024-02-29 09:00')", "timediff('2024-02-29 09:00', '2024-01-31 10:00')", "timediff('2023-03-31 00:00:00.5', '2023-02-28 23:59:59.75')",
  "julianday('2024-01-01', '+0.1234567890123456789 days')", "julianday('2460000.12345678901234567890')", "julianday('2024-01-01', '+1e-5 days')",
  "julianday('2024-01-01', '+123456789.987654321 seconds')", "julianday(2460000.000000001)", "strftime('%J', '2460000.99999999999')",
  "time(0.00001, 'subsecond', '-56 minute', 'localtime')", "strftime('%P%d%U%G%T', 9223372036854775807, 'auto', 'utc', 'subsec')",
  "strftime(' %f%I:%u', '1e400', 'auto', 'utc', 'start of month', '-11:49:01')", "datetime(253402300800, 'auto', 'localtime')",
  "datetime('9999-12-31 24:00', '-0000-01-00')", "datetime('9999-12-31 24:00', 'localtime')", "datetime('9999-12-31 24:00', '-1 day', 'localtime')",
  "datetime('9999-12-31 24:00', 'utc')", "datetime('24:00', 'start of month')", "datetime('24:00', '+390 months')", "datetime('2024-01-30 24:00', '+1 month')",
  "date('2024-01-01', 'subsec')", "time('24:00', 'subsec')", "time('12:00:00.9996', 'subsec')", "time(0.5, 'subsec')",
  "datetime('2024-01-01', '+464000000000000 seconds', '-464000000000000 seconds')", "datetime('2024-01-01', '+1 day', '+1 hour', '+1 minute', '+1 second')",
  'datetime(i, \'unixepoch\') FROM v', 'datetime(r) FROM v', 'datetime(t, \'+1 year\') FROM v', 'datetime(b) FROM v', 'strftime(\'%W\', t) FROM v',
  "date(i, 'auto', '+' || i % 7 || ' days') FROM v", "julianday(t) - julianday(r) FROM v", 'datetime(CAST(i AS REAL), \'unixepoch\') FROM v',
);

describe('date/time functions vs SQLite', () => {
  it(`hand-picked cases (${CASES.length})`, () => {
    const e = engines();
    const failures: string[] = [];
    for (const c of CASES) {
      const k = c.indexOf(' FROM v');
      const f = k >= 0 ? compare(e, c.slice(0, k), c.slice(k)) : compare(e, c);
      if (f) failures.push(f);
    }
    if (failures.length) throw new Error(`${failures.length} mismatches:\n${failures.slice(0, 20).join('\n')}`);
  });

  it('randomized calls (seeded)', () => {
    const r = rng(Number(process.env.DIFF_SEED ?? 20241101));
    const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
    const int = (lo: number, hi: number): number => lo + Math.floor(r() * (hi - lo + 1));
    const p2 = (n: number): string => String(n).padStart(2, '0');
    const year = (): string => {
      const k = r();
      const y = k < 0.6 ? int(1900, 2100) : k < 0.85 ? int(0, 9999) : -int(0, 4713);
      return (y < 0 ? '-' : '') + String(Math.abs(y)).padStart(4, '0');
    };
    const timeOfDay = (): string => {
      const k = r();
      let t = `${p2(int(0, k < 0.03 ? 25 : 23))}:${p2(int(0, 59))}`;
      if (r() < 0.7) t += `:${p2(int(0, k < 0.05 ? 60 : 59))}`;
      if (t.length > 5 && r() < 0.5) t += '.' + String(int(0, 999999)).slice(0, int(1, 6));
      if (r() < 0.15) t += pick(['Z', '+01:00', '-05:30', ' +14:00', '-00:45']);
      return t;
    };
    const value = (): string => {
      const k = r();
      if (k < 0.45) {
        let s = `${year()}-${p2(int(k < 0.02 ? 0 : 1, k < 0.02 ? 13 : 12))}-${p2(int(1, r() < 0.1 ? 31 : 28))}`;
        if (r() < 0.6) s += pick([' ', 'T']) + timeOfDay();
        return `'${s}'`;
      }
      if (k < 0.55) return `'${timeOfDay()}'`;
      if (k < 0.65) return String(int(-100, 5373500) + (r() < 0.5 ? 0.5 : r() < 0.5 ? 0 : Math.round(r() * 1e6) / 1e6));
      if (k < 0.8) return String(int(-210866760100, 253402300900) + (r() < 0.7 ? 0 : Math.round(r() * 1000) / 1000));
      if (k < 0.85) return `'${int(0, 5373490)}${r() < 0.5 ? '.' + int(0, 999) : ''}'`;
      if (k < 0.9) return `${pick(['i', 'r', 't', 'b'])}`;
      return pick(VALUES);
    };
    const modifier = (first: boolean): string => {
      const k = r();
      const sign = pick(['+', '-', '']);
      const num = (): string => (r() < 0.6 ? String(int(0, 400)) : (r() * 400).toFixed(int(1, 4)));
      if (k < 0.35) {
        return `'${sign}${num()} ${pick(['day', 'days', 'hour', 'hours', 'minute', 'minutes', 'second', 'seconds', 'month', 'months', 'year', 'years'])}'`;
      }
      if (k < 0.45) return `'${pick(['+', '-'])}${p2(int(0, 24))}:${p2(int(0, 59))}${r() < 0.5 ? ':' + p2(int(0, 59)) : ''}${r() < 0.3 ? '.' + int(0, 999) : ''}'`;
      if (k < 0.55) {
        const hm = r() < 0.3 ? ` ${p2(int(0, 24))}:${p2(int(0, 59))}` : '';
        return `'${pick(['+', '-'])}${String(int(0, 30)).padStart(4, '0')}-${p2(int(0, 12))}-${p2(int(0, 31))}${hm}'`;
      }
      if (k < 0.65) return `'start of ${pick(['day', 'month', 'year'])}'`;
      if (k < 0.72) return `'weekday ${int(0, 7)}'`;
      if (k < 0.8) return `'${pick(['floor', 'ceiling'])}'`;
      if (k < 0.85) return `'${pick(['subsec', 'subsecond'])}'`;
      if (k < 0.92 || first) return `'${pick(['unixepoch', 'julianday', 'auto'])}'`;
      return `'${pick(['localtime', 'utc'])}'`;
    };
    const fmt = (): string => {
      const n = int(1, 6);
      let s = '';
      for (let i = 0; i < n; i++) s += (r() < 0.2 ? pick(['-', ' ', 'x', ':']) : '') + '%' + pick(ALL_CODES);
      return `'${s}'`;
    };
    const call = (): string => {
      const args = [value()];
      const nm = r() < 0.3 ? 0 : int(1, 4);
      for (let i = 0; i < nm; i++) args.push(modifier(i === 0));
      const k = r();
      if (k < 0.3) return `strftime(${fmt()}, ${args.join(', ')})`;
      if (k < 0.36) return `timediff(${value()}, ${value()})`;
      return `${pick(FUNCS)}(${args.join(', ')})`;
    };
    const e = engines();
    const n = Number(process.env.DIFF_DATETIME ?? 4000);
    const failures: string[] = [];
    let nonNull = 0;
    for (let q = 0; q < n && failures.length < 10; q++) {
      const expr = call();
      const usesTable = /\b[irtb]\b/.test(expr.replace(/'[^']*'/g, ''));
      const f = compare(e, expr, usesTable ? ' FROM v' : '');
      if (f) failures.push(f);
      else if (!/^NULL$/.test(e.lite.selectArrays(`SELECT ${expr}${usesTable ? ' FROM v' : ''}`).map((x) => canon(x[0])).join())) nonNull++;
    }
    if (failures.length) throw new Error(`${failures.length} mismatches:\n${failures.join('\n')}`);
    // The generator should mostly produce valid dates, not just NULLs.
    expect(nonNull).toBeGreaterThan(n * 0.5);
  }, 600_000);

  it("'now' is stable within a statement and tracks the clock", () => {
    const db = Database.openFile(new MemoryVfs().openSync('now.db'));
    const before = Date.now();
    const [[a, b, c, d, u, cts]] = db.query(
      "SELECT julianday('now'), julianday(), datetime('now') = datetime(), strftime('%s','now') = strftime('%s'), unixepoch('now', 'subsec'), current_timestamp = datetime('now')",
    ).rows;
    const after = Date.now();
    expect(a).toBe(b);
    expect(c).toBe(1);
    expect(d).toBe(1);
    expect(cts).toBe(1);
    expect(u as number).toBeGreaterThanOrEqual(before / 1000);
    expect(u as number).toBeLessThanOrEqual(after / 1000);
    // Every row of one statement sees the same instant; a cached statement sees a new one next time.
    db.exec('CREATE TABLE n(x)');
    for (let i = 0; i < 200; i++) db.exec(`INSERT INTO n VALUES (${i})`);
    const rows = db.query("SELECT DISTINCT strftime('%f', 'now') FROM n").rows;
    expect(rows.length).toBe(1);
    const stmt = db.prepare("SELECT unixepoch('now', 'subsec')");
    const t1 = stmt.all()[0][0] as number;
    const wait = Date.now() + 5;
    while (Date.now() < wait);
    const t2 = stmt.all()[0][0] as number;
    expect(t2).toBeGreaterThan(t1);
  });
});
