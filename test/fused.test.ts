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
