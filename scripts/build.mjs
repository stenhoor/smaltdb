// Builds dist/: smaltdb.js (client), plan.js (the plan format), smaltdb-worker.js (default engine worker), worker-runtime.js (serve() for
// application worker entries with plugins), engine.js (synchronous engine for Node/workers).
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';

// Start clean, so files from older builds are never published.
rmSync('dist', { recursive: true, force: true });

// smaltdb_version() returns the package version (src/engine/exec/functions.ts).
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const define = { __SMALTDB_VERSION__: JSON.stringify(version) };
const common = { bundle: true, format: 'esm', target: 'es2022', sourcemap: true, logLevel: 'warning', minify: process.argv.includes('--minify'), define };
// No third-party code is bundled: optional features that depend on other packages are plugins,
// published separately with their own dependencies (ADR 0012).
await Promise.all([
  build({ ...common, entryPoints: ['src/client/index.ts'], outfile: 'dist/smaltdb.js', platform: 'browser' }),
  // The default engine worker (no plugins), and the runtime applications build their own worker entry with.
  // The plan format (types, builders, codec) for clients that build plans: kept out of smaltdb.js.
  build({ ...common, entryPoints: ['src/engine/plan/portable.ts'], outfile: 'dist/plan.js', platform: 'neutral' }),
  build({ ...common, entryPoints: ['src/engine/worker.ts'], outfile: 'dist/smaltdb-worker.js', platform: 'browser' }),
  build({ ...common, entryPoints: ['src/engine/worker-runtime.ts'], outfile: 'dist/worker-runtime.js', platform: 'browser' }),
  // Node / workers: the synchronous engine.
  build({ ...common, entryPoints: ['src/engine/index.ts'], outfile: 'dist/engine.js', platform: 'neutral' }),
]);
console.log('built dist/');
