/**
 * View interfaces (ADR 0027, step 2): every view made from now on has its typed column list captured the first time it
 * binds, stored with its definition and shown in the catalog. Views made before are grandfathered: they reflect.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';
import { plan as p } from '../src/engine/index.js';

const SETUP = `
  CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL);
  CREATE TABLE u(id INTEGER NOT NULL, t_id INT);
`;
const col = (name: string, type: string, notNull: boolean) => ({ name, type, notNull });

describe('view interfaces', () => {
  it('are captured when a view is created: names, types and what is proven never NULL', () => {
    const d = Database.openMemory();
    d.exec(SETUP);
    d.exec(`CREATE VIEW v AS SELECT id, name, score, 1 AS one, NULL AS nothing, name || 'x' AS called FROM t`);
    expect(d.catalog.view('v')!.interface).toEqual([
      col('id', 'int', true),
      col('name', 'text', true),
      col('score', 'real', false),
      col('one', 'int', true),
      col('nothing', 'null', false),
      col('called', 'text', false),
    ]);
    expect(d.catalog.view('v')!.reflects).toBeUndefined();
  });

  it("take the view's own column names", () => {
    const d = Database.openMemory();
    d.exec(SETUP);
    d.exec('CREATE VIEW w(a, b) AS SELECT id, name FROM t');
    expect(d.catalog.view('w')!.interface).toEqual([col('a', 'int', true), col('b', 'text', true)]);
  });

  it('follow joins, groupings, counts, unions and other views', () => {
    const d = Database.openMemory();
    d.exec(SETUP);
    d.exec(`
      CREATE VIEW j AS SELECT t.name, u.id AS uid FROM t LEFT JOIN u ON u.t_id = t.id;
      CREATE VIEW i AS SELECT t.name, u.id AS uid FROM t JOIN u ON u.t_id = t.id;
      CREATE VIEW g AS SELECT name, count(*) AS n, count(score) AS m, sum(score) AS s FROM t GROUP BY name;
      CREATE VIEW un AS SELECT name FROM t UNION SELECT 'x';
      CREATE VIEW un2 AS SELECT name FROM t UNION ALL SELECT score FROM t;
      CREATE VIEW over AS SELECT name FROM v2;
      CREATE VIEW v2 AS SELECT name FROM t WHERE score > 1;
    `);
    expect(d.catalog.view('j')!.interface).toEqual([col('name', 'text', true), col('uid', 'int', false)]);
    expect(d.catalog.view('i')!.interface).toEqual([col('name', 'text', true), col('uid', 'int', true)]);
    expect(d.catalog.view('g')!.interface!.map((c) => [c.name, c.notNull])).toEqual([['name', true], ['n', true], ['m', true], ['s', false]]);
    expect(d.catalog.view('un')!.interface!.map((c) => c.notNull)).toEqual([true]);
    expect(d.catalog.view('un2')!.interface!.map((c) => c.notNull)).toEqual([false]);
    // `over` was created before `v2`, and captured once `v2` was.
    expect(d.catalog.view('over')!.interface).toEqual([col('name', 'text', true)]);
  });

  it('are captured the first time a view binds, when it could not when it was created', () => {
    const vfs = new MemoryVfs();
    let d = Database.openFile(vfs.openSync('p.db'), {}, vfs.openSync('p.db-wal'));
    d.exec('CREATE VIEW later AS SELECT z FROM not_yet');
    expect(d.catalog.view('later')!.interface).toBeUndefined();
    expect(d.catalog.view('later')!.reflects).toBeUndefined();
    d.close();
    d = Database.openFile(vfs.openSync('p.db'), {}, vfs.openSync('p.db-wal'));
    expect(d.catalog.view('later')!.interface).toBeUndefined();
    d.exec('CREATE TABLE not_yet(z INTEGER NOT NULL)');
    expect(d.catalog.view('later')!.interface).toEqual([col('z', 'int', true)]);
    d.close();
    // Stored with the view's definition.
    d = Database.openFile(vfs.openSync('p.db'), {}, vfs.openSync('p.db-wal'));
    expect(d.catalog.view('later')!.interface).toEqual([col('z', 'int', true)]);
    d.exec('INSERT INTO not_yet VALUES (7)');
    expect(d.query('SELECT * FROM later').rows).toEqual([[7]]);
  });

  it('captured in a transaction that rolls back are pending again', () => {
    const d = Database.openMemory();
    d.exec('CREATE VIEW later AS SELECT z FROM not_yet');
    d.exec('BEGIN; CREATE TABLE not_yet(z INTEGER NOT NULL)');
    expect(d.catalog.view('later')!.interface).toEqual([col('z', 'int', true)]);
    d.exec('ROLLBACK');
    expect(d.catalog.view('later')!.interface).toBeUndefined();
    d.exec('CREATE TABLE not_yet(z TEXT)');
    expect(d.catalog.view('later')!.interface).toEqual([col('z', 'text', false)]);
  });

  it('wait while a view gives the wrong number of columns for its names', () => {
    const d = Database.openMemory();
    d.exec('CREATE VIEW short(x) AS SELECT 1, 2');
    expect(d.catalog.view('short')!.interface).toBeUndefined();
    expect(() => d.query('SELECT * FROM short')).toThrow(/expected 1 columns for 'short' but got 2/);
  });

  it('are captured for TEMP views', () => {
    const d = Database.openMemory();
    d.exec(SETUP);
    d.exec('CREATE TEMP VIEW tv AS SELECT name FROM t');
    expect(d.catalog.view('tv')).toMatchObject({ schema: 'temp', interface: [col('name', 'text', true)] });
  });

  it('stay as captured when a column the view reads is renamed', () => {
    const d = Database.openMemory();
    d.exec(SETUP);
    d.exec('CREATE VIEW v AS SELECT name FROM t');
    d.exec('ALTER TABLE t RENAME COLUMN name TO title');
    expect(d.catalog.view('v')!.interface).toEqual([col('name', 'text', true)]);
  });

  it('are not given to views made before interfaces, which reflect', () => {
    const vfs = new MemoryVfs();
    let d = Database.openFile(vfs.openSync('p.db'), {}, vfs.openSync('p.db-wal'));
    d.exec(SETUP);
    d.exec('CREATE VIEW old AS SELECT name FROM t');
    // As an engine before interfaces stored it: no interface, not pending.
    d.exec('BEGIN');
    (d as unknown as { writeDefinition(key: string, def: object): void }).writeDefinition('old', { kind: 'view', language: 'sql' });
    d.exec('COMMIT');
    d.close();
    d = Database.openFile(vfs.openSync('p.db'), {}, vfs.openSync('p.db-wal'));
    expect(d.catalog.view('old')).toMatchObject({ name: 'old', reflects: true });
    expect(d.catalog.view('old')!.interface).toBeUndefined();
    d.exec('CREATE TABLE other(x)');
    expect(d.catalog.view('old')!.interface).toBeUndefined();
  });
});

/** Rebuild t in one transaction, as a language changes a column's type: copy into t2, drop t, rename t2 to t. */
const rebuild = (d: Database, columns: string, select: string): void =>
  d.exec(`BEGIN; CREATE TABLE t2(${columns}); INSERT INTO t2 SELECT ${select} FROM t; DROP TABLE t; ALTER TABLE t2 RENAME TO t; COMMIT`);

