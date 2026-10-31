/**
 * Differential testing against SQLite (official WASM build, run in Node): random schemas' data,
 * random queries, results compared as multisets (or exact sequences when fully ordered).
 *
 *   DIFF_QUERIES=20000 npx vitest run test/differential.test.ts
 */
import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { SqlValue } from '../src/engine/values.js';
import { rng } from './helpers.js';

type Sqlite = { exec(sql: string): void; selectArrays(sql: string): unknown[][] };
let sqlite3: { oo1: { DB: new (name: string) => Sqlite } };

beforeAll(async () => {
  sqlite3 = (await (sqliteInit as unknown as (o: object) => Promise<unknown>)({ print: () => {}, printErr: () => {} })) as never;
});

const SCHEMA = `
  CREATE TABLE t1(a INTEGER PRIMARY KEY, b INTEGER, c REAL, d TEXT, e ANY) STRICT;
  CREATE INDEX t1_b ON t1(b);
  CREATE INDEX t1_d ON t1(d);
  CREATE TABLE t2(x INTEGER PRIMARY KEY, y INTEGER, z TEXT) STRICT;
  CREATE INDEX t2_y ON t2(y);
  CREATE INDEX t2_zy ON t2(z, y);
`;

const TEXTS = ["'a'", "'B'", "'b'", "'abc'", "'Abc'", "''", "'10'", "' x'", "'zz'", "'5'"];

function lit(r: () => number, kind: 'num' | 'text'): string {
  if (r() < 0.08) return 'NULL';
  if (kind === 'text') return TEXTS[Math.floor(r() * TEXTS.length)];
  const k = r();
  if (k < 0.6) return String(Math.floor(r() * 14) - 4);
  return ['0.5', '2.5', '-1.25', '3.75', '10.5'][Math.floor(r() * 5)];
}

function buildData(r: () => number): string[] {
  const out: string[] = [];
  for (let i = 1; i <= 60; i++) {
    const b = r() < 0.15 ? 'NULL' : String(Math.floor(r() * 11) - 5);
    const c = r() < 0.15 ? 'NULL' : (Math.floor(r() * 20) - 10 + 0.5).toString();
    const d = r() < 0.12 ? 'NULL' : TEXTS[Math.floor(r() * TEXTS.length)];
    const ek = r();
    const e = ek < 0.15 ? 'NULL' : ek < 0.5 ? String(Math.floor(r() * 9) - 3) : ek < 0.7 ? '1.5' : TEXTS[Math.floor(r() * TEXTS.length)];
    out.push(`INSERT INTO t1 VALUES (${i * 3 - Math.floor(r() * 2)}, ${b}, ${c}, ${d}, ${e})`);
  }
  for (let i = 1; i <= 40; i++) {
    const y = r() < 0.15 ? 'NULL' : String(Math.floor(r() * 11) - 5);
    const z = r() < 0.12 ? 'NULL' : TEXTS[Math.floor(r() * TEXTS.length)];
    out.push(`INSERT INTO t2 VALUES (${i * 2}, ${y}, ${z})`);
  }
  return out;
}

interface Ctx {
  r: () => number;
  num: string[];
  text: string[];
  agg?: boolean;
}

