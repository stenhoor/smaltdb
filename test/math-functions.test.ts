/**
 * The math functions (acos … trunc) against SQLite (official WASM build 3.54, which enables them), on a grid of
 * inputs that covers each function's edges: NULL, zero and negative zero, domain limits, huge values and
 * infinities, large INTEGERs (bigint), numeric and non-numeric text, and blobs. Each expression runs:
 * - on literals (constant-folded by the closure compiler);
 * - on an ANY column (the closure compiler's general path);
 * - on INTEGER and REAL columns, in a row table and in a columnar table (the typed fast paths and generated code),
 *   bare and inside arithmetic.
 * The type and the value must match SQLite's:
 * - exactly for the functions that are exactly rounded in both (sqrt, ceil, floor, trunc, mod, pi);
 * - to within one unit in the last place for the others: JavaScript's Math and the C library SQLite uses may round
 *   the last bit differently (e.g. tanh(0.7), log10(pi)), and ECMAScript leaves that to the implementation.
 * Two differences that do not come from the math functions are allowed, both documented in "Differences from
 * SQLite": -0.0 and 0.0 compare equal (SQLite reads -0.0 back from a REAL column as 0.0, smaltdb as -0.0), and on
 * text and ANY inputs an integral REAL result of ceil/floor/trunc can come out as an INTEGER.
 */
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import type { SqlValue } from '../src/engine/values.js';
import { rng } from './helpers.js';

type Sqlite = { exec(sql: string): void; selectArrays(sql: string): unknown[][] };
let lite: Sqlite;

beforeAll(async () => {
  const s3 = (await (sqliteInit as unknown as (o: object) => Promise<{ oo1: { DB: new (n: string) => Sqlite } }>)({ print: () => {}, printErr: () => {} }));
  lite = new s3.oo1.DB(':memory:');
});

const ONE_ARG = ['acos', 'acosh', 'asin', 'asinh', 'atan', 'atanh', 'cos', 'cosh', 'sin', 'sinh', 'tan', 'tanh', 'exp', 'sqrt', 'degrees', 'radians', 'ln', 'log', 'log10', 'log2', 'ceil', 'ceiling', 'floor', 'trunc'];
const TWO_ARG = ['atan2', 'mod', 'pow', 'power', 'log'];

/** Literals for the grid. */
const NUMBERS = ['0', '-0.0', '0.0', '1', '-1', '2', '3', '-7', '10', '100', '0.5', '-0.5', '1.5', '-1.5', '2.5', '-2.5', '0.7', '-0.7', '0.9999999', '1.0000001', '3.141592653589793', '1e-300', '5e-324', '1e300', '1e308', '1e400', '-1e400', '9007199254740993', '9223372036854775807', '-9223372036854775808', '12345.678'];
const OTHERS = ['NULL', "'4'", "' 2.5 '", "'-3'", "'abc'", "'12abc'", "'1e3'", "'0x10'", "''", "x'31'", "x''"];
const PAIR_VALUES = ['NULL', '0', '1', '-1', '2', '-2', '0.5', '-0.5', '2.5', '3', '10', '1e300', '1e400', '-1e400', "'2'", "'abc'", "'12abc'", "x'32'"];

/** A value in a form both engines can be compared on: kind and exact digits. */
function canon(type: unknown, v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return `${type}:${v.toString()}`;
  if (typeof v === 'number') return `${type}:${String(v)}`; // String(-0) is '0': -0.0 = 0.0
  return `${type}:${String(v)}`;
}

function sqliteRows(sql: string): string[] {
  return lite.selectArrays(sql).map((r) => canon(r[0], r[1]));
}

function smaltRows(db: Database, sql: string): string[] {
  return db.query(sql, undefined).rows.map((r: SqlValue[]) => canon(r[0], r[1]));
}

/** Functions whose results are exactly rounded in JavaScript and in C, so they must match SQLite to the bit. */
const EXACT = new Set(['sqrt', 'ceil', 'ceiling', 'floor', 'trunc', 'mod', 'pi']);

/** Two REAL results that differ by at most one unit in the last place. */
function withinOneUlp(a: string, b: string): boolean {
  const [ta, va] = a.split(':');
  const [tb, vb] = b.split(':');
  if (ta !== 'real' || tb !== 'real') return false;
  const x = Number(va);
  const y = Number(vb);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const buf = new DataView(new ArrayBuffer(16));
  buf.setFloat64(0, x);
  buf.setFloat64(8, y);
  return Math.abs(Number(buf.getBigInt64(0) - buf.getBigInt64(8))) <= 1;
}

/**
 * Whether smaltdb's result for `e` is acceptable: equal, within one ulp for a function that is not exactly rounded,
 * or (with `dynamic`: the argument's type is only known at run time) an INTEGER where SQLite has the same REAL.
 */
