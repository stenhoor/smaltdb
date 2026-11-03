import sqliteInit from '@sqlite.org/sqlite-wasm';
import { beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

let lite: { exec(s: string): void; selectArrays(s: string): unknown[][] };
beforeAll(async () => {
  const s3 = (await (sqliteInit as unknown as (o: object) => Promise<{ oo1: { DB: new (n: string) => typeof lite } }>)({ print() {}, printErr() {} }));
  lite = new s3.oo1.DB(':memory:');
});

describe('fused scan + filter + aggregate', () => {
  it('uses the fused operator and matches SQLite, including overflow cells, NULLs and FILTER', () => {
    const d = Database.openFile(new MemoryVfs().openSync('f.db'), { pageSize: 1024 });
    const ddl = 'CREATE TABLE t(id INTEGER PRIMARY KEY, b INT, c REAL, s TEXT, big TEXT)';
    d.exec(ddl);
    lite.exec(ddl + ' STRICT');
    const rows: string[] = [];
    for (let i = 1; i <= 3000; i++) {
      const b = i % 11 === 0 ? 'NULL' : String((i * 37) % 1000 - 500);
      const c = i % 13 === 0 ? 'NULL' : String(((i * 7919) % 1000) / 8);
      const big = i % 97 === 0 ? `'${'x'.repeat(2000 + i)}'` : 'NULL'; // forces overflow cells (slow path)
      rows.push(`(${i}, ${b}, ${c}, 'k${i % 7}', ${big})`);
    }
    for (let i = 0; i < rows.length; i += 500) {
      const sql = `INSERT INTO t VALUES ${rows.slice(i, i + 500).join(',')}`;
      d.exec(sql);
      lite.exec(sql);
    }
    const queries = [
      'SELECT count(*), count(b), sum(b), total(c), avg(c), min(b), max(c) FROM t',
      'SELECT count(*), sum(b * 2 + id), avg(c * 1.1) FROM t WHERE b % 7 = 3 AND c < 90',
      'SELECT sum(b) FILTER (WHERE c > 50), count(*) FILTER (WHERE b IS NULL), max(s) FROM t WHERE b > -480',
      'SELECT count(*), sum(length(big)) FROM t WHERE big IS NOT NULL',
      "SELECT min(s), max(s), count(*) FROM t WHERE s > 'k3' OR b < -400",
      'SELECT sum(b) / count(*), avg(b) FROM t WHERE c IS NULL',
      'SELECT count(*), sum(b) FROM t WHERE 0',
    ];
    for (const q of queries) {
      const plan = d.query('EXPLAIN QUERY PLAN ' + q).rows.map((r) => r[3]).join(' ');
      if (!process.env.SMALT_NO_CODEGEN) expect(plan, q).toMatch(/fused/);
      const norm = (rs: unknown[][]) => JSON.stringify(rs.map((r) => r.map((v) => (typeof v === 'number' && !Number.isInteger(v) ? v.toPrecision(12) : typeof v === 'bigint' ? Number(v) : v))));
      expect(norm(d.query(q).rows), q).toBe(norm(lite.selectArrays(q)));
    }
    d.exec('DELETE FROM t');
    expect(d.query('SELECT count(*), sum(b), avg(c), min(b) FROM t WHERE b > 0').rows).toEqual([[0, null, null, null]]);
  });
});

describe('fused scan + filter and fused GROUP BY', () => {
  it('match SQLite across batches, pages, LIMIT, correlation, NULL/NOCASE/multi-column keys; no leaked pins', () => {
    const d = Database.openFile(new MemoryVfs().openSync('g.db'), { pageSize: 1024 });
    const ddl = 'CREATE TABLE g(id INTEGER PRIMARY KEY, k INT, t TEXT COLLATE NOCASE, x REAL, big TEXT)';
    d.exec(ddl);
    lite.exec(ddl + ' STRICT');
    const words = ['apple', 'Apple', 'APPLE', 'pear', 'Pear', 'fig', null];
    const rows: string[] = [];
    for (let i = 1; i <= 5000; i++) {
      const k = i % 17 === 0 ? 'NULL' : String(i % 23);
      const t = words[i % words.length];
      const x = i % 19 === 0 ? 'NULL' : String((i % 101) / 4);
      const big = i % 211 === 0 ? `'${'y'.repeat(1500)}'` : 'NULL';
      rows.push(`(${i}, ${k}, ${t === null ? 'NULL' : `'${t}'`}, ${x}, ${big})`);
    }
    for (let i = 0; i < rows.length; i += 500) {
      const sql = `INSERT INTO g VALUES ${rows.slice(i, i + 500).join(',')}`;
      d.exec(sql);
      lite.exec(sql);
    }
    // Which spelling represents a NOCASE group is unspecified (first row in each engine's processing order).
    const norm = (rs: unknown[][]) =>
      rs.map((r) => r.map((v) => (typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(10)) : typeof v === 'bigint' ? Number(v) : typeof v === 'string' ? v.toLowerCase() : v)));
    const sorted = (rs: unknown[][]) => JSON.stringify(norm(rs).map((r) => JSON.stringify(r)).sort());
    const cases: [string, RegExp, boolean][] = [
      ['SELECT id, k * 2 + 1, x FROM g WHERE k % 3 = 1 AND x < 20', /fused scan \+ filter\)/, false],
      ['SELECT id, length(big) FROM g WHERE big IS NOT NULL', /fused scan \+ filter\)/, false],
      ['SELECT id FROM g WHERE x > 10 ORDER BY id LIMIT 7', /fused scan \+ filter\)/, true],
      ['SELECT id FROM g WHERE k = 5 LIMIT 3 OFFSET 40', /fused scan \+ filter\)/, false],
      ['SELECT DISTINCT t FROM g WHERE x >= 0', /fused scan \+ filter\)/, false],
      ['SELECT k, count(*), sum(x), avg(id) FROM g GROUP BY k', /GROUP BY\)/, false],
      ['SELECT t, count(*), max(id) FROM g WHERE x IS NOT NULL GROUP BY t', /GROUP BY\)/, false],
      ['SELECT k % 4, t, count(*), total(x) FROM g GROUP BY k % 4, t', /GROUP BY\)/, false],
      ['SELECT k, count(*) FILTER (WHERE x > 5), min(x) FROM g WHERE k > 10 GROUP BY k HAVING count(*) > 100', /GROUP BY\)/, false],
      ['SELECT k, sum(length(big)) FROM g GROUP BY k', /GROUP BY\)/, false],
      ['SELECT g1.id, (SELECT count(*) FROM g AS g2 WHERE g2.k = g1.k AND g2.id < g1.id) FROM g AS g1 WHERE g1.id % 500 = 0', /fused/, false],
    ];
    for (const [q, plan, ordered] of cases) {
      const p = d.query('EXPLAIN QUERY PLAN ' + q).rows.map((r) => r[3]).join(' | ');
      if (!process.env.SMALT_NO_CODEGEN) expect(p, q).toMatch(plan);
      const a = d.query(q).rows;
      const b = lite.selectArrays(q);
      if (ordered) expect(JSON.stringify(norm(a)), q).toBe(JSON.stringify(norm(b)));
      else expect(sorted(a), q).toBe(sorted(b));
      expect(d.pager.pinnedCount(), `pins after ${q}`).toBe(0);
    }
    // A cursor abandoned mid-scan must release its pinned leaf.
    const st = d.prepare('SELECT id FROM g WHERE k = 1');
    const c = st.cursor();
    expect(c.next()).not.toBeNull();
    c.close();
    expect(d.pager.pinnedCount()).toBe(0);
  });
});