function pick<T>(r: () => number, xs: T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

function genNum(c: Ctx, depth: number): string {
  const r = c.r;
  const k = r();
  if (depth <= 0 || k < 0.35) return r() < 0.7 && c.num.length ? pick(r, c.num) : lit(r, 'num');
  if (k < 0.6) return `(${genNum(c, depth - 1)} ${pick(r, ['+', '-', '*', '/', '%'])} ${genNum(c, depth - 1)})`;
  if (k < 0.65) return `-${genNum(c, depth - 1)}`;
  if (k < 0.7) return `abs(${genNum(c, depth - 1)})`;
  if (k < 0.75) return `coalesce(${genNum(c, depth - 1)}, ${genNum(c, depth - 1)})`;
  if (k < 0.8) return `CASE WHEN ${genBool(c, depth - 1)} THEN ${genNum(c, depth - 1)} ELSE ${genNum(c, depth - 1)} END`;
  if (k < 0.84) return `length(${genText(c, depth - 1)})`;
  if (k < 0.87) return `instr(${genText(c, depth - 1)}, ${genText(c, depth - 1)})`;
  if (k < 0.9) return `${pick(r, ['max', 'min'])}(${genNum(c, depth - 1)}, ${genNum(c, depth - 1)})`;
  if (k < 0.93) return `CAST(${genNum(c, depth - 1)} AS INTEGER)`;
  if (k < 0.96) return `nullif(${genNum(c, depth - 1)}, ${genNum(c, depth - 1)})`;
  return `round(${genNum(c, depth - 1)})`;
}

function genText(c: Ctx, depth: number): string {
  const r = c.r;
  const k = r();
  if (depth <= 0 || k < 0.45) return r() < 0.7 && c.text.length ? pick(r, c.text) : lit(r, 'text');
  if (k < 0.55) return `upper(${genText(c, depth - 1)})`;
  if (k < 0.65) return `lower(${genText(c, depth - 1)})`;
  if (k < 0.72) return `(${genText(c, depth - 1)} || ${genText(c, depth - 1)})`;
  if (k < 0.8) return `substr(${genText(c, depth - 1)}, ${Math.floor(r() * 5) - 2}${r() < 0.5 ? `, ${Math.floor(r() * 4) - 1}` : ''})`;
  if (k < 0.86) return `coalesce(${genText(c, depth - 1)}, ${genText(c, depth - 1)})`;
  if (k < 0.92) return `trim(${genText(c, depth - 1)})`;
  return `replace(${genText(c, depth - 1)}, 'b', 'Q')`;
}

function genBool(c: Ctx, depth: number): string {
  const r = c.r;
  const k = r();
  if (depth <= 0 || k < 0.4) {
    const kk = r();
    if (kk < 0.45) return `${genNum(c, 1)} ${pick(r, ['=', '!=', '<', '<=', '>', '>=', 'IS', 'IS NOT'])} ${genNum(c, 1)}`;
    if (kk < 0.65) return `${genText(c, 1)} ${pick(r, ['=', '!=', '<', '>=', 'IS'])} ${genText(c, 1)}`;
    if (kk < 0.75) return `${pick(r, [...c.num, ...c.text])} ${pick(r, ['=', '<', '>'])} ${r() < 0.5 ? genText(c, 0) : genNum(c, 0)}`;
    if (kk < 0.85) return `${pick(r, [...c.num, ...c.text])} IS ${r() < 0.5 ? 'NOT ' : ''}NULL`;
    if (kk < 0.92) return `${genText(c, 1)} ${r() < 0.2 ? 'NOT ' : ''}LIKE ${pick(r, ["'a%'", "'%b%'", "'_bc'", "'%'", "'A_'", "'1%'"])}`;
    return `${genText(c, 1)} GLOB ${pick(r, ["'a*'", "'*b*'", "'[a-c]*'", "'?'"])}`;
  }
  if (k < 0.55) return `(${genBool(c, depth - 1)} AND ${genBool(c, depth - 1)})`;
  if (k < 0.7) return `(${genBool(c, depth - 1)} OR ${genBool(c, depth - 1)})`;
  if (k < 0.78) return `NOT (${genBool(c, depth - 1)})`;
  if (k < 0.88) return `${genNum(c, 1)} ${r() < 0.2 ? 'NOT ' : ''}BETWEEN ${genNum(c, 0)} AND ${genNum(c, 0)}`;
  const isNum = r() < 0.6;
  const items = Array.from({ length: 1 + Math.floor(r() * 4) }, () => (isNum ? lit(r, 'num') : lit(r, 'text')));
  return `${isNum ? genNum(c, 1) : genText(c, 1)} ${r() < 0.2 ? 'NOT ' : ''}IN (${items.join(', ')})`;
}

const T1 = { num: ['a', 'b', 'c', 't1.b'], text: ['d'] };
const T2 = { num: ['x', 'y'], text: ['z'] };
const J = { num: ['a', 'b', 'c', 'x', 'y', 't1.b', 't2.y'], text: ['d', 'z'] };

function genQuery(r: () => number): { sql: string; ordered: boolean } {
  const shape = r();
  const ncols = 1 + Math.floor(r() * 3);
  const cols = (c: Ctx): string[] => Array.from({ length: ncols }, () => (r() < 0.6 ? genNum(c, 2) : genText(c, 2)));
  if (shape < 0.25) {
    const c = { r, ...T1 };
    return { sql: `SELECT ${cols(c).join(', ')} FROM t1${r() < 0.8 ? ` WHERE ${genBool(c, 2)}` : ''}`, ordered: false };
  }
  if (shape < 0.42) {
    const c = { r, ...J };
    const jt = r() < 0.5 ? 'LEFT JOIN' : 'JOIN';
    const on = pick(r, ['t2.y = t1.b', 't2.x = t1.a', 't2.z = t1.d', 't1.b = t2.y AND t2.x > 4', 't2.y = t1.b + 1', 't2.x = t1.b']);
    return { sql: `SELECT ${cols(c).join(', ')} FROM t1 ${jt} t2 ON ${on}${r() < 0.6 ? ` WHERE ${genBool(c, 1)}` : ''}`, ordered: false };
  }
  if (shape < 0.6) {
    const c = { r, ...T1 };
    const g = pick(r, ['b', 'd', 'b, d', 'b % 3', 'length(d)', 'e']);
    const aggs = Array.from({ length: 1 + Math.floor(r() * 3) }, () =>
      pick(r, ['count(*)', `count(${genNum(c, 0)})`, `sum(${genNum(c, 1)})`, `total(${genNum(c, 1)})`, `avg(${genNum(c, 1)})`, `min(${genNum(c, 1)})`, `max(${genText(c, 1)})`, `count(DISTINCT ${pick(r, ['b', 'd', 'e'])})`]),
    );
    const having = r() < 0.3 ? ` HAVING count(*) > ${Math.floor(r() * 4)}` : '';
    if (r() < 0.2) return { sql: `SELECT ${aggs.join(', ')} FROM t1${r() < 0.5 ? ` WHERE ${genBool(c, 1)}` : ''}`, ordered: false };
    return { sql: `SELECT ${g}, ${aggs.join(', ')} FROM t1${r() < 0.5 ? ` WHERE ${genBool(c, 1)}` : ''} GROUP BY ${g}${having}`, ordered: false };
  }
  if (shape < 0.75) {
    const c = { r, ...T1 };
    const c2 = { r, ...T2 };
    const k = r();
    let w: string;
    if (k < 0.35) w = `${pick(r, ['b', 'a', 'd'])} ${r() < 0.3 ? 'NOT ' : ''}IN (SELECT ${pick(r, ['y', 'x', 'z'])} FROM t2 WHERE ${genBool(c2, 1)})`;
    else if (k < 0.65) w = `${r() < 0.4 ? 'NOT ' : ''}EXISTS (SELECT 1 FROM t2 WHERE t2.y = t1.b AND ${genBool(c2, 1)})`;
    else w = `${genNum(c, 1)} < (SELECT ${pick(r, ['max(y)', 'count(*)', 'min(x)', 'sum(y)'])} FROM t2 WHERE t2.y ${pick(r, ['=', '<', '>'])} t1.b)`;
    return { sql: `SELECT ${cols(c).join(', ')} FROM t1 WHERE ${w}`, ordered: false };
  }
  if (shape < 0.85) {
    const c = { r, ...T1 };
    const cs = cols(c);
    const order = cs.map((_, i) => `${i + 1}${r() < 0.4 ? ' DESC' : ''}`).join(', ');
    const limit = r() < 0.6 ? ` LIMIT ${Math.floor(r() * 10)}${r() < 0.5 ? ` OFFSET ${Math.floor(r() * 5)}` : ''}` : '';
    return { sql: `SELECT ${r() < 0.3 ? 'DISTINCT ' : ''}${cs.join(', ')} FROM t1${r() < 0.6 ? ` WHERE ${genBool(c, 2)}` : ''} ORDER BY ${order}${limit}`, ordered: true };
  }
  if (shape < 0.93) {
    const op = pick(r, ['UNION', 'UNION ALL', 'INTERSECT', 'EXCEPT']);
    return { sql: `SELECT b, d FROM t1 WHERE ${genBool({ r, ...T1 }, 1)} ${op} SELECT y, z FROM t2 WHERE ${genBool({ r, ...T2 }, 1)}`, ordered: false };
  }
  const c = { r, ...T1 };
  return { sql: `SELECT ${cols(c).join(', ')} FROM (SELECT * FROM t1 WHERE ${genBool(c, 1)}) AS s WHERE ${genBool({ r, num: ['s.b', 's.c', 'a'], text: ['s.d'] }, 1)}`, ordered: false };
}

function canon(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'bigint') return 'i' + v.toString();
  if (typeof v === 'number') return Number.isInteger(v) ? 'i' + v : 'r' + v.toPrecision(12);
  if (typeof v === 'string') return 's' + JSON.stringify(v);
  if (v instanceof Uint8Array) return 'x' + Buffer.from(v).toString('hex');
  return '?' + String(v);
}

