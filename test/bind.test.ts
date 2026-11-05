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
    expect(bind('CREATE TABLE u(x)')).toMatchObject({ kind: 'schema' });
    expect(() => bind('EXPLAIN DELETE FROM t')).toThrow('EXPLAIN is only supported for SELECT statements');
  });
});