function acceptable(e: string, want: string, got: string, dynamic: boolean): boolean {
  if (want === got) return true;
  const fn = /^(\w+)\(/.exec(e)?.[1] ?? '';
  if (!EXACT.has(fn) && withinOneUlp(want, got)) return true;
  if (dynamic && ['ceil', 'ceiling', 'floor', 'trunc'].includes(fn) && want.startsWith('real:') && got === `integer:${want.slice(5)}`) return true;
  return false;
}

function compare(exprs: string[], run: (e: string) => [string, string], dynamic: (e: string) => boolean): void {
  const mismatches: string[] = [];
  for (const e of exprs) {
    const [want, got] = run(e);
    if (!acceptable(e, want, got, dynamic(e))) mismatches.push(`${e}: SQLite ${want}, smaltdb ${got}`);
  }
  expect(mismatches).toEqual([]);
}

const literalExprs = (): string[] => [
  ...ONE_ARG.flatMap((f) => [...NUMBERS, ...OTHERS].map((x) => `${f}(${x})`)),
  ...TWO_ARG.flatMap((f) => PAIR_VALUES.flatMap((x) => PAIR_VALUES.map((y) => `${f}(${x}, ${y})`))),
  'pi()',
  'pi() * 2',
];

describe('math functions match SQLite', () => {
  it('on literals', () => {
    const db = Database.openMemory();
    compare(literalExprs(), (e) => [sqliteRows(`SELECT typeof(${e}), ${e}`)[0], smaltRows(db, `SELECT typeof(${e}), ${e}`)[0]], (e) => e.includes("'"));
    db.close();
  });

  it('on an ANY column', () => {
    const db = Database.openMemory();
    const values = [...NUMBERS, ...OTHERS];
    const ddl = 'CREATE TABLE a(id INTEGER PRIMARY KEY, v ANY) STRICT';
    lite.exec(`DROP TABLE IF EXISTS a; ${ddl}`);
    db.exec(ddl);
    values.forEach((v, i) => {
      lite.exec(`INSERT INTO a VALUES (${i}, ${v})`);
      db.exec(`INSERT INTO a VALUES (${i}, ${v})`);
    });
    const exprs = ONE_ARG.flatMap((f) => values.map((_v, i) => `${f}(v)|${i}`));
    compare(exprs, (e) => {
      const [call, id] = e.split('|');
      const sql = `SELECT typeof(${call}), ${call} FROM a WHERE id = ${id}`;
      return [sqliteRows(sql)[0], smaltRows(db, sql)[0]];
    }, () => true);
    db.close();
  });

  for (const storage of ['row', 'columnar']) {
    it(`on INTEGER and REAL columns (${storage} table), bare and in arithmetic`, () => {
      const db = Database.openMemory();
      const ints = ['0', '1', '-1', '2', '3', '-7', '10', '100', '9007199254740993', '9223372036854775807', '-9223372036854775808', 'NULL'];
      const reals = ['0.0', '-0.0', '0.5', '-0.5', '1.5', '-1.5', '2.5', '0.7', '-0.7', '3.141592653589793', '1e-300', '1e300', '1e308', '1e400', '-1e400', '12345.678', 'NULL'];
      const n = Math.max(ints.length, reals.length);
      lite.exec('DROP TABLE IF EXISTS n; CREATE TABLE n(id INTEGER PRIMARY KEY, i INTEGER, r REAL) STRICT');
      db.exec(`CREATE TABLE n(id INTEGER PRIMARY KEY, i INTEGER, r REAL)${storage === 'columnar' ? " WITH (storage = 'columnar')" : ''}`);
      for (let k = 0; k < n; k++) {
        const row = `(${k}, ${ints[k % ints.length]}, ${reals[k % reals.length]})`;
        lite.exec(`INSERT INTO n VALUES ${row}`);
        db.exec(`INSERT INTO n VALUES ${row}`);
      }
      const exprs = [
        ...ONE_ARG.flatMap((f) => [`${f}(i)`, `${f}(r)`, `${f}(r) + 0`, `${f}(i) * 1`, `${f}(r * 2) - 1`]),
        ...TWO_ARG.flatMap((f) => [`${f}(i, r)`, `${f}(r, i)`, `${f}(r, 2)`, `${f}(i, 2) + 1`, `${f}(r + 1, i - 1) * 2`]),
      ];
      // One query per expression over every row, in rowid order.
      const mismatches: string[] = [];
      for (const e of exprs) {
        const sql = `SELECT typeof(${e}), ${e} FROM n ORDER BY id`;
        const want = sqliteRows(sql);
        const got = smaltRows(db, sql);
        want.forEach((w, k) => {
          if (!acceptable(e, w, got[k], false)) mismatches.push(`${e} (row ${k}): SQLite ${w}, smaltdb ${got[k]}`);
        });
      }
      expect(mismatches).toEqual([]);
      db.close();
    });
  }

  it('aggregates over math functions (the fused columnar pipeline)', () => {
    const db = Database.openMemory();
    lite.exec('DROP TABLE IF EXISTS g; CREATE TABLE g(id INTEGER PRIMARY KEY, k INTEGER, x REAL) STRICT');
    db.exec("CREATE TABLE g(id INTEGER PRIMARY KEY, k INTEGER, x REAL) WITH (storage = 'columnar')");
    const rows: string[] = [];
    for (let i = 1; i <= 3000; i++) rows.push(`(${i}, ${i % 7}, ${i % 13 === 0 ? 'NULL' : ((i * 37) % 1000) / 10 - 20})`);
    lite.exec(`INSERT INTO g VALUES ${rows.join(',')}`);
    db.exec(`INSERT INTO g VALUES ${rows.join(',')}`);
    for (const sql of [
      'SELECT k, count(sqrt(x)), round(sum(sqrt(x)), 6), round(sum(ln(x)), 6), round(avg(pow(x, 2)), 4), min(ceil(x)), max(floor(x)), round(sum(sin(x) * cos(x)), 6) FROM g GROUP BY k ORDER BY k',
      'SELECT count(*) FROM g WHERE sqrt(x) > 5 AND ln(x) < 4',
      'SELECT round(sum(exp(x / 100)), 6), round(sum(mod(x, 3)), 6), round(sum(degrees(radians(x))), 6) FROM g',
    ]) {
      expect(db.query(sql).rows.map((r: SqlValue[]) => r.map(String)), sql).toEqual(lite.selectArrays(sql).map((r) => r.map(String)));
    }
    db.close();
  });
});

describe('math functions: errors', () => {
  it('check their argument counts like SQLite', () => {
    const db = Database.openMemory();
    for (const sql of ['SELECT sqrt()', 'SELECT sqrt(1, 2)', 'SELECT pow(2)', 'SELECT pi(1)', 'SELECT log()', 'SELECT log(1, 2, 3)', 'SELECT ceil(1, 2)']) {
      expect(() => db.query(sql), sql).toThrow('wrong number of arguments');
      expect(() => lite.selectArrays(sql), sql).toThrow('wrong number of arguments');
    }
    db.close();
  });
});

describe('math functions on random inputs', () => {
  /** Functions that matched SQLite's WASM build (musl) to the bit on every input when this was written. */
  const BIT_EXACT = new Set(['sqrt', 'acos', 'asin', 'atan', 'tan', 'tanh', 'log2', 'log10', 'atan2']);
  const ULPS = new DataView(new ArrayBuffer(16));
  const ulps = (a: number, b: number): number => {
    if (a === b) return 0;
    ULPS.setFloat64(0, a);
    ULPS.setFloat64(8, b);
    return Math.abs(Number(ULPS.getBigInt64(0) - ULPS.getBigInt64(8)));
  };

  it('are within one unit in the last place of SQLite, and exact where both are exact', () => {
    const r = rng(20261103);
    const ranges = [() => r() * 2 - 1, () => (r() * 2 - 1) * 1e-3, () => (r() * 2 - 1) * 20, () => r() * 1e4, () => r() * 1e-200, () => 1 + (r() - 0.5) * 1e-3];
    const db = Database.openMemory();
    const report: string[] = [];
    for (const f of [...ONE_ARG.filter((f) => !['ceil', 'ceiling', 'floor', 'trunc'].includes(f)), 'atan2', 'pow', 'mod']) {
      const pairs = ['atan2', 'pow', 'mod'].includes(f);
      const xs = ranges.flatMap((g) => Array.from({ length: 400 }, () => (pairs ? `${g().toPrecision(17)}, ${(r() * 20 - 10).toPrecision(17)}` : g().toPrecision(17))));
      // acosh is undefined below 1. smaltdb returns NULL there; SQLite's WASM build (musl) returns a wrong
      // value for some x <= -2 (native builds return NULL), so those inputs are checked separately below.
      const inputs = f === 'acosh' ? xs.filter((x) => Number(x) >= 1 || Number(x) > -2) : xs;
      const sql = `SELECT ${f}(${pairs ? 'column1, column2' : 'column1'}) FROM (VALUES ${inputs.map((x) => `(${x})`).join(',')})`;
      const want = lite.selectArrays(sql).map((row) => row[0] as number | null);
      const got = db.query(sql).rows.map((row: SqlValue[]) => row[0] as number | null);
      let max = 0;
      want.forEach((w, i) => {
        const g = got[i];
        const u = w === null || g === null ? (w === g ? 0 : Infinity) : ulps(w, g);
        if (u > max) max = u;
      });
      if (max > (BIT_EXACT.has(f) ? 0 : 1)) report.push(`${f}: ${max} ulp`);
    }
    expect(report).toEqual([]);
    db.close();
  });

  it('acosh is NULL below 1', () => {
    const db = Database.openMemory();
    expect(db.query('SELECT acosh(0.5), acosh(-1), acosh(-7), acosh(-559746.5), acosh(1)').rows).toEqual([[null, null, null, null, 0]]);
    db.close();
  });
});