function rowsCanon(rows: unknown[][], ordered: boolean): string[] {
  const out = rows.map((row) => row.map(canon).join('|'));
  return ordered ? out : out.sort();
}

function run(seed: number, queries: number): { failures: string[]; compared: number; bothErr: number } {
  const r = rng(seed);
  const lite = new sqlite3.oo1.DB(':memory:');
  const smalt = Database.openFile(new MemoryVfs().openSync('d.db'));
  lite.exec(SCHEMA);
  smalt.exec(SCHEMA.replaceAll(' STRICT', ''));
  for (const s of buildData(r)) {
    lite.exec(s);
    smalt.exec(s);
  }
  const failures: string[] = [];
  let compared = 0;
  let bothErr = 0;
  for (let q = 0; q < queries && failures.length < 5; q++) {
    const { sql, ordered } = genQuery(r);
    let a: unknown[][] | Error;
    let b: SqlValue[][] | Error;
    try {
      a = lite.selectArrays(sql);
    } catch (e) {
      a = e as Error;
    }
    try {
      b = smalt.query(sql).rows;
    } catch (e) {
      b = e as Error;
    }
    if (a instanceof Error || b instanceof Error) {
      if (a instanceof Error && b instanceof Error) {
        bothErr++;
        continue;
      }
      failures.push(`${sql}\n  sqlite: ${a instanceof Error ? 'ERROR ' + a.message : JSON.stringify(rowsCanon(a, ordered).slice(0, 5))}\n  smalt:  ${b instanceof Error ? 'ERROR ' + b.message : JSON.stringify(rowsCanon(b, ordered).slice(0, 5))}`);
      continue;
    }
    compared++;
    const ca = rowsCanon(a, ordered);
    const cb = rowsCanon(b, ordered);
    if (JSON.stringify(ca) !== JSON.stringify(cb)) {
      const onlyA = ca.filter((x) => !cb.includes(x)).slice(0, 4);
      const onlyB = cb.filter((x) => !ca.includes(x)).slice(0, 4);
      failures.push(`${sql}\n  rows sqlite=${ca.length} smalt=${cb.length}\n  only sqlite: ${JSON.stringify(onlyA)}\n  only smalt:  ${JSON.stringify(onlyB)}`);
    }
  }
  return { failures, compared, bothErr };
}

