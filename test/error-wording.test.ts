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
    expect(errorOf(() => d.exec("INSERT INTO t VALUES ('y', 1)")).message).toMatch(/UNIQUE constraint failed: t\.b/);
    expect(seen.map((e) => e.code)).toEqual(['SMALT_CONSTRAINT_NOTNULL', 'SMALT_CONSTRAINT_UNIQUE']);
    expect(seen[1]).toMatchObject({ constraint: 'unique', table: 't', columns: ['b'], message: expect.stringMatching(/UNIQUE/) });
  });

  it('a plan keeps the engine\'s words', () => {
    lang.errorMessage = () => 'worded by SQL';
    const d = Database.openMemory();
    d.exec('CREATE TABLE t(a TEXT NOT NULL)');
    const e = errorOf(() => d.queryPlan({ kind: 'write', plan: p.append('t', p.values([[p.lit(null)]]), [0]) }));
    expect(e.message).toMatch(/NOT NULL constraint failed: t\.a/);
    expect(errorOf(() => d.exec('INSERT INTO t VALUES (NULL)')).message).toBe('worded by SQL');
  });
});