describe('schema operations against view interfaces (ADR 0027 step 3)', () => {
  it('refuse dropping a table a view reads, changing nothing', () => {
    const d = Database.openMemory();
    d.exec(`${SETUP} INSERT INTO t VALUES (1, 'a', 2.5); CREATE VIEW v AS SELECT name FROM t`);
    expect(() => d.exec('DROP TABLE t')).toThrow('schema change breaks the interface of view v: it no longer binds (no such table: t)');
    expect(d.query('SELECT name FROM v').rows).toEqual([['a']]);
    d.exec('DROP VIEW v; DROP TABLE t');
    expect(d.catalog.table('t')).toBeUndefined();
  });

  it('refuse dropping a view another view reads', () => {
    const d = Database.openMemory();
    d.exec(`${SETUP} CREATE VIEW inner_v AS SELECT name FROM t; CREATE VIEW outer_v AS SELECT name FROM inner_v`);
    expect(() => d.exec('DROP VIEW inner_v')).toThrow(/breaks the interface of view outer_v: it no longer binds/);
  });

  it('refuse a TEMP table that shadows what a view reads with other columns', () => {
    const d = Database.openMemory();
    d.exec(`${SETUP} CREATE VIEW v AS SELECT name FROM t`);
    expect(() => d.exec('CREATE TEMP TABLE t(x)')).toThrow(/breaks the interface of view v/);
  });

  it('allow a rename of what a view reads', () => {
    const d = Database.openMemory();
    d.exec(`${SETUP} INSERT INTO t VALUES (1, 'a', 2.5); CREATE VIEW v AS SELECT name FROM t`);
    d.exec('ALTER TABLE t RENAME COLUMN name TO title; ALTER TABLE t RENAME TO t_new');
    expect(d.query('SELECT * FROM v').rows).toEqual([['a']]);
    expect(d.catalog.view('v')!.interface).toEqual([col('name', 'text', true)]);
  });

  it('keep a view over * to the columns it had when a column is added', () => {
    const d = Database.openMemory();
    d.exec(`${SETUP} INSERT INTO t VALUES (1, 'a', 2.5); CREATE VIEW v AS SELECT * FROM t`);
    d.exec('ALTER TABLE t ADD COLUMN extra TEXT');
    expect(d.catalog.view('v')!.interface!.map((c) => c.name)).toEqual(['id', 'name', 'score']);
    // Read through the plan API, the engine expands the view: the interface's columns.
    expect(d.queryPlan(p.scan('v', [0, 1, 2])).rows).toEqual([[1, 'a', 2.5]]);
  });

  it('check a rebuild at COMMIT: a lossless type change is converted where the engine expands the view', () => {
    const d = Database.openMemory();
    d.exec(`CREATE TABLE t(code TEXT); INSERT INTO t VALUES ('42'); CREATE VIEW v AS SELECT code FROM t`);
    rebuild(d, 'code INTEGER', 'CAST(code AS INTEGER)');
    expect(d.catalog.view('v')!.interface).toEqual([col('code', 'text', false)]);
    const r = d.queryPlan(p.scan('v', [0]));
    expect(r.rows).toEqual([['42']]);
  });

  it('refuse at COMMIT a change that is not lossless, keeping the transaction open', () => {
    const d = Database.openMemory();
    d.exec(`CREATE TABLE t(n INTEGER); INSERT INTO t VALUES (7); CREATE VIEW v AS SELECT n FROM t`);
    expect(() => rebuild(d, 'n REAL', 'n')).toThrow('schema change breaks the interface of view v: column n: int → real is not lossless');
    expect(d.inTransaction).toBe(true);
    d.exec('ROLLBACK');
    expect(d.catalog.table('t')!.columns[0]!.type).toBe('int');
    expect(d.query('SELECT n FROM v').rows).toEqual([[7]]);
  });

  it('refuse a column that can now be NULL where the interface says it cannot', () => {
    const d = Database.openMemory();
    d.exec(`CREATE TABLE t(name TEXT NOT NULL); CREATE VIEW v AS SELECT name FROM t`);
    expect(() => rebuild(d, 'name TEXT', 'name')).toThrow('schema change breaks the interface of view v: column name can now be NULL');
    d.exec('ROLLBACK');
  });

  it('leave views without an interface as they were', () => {
    const d = Database.openMemory();
    d.exec(`${SETUP} CREATE VIEW later AS SELECT z FROM not_yet`);
    d.exec('DROP TABLE t');
    expect(d.catalog.view('later')!.interface).toBeUndefined();
  });
});