describe('differential vs SQLite', () => {
  const total = Number(process.env.DIFF_QUERIES ?? 3000);
  const seeds = 3;
  for (let s = 1; s <= seeds; s++) {
    it(`random queries agree with SQLite (seed ${s})`, () => {
      const { failures, compared } = run(s * 7919, Math.ceil(total / seeds));
      if (failures.length) throw new Error(`${failures.length} mismatches:\n\n${failures.join('\n\n')}`);
      expect(compared).toBeGreaterThan(total / seeds / 2);
    });
  }
});

// ------------------------------------------------------------------ DML

const DML_SCHEMA = `
  CREATE TABLE w(id INTEGER PRIMARY KEY, k INTEGER UNIQUE, v TEXT NOT NULL DEFAULT 'dflt', n REAL CHECK (n IS NULL OR n < 100)) STRICT;
  CREATE INDEX w_v ON w(v);
`;

function genDml(r: () => number): string {
  const k = r();
  const key = (): string => (r() < 0.1 ? 'NULL' : String(Math.floor(r() * 30)));
  const txt = (): string => pick(r, ["'a'", "'b'", "'c'", 'NULL', "'zz'"]);
  const num = (): string => pick(r, ['1.5', '50', '150', 'NULL', '-2.25', "'7'"]);
  const or = pick(r, ['', '', '', ' OR IGNORE', ' OR REPLACE']);
  if (k < 0.45) {
    const n = 1 + Math.floor(r() * 3);
    const rows = Array.from({ length: n }, () => (r() < 0.5 ? `(${key()}, ${key()}, ${txt()}, ${num()})` : `(NULL, ${key()}, ${txt()}, ${num()})`));
    if (r() < 0.2) return `INSERT${or} INTO w(k, n) VALUES (${key()}, ${num()})`;
    return `INSERT${or} INTO w VALUES ${rows.join(', ')}`;
  }
  if (k < 0.75) {
    const set = pick(r, [`k = ${key()}`, `v = ${txt()}`, `n = ${num()}`, 'k = k + 1', "v = v || 'x'", `id = id + ${Math.floor(r() * 5)}`, 'n = n * 2']);
    return `UPDATE${or} w SET ${set} WHERE ${pick(r, [`id = ${key()}`, `k > ${key()}`, `v = ${txt()}`, 'n IS NULL', `id BETWEEN ${key()} AND ${key()}`, '1'])}`;
  }
  if (k < 0.95) return `DELETE FROM w WHERE ${pick(r, [`id = ${key()}`, `k < ${key()}`, `v = ${txt()}`, 'n > 10', `id IN (${key()}, ${key()})`])}`;
  return 'DELETE FROM w';
}

