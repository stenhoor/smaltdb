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

  it('no source file imports a language', () => {
    const into = files(SRC).flatMap((f) => packages(f).filter((p) => /^smaltql(\/|$)/.test(p)).map((p) => `${relative(SRC, f)} -> ${p}`));
    expect(into).toEqual([]);
  });
});
