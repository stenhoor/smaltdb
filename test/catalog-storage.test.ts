/**
 * Language-neutral catalog storage (ADR 0015 step 7, catalog/stored.ts): each object's definition is stored as
 * versioned JSON beside its source text, and opening a database reads definitions instead of parsing SQL.
 */
import { describe, expect, it } from 'vitest';
import { decodeDef, encodeDef, DEFINITION_VERSION } from '../src/engine/catalog/stored.js';
import { Database } from '../src/engine/database.js';
import type { BindContext } from '../src/engine/plan/bind-context.js';
import { DH_FORMAT_MAJOR, FORMAT_MAJOR } from '../src/engine/storage/format.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

const open = (vfs: MemoryVfs): Database => Database.openFile(vfs.openSync('c.db'), {}, vfs.openSync('c.db-wal'));

const SETUP = [
  "CREATE TABLE p(id INTEGER PRIMARY KEY, code TEXT UNIQUE COLLATE NOCASE, n INT CHECK (n >= 0) DEFAULT 1, CONSTRAINT short CHECK (length(code) < 5))",
  'CREATE TABLE c(id INTEGER PRIMARY KEY, pid INT REFERENCES p(id) ON DELETE CASCADE, big INT DEFAULT 9223372036854775807, b BLOB DEFAULT x\'00ff\', r REAL DEFAULT 1e999)',
  'CREATE INDEX c_expr ON c(pid * 2) WHERE pid IS NOT NULL',
  'CREATE VIEW pv(i, k) AS SELECT id, upper(code) FROM p',
  "CREATE MATERIALIZED VIEW pm WITH (refresh_every = 60) AS SELECT count(*) AS n FROM p",
  "INSERT INTO p(code) VALUES ('ab'), ('cd')",
  'INSERT INTO c(pid) VALUES (1)',
];

describe('catalog storage', () => {
  it('opens from stored definitions: expressions come back bound, values with their types', () => {
    const vfs = new MemoryVfs();
    let d = open(vfs);
    for (const s of SETUP) d.exec(s);
    d.close();
    d = open(vfs);
    // CHECKs were bound at CREATE TABLE and stored bound: opening binds nothing and still has them.
    const p = (d as unknown as { bindContext(): BindContext }).bindContext().getTable('p')!;
    expect(p.checks.map((c) => [c.name, c.text, c.expr?.k])).toEqual([[undefined, 'n >= 0', 'call'], ['short', 'length(code) < 5', 'call']]);
    expect(d.query('SELECT big, hex(b), r FROM c').rows).toEqual([[9223372036854775807n, '00FF', Infinity]]);
    expect(() => d.exec('INSERT INTO p(code, n) VALUES (\'x\', -1)')).toThrow(/CHECK constraint failed: n >= 0/);
    expect(() => d.exec("INSERT INTO p(code) VALUES ('AB')")).toThrow(/UNIQUE/);
    expect(d.query('SELECT * FROM pv ORDER BY i').rows).toEqual([[1, 'AB'], [2, 'CD']]);
    const idx = (d as unknown as { bindContext(): BindContext }).bindContext().getTable('c')!.indexes.find((i) => i.name === 'c_expr')!;
    expect(idx.columns[0].expr).toMatchObject({ text: 'pid * 2', expr: { k: 'call', fn: 'sql.mul' } });
    expect(idx.where).toMatchObject({ text: 'pid IS NOT NULL', expr: { k: 'isNull' } });
    expect(d.query('SELECT id FROM c INDEXED BY c_expr WHERE pid * 2 = 2 AND pid IS NOT NULL').rows).toEqual([[1]]);
    d.exec('REFRESH MATERIALIZED VIEW pm');
    expect(d.query('SELECT n FROM pm').rows).toEqual([[2]]);
    expect(d.query("SELECT refresh_mode FROM information_schema.materialized_views WHERE table_name = 'pm'").rows).toEqual([['EVERY 60 SECONDS']]);
    d.exec('DELETE FROM p WHERE id = 1');
    expect(d.query('SELECT count(*) FROM c').rows).toEqual([[0]]);
    expect(d.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('keeps the definitions out of sqlite_schema, and in step with the catalog', () => {
    const vfs = new MemoryVfs();
    let d = open(vfs);
    for (const s of SETUP) d.exec(s);
    d.exec('DROP VIEW pv');
    d.exec('BEGIN');
    d.exec('CREATE TABLE gone(x)');
    d.exec('ROLLBACK');
    d.close();
    d = open(vfs);
    const names = d.query('SELECT name FROM sqlite_schema').rows.flat();
    expect(names).not.toContain('smalt_definition');
    expect(names).not.toContain('pv');
    expect(() => d.query('SELECT * FROM smalt_definition')).toThrow(/no such table/);
    expect(() => d.query('SELECT * FROM gone')).toThrow(/no such table/);
    d.exec('CREATE VIEW pv AS SELECT 1');
    expect(d.query('SELECT * FROM pv').rows).toEqual([[1]]);
    expect(d.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('refuses files of the previous format', () => {
    const vfs = new MemoryVfs();
    const d = open(vfs);
    d.exec('CREATE TABLE t(a)');
    d.checkpoint();
    d.close();
    const f = vfs.openSync('c.db');
    const v = new Uint8Array(2);
    new DataView(v.buffer).setUint16(0, FORMAT_MAJOR - 1, true);
    f.write(v, DH_FORMAT_MAJOR);
    f.close();
    expect(() => open(vfs)).toThrow(expect.objectContaining({ code: 'SMALT_FORMAT' }));
  });

  it('refuses definitions of another version, and reports unreadable ones as corrupt', () => {
    const text = encodeDef({ kind: 'connection', options: { n: 1n } });
    expect(decodeDef(text, 'x')).toEqual({ kind: 'connection', options: { n: 1n } });
    const newer = text.replace(`"v":${DEFINITION_VERSION}`, `"v":${DEFINITION_VERSION + 1}`);
    expect(() => decodeDef(newer, 'x')).toThrow(expect.objectContaining({ code: 'SMALT_FORMAT' }));
    expect(() => decodeDef('{', 'x')).toThrow(expect.objectContaining({ code: 'SMALT_CORRUPT' }));
  });
});