describe('differential DML vs SQLite', () => {
  for (const seed of [1, 2, 3]) {
    it(`random writes leave identical tables (seed ${seed})`, () => {
      const r = rng(seed * 104729);
      const lite = new sqlite3.oo1.DB(':memory:');
      const smalt = Database.openFile(new MemoryVfs().openSync('w.db'));
      lite.exec(DML_SCHEMA);
      smalt.exec(DML_SCHEMA.replaceAll(' STRICT', ''));
      const steps = Number(process.env.DIFF_DML ?? 600);
      for (let i = 0; i < steps; i++) {
        const sql = genDml(r);
        let ea: string | null = null;
        let eb: string | null = null;
        try {
          lite.exec(sql);
        } catch (e) {
          ea = (e as Error).message;
        }
        try {
          smalt.exec(sql);
        } catch (e) {
          eb = (e as Error).message;
        }
        if ((ea === null) !== (eb === null)) throw new Error(`${sql}\n  sqlite: ${ea ?? 'ok'}\n  smalt: ${eb ?? 'ok'}`);
        const q = 'SELECT id, k, v, n FROM w ORDER BY id';
        const a = rowsCanon(lite.selectArrays(q), true);
        const b = rowsCanon(smalt.query(q).rows, true);
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          throw new Error(`after: ${sql}\n  sqlite: ${JSON.stringify(a.slice(0, 8))}\n  smalt:  ${JSON.stringify(b.slice(0, 8))}`);
        }
      }
      expect(smalt.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
    });
  }
});

