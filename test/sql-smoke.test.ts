import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

function db() {
  return Database.openFile(new MemoryVfs().openSync('t.db'));
}

describe('SQL smoke', () => {
  it('creates, inserts, selects', () => {
    const d = db();
    d.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INT, score REAL);
            CREATE INDEX users_age ON users(age);`);
    d.run('INSERT INTO users(name, age, score) VALUES (?, ?, ?), (?, ?, ?)', ['ann', 30, 1.5, 'bob', 25, 2]);
    d.run("INSERT INTO users VALUES (10, 'cy', 41, NULL)");
    expect(d.query('SELECT id, name, age FROM users ORDER BY id').rows).toEqual([[1, 'ann', 30], [2, 'bob', 25], [10, 'cy', 41]]);
    expect(d.query('SELECT name FROM users WHERE age > 26 ORDER BY name').rows).toEqual([['ann'], ['cy']]);
    expect(d.query('SELECT count(*), sum(age), avg(score) FROM users').rows).toEqual([[3, 96, 1.75]]);
    expect(d.query('SELECT name FROM users WHERE id = 2').rows).toEqual([['bob']]);
    // Cost-based: a 3-row table is cheaper to scan than to probe through an index...
    expect(d.query('EXPLAIN QUERY PLAN SELECT name FROM users WHERE age = 30').rows.map((r) => r[3]).join()).toMatch(/SCAN users/);
    // ...but with many rows the index wins.
    d.exec('BEGIN');
    for (let i = 0; i < 3000; i++) d.run('INSERT INTO users(name, age) VALUES (?, ?)', ['u' + i, 100 + (i % 500)]);
    d.exec('COMMIT');
    expect(d.query('EXPLAIN QUERY PLAN SELECT name FROM users WHERE age = 30').rows.map((r) => r[3]).join()).toMatch(/INDEX users_age/);
    expect(d.query('SELECT name FROM users WHERE age = 30').rows).toEqual([['ann']]);
  });

  it('enforces constraints and rolls back failed statements', () => {
    const d = db();
    d.exec('CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT UNIQUE, c INT CHECK (c > 0))');
    d.run("INSERT INTO t VALUES (1, 'x', 5)");
    expect(() => d.run("INSERT INTO t VALUES (2, 'x', 5)")).toThrow(/UNIQUE constraint failed: t.b/);
    expect(() => d.run("INSERT INTO t VALUES (3, 'y', -1)")).toThrow(/CHECK constraint failed/);
    expect(() => d.run("INSERT INTO t VALUES (4, 'z', 'abc')")).toThrow(/cannot store TEXT value in INTEGER column t.c/);
    // Multi-row insert that fails part way leaves nothing behind.
    expect(() => d.run("INSERT INTO t VALUES (5, 'p', 1), (6, 'x', 1)")).toThrow(/UNIQUE/);
    expect(d.query('SELECT a FROM t ORDER BY a').rows).toEqual([[1]]);
    d.run("INSERT OR REPLACE INTO t VALUES (7, 'x', 2)");
    expect(d.query('SELECT a, b FROM t').rows).toEqual([[7, 'x']]);
    expect(d.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('joins, groups, subqueries', () => {
    const d = db();
    d.exec(`CREATE TABLE a(id INTEGER PRIMARY KEY, g TEXT);
            CREATE TABLE b(id INTEGER PRIMARY KEY, a_id INT, v INT);
            INSERT INTO a VALUES (1,'x'),(2,'y'),(3,'x');
            INSERT INTO b(a_id, v) VALUES (1,10),(1,20),(2,5),(9,1);`);
    expect(d.query('SELECT a.id, b.v FROM a JOIN b ON b.a_id = a.id ORDER BY 1, 2').rows).toEqual([[1, 10], [1, 20], [2, 5]]);
    expect(d.query('SELECT a.id, b.v FROM a LEFT JOIN b ON b.a_id = a.id ORDER BY 1, 2').rows).toEqual([[1, 10], [1, 20], [2, 5], [3, null]]);
    expect(d.query('SELECT g, count(*), sum(v) FROM a LEFT JOIN b ON a_id = a.id GROUP BY g ORDER BY g').rows).toEqual([['x', 3, 30], ['y', 1, 5]]);
    expect(d.query('SELECT id FROM a WHERE id IN (SELECT a_id FROM b) ORDER BY id').rows).toEqual([[1], [2]]);
    expect(d.query('SELECT id, (SELECT max(v) FROM b WHERE a_id = a.id) FROM a ORDER BY id').rows).toEqual([[1, 20], [2, 5], [3, null]]);
    expect(d.query('SELECT id FROM a WHERE NOT EXISTS (SELECT 1 FROM b WHERE a_id = a.id)').rows).toEqual([[3]]);
    d.run('UPDATE b SET v = v * 2 WHERE a_id = 1');
    expect(d.query('SELECT sum(v) FROM b').rows).toEqual([[66]]);
    expect(d.run('DELETE FROM b WHERE v > 30').changes).toBe(1);
    expect(d.query('SELECT 1 + 2, 5 / 2, 5.0 / 2, 7 % 3, \'a\' || 1, typeof(1.0), typeof(1)').rows).toEqual([[3, 2, 2.5, 1, 'a1', 'real', 'integer']]);
  });

  it('persists across reopen', () => {
    const vfs = new MemoryVfs();
    const d = Database.openFile(vfs.openSync('p.db'));
    d.exec("CREATE TABLE t(x TEXT, y INT UNIQUE); INSERT INTO t VALUES ('a', 1), ('b', 2); CREATE INDEX tx ON t(x)");
    d.close();
    const d2 = Database.openFile(vfs.openSync('p.db'));
    expect(d2.query("SELECT y FROM t WHERE x = 'b'").rows).toEqual([[2]]);
    expect(d2.query('SELECT name FROM sqlite_schema ORDER BY name').rows).toEqual([['smalt_autoindex_t_1'], ['t'], ['tx']]);
  });

  it('supports explicit transactions', () => {
    const d = db();
    d.exec('CREATE TABLE t(x INT)');
    d.exec('BEGIN; INSERT INTO t VALUES (1); INSERT INTO t VALUES (2); ROLLBACK');
    expect(d.query('SELECT count(*) FROM t').rows).toEqual([[0]]);
    d.exec('BEGIN; INSERT INTO t VALUES (1)');
    expect(() => d.exec("INSERT INTO t VALUES ('bad')")).toThrow();
    d.exec('INSERT INTO t VALUES (3); COMMIT');
    expect(d.query('SELECT x FROM t ORDER BY x').rows).toEqual([[1], [3]]);
  });

  it('EXPLAIN ANALYZE reports loops, actual rows and estimates per operator, and leaves the plan reusable', () => {
    const d = db();
    d.exec('CREATE TABLE a(id INTEGER PRIMARY KEY, g INT); CREATE TABLE b(id INTEGER PRIMARY KEY, a_id INT); CREATE INDEX b_a ON b(a_id)');
    for (let i = 1; i <= 50; i++) d.exec(`INSERT INTO a VALUES (${i}, ${i % 5})`);
    for (let i = 1; i <= 200; i++) d.exec(`INSERT INTO b VALUES (${i}, ${(i % 50) + 1})`);
    const sql = 'SELECT a.id, b.id FROM a JOIN b ON b.a_id = a.id WHERE a.g = 1';
    const res = d.query('EXPLAIN ANALYZE ' + sql);
    expect(res.columns).toEqual(['id', 'parent', 'detail', 'est_rows', 'loops', 'rows', 'time_ms']);
    const byDetail = (re: RegExp) => res.rows.find((r) => re.test(String(r[2])))!;
    expect(byDetail(/\b(SCAN|SEARCH) a\b/)[4]).toBe(1);
    expect(byDetail(/\b(SCAN|SEARCH) b\b/)[4]).toBeGreaterThanOrEqual(1);
    // The filtered access to a (fused, or a FILTER over the scan) carries an estimate and 10 actual rows.
    expect(res.rows.some((r) => r[5] === 10 && typeof r[3] === 'number')).toBe(true);
    expect(res.rows[0][5]).toBe(40); // root produces the query's rows
    expect(res.rows.every((r) => typeof r[6] === 'number' && (r[6] as number) >= 0)).toBe(true);
    // Index nested loop: the inner side runs once per outer row.
    const point = d.query('EXPLAIN ANALYZE SELECT b.id FROM a JOIN b ON b.a_id = a.id WHERE a.id IN (3, 7)').rows;
    const inner = point.find((r) => /SEARCH b USING INDEX b_a/.test(String(r[2])))!;
    expect(inner[4]).toBe(2);
    expect(inner[5]).toBe(8);
    // The instrumented operators were restored: the same SQL still runs normally.
    expect(d.query(sql).rows.length).toBe(40);
    expect(d.query('EXPLAIN ANALYZE ' + sql).rows[0][5]).toBe(40);
  });
});
