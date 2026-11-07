/**
 * The language boundary (ADR 0015): the engine carries no language. SQL is smaltql's, which reaches the engine only
 * through `smaltdb/language` (src/engine/language-support.ts) and registers itself.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SRC = resolve('src');

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));

/** The packages a file imports or re-exports. */
function packages(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specs = [...text.matchAll(/\bfrom\s+'([^']+)'|\bimport\(\s*'([^']+)'\s*\)|^\s*import\s+'([^']+)'/gm)].map((m) => m[1] ?? m[2] ?? m[3]);
  return specs.filter((s) => !s.startsWith('.') && !s.startsWith('node:'));
}

describe('language boundary', () => {
  it('the engine carries no language', () => {
    expect(existsSync(join(SRC, 'engine/sql'))).toBe(false);
  });

  // ADR 0017: code that runs without SQL must not reach it at run time either. Importing nothing is not enough.
  it('only the text API reaches SQL', () => {
    // The text API: SQL text is parsed by SQL (prepare, exec, …). Nothing else may name the SQL language or parse with it.
    const TEXT_API = ['prepare', 'sql', 'parseSql', 'parseOneSql', 'isScript', 'exec', 'execAsync', 'planOf', 'compile', 'morselQuery'];
    const reaches = /\bthis\.(?:sql|parseSql|parseOneSql)\b|languageOf\('sql'\)/;
    const found: string[] = [];
    for (const f of files(SRC)) {
      let method = '';
      for (const line of readFileSync(f, 'utf8').split('\n')) {
        const m = /^ {2}(?:(?:private|protected|public|static|async|get)\s+)*(\w+)\s*[(<]/.exec(line);
        if (m) method = m[1];
        if (reaches.test(line) && !/^\s*(\/\/|\*)/.test(line)) found.push(`${relative(SRC, f)}:${method}`);
      }
    }
    expect(found.filter((x) => !(x.startsWith('engine/database.ts:') && TEXT_API.includes(x.split(':')[1])))).toEqual([]);
  });

  it('no engine or client code writes SQL statements', () => {
    // Statements as text: what the engine, its client and worker would run or store as SQL (ADR 0017).
    // ('ROLLBACK' alone is also an ON CONFLICT action, so only ROLLBACK TO / TRANSACTION count.)
    const statement = /['"`](?:BEGIN(?: DEFERRED| IMMEDIATE| EXCLUSIVE| TRANSACTION)?|COMMIT|END)['"`]|['"`]ROLLBACK (?:TO|TRANSACTION)\b|['"`](?:CREATE (?:TEMP |EXTERNAL |MATERIALIZED )?(?:TABLE|INDEX|VIEW)|INSERT INTO|REFRESH MATERIALIZED VIEW|SELECT \S.* FROM|DELETE FROM|UPDATE \S+ SET)\b/;
    const found = files(SRC).flatMap((f) =>
      readFileSync(f, 'utf8')
        .split('\n')
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => statement.test(line) && !/^\s*(\/\/|\*|\/\*)/.test(line))
        .map(({ line, i }) => `${relative(SRC, f)}:${i + 1}: ${line.trim()}`),
    );
    expect(found).toEqual([]);
  });

  it('no source file imports a language', () => {
    const into = files(SRC).flatMap((f) => packages(f).filter((p) => /^smaltql(\/|$)/.test(p)).map((p) => `${relative(SRC, f)} -> ${p}`));
    expect(into).toEqual([]);
  });
});
