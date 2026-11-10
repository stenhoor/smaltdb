/**
 * DROP refuses the schema table and the engine's own objects (issue #194): dropping one corrupted the database. As
 * ALTER TABLE does, and SQLite ('table sqlite_master may not be dropped'). Checked in the engine, so plans and every
 * language are covered.
 */
import { describe, expect, it } from 'vitest';
import { Database } from '../src/engine/database.js';
import type { PlanStatementInput } from '../src/engine/plan/statement.js';

const INTERNAL = ['smalt_columnar', 'smalt_stat', 'smalt_matview', 'smalt_extcache', 'smalt_anything', 'sqlite_autoindex_t_1', 'sqlite_stat1'];
const SCHEMA = ['sqlite_schema', 'sqlite_master', 'smalt_schema', 'SQLITE_MASTER'];
const KINDS = ['TABLE', 'VIEW', 'INDEX', 'MATERIALIZED VIEW', 'EXTERNAL TABLE'];

function fresh(): Database {
  const db = Database.openMemory();
  db.exec("CREATE TABLE events(id INT, kind TEXT) WITH (storage = 'columnar')");
  db.exec("INSERT INTO events VALUES (1, 'a')");
  db.exec('CREATE TABLE a(x)');
  return db;
}

describe('DROP of internal objects', () => {
  it('refuses the schema table, with SQLite’s message, for every object type and with IF EXISTS', () => {
    const db = fresh();
    for (const kind of KINDS) {
      for (const name of SCHEMA) {
        expect(() => db.exec(`DROP ${kind} ${name}`), `${kind} ${name}`).toThrow(`${kind.toLowerCase()} sqlite_master may not be dropped`);
        expect(() => db.exec(`DROP ${kind} IF EXISTS ${name}`), `${kind} IF EXISTS ${name}`).toThrow('may not be dropped');
      }
    }
  });

  it('refuses the engine’s smalt_* and sqlite_* objects', () => {
    const db = fresh();
    for (const kind of KINDS) {
      for (const name of INTERNAL) {
        expect(() => db.exec(`DROP ${kind} ${name}`), `${kind} ${name}`).toThrow(`${kind.toLowerCase()} ${name} may not be dropped`);
        expect(() => db.exec(`DROP ${kind} IF EXISTS ${name}`), `${kind} IF EXISTS ${name}`).toThrow('may not be dropped');
      }
    }
  });

  it('leaves the database intact (the issue’s reproductions)', () => {
    const db = fresh();
    expect(() => db.exec('DROP TABLE smalt_columnar')).toThrow('table smalt_columnar may not be dropped');
    expect(() => db.exec('DROP TABLE sqlite_schema')).toThrow('table sqlite_master may not be dropped');
    expect(db.query('SELECT count(*) FROM events').rows).toEqual([[1]]);
    db.exec('DROP TABLE events');
    db.exec('CREATE TABLE more(x)');
    db.exec('CREATE TABLE b(y)');
    expect(db.query("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'smalt%' ORDER BY name").rows).toEqual([['a'], ['b'], ['more']]);
    expect(db.query('PRAGMA integrity_check').rows).toEqual([['ok']]);
  });

  it('refuses them in plans too, whatever language built them', () => {
    const db = fresh();
    const drop = (objectType: string, name: string) =>
      ({ kind: 'schema', op: { op: 'drop', objectType, name, ifExists: true, source: { language: 'test', text: '' } } }) as unknown as PlanStatementInput;
    expect(() => db.queryPlan(drop('table', 'smalt_columnar'))).toThrow('table smalt_columnar may not be dropped');
    expect(() => db.queryPlan(drop('table', 'sqlite_schema'))).toThrow('table sqlite_master may not be dropped');
    expect(db.query('SELECT count(*) FROM events').rows).toEqual([[1]]);
  });

  it('still drops ordinary objects, and DROP … IF EXISTS of a missing one is a no-op', () => {
    const db = fresh();
    db.exec('CREATE VIEW v AS SELECT x FROM a; CREATE INDEX ai ON a(x)');
    db.exec('DROP INDEX ai; DROP VIEW v; DROP TABLE a; DROP TABLE events');
    db.exec('DROP TABLE IF EXISTS nothing_here');
    expect(db.query("SELECT count(*) FROM sqlite_schema WHERE type IN ('table', 'view', 'index') AND name NOT LIKE 'smalt%'").rows).toEqual([[0]]);
  });
});
