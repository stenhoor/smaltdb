// Engine comparison in Node, against native SQLite (node:sqlite): the "most aggressive" baseline, compiled C with
// no WebAssembly and no browser. The browser harness (bench/browser/run.mjs) is the like-for-like comparison with
// SQLite WASM; both run the same workloads (bench/shared/workloads.ts) and report the same way.
//
//   npm run bench:native -- [--engines smaltdb,native-wal,...] [--reps 5] [--rows 100000] [--analytic-rows 200000]
//                           [--no-joins] [--no-indexes] [--no-matviews] [--baseline native-wal] [--save]
//
// Engines: smaltdb (Node file VFS, fsync on flush), smaltdb-mem, native-wal (WAL, synchronous=FULL: smaltdb's
// durability), native-wal-normal (WAL, synchronous=NORMAL: commits fsync at checkpoints only), native-mem,
// sqlite-wasm-mem (SQLite WASM in Node, to separate WebAssembly from the engine).
// In-memory view: --engines smaltdb-mem,native-mem,sqlite-wasm-mem --baseline native-mem
//
// Each repetition runs every engine once in a fresh Node process (engine order rotates per repetition).
import { execFileSync, execSync } from 'node:child_process';
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import { report } from '../lib/report.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const ALL = ['smaltdb', 'native-wal', 'native-wal-normal', 'smaltdb-mem', 'native-mem', 'sqlite-wasm-mem'];
const enginesArg = arg('engines', ALL.join(','));
const engines = enginesArg === 'all' ? ALL : enginesArg.split(',');
const reps = Number(arg('reps', 5));
const opts = {
  rows: Number(arg('rows', 100000)),
  lookups: Number(arg('lookups', 10000)),
  smallTxns: Number(arg('small-txns', 200)),
  analyticRows: Number(arg('analytic-rows', 200000)),
  joins: !process.argv.includes('--no-joins'),
  indexes: !process.argv.includes('--no-indexes'),
  matviews: !process.argv.includes('--no-matviews'),
};
const baseline = arg('baseline', engines.includes('native-wal') ? 'native-wal' : engines[engines.length - 1]);
const save = process.argv.includes('--save');

const out = '.cache/bench-node';
mkdirSync(out, { recursive: true });
const bundle = `${out}/engine.mjs`;
await build({
  entryPoints: ['bench/node/engine.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  outfile: bundle,
  external: ['node:sqlite', '@sqlite.org/sqlite-wasm'],
  logLevel: 'warning',
});

let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD').toString().trim();
} catch {}
const env = {
  runtime: `node ${process.version}`,
  host: `${os.cpus()[0]?.model} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GiB, load ${os.loadavg().map((x) => x.toFixed(2)).join('/')}`,
  storage: process.env.BENCH_DIR ?? os.tmpdir(),
  commit,
  date: new Date().toISOString(),
  reps,
  ...opts,
};
console.log(`${env.runtime}  commit ${commit}  reps=${reps} rows=${opts.rows} analytic=${opts.analyticRows}\nhost: ${env.host}\nfiles: ${env.storage}\n`);

const runs = Object.fromEntries(engines.map((e) => [e, []]));
const failures = [];
for (let rep = 0; rep < reps; rep++) {
  const order = engines.map((_, i) => engines[(i + rep) % engines.length]);
  for (const engine of order) {
    let r;
    try {
      const stdout = execFileSync(process.execPath, ['--no-warnings', bundle, engine, JSON.stringify(opts)], { encoding: 'utf8', maxBuffer: 1 << 28 });
      r = JSON.parse(stdout.trim().split('\n').pop());
    } catch (e) {
      r = { ok: false, engine, error: String(e?.stderr || e?.message || e) };
    }
    if (r.ok) runs[engine].push(r);
    else failures.push({ engine, rep, error: r.error });
    process.stdout.write(r.ok ? '.' : 'x');
  }
}
process.stdout.write('\n\n');

const suffix = engines.every((e) => e.endsWith('-mem')) ? '-mem' : '';
report({ engines, runs, failures, baseline, env, file: save ? `bench/results/${env.date.slice(0, 10)}-node-${commit}${suffix}.json` : undefined });
