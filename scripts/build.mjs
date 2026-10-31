// Builds dist/: smaltdb.js (client), smaltdb-worker.js (engine worker), engine.js (synchronous engine for Node/workers).
import { build } from 'esbuild';

const common = { bundle: true, format: 'esm', target: 'es2022', sourcemap: true, logLevel: 'warning', minify: process.argv.includes('--minify') };
await Promise.all([
  build({ ...common, entryPoints: ['src/client/index.ts'], outfile: 'dist/smaltdb.js', platform: 'browser' }),
  build({ ...common, entryPoints: ['src/engine/worker.ts'], outfile: 'dist/smaltdb-worker.js', platform: 'browser' }),
  build({ ...common, entryPoints: ['src/engine/index.ts'], outfile: 'dist/engine.js', platform: 'neutral' }),
]);
console.log('built dist/');
