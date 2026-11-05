/**
 * Regression tests for the S2 findings of the M7 code review (docs/research/m7-code-review.md):
 * wrong results or errors in specific shapes.
 */
import { describe, expect, it } from 'vitest';
import { Database, type BindParams } from '../src/engine/database.js';
import { EngineServer, type PartialTask, type ReaderPool } from '../src/engine/server.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import type { Request, Response } from '../src/shared/protocol.js';
import { columnValue } from '../src/shared/protocol.js';
import { until } from './helpers/wait.js';
import type { SqlValue } from '../src/engine/values.js';

const fileDb = () => Database.open(new MemoryVfs(), 'db');

/** Morsels either decline the query or return exactly what a normal run returns. */
function morselsAgree(db: Database, sql: string, params?: BindParams): void {
  const want = db.query(sql, params);
  for (const parts of [2, 4]) {
    const got = db.queryMorsels(sql, params, parts);
    if (got) expect({ columns: got.columns, rows: got.rows }, `${sql} (${parts} parts)`).toEqual({ columns: want.columns, rows: want.rows });
  }
}

/** With matview_rewrite on, `sql` returns what it returns with rewrite off. */
function rewriteAgrees(db: Database, sql: string): void {
  db.exec('PRAGMA matview_rewrite = 0');
  const want = db.query(sql);
  db.exec('PRAGMA matview_rewrite = 1');
  const got = db.query(sql);
  expect({ columns: got.columns, rows: got.rows }, sql).toEqual({ columns: want.columns, rows: want.rows });
}

describe('S2 morsel and MV merges', () => {
  it('7: min/max over a NOCASE column', async () => {
    const db = await fileDb();
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, ci TEXT COLLATE NOCASE); INSERT INTO t VALUES (1, 0, 'b'), (2, 0, 'a'), (3, 1, 'B'), (4, 1, 'C')");
    morselsAgree(db, 'SELECT min(ci), max(ci) FROM t');
    morselsAgree(db, 'SELECT g, max(ci) FROM t GROUP BY g ORDER BY g');
    db.exec('CREATE MATERIALIZED VIEW mv AS SELECT g, max(ci) AS m FROM t GROUP BY g');
    rewriteAgrees(db, 'SELECT max(ci) FROM t');
  });

  it('8: an MV roll-up count over no matching rows is 0, not NULL', async () => {
    const db = await fileDb();
    db.exec('CREATE TABLE t(g INT, x INT); INSERT INTO t VALUES (1, 1), (2, NULL)');
    db.exec('CREATE MATERIALIZED VIEW mv AS SELECT g, count(*) AS n, count(x) AS cx, sum(x) AS s FROM t GROUP BY g');
    rewriteAgrees(db, 'SELECT count(*) FROM t WHERE g = 999');
    rewriteAgrees(db, 'SELECT count(x), count(*), sum(x) FROM t WHERE g > 5');
    db.exec('CREATE TABLE u(g INT); CREATE MATERIALIZED VIEW mu AS SELECT g, count(*) AS n FROM u GROUP BY g');
    rewriteAgrees(db, 'SELECT count(*) FROM u');
  });

  it('9: a user column named rowid', async () => {
    const db = await fileDb();
    db.exec('CREATE TABLE t(rowid INT, v INT)');
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) INSERT INTO t SELECT 1000000 + i, i FROM n');
    morselsAgree(db, 'SELECT sum(v), count(*) FROM t');
    db.exec("CREATE TABLE c(rowid INT, v INT) WITH (storage = 'columnar'); INSERT INTO c SELECT rowid, v FROM t");
    morselsAgree(db, 'SELECT sum(v), count(*) FROM c');
  });

  it('10: REAL results keep their type', async () => {
    const db = await fileDb();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, x REAL)');
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 100) INSERT INTO t SELECT i, i % 2, i * 2.0 FROM n');
    morselsAgree(db, "SELECT g, typeof(max(x)), typeof(sum(x)), min(x) || '', typeof(total(x)) FROM t GROUP BY g ORDER BY g");
  });

  it('11: HAVING names a table column that an output alias also names', async () => {
    const db = await fileDb();
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, a INT)');
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20) INSERT INTO t SELECT i, i % 2, i FROM n');
    morselsAgree(db, 'SELECT g, sum(a) AS a FROM t GROUP BY g HAVING a > 5 ORDER BY g');
    morselsAgree(db, 'SELECT g, sum(a) AS s FROM t GROUP BY g HAVING sum(a) > 100 ORDER BY g');
  });

  it('12: rewriting to a view keeps t.* and the query\'s column names', async () => {
    const db = await fileDb();
    db.exec('CREATE TABLE t(a INT, b TEXT); INSERT INTO t VALUES (1, \'x\'), (2, \'y\')');
    db.exec('CREATE MATERIALIZED VIEW mv AS SELECT * FROM t');
    rewriteAgrees(db, 'SELECT t.* FROM t ORDER BY a');
    rewriteAgrees(db, 'SELECT x.* FROM t AS x ORDER BY a');
    db.exec('CREATE TABLE t2(a INT, b TEXT); INSERT INTO t2 VALUES (3, \'z\'); CREATE MATERIALIZED VIEW mv2(p, q) AS SELECT * FROM t2');
    rewriteAgrees(db, 'SELECT * FROM t2');
  });
});

