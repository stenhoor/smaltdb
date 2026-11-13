// Bundles and runs one micro benchmark: `npm run bench:micro -- <name> [args…]` runs bench/micro/<name>.ts with args.
// SQL comes from smaltql (packed.json), and its imports of smaltdb resolve to this checkout's source, as in the tests
// and the other benchmarks: a plain esbuild bundle would run smaltql on the pinned smaltdb build instead.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { selfAliasPlugin } from '../../scripts/self-alias.mjs';

const [name, ...args] = process.argv.slice(2);
const names = readdirSync('bench/micro').filter((f) => f.endsWith('.ts') && f !== 'storage.ts').map((f) => f.slice(0, -3));
if (!name || !existsSync(`bench/micro/${name}.ts`) || name === 'storage') {
  console.error(`usage: npm run bench:micro -- <name> [args…]\n  names: ${names.join(', ')}\n  (storage runs with npm run bench)`);
  process.exit(1);
}
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
mkdirSync('.cache/bench-micro', { recursive: true });
const outfile = `.cache/bench-micro/${name}.mjs`;
await build({
  entryPoints: [`bench/micro/${name}.ts`],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'es2022',
  outfile,
  external: ['@sqlite.org/sqlite-wasm', 'node:sqlite'],
  plugins: [selfAliasPlugin],
  define: { __SMALTDB_VERSION__: JSON.stringify(version) },
  logLevel: 'warning',
});
execFileSync(process.execPath, ['--no-warnings', outfile, ...args], { stdio: 'inherit' });
