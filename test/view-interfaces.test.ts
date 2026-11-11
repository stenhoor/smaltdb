/**
 * View interfaces (ADR 0027, step 2): every view made from now on has its typed column list captured the first time it
 * binds, stored with its definition and shown in the catalog. Views made before are grandfathered: they reflect.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

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