describe('raw-byte prefilter for text = literal', () => {
  it('matches SQLite for NULLs, empty, multi-byte, long literals and non-BINARY collations', () => {
    const d = Database.openFile(new MemoryVfs().openSync('p.db'), { pageSize: 1024 });
    const ddl = 'CREATE TABLE p(id INTEGER PRIMARY KEY, s TEXT, n TEXT COLLATE NOCASE, k INT, big TEXT)';
    d.exec(ddl);
    lite.exec(ddl + ' STRICT');
    const vals = ["'abc'", "'ABC'", "''", 'NULL', "'héllo'", "'日本語'", "'😀x'", `'${'long-string-'.repeat(3)}'`, `'${'long-string-'.repeat(3)}!'`, "'abc '"];
    const rows: string[] = [];
    for (let i = 1; i <= 800; i++) {
      const big = i % 50 === 0 ? `'${'y'.repeat(1500)}'` : 'NULL'; // overflow cells take the slow path
      rows.push(`(${i}, ${vals[i % vals.length]}, ${vals[(i * 3) % vals.length]}, ${i % 5}, ${big})`);
    }
    const ins = `INSERT INTO p VALUES ${rows.join(',')}`;
    d.exec(ins);
    lite.exec(ins);
    const lits = ["'abc'", "''", "'héllo'", "'日本語'", "'😀x'", `'${'long-string-'.repeat(3)}'`, "'nope'", "'ABC'"];
    for (const lit of lits) {
      for (const q of [
        `SELECT id, s FROM p WHERE s = ${lit}`,
        `SELECT id FROM p WHERE ${lit} = s AND k > 1`,
        `SELECT count(*) FROM p WHERE s = ${lit}`,
        `SELECT k, count(*) FROM p WHERE s = ${lit} GROUP BY k`,
        `SELECT id FROM p WHERE n = ${lit}`, // NOCASE column: no byte prefilter
        `SELECT id FROM p WHERE s = ${lit} COLLATE NOCASE`,
        `SELECT id FROM p WHERE s = ${lit} OR k = 0`,
      ]) {
        const a = JSON.stringify(lite.selectArrays(q).map(String).sort());
        const b = JSON.stringify(d.query(q).rows.map(String).sort());
        expect(b, q).toBe(a);
      }
    }
  });
});

describe('fused pipelines over bound expressions', () => {
  it('leave subqueries to the operators and fuse the rest', () => {
    const d = Database.openFile(new MemoryVfs().openSync('a.db'), {});
    d.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, b INT, s TEXT)');
    d.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 500) INSERT INTO t SELECT i, i % 17, 'k' || (i % 5) FROM n");
    const plan = (q: string) => d.query('EXPLAIN QUERY PLAN ' + q).rows.map((r) => r[3]).join(' ');
    const grouped = "SELECT b * 2, count(*) FROM t WHERE b > 3 AND s <> 'k1' GROUP BY b * 2";
    expect(plan(grouped)).toMatch(/fused scan \+ filter \+ GROUP BY/);
    expect(d.query(grouped).rows.length).toBe(13);
    const sub = 'SELECT id FROM t WHERE b = (SELECT max(b) FROM t)';
    expect(plan(sub)).not.toMatch(/SCAN t \(fused/);
    expect(d.query(sub).rows.length).toBe(d.query('SELECT id FROM t WHERE b = 16').rows.length);
  });
});
