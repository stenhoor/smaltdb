import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// smaltdb_version() returns the package version, injected like scripts/build.mjs does.
const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const plugin = (name: string): string => fileURLToPath(new URL(`./plugins/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  define: { __SMALTDB_VERSION__: JSON.stringify(version) },
  // Plugins (ADR 0012) are tested from source.
  resolve: { alias: { '@smaltdb/parquet': plugin('parquet') } },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
