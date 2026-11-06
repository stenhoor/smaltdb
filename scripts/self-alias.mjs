// smaltdb's own entry points, resolved to this repository's source: for packages built on smaltdb that the tests,
// benchmarks and browser tests use (smaltql, pinned in packed.json), so they run on this checkout's engine.
// Specifiers match exactly (`smaltdb` must not also match `smaltdb/engine`).
import { fileURLToPath } from 'node:url';

const src = (path) => fileURLToPath(new URL(`../src/${path}`, import.meta.url));

const ENTRIES = {
  smaltdb: src('client/index.ts'),
  'smaltdb/engine': src('engine/index.ts'),
  'smaltdb/plan': src('engine/plan/portable.ts'),
  'smaltdb/language': src('engine/language-support.ts'),
  'smaltdb/worker-runtime': src('engine/worker-runtime.ts'),
};

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** vite / vitest `resolve.alias`. */
export const selfAlias = Object.entries(ENTRIES).map(([find, replacement]) => ({ find: new RegExp(`^${escape(find)}$`), replacement }));

/** An esbuild plugin with the same mapping. */
export const selfAliasPlugin = {
  name: 'smaltdb-self',
  setup(build) {
    build.onResolve({ filter: /^smaltdb(\/[a-z-]+)?$/ }, (args) => (ENTRIES[args.path] ? { path: ENTRIES[args.path] } : undefined));
  },
};