describe('views as a language reads them (getView)', () => {
  const getView = (d: Database, name: string) => (d as unknown as { bindContext(): { getView(n: string): { interface?: unknown; reshaped?: true } | undefined } }).bindContext().getView(name);

  it('give the interface, and reshaped once the query no longer gives exactly it', () => {
    const d = Database.openMemory();
    d.exec(`CREATE TABLE t(code TEXT); CREATE VIEW v AS SELECT code FROM t; CREATE VIEW s AS SELECT * FROM t`);
    expect(getView(d, 'v')).toMatchObject({ interface: [col('code', 'text', false)] });
    expect(getView(d, 'v')!.reshaped).toBeUndefined();
    rebuild(d, 'code INTEGER', 'CAST(code AS INTEGER)');
    expect(getView(d, 'v')!.reshaped).toBe(true);
    expect(getView(d, 's')!.reshaped).toBe(true);
  });

  it('give reshaped for a view over * that gained a column', () => {
    const d = Database.openMemory();
    d.exec(`CREATE TABLE t(a INT); CREATE VIEW s AS SELECT * FROM t`);
    expect(getView(d, 's')!.reshaped).toBeUndefined();
    d.exec('ALTER TABLE t ADD COLUMN b TEXT');
    expect(getView(d, 's')!.reshaped).toBe(true);
  });
});

