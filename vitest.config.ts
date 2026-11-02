import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// smaltdb_version() returns the package version, injected like scripts/build.mjs does.
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const src = (path: string): string => fileURLToPath(new URL(`./plugins/${path}`, import.meta.url));

export default defineConfig({
  define: { __SMALTDB_VERSION__: JSON.stringify(version) },
  // Plugins (ADR 0012) are tested from source.
  resolve: {
    alias: [
      { find: /^@smaltdb\/(parquet|io|external)\/client$/, replacement: src('$1/src/client.ts') },
      { find: /^@smaltdb\/(parquet|io|external)$/, replacement: src('$1/src/index.ts') },
    ],
  },
  test: {
    include: ['test/**/*.test.ts', 'plugins/*/test/**/*.test.ts'],
  },
});
