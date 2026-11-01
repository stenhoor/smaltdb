// Builds dist/: smaltdb.js (client), smaltdb-worker.js (engine worker), engine.js (synchronous engine for Node/workers).
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

// Start clean: chunk names carry content hashes, so old ones would otherwise pile up (and be published).
rmSync('dist', { recursive: true, force: true });

const common = { bundle: true, format: 'esm', target: 'es2022', sourcemap: true, logLevel: 'warning', minify: process.argv.includes('--minify') };
await Promise.all([
  build({ ...common, entryPoints: ['src/client/index.ts'], outfile: 'dist/smaltdb.js', platform: 'browser' }),
  // Code splitting: the Parquet reader (hyparquet) is a chunk the worker loads on first use.
  build({ ...common, entryPoints: { 'smaltdb-worker': 'src/engine/worker.ts' }, outdir: 'dist', splitting: true, chunkNames: 'chunks/[name]-[hash]', platform: 'browser' }),
  // Node / workers: the optional Parquet packages are resolved at run time (peer dependencies).
  build({ ...common, entryPoints: ['src/engine/index.ts'], outfile: 'dist/engine.js', platform: 'neutral', external: ['hyparquet', 'hyparquet-compressors'] }),
]);
console.log('built dist/');
