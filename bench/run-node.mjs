// Bundles and runs the Node micro benchmarks: `npm run bench [-- --json out.json]`.
import { build } from 'esbuild';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const outfile = '.cache/bench-node.mjs';
await build({
  stdin: {
    contents: `
      import { storageBenchmarks } from './bench/micro/storage.ts';
      import { formatResults } from './bench/lib/harness.ts';
      export async function main() { const r = await storageBenchmarks(); console.log(formatResults(r)); return r; }`,
    resolveDir: process.cwd(),
    loader: 'ts',
  },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile,
  logLevel: 'warning',
});
const { main } = await import(pathToFileURL(outfile).href);
console.log(`node ${process.version}\n`);
const results = await main();
const i = process.argv.indexOf('--json');
if (i > 0) writeFileSync(process.argv[i + 1], JSON.stringify({ env: `node ${process.version}`, results }, null, 2));
