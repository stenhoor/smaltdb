// Builds one plugin (run from its folder, plugins/<name>): dist/index.js and dist/index.d.ts.
// Third-party packages are never bundled: they stay imports, installed by npm with their own licences (ADR 0012).
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

rmSync('dist', { recursive: true, force: true });
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const external = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}), 'smaltdb/*'];
// src/index.ts is the plugin (for the engine); src/client.ts, when present, the helpers applications call.
await build({
  entryPoints: ['src/index.ts', ...(existsSync('src/client.ts') ? ['src/client.ts'] : [])],
  outdir: 'dist',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  sourcemap: true,
  external,
  define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version) },
  logLevel: 'warning',
});
// Declarations: types from smaltdb/engine stay imports of the smaltdb package; they are checked against the
// core's built declarations (dist/types: run the core's build:types first, as `npm run build` does).
writeFileSync(
  'tsconfig.build.json',
  JSON.stringify({
    extends: '../../tsconfig.json',
    compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, outDir: 'dist', rootDir: 'src', paths: { 'smaltdb/engine': ['../../dist/types/engine/index.d.ts'] } },
    include: ['src'],
  }),
);
try {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  execFileSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { stdio: 'inherit' });
} finally {
  rmSync('tsconfig.build.json');
}
console.log(`built ${pkg.name}`);