describe('S2 TEMP isolation', () => {
  it('13: ALTER TABLE on a TEMP table is rejected, and main.t is altered on its own', async () => {
    const db = await fileDb();
    db.exec('CREATE TEMP TABLE tmp(x INT); INSERT INTO tmp VALUES (9)');
    expect(() => db.exec('ALTER TABLE tmp ADD COLUMN y INT DEFAULT 3')).toThrow(/TEMP/);
    expect(() => db.exec('ALTER TABLE tmp RENAME TO tmp2')).toThrow(/TEMP/);
    expect(db.query('SELECT * FROM tmp').rows).toEqual([[9]]);
    db.exec('CREATE TABLE t(a INT); INSERT INTO t VALUES (1); CREATE TEMP TABLE t(a INT, b INT)');
    expect(() => db.exec('ALTER TABLE t ADD COLUMN c INT')).toThrow(/TEMP/);
    db.exec('ALTER TABLE main.t ADD COLUMN c INT DEFAULT 5');
    expect(db.query('SELECT * FROM main.t').rows).toEqual([[1, 5]]);
    expect(db.query("SELECT name FROM pragma_table_info('t')").rows.length).toBe(2); // the temp table is unchanged
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('14: persistent views cannot keep a TEMP table\'s rows', async () => {
    const vfs = new MemoryVfs();
    const db = await Database.open(vfs, 'db');
    db.exec('CREATE TEMP TABLE tt(x INT); INSERT INTO tt VALUES (1), (2)');
    expect(() => db.exec('CREATE MATERIALIZED VIEW m AS SELECT x FROM tt')).toThrow(/TEMP/);
    db.exec('CREATE VIEW vv AS SELECT x FROM tt'); // becomes a TEMP view, as in SQLite
    expect(db.query('SELECT count(*) FROM vv').rows).toEqual([[2]]);
    expect(db.query("SELECT count(*) FROM sqlite_schema WHERE name = 'vv'").rows).toEqual([[0]]);
    expect(() => db.exec('CREATE VIEW main.vm AS SELECT x FROM tt')).toThrow(/TEMP/);
    db.close();
    const again = await Database.open(vfs, 'db');
    expect(() => again.query('SELECT * FROM vv')).toThrow(/no such table/);
  });

  it('15: TEMP views are connection-local (never routed to parallel readers)', async () => {
    const db = await fileDb();
    db.exec('CREATE TABLE t(a INT); CREATE TEMP VIEW tv AS SELECT * FROM t');
    expect(db.prepare('SELECT * FROM tv').usesMemoryObjects).toBe(true);
    expect(db.prepare('SELECT * FROM t').usesMemoryObjects).toBe(false);
  });

  it('16: ANALYZE leaves TEMP tables out of the file\'s statistics', async () => {
    const vfs = new MemoryVfs();
    const db = await Database.open(vfs, 'db');
    db.exec('CREATE TABLE t(a INT, b INT)');
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000) INSERT INTO t SELECT i, i FROM n');
    db.exec('CREATE TEMP TABLE tmp(k INT); INSERT INTO tmp VALUES (1), (2), (3); CREATE INDEX tmp_k ON tmp(k)');
    db.exec('CREATE TEMP TABLE t(z INT); INSERT INTO t VALUES (7)');
    db.exec('ANALYZE');
    const stats = db.query('SELECT tbl, stat FROM smalt_stat WHERE idx IS NULL ORDER BY tbl').rows;
    expect(stats.map((r) => r[0])).toEqual(['t']);
    expect(JSON.parse(stats[0][1] as string).rows).toBe(1000);
    db.close();
    const again = await Database.open(vfs, 'db');
    expect(again.query('SELECT count(*) FROM smalt_stat WHERE tbl = \'tmp\'').rows).toEqual([[0]]);
  });

  it('17: a TEMP table does not hide the main table from information_schema', async () => {
    const db = await fileDb();
    db.exec('CREATE TABLE t(a INT, b INT); CREATE TEMP TABLE t(z INT)');
    expect(db.query("SELECT table_name FROM information_schema.tables WHERE table_name = 't'").rows).toEqual([['t']]);
    expect(db.query("SELECT column_name FROM information_schema.columns WHERE table_name = 't' ORDER BY ordinal_position").rows).toEqual([['a'], ['b']]);
  });

  it('19: a main index cannot take a TEMP index\'s name (or the reverse)', async () => {
    const db = await fileDb();
    db.exec('CREATE TEMP TABLE tt(a INT); CREATE INDEX i ON tt(a); CREATE TABLE m(a INT)');
    expect(() => db.exec('CREATE INDEX i ON m(a)')).toThrow(/already exists/);
    db.exec('CREATE INDEX j ON m(a)');
    expect(() => db.exec('CREATE INDEX j ON tt(a)')).toThrow(/already exists/);
    db.exec('DROP INDEX i');
    expect(db.query("SELECT count(*) FROM pragma_index_list('tt')").rows).toEqual([[0]]);
    expect(db.query("SELECT count(*) FROM pragma_index_list('m')").rows).toEqual([[1]]);
  });
});

describe('S2 columnar rowid space', () => {
  it('18: INSERT past the largest rowid picks a free random rowid (as SQLite) instead of wrapping', async () => {
    const db = await fileDb();
    db.exec("CREATE TABLE c(id INTEGER PRIMARY KEY, g INT) WITH (storage = 'columnar')");
    // 8192 rows in one statement: compaction moves them, the maximum included, into a row group.
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 8191) INSERT INTO c SELECT i, 0 FROM n');
    db.exec('INSERT INTO c VALUES (9223372036854775807, 1)');
    db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 8192) INSERT INTO c SELECT 10000 + i, 0 FROM n');
    expect(db.query('INSERT INTO c(g) VALUES (7) RETURNING id > 0 AND id <= 4611686018427387904').rows).toEqual([[1]]);
    expect(db.query('SELECT count(*), count(DISTINCT id), min(id) > 0 FROM c').rows).toEqual([[16385, 16385, 1]]);
  });
});

