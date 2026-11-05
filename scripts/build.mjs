// Builds dist/: smaltdb.js (client), plan.js (the plan format), smaltdb-worker.js (default engine worker), and the engine-side
// entries engine.js (synchronous engine for Node/workers), worker-runtime.js (serve() for application worker entries with
// plugins) and language.js (what a language reaches in the engine, ADR 0015), which share one copy of the engine.
// `node scripts/build.mjs --outdir <dir>` builds elsewhere (test/dist.test.ts).
import { build } from 'esbuild';
import { readFileSync, rmSync } from 'node:fs';

const at = process.argv.indexOf('--outdir');
const out = at > 0 ? process.argv[at + 1] : 'dist';
// Start clean, so files from older builds are never published.
rmSync(out, { recursive: true, force: true });

// smaltdb_version() returns the package version (src/engine/exec/functions.ts).
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
const define = { __SMALTDB_VERSION__: JSON.stringify(version) };
const common = { bundle: true, format: 'esm', target: 'es2022', sourcemap: true, logLevel: 'warning', minify: process.argv.includes('--minify'), define };
// No third-party code is bundled: optional features that depend on other packages are plugins,
// published separately with their own dependencies (ADR 0012).
await Promise.all([
  build({ ...common, entryPoints: ['src/client/index.ts'], outfile: `${out}/smaltdb.js`, platform: 'browser' }),
  // The plan format (types, builders, codec) for clients that build plans: kept out of smaltdb.js.
  build({ ...common, entryPoints: ['src/engine/plan/portable.ts'], outfile: `${out}/plan.js`, platform: 'neutral' }),
  // The default engine worker (no plugins): one self-contained file, loaded by URL.
  build({ ...common, entryPoints: ['src/engine/worker.ts'], outfile: `${out}/smaltdb-worker.js`, platform: 'browser' }),
  // The engine-side entries, split into shared chunks: a language registered through language.js is the one engine.js and
  // worker-runtime.js read (one language registry, one function registry).
  build({
    ...common,
    entryPoints: { engine: 'src/engine/index.ts', 'worker-runtime': 'src/engine/worker-runtime.ts', language: 'src/engine/language-support.ts' },
    outdir: out,
    splitting: true,
    chunkNames: 'chunks/[name]-[hash]',
    platform: 'neutral',
  }),
]);
console.log(`built ${out}/`);
