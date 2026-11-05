/** SQL's bind (ADR 0015 step 6b, sql/frontend/bind.ts): every statement as a bound statement the engine dispatches on. */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import { parseOne } from '../src/engine/sql/parser.js';
import type { BindContext } from '../src/engine/plan/bind-context.js';
import { bindStatement } from '../src/engine/sql/frontend/bind.js';
import { MemoryVfs } from '../src/engine/vfs/memory.js';

describe('bind', () => {
  it('binds each kind of statement', async () => {
    const db = await Database.open(new MemoryVfs(), 'db');
    db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, a INT); CREATE MATERIALIZED VIEW m AS SELECT a FROM t');
    const ctx = (db as unknown as { bindContext(): BindContext }).bindContext();
    const bind = (sql: string) => bindStatement(parseOne(sql), ctx);
    expect(bind('SELECT a FROM t')).toMatchObject({ kind: 'query', plan: { op: 'project' }, columns: [{ name: 'a' }] });
    expect(bind('INSERT OR IGNORE INTO t(a) VALUES (1)')).toMatchObject({ kind: 'write', plan: { op: 'append', onConflict: 'ignore' } });
    expect(bind('UPDATE t SET a = 2 RETURNING id')).toMatchObject({ kind: 'write', plan: { op: 'update' }, returning: [{ name: 'id' }] });
    expect(bind('DELETE FROM t')).toMatchObject({ kind: 'write', plan: { op: 'delete' } });
    expect(bind('EXPLAIN QUERY PLAN SELECT a FROM t')).toMatchObject({ kind: 'explain', mode: 'plan', query: { kind: 'query' } });
    expect(bind('EXPLAIN ANALYZE SELECT a FROM t')).toMatchObject({ kind: 'explain', mode: 'analyze' });
    expect(bind('BEGIN IMMEDIATE')).toEqual({ kind: 'transaction', action: 'begin', mode: 'immediate' });
    expect(bind('BEGIN')).toEqual({ kind: 'transaction', action: 'begin', mode: 'deferred' });
    expect(bind('COMMIT')).toEqual({ kind: 'transaction', action: 'commit' });
    expect(bind('ROLLBACK TO sp')).toEqual({ kind: 'transaction', action: 'rollback', savepoint: 'sp' });
    expect(bind('SAVEPOINT sp')).toEqual({ kind: 'transaction', action: 'savepoint', name: 'sp' });
    expect(bind('RELEASE sp')).toEqual({ kind: 'transaction', action: 'release', name: 'sp' });
    expect(bind('PRAGMA user_version = -3')).toMatchObject({ kind: 'setting', name: 'user_version', value: { k: 'lit' } });
    expect(bind('PRAGMA user_version')).toEqual({ kind: 'setting', name: 'user_version' });
    expect(bind('ANALYZE t')).toMatchObject({ kind: 'maintenance', action: 'analyze', target: 't' });
    expect(bind('VACUUM')).toEqual({ kind: 'maintenance', action: 'vacuum' });
    expect(bind('REFRESH MATERIALIZED VIEW m')).toMatchObject({ kind: 'maintenance', action: 'refresh', view: 'm', withData: true, ifChanged: false });
    // DDL: schema operations, plain data (no syntax trees).
    const ddl: [string, object][] = [
      ["CREATE TABLE u(id INTEGER PRIMARY KEY AUTOINCREMENT, x TEXT NOT NULL DEFAULT 'a' COLLATE NOCASE, CHECK (length(x) < 5), UNIQUE (x))", { op: 'createTable', table: { name: 'u', storage: 'row', keys: [{ kind: 'primaryKey', autoincrement: true }, { kind: 'unique' }], checks: [{ text: 'length(x) < 5' }] } }],
      ['CREATE UNIQUE INDEX ix ON t(a * 2) WHERE a > 0', { op: 'createIndex', index: { name: 'ix', table: 't', unique: true, columns: [{ column: -1, expr: { text: 'a * 2' } }], where: { text: 'a > 0' } } }],
      ['CREATE VIEW v(c) AS SELECT a FROM t', { op: 'createView', name: 'v', columns: ['c'], materialized: false, source: { language: 'sql', text: 'CREATE VIEW v(c) AS SELECT a FROM t' } }],
      ["CREATE MATERIALIZED VIEW mv WITH (storage = 'columnar') AS SELECT a FROM t WITH NO DATA", { op: 'createView', materialized: true, options: { storage: 'columnar' }, withData: false }],
      ["CREATE CONNECTION c WITH (type = 'http')", { op: 'createConnection', name: 'c', options: { type: 'http' } }],
      ["CREATE EXTERNAL TABLE e (a INT) WITH (location = 'x.csv')", { op: 'createExternalTable', name: 'e', columns: [{ name: 'a', declaredType: 'INT', constrained: false }], options: { location: 'x.csv' } }],
      ['DROP TABLE IF EXISTS t', { op: 'drop', objectType: 'table', name: 't', ifExists: true }],
    ];
    const syntax = (o: unknown): boolean => !!o && typeof o === 'object' && ('pos' in (o as object) || Object.values(o as object).some(syntax));
    for (const [q, op] of ddl) {
      const b = bind(q);
      expect(b, q).toMatchObject({ kind: 'schema', op });
      expect(syntax(b), q).toBe(false);
      expect(() => JSON.stringify(b), q).not.toThrow();
    }
    expect(bind('ALTER TABLE t ADD COLUMN z')).toMatchObject({ kind: 'schema', sql: {} });
    expect(() => bind('EXPLAIN DELETE FROM t')).toThrow('EXPLAIN is only supported for SELECT statements');
  });
});
