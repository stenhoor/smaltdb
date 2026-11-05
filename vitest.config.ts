import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

// smaltdb_version() returns the package version, injected like scripts/build.mjs does.
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

export default defineConfig({
  define: { __SMALTDB_VERSION__: JSON.stringify(version) },
  test: {
    include: ['test/**/*.test.ts'],
    setupFiles: ['test/setup-sql.ts'],
  },
});
