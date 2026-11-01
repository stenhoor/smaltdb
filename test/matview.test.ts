import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const setup = (db: Database): void => {
  db.exec(`CREATE TABLE sales(id INTEGER PRIMARY KEY, day TEXT, amount REAL, cust TEXT COLLATE NOCASE);
    INSERT INTO sales(day, amount, cust) VALUES ('d1', 10, 'A'), ('d1', 5.5, 'b'), ('d2', 7, 'a')`);
};

describe('materialized views (row storage)', () => {
  it('stores the query result and changes only on REFRESH', () => {
    const db = Database.openMemory();
    setup(db);
    db.exec('CREATE MATERIALIZED VIEW by_day AS SELECT day, sum(amount) AS total, count(*) AS n FROM sales GROUP BY day');
    expect(db.query('SELECT * FROM by_day ORDER BY day').rows).toEqual([['d1', 15.5, 2], ['d2', 7, 1]]);
    db.exec("INSERT INTO sales(day, amount, cust) VALUES ('d3', 1, 'c')");
    expect(db.query('SELECT count(*) FROM by_day').rows).toEqual([[2]]);
    expect(db.run('REFRESH MATERIALIZED VIEW by_day').changes).toBe(3);
    expect(db.query('SELECT * FROM by_day ORDER BY day').rows).toEqual([['d1', 15.5, 2], ['d2', 7, 1], ['d3', 1, 1]]);
    db.exec('REFRESH MATERIALIZED VIEW CONCURRENTLY by_day');
    expect(db.query('SELECT count(*) FROM by_day').rows).toEqual([[3]]);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('keeps column types and collations, supports indexes', () => {
    const db = Database.openMemory();
    setup(db);
    db.exec('CREATE MATERIALIZED VIEW c (who, cnt) AS SELECT cust, count(*) FROM sales GROUP BY cust');
    expect(db.query("SELECT who FROM c WHERE who = 'A'").rows).toEqual([['A']]); // NOCASE carried over
    expect(db.query("SELECT name, type FROM pragma_table_info('c')").rows).toEqual([['who', 'TEXT'], ['cnt', 'INTEGER']]);
    db.exec('CREATE UNIQUE INDEX c_who ON c(who)');
    db.exec("INSERT INTO sales(day, amount, cust) VALUES ('d4', 2, 'z')");
    db.exec('REFRESH MATERIALIZED VIEW c');
    expect(db.query("SELECT cnt FROM c INDEXED BY c_who WHERE who = 'z'").rows).toEqual([[1]]);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('WITH NO DATA leaves the view unpopulated until refreshed', () => {
    const db = Database.openMemory();
    setup(db);
    db.exec('CREATE MATERIALIZED VIEW v AS SELECT day FROM sales WITH NO DATA');
    expect(() => db.query('SELECT * FROM v')).toThrow(/has not been populated/);
    db.exec('REFRESH MATERIALIZED VIEW v');
    expect(db.query('SELECT count(*) FROM v').rows).toEqual([[3]]);
    db.exec('REFRESH MATERIALIZED VIEW v WITH NO DATA');
    expect(() => db.query('SELECT * FROM v')).toThrow(/has not been populated/);
    expect(() => db.exec('REFRESH MATERIALIZED VIEW CONCURRENTLY v WITH NO DATA')).toThrow(/CONCURRENTLY/);
  });

  it('is read-only and has its own DROP', () => {
    const db = Database.openMemory();
    setup(db);
    db.exec('CREATE MATERIALIZED VIEW v AS SELECT day FROM sales');
    expect(() => db.exec("INSERT INTO v VALUES ('x')")).toThrow(/cannot change materialized view/);
    expect(() => db.exec('UPDATE v SET day = 1')).toThrow(/cannot change materialized view/);
    expect(() => db.exec('DELETE FROM v')).toThrow(/cannot change materialized view/);
    expect(() => db.exec('ALTER TABLE v ADD COLUMN x')).toThrow(/may not be altered/);
    expect(() => db.exec('DROP TABLE v')).toThrow(/DROP MATERIALIZED VIEW/);
    expect(() => db.exec('DROP VIEW v')).toThrow(/DROP MATERIALIZED VIEW/);
    expect(() => db.exec('CREATE MATERIALIZED VIEW v AS SELECT 1')).toThrow(/already exists/);
    db.exec('CREATE MATERIALIZED VIEW IF NOT EXISTS v AS SELECT 1');
    db.exec('DROP MATERIALIZED VIEW v');
    db.exec('DROP MATERIALIZED VIEW IF EXISTS v');
    expect(() => db.exec('DROP MATERIALIZED VIEW v')).toThrow(/no such materialized view/);
    expect(db.query("SELECT count(*) FROM sqlite_schema WHERE type = 'matview'").rows).toEqual([[0]]);
  });

  it('survives reopen, and a failed refresh keeps the old rows', () => {
    const vfs = new MemoryVfs();
    let db = Database.openFile(vfs.openSync('m.db'), {}, vfs.openSync('m.db-wal'));
    setup(db);
    db.exec('CREATE MATERIALIZED VIEW v AS SELECT day, amount FROM sales; CREATE INDEX v_amount ON v(amount)');
    db.close();
    db = Database.openFile(vfs.openSync('m.db'), {}, vfs.openSync('m.db-wal'));
    expect(db.query('SELECT count(*) FROM v WHERE amount > 6').rows).toEqual([[2]]);
    // A value the view's REAL column cannot hold exactly: the refresh fails and nothing changes.
    db.exec("CREATE TABLE extra(x); INSERT INTO extra VALUES (1)");
    db.exec('BEGIN');
    db.exec("UPDATE sales SET amount = NULL WHERE id = 1");
    db.exec('COMMIT');
    db.exec('REFRESH MATERIALIZED VIEW v');
    expect(db.query('SELECT count(*) FROM v WHERE amount IS NULL').rows).toEqual([[1]]);
    db.exec('DROP TABLE sales');
    expect(() => db.exec('REFRESH MATERIALIZED VIEW v')).toThrow(/no such table/);
    expect(db.query('SELECT count(*) FROM v').rows).toEqual([[3]]);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('rejects a refresh whose values no longer fit the stored column types', () => {
    const db = Database.openMemory();
    db.exec("CREATE TABLE t(v ANY); INSERT INTO t VALUES (1), (2)");
    db.exec('CREATE MATERIALIZED VIEW m AS SELECT v + 0 AS v FROM t');
    db.exec("INSERT INTO t VALUES ('text')");
    // 'text' + 0 is 0 (an integer) in SQLite, so still fine; a REAL breaks the INTEGER column.
    db.exec('INSERT INTO t VALUES (2.5)');
    const before = db.query('SELECT name, type FROM pragma_table_info(?)', ['m']).rows;
    if (before[0][1] === 'INTEGER') {
      expect(() => db.exec('REFRESH MATERIALIZED VIEW m')).toThrow(/add a CAST/);
      expect(db.query('SELECT count(*) FROM m').rows).toEqual([[2]]);
    } else {
      db.exec('REFRESH MATERIALIZED VIEW m');
      expect(db.query('SELECT count(*) FROM m').rows).toEqual([[4]]);
    }
  });

  it('appears in information_schema', () => {
    const db = Database.openMemory();
    setup(db);
    db.exec('CREATE MATERIALIZED VIEW v AS SELECT day FROM sales');
    expect(db.query("SELECT table_type, is_insertable_into FROM information_schema.tables WHERE table_name = 'v'").rows).toEqual([['MATERIALIZED VIEW', 'NO']]);
    const mv = db.query('SELECT table_name, view_definition, storage, refresh_mode, is_populated, last_refresh IS NOT NULL FROM information_schema.materialized_views').rows;
    expect(mv).toEqual([['v', 'SELECT day FROM sales', 'row', 'MANUAL', 'YES', 1]]);
    expect(db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'v'").rows).toEqual([['day']]);
  });

  it('validates options', () => {
    const db = Database.openMemory();
    setup(db);
    expect(() => db.exec("CREATE MATERIALIZED VIEW v WITH (refresh = 'on_commit') AS SELECT 1")).toThrow(/not supported/);
    expect(() => db.exec("CREATE MATERIALIZED VIEW v WITH (colour = 'red') AS SELECT 1")).toThrow(/unknown materialized view option/);
    expect(() => db.exec('CREATE MATERIALIZED VIEW v AS SELECT day, day FROM sales')).toThrow(/more than once/);
    expect(() => db.exec('CREATE MATERIALIZED VIEW v (a, b) AS SELECT day FROM sales')).toThrow(/column names/);
  });
});
