import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';
import { selfAlias } from './scripts/self-alias.mjs';

// smaltdb_version() returns the package version, injected like scripts/build.mjs does.
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

export default defineConfig({
  define: { __SMALTDB_VERSION__: JSON.stringify(version) },
  // SQL comes from smaltql (packed.json): its imports of smaltdb resolve to this repository's source, so tests have one
  // engine. vitest transforms smaltql (inline) so the aliases apply to it.
  resolve: { alias: selfAlias },
  test: {
    server: { deps: { inline: [/node_modules\/@smaltworks\/smaltql\//] } },
    include: ['test/**/*.test.ts'],
    // test/no-sql runs with no language registered: vitest.no-sql.config.ts (ADR 0017).
    exclude: ['test/no-sql/**', '**/node_modules/**'],
    setupFiles: ['test/setup-sql.ts'],
  },
});
