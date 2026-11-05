/**
 * The published engine-side entries (scripts/build.mjs): engine.js, worker-runtime.js and language.js share one copy of
 * the engine, so a language registered through `smaltdb/language` is the one a database from `smaltdb/engine` reads
 * (ADR 0015 step 9).
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const out = mkdtempSync(join(tmpdir(), 'smaltdb-dist-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

type Db = { prepare(text: string): { all(): unknown[][] } };

describe('dist', () => {
  it('engine.js, worker-runtime.js and language.js share one engine', async () => {
    execFileSync(process.execPath, ['scripts/build.mjs', '--outdir', out], { stdio: 'pipe' });
    const load = (f: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ pathToFileURL(join(out, f)).href);
    const engine = await load('engine.js');
    const language = await load('language.js');
    expect(typeof (await load('worker-runtime.js')).serve).toBe('function');
    expect(language.SmaltError).toBe(engine.SmaltError);

    const { Database } = engine as unknown as { Database: { openMemory(): Db } };
    expect(Database.openMemory().prepare('SELECT 1').all()).toEqual([[1]]);
    // A language registered through language.js replaces the SQL engine.js registered: the registry is shared.
    const registerLanguage = language.registerLanguage as (l: unknown) => void;
    registerLanguage({
      name: 'sql',
      parseOne: () => {
        throw new Error('read through language.js');
      },
    });
    expect(() => Database.openMemory().prepare('SELECT 1')).toThrow('read through language.js');
  });
});
