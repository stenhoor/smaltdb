import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const COLS = 'id INTEGER PRIMARY KEY, g INT, s TEXT, x REAL, b BLOB';

/** A columnar table `c` and a row table `r` with the same rows, for comparing results. */
async function setup(rows = 20000, vfs = new MemoryVfs()) {
  const db = await Database.open(vfs, 'db', { walAutoCheckpointBytes: 1 << 30 });
  db.exec(`CREATE TABLE c(${COLS}) WITH (storage = 'columnar')`);
  db.exec(`CREATE TABLE r(${COLS})`);
  both(db, `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows})
    INSERT INTO T SELECT i, (i * 7919) % 101, CASE WHEN i % 11 = 0 THEN NULL ELSE 's' || (i % 37) END, i / 4.0, CASE WHEN i % 5 = 0 THEN x'00ff' END FROM n`);
  return { vfs, db };
}

/** Run `sql` (with `T` as the table) on both tables. */
function both(db: Database, sql: string, params: unknown[] = []): void {
  db.run(sql.replace(/\bT\b/g, 'c'), params as never);
  db.run(sql.replace(/\bT\b/g, 'r'), params as never);
}

/** `sql` (with `T`) gives the same rows on both tables. */
function same(db: Database, sql: string, sortRows = false): unknown[][] {
  const norm = (rows: unknown[][]) => (sortRows ? [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)) : rows);
  const a = norm(db.query(sql.replace(/\bT\b/g, 'c')).rows);
  const b = norm(db.query(sql.replace(/\bT\b/g, 'r')).rows);
  expect(a).toEqual(b);
  return a;
}

const segRows = (db: Database): number => (db.query("SELECT count(*) FROM c").rows[0]![0] as number) - delta(db);
const delta = (db: Database): number => {
  const t = (db as unknown as { tables: Map<string, { rootPage: number }> }).tables.get('c')!;
  return (db as unknown as { tree(root: number): { count(): number } }).tree(t.rootPage).count();
};

const QUERIES = [
  'SELECT count(*), sum(g), avg(x), min(s), max(s), count(b), total(x) FROM T',
  'SELECT g, count(*), sum(x), max(s) FROM T GROUP BY g ORDER BY g',
  'SELECT g, count(*) FROM T WHERE x BETWEEN 100 AND 2000 AND s IS NOT NULL GROUP BY g ORDER BY g',
  'SELECT * FROM T WHERE id IN (1, 77, 8192, 8193, 16384, 19999, 20000, 25000) ORDER BY id',
  'SELECT * FROM T WHERE id = 12345',
  'SELECT id, s FROM T WHERE g = 7 ORDER BY id',
  'SELECT s, count(*) FROM T GROUP BY s HAVING count(*) > 10 ORDER BY 1',
  'SELECT count(*) FROM T WHERE id > 15000',
  'SELECT T.id, u.id FROM T JOIN T AS u ON u.id = T.id + 1 WHERE T.id % 1000 = 0 ORDER BY 1',
];