describe('arithmetic edge cases vs SQLite (code generation and closure paths)', () => {
  it('agrees on overflow, division, modulo, signs and mixed types', () => {
    const lite = new sqlite3.oo1.DB(':memory:');
    const smalt = Database.openFile(new MemoryVfs().openSync('e.db'));
    const ddl = 'CREATE TABLE e(i INTEGER, j INTEGER, x REAL, y REAL, t TEXT, a ANY)';
    lite.exec(ddl + ' STRICT');
    smalt.exec(ddl);
    const ints = ['9223372036854775807', '-9223372036854775808', '9007199254740993', '9007199254740992', '-9007199254740993', '4611686018427387904', '2147483648', '-2147483648', '7', '-7', '3', '-1', '1', '0', 'NULL'];
    const reals = ['0.5', '-0.0', '1e308', '-1e308', '3.5', '2.0', 'NULL'];
    const texts = ["'12'", "'3.5'", "'abc'", "'-4x'", "''", 'NULL'];
    const r = rng(99);
    for (let n = 0; n < 120; n++) {
      // ANY column: no integral REALs (known limitation, ADR 0003: they read back as INTEGER).
      const anyVals = [...ints, '0.5', '-2.25', '3.5', ...texts];
      const row = `(${pick(r, ints)}, ${pick(r, ints)}, ${pick(r, reals)}, ${pick(r, reals)}, ${pick(r, texts)}, ${pick(r, anyVals)})`;
      lite.exec(`INSERT INTO e VALUES ${row}`);
      smalt.exec(`INSERT INTO e VALUES ${row}`);
    }
    const exprs: string[] = [];
    for (const op of ['+', '-', '*', '/', '%']) {
      for (const [l, rr] of [['i', 'j'], ['i', 'x'], ['x', 'y'], ['i', 't'], ['t', 'j'], ['a', 'i'], ['a', 'x'], ['i', '2'], ['i', '-1'], ['x', '0'], ['i', '0'], ['j', '3.0']]) {
        exprs.push(`${l} ${op} ${rr}`, `-(${l} ${op} ${rr})`, `(${l} ${op} ${rr}) ${pick(r, ['<', '=', '>=', '!='])} 0`);
      }
    }
    exprs.push('i * j * 2', '(i + j) / 2', 'i % 3 = 1 AND x > 0', 'NOT (i > j) OR x IS NULL', '-i', '- x', 'i - -j');
    const failures: string[] = [];
    for (const ex of exprs) {
      const sql = `SELECT ${ex} FROM e`;
      let a: unknown;
      let b: unknown;
      try {
        a = rowsCanon(lite.selectArrays(sql), true);
      } catch (e) {
        a = 'ERR ' + (e as Error).message;
      }
      try {
        b = rowsCanon(smalt.query(sql).rows, true);
      } catch (e) {
        b = 'ERR ' + (e as Error).message;
      }
      if (typeof a === 'string' || typeof b === 'string') {
        if ((typeof a === 'string') !== (typeof b === 'string')) failures.push(`${ex}: sqlite=${String(a).slice(0, 80)} smalt=${String(b).slice(0, 80)}`);
        continue;
      }
      const sa = a as string[];
      const sb = b as string[];
      const diff = sa.findIndex((v, i) => v !== sb[i]);
      if (diff >= 0 || sa.length !== sb.length) failures.push(`${ex}: row ${diff}: sqlite=${sa[diff]} smalt=${sb[diff]}`);
    }
    if (failures.length) throw new Error(`${failures.length} mismatches:\n${failures.slice(0, 15).join('\n')}`);
  });
});