// ------------------------------------------------------------------ server (item 6)

class FakeReaders implements ReaderPool {
  busy = 0;
  failNext = false;
  constructor(private readonly readers: Database[]) {}
  dispatch(): boolean {
    return false;
  }
  forward(): boolean {
    return false;
  }
  idle(): number {
    return this.readers.length - this.busy;
  }
  partial(task: PartialTask, done: (err: string | null, rows: SqlValue[][] | null) => void): boolean {
    if (this.busy >= this.readers.length) return false;
    const r = this.readers[this.busy++];
    const fail = this.failNext;
    this.failNext = false;
    setTimeout(() => {
      this.busy--;
      if (fail) return done('reader failed', null);
      r.refreshSnapshot();
      done(null, r.runPartial(structuredClone(task)));
    }, 5);
    return true;
  }
}

async function server() {
  const vfs = new MemoryVfs();
  const db = await Database.open(vfs, 'db', { sharedHandles: true, walAutoCheckpointBytes: 1 << 30 });
  db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, g INT, x REAL)');
  db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 250000) INSERT INTO t SELECT i, i % 10, i / 2.0 FROM n');
  const readers = new FakeReaders(await Promise.all([1, 2, 3].map(() => Database.openReader(vfs, 'db'))));
  const log: { session: string; msg: Response }[] = [];
  const srv = new EngineServer((session, msg) => log.push({ session, msg }), { open: () => db, readers });
  let id = 1;
  const send = (session: string, body: Record<string, unknown>): number => {
    const rid = id++;
    srv.receive(session, { ...body, id: rid } as Request);
    return rid;
  };
  const of = (session: string, rid: number) => log.filter((m) => m.session === session && m.msg.id === rid).map((m) => m.msg);
  const kinds = (session: string, rid: number) => of(session, rid).map((m) => m.kind);
  const rows = (session: string, rid: number): unknown[][] => {
    const out: unknown[][] = [];
    for (const m of of(session, rid)) if (m.kind === 'batch') for (let i = 0; i < m.length; i++) out.push(m.cols.map((c) => columnValue(c, i)));
    return out;
  };
  const open = send(EngineServer.LOCAL, { op: 'open', name: 'db', storage: 'opfs' });
  await until('open', () => kinds(EngineServer.LOCAL, open).length > 0);
  return { db, srv, readers, send, of, kinds, rows };
}

