/**
 * A statement's language words its errors (ADR 0016 section 10): the engine passes an error's code, message and fields
 * to the language's `errorMessage`, once, for errors leaving a statement written in it; plans keep the engine's words.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { sqlLanguage } from 'smaltql';
import { Database } from '../src/engine/database.js';
import { SmaltError, type ErrorToWord } from '../src/engine/errors.js';
import { plan as p } from '../src/engine/index.js';
import type { SmaltLanguage } from '../src/engine/plan/language.js';

const lang = sqlLanguage as SmaltLanguage & { errorMessage?: (e: ErrorToWord) => string | undefined };
const before = lang.errorMessage;
afterEach(() => {
  if (before) lang.errorMessage = before;
  else delete lang.errorMessage;
});

function errorOf(f: () => unknown): SmaltError {
  try {
    f();
  } catch (e) {
    if (e instanceof SmaltError) return e;
    throw e;
  }
  throw new Error('expected an error');
}

describe('errorMessage', () => {
  it('words the errors of statements written in the language, from their fields', () => {
    const seen: ErrorToWord[] = [];
    lang.errorMessage = (e) => {
      seen.push(e);
      return e.constraint === 'notNull' ? `${e.columns![0]} is required in ${e.table}` : undefined;
    };
    const d = Database.openMemory();
    d.exec('CREATE TABLE t(a TEXT NOT NULL, b INT UNIQUE)');
    d.exec("INSERT INTO t VALUES ('x', 1)");
    expect(errorOf(() => d.exec('INSERT INTO t VALUES (NULL, 2)'))).toMatchObject({ code: 'SMALT_CONSTRAINT_NOTNULL', message: 'a is required in t', constraint: 'notNull' });
    // undefined keeps the engine's message.
    expect(errorOf(() => d.exec("INSERT INTO t VALUES ('y', 1)")).message).toBe('duplicate key in t (b)');
    expect(seen.map((e) => e.code)).toEqual(['SMALT_CONSTRAINT_NOTNULL', 'SMALT_CONSTRAINT_UNIQUE']);
    expect(seen[1]).toMatchObject({ constraint: 'unique', table: 't', columns: ['b'], message: 'duplicate key in t (b)' });
  });

  it('a plan keeps the engine\'s words', () => {
    lang.errorMessage = () => 'worded by SQL';
    const d = Database.openMemory();
    d.exec('CREATE TABLE t(a TEXT NOT NULL)');
    const e = errorOf(() => d.queryPlan({ kind: 'write', plan: p.append('t', p.values([[p.lit(null)]]), [0]) }));
    expect(e.message).toBe('t.a must not be null');
    expect(errorOf(() => d.exec('INSERT INTO t VALUES (NULL)')).message).toBe('worded by SQL');
  });
});

describe("the engine's words", () => {
  it('word each constraint failure from its fields, for plans', () => {
    const d = Database.openMemory();
    d.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE t(id INTEGER PRIMARY KEY, a TEXT NOT NULL, b INT, c INT, UNIQUE (b, c), CONSTRAINT positive CHECK (b > 0));
      CREATE UNIQUE INDEX t_lower ON t(lower(a));
      CREATE TABLE u(id INTEGER PRIMARY KEY, tid INT REFERENCES t(id) ON DELETE RESTRICT);
      INSERT INTO t VALUES (1, 'x', 1, 1);
      INSERT INTO u VALUES (1, 1);
    `);
    const insert = (...v: unknown[]) => errorOf(() => d.queryPlan({ kind: 'write', plan: p.append('t', p.values([v.map((x) => p.lit(x as never))]), [0, 1, 2, 3]) })).message;
    expect(insert(2, null, 2, 2)).toBe('t.a must not be null');
    expect(insert(2, 'y', 1, 1)).toBe('duplicate key in t (b, c)');
    expect(insert(1, 'y', 3, 3)).toBe('duplicate primary key in t (id)');
    expect(insert(2, 'X', 3, 3)).toBe('duplicate key in index t_lower');
    expect(insert(2, 'y', -1, 3)).toBe('check positive failed on t');
    const del = p.remove('t', p.filter(p.scan('t', [-1]), p.call('cmp_eq', [p.col(0, 0, 'int'), p.lit(1)], 'int')), 0);
    expect(errorOf(() => d.queryPlan({ kind: 'write', plan: del })).message).toBe('foreign key from u (tid) violated');
    const orphan = p.append('u', p.values([[p.lit(2), p.lit(99)]]), [0, 1]);
    expect(errorOf(() => d.queryPlan({ kind: 'write', plan: orphan })).message).toBe('foreign key violated');
  });
});
