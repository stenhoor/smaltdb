/**
 * The language boundary (ADR 0015 step 9): the SQL language (src/engine/sql/) reaches the engine only through
 * src/engine/language-support.ts, and engine code does not import the SQL language.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ENGINE = resolve('src/engine');
const SQL = join(ENGINE, 'sql');
const SUPPORT = join(ENGINE, 'language-support.ts');

/** smaltdb's entry points, which register (and export) the SQL language until it is its own package (step 9). */
const SQL_ROOTS = ['index.ts', 'worker-runtime.ts'];

const files = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []));

/** The local modules a file imports or re-exports, as absolute .ts paths. */
function imports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const specs = [...text.matchAll(/\bfrom\s+'([^']+)'|\bimport\(\s*'([^']+)'\s*\)|^\s*import\s+'([^']+)'/gm)].map((m) => m[1] ?? m[2] ?? m[3]);
  return specs.filter((s) => s.startsWith('.')).map((s) => resolve(dirname(file), s).replace(/\.js$/, '.ts'));
}

const inside = (path: string, dir: string): boolean => !relative(dir, path).startsWith('..');

describe('language boundary', () => {
  it('the SQL language reaches the engine only through language-support.ts', () => {
    const outside = files(SQL).flatMap((f) => imports(f).filter((i) => !inside(i, SQL) && i !== SUPPORT).map((i) => `${relative(ENGINE, f)} -> ${relative(ENGINE, i)}`));
    expect(outside).toEqual([]);
  });

  it('engine code does not import the SQL language', () => {
    const engine = files(ENGINE).filter((f) => !inside(f, SQL) && !SQL_ROOTS.includes(relative(ENGINE, f)));
    const into = engine.flatMap((f) => imports(f).filter((i) => inside(i, SQL)).map((i) => `${relative(ENGINE, f)} -> ${relative(ENGINE, i)}`));
    expect(into).toEqual([]);
  });

  it('language-support.ts does not import the SQL language', () => {
    expect(imports(SUPPORT).filter((i) => inside(i, SQL))).toEqual([]);
  });
});
