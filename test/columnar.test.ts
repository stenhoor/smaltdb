import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import type { SqlValue } from '../src/engine/values.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

/** A table exercising every chunk encoding over several row groups (8192 rows each). */
function setup(db: Database, n = 20000): void {
  db.exec(`CREATE TABLE src(id INTEGER PRIMARY KEY, small INT, big INT, r REAL, dict TEXT, plain TEXT, ci TEXT COLLATE NOCASE, bl BLOB, mixed ANY, sparse INT)`);
  const ins = db.prepare('INSERT INTO src VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  db.exec('BEGIN');
  for (let i = 1; i <= n; i++) {
    const mixed: SqlValue = i % 5 === 0 ? null : i % 5 === 1 ? i : i % 5 === 2 ? i + 0.5 : i % 5 === 3 ? 'm' + i : i % 97 === 0 ? 9007199254740993n : new Uint8Array([i & 255]);
    ins.run([i, i % 1000, i * 1000003, i / 7, 'k' + (i % 13), 'p' + i, i % 2 ? 'Abc' : 'aBC', i % 11 === 0 ? null : new Uint8Array([i & 255, 7]), mixed, i % 100 === 0 ? i : null]);
  }
  db.exec('COMMIT');
  db.exec("CREATE MATERIALIZED VIEW col WITH (storage = 'columnar') AS SELECT * FROM src");
}

const same = (db: Database, sql: string, params: SqlValue[] = []): void => {
  expect(db.query(sql.replaceAll('$T', 'col'), params).rows).toEqual(db.query(sql.replaceAll('$T', 'src'), params).rows);
};

describe('columnar materialized views', () => {
  it('return exactly the stored query results, for every encoding', () => {
    const db = Database.openMemory();
    setup(db);
    same(db, 'SELECT * FROM $T ORDER BY id');
    same(db, 'SELECT count(*), sum(small), sum(big), sum(r), min(dict), max(plain), count(bl), count(mixed), count(sparse) FROM $T');
    same(db, 'SELECT dict, count(*), avg(r) FROM $T GROUP BY dict ORDER BY dict');
    same(db, "SELECT typeof(mixed), count(*) FROM $T GROUP BY 1 ORDER BY 1");
    same(db, 'SELECT rowid, id FROM $T WHERE id % 4096 = 0 ORDER BY rowid');
  });

  it('prune row groups with zone maps and still filter exactly', () => {
    const db = Database.openMemory();
    setup(db);
    same(db, 'SELECT count(*), sum(r) FROM $T WHERE id BETWEEN ? AND ?', [100, 500]);
    same(db, 'SELECT count(*) FROM $T WHERE id > 19990 OR id < 3');
    same(db, "SELECT count(*) FROM $T WHERE plain = 'p12345'");
    same(db, "SELECT count(*) FROM $T WHERE ci = 'ABC'"); // NOCASE: no text pruning, still correct
    same(db, 'SELECT count(*) FROM $T WHERE sparse >= 19000');
    same(db, 'SELECT count(*) FROM $T WHERE big < 0');
    const plan = db.query('EXPLAIN QUERY PLAN SELECT count(*) FROM col WHERE id BETWEEN ? AND ?', [100, 500]).rows.flat().join(' ');
    expect(plan).toMatch(/columnar, zone maps: id >= \? AND id <= \?/);
    const rows = db.query('EXPLAIN ANALYZE SELECT count(*) FROM col WHERE id BETWEEN 100 AND 500').rows;
    const scan = rows.find((r) => String(r[2]).startsWith('SCAN col'))!;
    expect(scan[5]).toBe(8192); // one row group read out of three
  });

  it('join, sort and aggregate like any table', () => {
    const db = Database.openMemory();
    setup(db, 9000);
    db.exec('CREATE TABLE k(v INT); INSERT INTO k VALUES (1), (5), (999)');
    same(db, 'SELECT k.v, count(*) FROM k JOIN $T ON $T.small = k.v GROUP BY k.v ORDER BY k.v');
    same(db, 'SELECT id FROM $T ORDER BY r DESC LIMIT 5');
    same(db, 'SELECT count(DISTINCT dict) FROM $T');
  });

  it('refresh replaces the segments; failed refreshes and rollbacks keep the old ones', () => {
    const vfs = new MemoryVfs();
    let db = Database.openFile(vfs.openSync('c.db'), {}, vfs.openSync('c.db-wal'));
    setup(db, 3000);
    db.close();
    db = Database.openFile(vfs.openSync('c.db'), {}, vfs.openSync('c.db-wal'));
    same(db, 'SELECT count(*), sum(big) FROM $T');
    db.exec('DELETE FROM src WHERE id > 1000');
    db.exec('BEGIN');
    db.exec('REFRESH MATERIALIZED VIEW col');
    expect(db.query('SELECT count(*) FROM col').rows).toEqual([[1000]]);
    db.exec('ROLLBACK');
    expect(db.query('SELECT count(*) FROM col').rows).toEqual([[3000]]);
    db.exec('REFRESH MATERIALIZED VIEW CONCURRENTLY col');
    same(db, 'SELECT * FROM $T ORDER BY id');
    expect(() => db.exec('CREATE INDEX col_i ON col(id)')).toThrow(/cannot be indexed/);
    db.exec('REFRESH MATERIALIZED VIEW col WITH NO DATA');
    expect(() => db.query('SELECT * FROM col')).toThrow(/not been populated/);
    db.exec('REFRESH MATERIALIZED VIEW col');
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
    expect(db.query("SELECT storage, is_populated FROM information_schema.materialized_views").rows).toEqual([['columnar', 'YES']]);
  });

  it('handles empty results and all-NULL columns', () => {
    const db = Database.openMemory();
    db.exec("CREATE TABLE t(a INT, b TEXT); INSERT INTO t VALUES (NULL, NULL), (NULL, NULL)");
    db.exec("CREATE MATERIALIZED VIEW e WITH (storage = 'columnar') AS SELECT * FROM t WHERE a > 0");
    expect(db.query('SELECT count(*) FROM e').rows).toEqual([[0]]);
    db.exec("CREATE MATERIALIZED VIEW n WITH (storage = 'columnar') AS SELECT * FROM t");
    expect(db.query('SELECT count(*), count(a), max(b) FROM n').rows).toEqual([[2, 0, null]]);
    expect(db.query('SELECT count(*) FROM n WHERE a = 1').rows).toEqual([[0]]);
  });
});