describe('cascade (ADR 0027 step 4)', () => {
  const run = (d: Database, op: object) => d.preparePlan({ kind: 'schema', op } as never).run();

  it('drops the views a drop breaks, and the views those break, listing them', () => {
    const d = Database.openMemory();
    d.exec(`${SETUP} CREATE VIEW a AS SELECT name FROM t; CREATE VIEW b AS SELECT name FROM a; CREATE VIEW keep AS SELECT id FROM u`);
    const r = run(d, { op: 'drop', objectType: 'table', name: 't', ifExists: false, cascade: true });
    expect(r.cascaded).toEqual(['a', 'b']);
    expect(d.catalog.views().map((v) => v.name)).toEqual(['keep']);
    expect(d.catalog.table('t')).toBeUndefined();
  });

  it('drops the views an alterTable breaks', () => {
    const d = Database.openMemory();
    d.exec(`${SETUP} CREATE VIEW a AS SELECT score FROM t; CREATE VIEW keep AS SELECT name FROM t`);
    const r = run(d, { op: 'alterTable', table: 't', action: { kind: 'dropColumn', column: 'score' }, cascade: true });
    expect(r.cascaded).toEqual(['a']);
    expect(d.catalog.views().map((v) => v.name)).toEqual(['keep']);
    expect(d.catalog.table('t')!.columns.map((c) => c.name)).toEqual(['id', 'name']);
  });

  it('drops nothing when nothing breaks, and inside a transaction drops at once', () => {
    const d = Database.openMemory();
    d.exec(`${SETUP} CREATE VIEW a AS SELECT name FROM t`);
    expect(run(d, { op: 'drop', objectType: 'table', name: 'u', ifExists: false, cascade: true }).cascaded).toBeUndefined();
    d.exec('BEGIN');
    expect(run(d, { op: 'drop', objectType: 'table', name: 't', ifExists: false, cascade: true }).cascaded).toEqual(['a']);
    d.exec('ROLLBACK');
    expect(d.catalog.view('a')).toBeDefined();
  });

  it('refuses as before without it', () => {
    const d = Database.openMemory();
    d.exec(`${SETUP} CREATE VIEW a AS SELECT score FROM t`);
    expect(() => run(d, { op: 'alterTable', table: 't', action: { kind: 'dropColumn', column: 'score' } })).toThrow();
    expect(d.catalog.view('a')).toBeDefined();
  });

  it('is checked by the plan validator', () => {
    const d = Database.openMemory();
    d.exec(SETUP);
    expect(() => run(d, { op: 'drop', objectType: 'table', name: 't', ifExists: false, cascade: 'yes' })).toThrow(/cascade/);
  });
});

describe('materialized views (ADR 0027 step 5)', () => {
  it('have an interface, kept across a reopen', () => {
    const vfs = new MemoryVfs();
    let d = Database.openFile(vfs.openSync('p.db'), {}, vfs.openSync('p.db-wal'));
    d.exec(`${SETUP} CREATE MATERIALIZED VIEW mv AS SELECT id, name, score FROM t`);
    const want = [col('id', 'int', true), col('name', 'text', true), col('score', 'real', false)];
    expect(d.catalog.table('mv')!.interface).toEqual(want);
    d.close();
    d = Database.openFile(vfs.openSync('p.db'), {}, vfs.openSync('p.db-wal'));
    expect(d.catalog.table('mv')!.interface).toEqual(want);
  });

  it('hold what they read: a drop is refused, or cascades', () => {
    const d = Database.openMemory();
    d.exec(`${SETUP} CREATE MATERIALIZED VIEW mv AS SELECT name FROM t`);
    expect(() => d.exec('DROP TABLE t')).toThrow('schema change breaks the interface of materialized view mv: it no longer binds (no such table: t)');
    const r = d.preparePlan({ kind: 'schema', op: { op: 'drop', objectType: 'table', name: 't', ifExists: false, cascade: true } }).run();
    expect(r.cascaded).toEqual(['mv']);
    expect(d.catalog.table('mv')).toBeUndefined();
  });

  it('refresh with the lossless conversion after a type change', () => {
    const d = Database.openMemory();
    d.exec(`CREATE TABLE t(code TEXT); INSERT INTO t VALUES ('42'); CREATE MATERIALIZED VIEW mv AS SELECT code FROM t`);
    rebuild(d, 'code INTEGER', 'CAST(code AS INTEGER)');
    d.exec("INSERT INTO t VALUES (7); REFRESH MATERIALIZED VIEW mv");
    expect(d.query('SELECT code FROM mv ORDER BY code').rows).toEqual([['42'], ['7']]);
  });

  it('over * keep the columns they had when one is added, and refresh', () => {
    const d = Database.openMemory();
    d.exec(`CREATE TABLE t(a INTEGER, b TEXT); INSERT INTO t VALUES (1, 'x'); CREATE MATERIALIZED VIEW mv AS SELECT * FROM t`);
    d.exec("ALTER TABLE t ADD COLUMN c TEXT; INSERT INTO t VALUES (2, 'y', 'z'); REFRESH MATERIALIZED VIEW mv");
    const r = d.query('SELECT * FROM mv ORDER BY a');
    expect(r.columns).toEqual(['a', 'b']);
    expect(r.rows).toEqual([[1, 'x'], [2, 'y']]);
  });
});