const AGG = 'SELECT g, count(*), sum(x) FROM t GROUP BY g ORDER BY g';

describe('S2-6: server morsel scheduling', () => {
  it('a write pipelined after the same session\'s morsel query waits instead of failing', async () => {
    const s = await server();
    const q = s.send('local', { op: 'query', sql: AGG });
    const w = s.send('local', { op: 'exec', sql: 'INSERT INTO t VALUES (999999, 1, 1.0)' });
    await until('the query and the write', () => s.kinds('local', q).includes('done') && s.kinds('local', w).length > 0);
    expect(s.srv.morselQueries).toBe(1);
    expect(s.rows('local', q).length).toBe(10);
    expect(s.kinds('local', w)).toEqual(['ok']);
    expect(s.db.query('SELECT count(*) FROM t').rows).toEqual([[250001]]);
  });

  for (const failNext of [false, true]) {
    it(`no deadlock with another session's transaction and a finite credit${failNext ? ' (reader failure fallback)' : ''}`, async () => {
      const s = await server();
      s.readers.failNext = failNext;
      const q = s.send('local', { op: 'query', sql: AGG, credit: 1, batchSize: 2 });
      const b = s.send('tab-b', { op: 'exec', sql: 'BEGIN' });
      const ins = s.send('tab-b', { op: 'exec', sql: 'INSERT INTO t VALUES (999999, 1, 1.0)' });
      await until("tab-b's INSERT (a deadlock never answers it)", () => s.kinds('tab-b', ins).length > 0);
      expect(s.kinds('tab-b', b)).toEqual(['ok']);
      expect(s.kinds('tab-b', ins)).toEqual(['ok']); // not stuck behind the morsel query
      const c = s.send('tab-b', { op: 'exec', sql: 'COMMIT' });
      await until('COMMIT', () => s.kinds('tab-b', c).length > 0);
      expect(s.kinds('tab-b', c)).toEqual(['ok']);
      // The query may still be on its first batch or not started (fallback): grant credit until done.
      await until('the query to finish', () => {
        s.srv.receive('local', { id: 0, op: 'credit', target: q, n: 100 } as Request);
        const k = s.kinds('local', q).at(-1);
        return k === 'done' || k === 'error';
      });
      expect(s.kinds('local', q).at(-1)).toBe('done');
      expect(s.rows('local', q).length).toBe(10);
    });
  }

  it('closing the database fails pending morsel queries instead of answering from a closed database', async () => {
    const s = await server();
    const q = s.send('local', { op: 'query', sql: AGG });
    const c = s.send('local', { op: 'close' });
    await until('close and the query', () => s.kinds('local', c).length > 0 && s.kinds('local', q).length > 0);
    expect(s.kinds('local', c)).toEqual(['ok']);
    expect(s.kinds('local', q)).toEqual(['error']);
  });
});
