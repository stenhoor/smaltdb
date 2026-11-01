import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { SmaltError } from '../src/engine/errors.js';

/**
 * Interrupting a statement at its k-th interrupt check (k = 1, 2, …) must leave the database as
 * it was: no pinned pages, unchanged data, a passing integrity check, and a usable connection.
 */
function setup(): Database {
  const db = Database.openMemory({ pageSize: 1024 });
  db.exec(`CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, v REAL, s TEXT);
    CREATE INDEX t_g ON t(g);
    CREATE TABLE u(g INT, w TEXT);
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 6000)
      INSERT INTO t SELECT i, i % 37, i / 3.0, printf('row-%05d-%s', i, hex(i)) FROM n;
    INSERT INTO u SELECT g, 'u' || g FROM t WHERE id <= 37;
    CREATE MATERIALIZED VIEW mr AS SELECT g, count(*) AS n, sum(v) AS sv FROM t GROUP BY g;
    CREATE MATERIALIZED VIEW mc WITH (storage = 'columnar') AS SELECT * FROM t;`);
  return db;
}

const fingerprint = (db: Database): string => JSON.stringify([db.query('SELECT count(*), sum(g), sum(v), max(s) FROM t').rows, db.query('SELECT count(*) FROM u').rows, db.query('SELECT sum(n) FROM mr').rows, db.query('SELECT count(*), sum(v) FROM mc').rows, db.query("SELECT count(*) FROM sqlite_schema").rows]);

const STATEMENTS: [string, (db: Database) => unknown][] = [
  ['full scan', (db) => db.query('SELECT * FROM t WHERE s LIKE ?', ['%9%']).rows],
  ['fused aggregate', (db) => db.query('SELECT sum(v), count(*) FROM t WHERE g > 3').rows],
  ['index scan', (db) => db.query('SELECT sum(v) FROM t WHERE g BETWEEN 3 AND 9').rows],
  ['join + group', (db) => db.query('SELECT u.w, count(*) FROM t JOIN u ON u.g = t.g GROUP BY u.w').rows],
  ['sort', (db) => db.query('SELECT s FROM t ORDER BY v DESC LIMIT 5').rows],
  ['columnar aggregate', (db) => db.query('SELECT g, sum(v) FROM mc WHERE id > 100 GROUP BY g').rows],
  ['update', (db) => db.exec("UPDATE t SET s = s || 'x', g = g + 1 WHERE id % 3 = 0")],
  ['delete', (db) => db.exec('DELETE FROM t WHERE id % 5 = 0')],
  ['insert select', (db) => db.exec('INSERT INTO t(g, v, s) SELECT g, v, s FROM t WHERE id <= 2000')],
  ['create index', (db) => db.exec('CREATE INDEX t_s ON t(s)')],
  ['refresh row MV', (db) => db.exec('REFRESH MATERIALIZED VIEW mr')],
  ['refresh columnar MV', (db) => db.exec('REFRESH MATERIALIZED VIEW CONCURRENTLY mc')],
  ['transaction', (db) => db.exec("BEGIN; UPDATE t SET v = v + 1; DELETE FROM u; COMMIT")],
];

describe('interrupting statements', () => {
  for (const [name, run] of STATEMENTS) {
    it(`${name}: every interrupt point leaves the database unchanged`, () => {
      const db = setup();
      const before = fingerprint(db);
      const pager = (db as unknown as { pager: { pinnedCount(): number } }).pager;
      let interrupted = 0;
      for (let k = 1; k <= 40; k++) {
        let calls = 0;
        db.setInterruptCheck(() => {
          if (++calls === k) throw new SmaltError('SMALT_INTERRUPT', 'interrupted');
        });
        let threw = false;
        try {
          run(db);
        } catch (e) {
          threw = true;
          expect((e as SmaltError).code).toBe('SMALT_INTERRUPT');
        }
        db.setInterruptCheck(null);
        if (db.inTransaction) db.exec('ROLLBACK');
        expect(pager.pinnedCount()).toBe(0);
        if (!threw) break; // finished before the k-th check: all points covered
        interrupted++;
        expect(fingerprint(db)).toBe(before);
      }
      // Cached columnar chunks touch few pages: that statement may finish before any check.
      if (name !== 'columnar aggregate') expect(interrupted).toBeGreaterThan(0);
      expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
    });
  }
});