describe('columnar tables', () => {
  it('compact inserts into row groups and answer like a row table', async () => {
    const { db } = await setup();
    expect(segRows(db)).toBe(16384); // two full row groups; the rest stays in the delta store
    expect(delta(db)).toBe(20000 - 16384);
    for (const q of QUERIES) same(db, q);
    same(db, 'SELECT * FROM T ORDER BY id');
    const plan = db.query('EXPLAIN QUERY PLAN SELECT g, sum(x) FROM c WHERE x > 10 GROUP BY g').rows.map((r) => r[3]).join(' | ');
    expect(plan).toMatch(/columnar table/);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('update and delete rows in the segments and in the delta store', async () => {
    const { db } = await setup();
    both(db, 'UPDATE T SET s = upper(s), x = x * 2 WHERE g < 10'); // segment rows move to the delta
    both(db, 'DELETE FROM T WHERE id % 7 = 0');
    both(db, 'UPDATE T SET id = id + 100000 WHERE id BETWEEN 8000 AND 8100'); // rowid changes
    both(db, "INSERT INTO T(g, s) VALUES (5, 'new'), (6, 'newer')");
    both(db, 'DELETE FROM T WHERE id IN (1, 2, 3, 19999)');
    for (const q of QUERIES) same(db, q);
    same(db, 'SELECT * FROM T ORDER BY id');
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('enforce rowid uniqueness across segments and delta', async () => {
    const { db } = await setup();
    expect(() => db.run('INSERT INTO c(id, g) VALUES (5, 1)')).toThrow(/UNIQUE|constraint/i);
    expect(() => db.run('INSERT INTO c(id, g) VALUES (19000, 1)')).toThrow(/UNIQUE|constraint/i);
    both(db, "INSERT OR REPLACE INTO T(id, g, s) VALUES (5, -1, 'replaced'), (19000, -2, 'replaced')");
    both(db, 'INSERT OR IGNORE INTO T(id, g) VALUES (6, -3)');
    // A deleted segment rowid can be reused.
    both(db, 'DELETE FROM T WHERE id = 100');
    both(db, "INSERT INTO T(id, g, s) VALUES (100, 42, 'again')");
    same(db, 'SELECT * FROM T WHERE id IN (5, 6, 100, 19000) ORDER BY id');
    expect(db.query('SELECT max(id) FROM c').rows).toEqual([[20000]]);
    both(db, 'INSERT INTO T(g) VALUES (1)');
    same(db, 'SELECT max(id) FROM T');
  });

  it('rewrite segments when deletions pile up, on PRAGMA compact, and on DELETE without WHERE', async () => {
    const { vfs, db } = await setup();
    both(db, 'DELETE FROM T WHERE id <= 9000');
    expect(segRows(db) + delta(db)).toBe(11000);
    same(db, 'SELECT * FROM T ORDER BY id');
    both(db, 'UPDATE T SET g = 0 WHERE id % 2 = 0');
    db.exec('PRAGMA compact(c)');
    expect(delta(db)).toBe(0);
    same(db, 'SELECT * FROM T ORDER BY id');
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
    db.close();
    const again = await Database.open(vfs, 'db');
    same(again, 'SELECT * FROM T ORDER BY id');
    expect(again.run('DELETE FROM c').changes).toBe(11000);
    again.exec('DELETE FROM r');
    expect(again.query('SELECT count(*) FROM c').rows).toEqual([[0]]);
    both(again, "INSERT INTO T VALUES (1, 1, 'a', 1.5, NULL)");
    same(again, 'SELECT * FROM T');
    expect(again.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('roll back writes and compactions with the transaction', async () => {
    const { db } = await setup();
    const before = db.query('SELECT count(*), sum(x) FROM c').rows;
    db.exec('BEGIN');
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000) INSERT INTO c(g, x) SELECT i, i FROM n');
    db.exec('DELETE FROM c WHERE id < 5000');
    expect(db.query('SELECT count(*) FROM c').rows).toEqual([[25001]]);
    db.exec('ROLLBACK');
    expect(db.query('SELECT count(*), sum(x) FROM c').rows).toEqual(before);
    same(db, 'SELECT * FROM T ORDER BY id');
    // A failing statement after a compaction-sized insert leaves nothing behind.
    expect(() => db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 9000) INSERT INTO c(id, g) SELECT CASE WHEN i = 9000 THEN 1 ELSE 30000 + i END, i FROM n')).toThrow(/UNIQUE|constraint/i);
    same(db, 'SELECT * FROM T ORDER BY id');
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('are visible to snapshot readers, also across rewrites', async () => {
    const vfs = new MemoryVfs();
    const w = await Database.open(vfs, 'db', { sharedHandles: true, walAutoCheckpointBytes: 1 << 30 });
    w.exec(`CREATE TABLE c(${COLS}) WITH (storage = 'columnar')`);
    w.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000) INSERT INTO c(id, g) SELECT i, i % 3 FROM n');
    const r = await Database.openReader(vfs, 'db');
    expect(r.query('SELECT count(*), sum(g) FROM c').rows).toEqual([[10000, 10000]]);
    w.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000) INSERT INTO c(g) SELECT 1 FROM n');
    w.exec('DELETE FROM c WHERE id <= 100');
    r.refreshSnapshot();
    expect(r.query('SELECT count(*) FROM c').rows).toEqual([[19900]]);
    w.exec('PRAGMA compact(c)');
    r.refreshSnapshot();
    expect(r.query('SELECT count(*), min(id) FROM c').rows).toEqual([[19900, 101]]);
  });

  it('can be renamed: segments, delta rows and deletions move with them, and stay after a reopen (#193)', async () => {
    const { vfs, db } = await setup(20000);
    db.exec('PRAGMA compact(c)');
    both(db, 'INSERT INTO T SELECT id + 100000, g, s, x, b FROM T WHERE id <= 50'); // delta rows
    both(db, 'DELETE FROM T WHERE id % 1000 = 0'); // deletions
    const before = same(db, 'SELECT count(*), sum(g), min(id), max(id), count(s) FROM T');
    db.exec('ALTER TABLE c RENAME TO c2');
    expect(() => db.query('SELECT 1 FROM c')).toThrow(/no such table/);
    expect(db.query('SELECT count(*), sum(g), min(id), max(id), count(s) FROM c2').rows).toEqual(before);
    expect(db.query('SELECT name FROM smalt_columnar').rows).toEqual([['c2']]);
    expect(db.catalog.table('c2')?.storage).toBe('columnar');
    // Written, deleted from and compacted under its new name.
    db.exec("INSERT INTO c2 VALUES (500000, 1, 'z', 1.5, NULL)");
    db.exec('DELETE FROM c2 WHERE id = 7');
    db.exec('PRAGMA compact(c2)');
    expect(db.query('SELECT count(*) FROM c2').rows).toEqual([[before[0]![0] as number]]);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
    db.close();
    const again = await Database.open(vfs, 'db');
    expect(again.query('SELECT count(*), max(id) FROM c2').rows).toEqual([[before[0]![0] as number, 500000]]);
    expect(again.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
    // The schema operation, as the issue has it: a columnar table renamed through alterTable.
    again.queryPlan({ kind: 'schema', op: { op: 'createTable', temp: false, ifNotExists: false, table: { name: 't', storage: 'columnar', columns: [{ name: 'v', declaredType: 'INTEGER', type: 'INTEGER', notNull: false, collation: 'binary' }], keys: [], checks: [], foreignKeys: [] } } } as never);
    again.queryPlan({ kind: 'schema', op: { op: 'alterTable', table: 't', action: { kind: 'renameTable', newName: 'u' } } } as never);
    expect(again.catalog.table('u')?.storage).toBe('columnar');
    again.close();
  });

  it('reject what they do not support', async () => {
    const db = Database.openMemory();
    expect(() => db.exec("CREATE TABLE a(x UNIQUE) WITH (storage = 'columnar')")).toThrow(/UNIQUE/);
    expect(() => db.exec("CREATE TABLE a(x) WITH (storage = 'other')")).toThrow(/storage/);
    expect(() => db.exec("CREATE TABLE a(x) WITH (shape = 'columnar')")).toThrow(/unknown table option/);
    db.exec("CREATE TABLE a(id INTEGER PRIMARY KEY, x) WITH (storage = 'columnar')");
    expect(() => db.exec('CREATE INDEX ax ON a(x)')).toThrow(/cannot be indexed/);
    expect(() => db.exec('ALTER TABLE a ADD COLUMN y')).toThrow(/columnar table a yet, except RENAME TO/);
    expect(() => db.exec('ALTER TABLE a RENAME COLUMN x TO y')).toThrow(/columnar/);
    expect(() => db.exec('ALTER TABLE a DROP COLUMN x')).toThrow(/columnar/);
    expect(() => db.exec('CREATE TABLE child(a_id REFERENCES a(id))')).toThrow(/columnar/);
    expect(() => db.exec('CREATE TEMP TABLE t2(x) WITH (storage = \'columnar\')')).toThrow(/TEMP/);
    db.exec('INSERT INTO a(x) VALUES (1), (2)');
    expect(db.query('SELECT sum(x) FROM a').rows).toEqual([[3]]);
    db.exec('DROP TABLE a');
    expect(db.query('SELECT count(*) FROM smalt_columnar').rows).toEqual([[0]]);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });
});
