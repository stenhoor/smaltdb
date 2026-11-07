import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { selfAlias } from './scripts/self-alias.mjs';

const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

// The engine with no SQL (ADR 0017): no language is registered here, unlike the main project (test/setup-sql.ts).
// Everything these tests run goes through plans, the client and the worker server, and the plugins in packed.json.
export default defineConfig({
  define: { __SMALTDB_VERSION__: JSON.stringify(version) },
  resolve: { alias: selfAlias },
  test: {
    include: ['test/no-sql/**/*.test.ts'],
    setupFiles: [],
  },
});
