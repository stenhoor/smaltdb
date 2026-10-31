// Engine comparison in a real browser.
//
//   npm run bench:browser -- [--engines smaltdb,sqlite-off,sqlite-journal] [--reps 5] [--rows 100000]
//                            [--analytic-rows 200000] [--save] [--baseline sqlite-off]
//
// Each repetition runs every engine once in a fresh worker (engine order rotates per repetition).
// Reports the median and spread per workload, and ratios versus the baseline engine with a verdict
// that only claims a difference when the min/max ranges do not overlap.
import { execSync } from 'node:child_process';
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { loadPlaywright } from '../../test/browser/playwright.mjs';
import { serve } from '../../test/browser/serve.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const ALL = ['smaltdb', 'sqlite-off', 'sqlite-wal', 'sqlite-journal', 'pglite', 'duckdb'];
const enginesArg = arg('engines', 'smaltdb,sqlite-off,sqlite-wal,sqlite-journal');
const engines = enginesArg === 'all' ? ALL : enginesArg.split(',');
const reps = Number(arg('reps', 5));
const rows = Number(arg('rows', 100000));
const lookups = Number(arg('lookups', 10000));
const smallTxns = Number(arg('small-txns', 200));
const analyticRows = Number(arg('analytic-rows', 200000));
const baseline = arg('baseline', 'sqlite-off');
const save = process.argv.includes('--save');

const out = '.cache/bench-browser';
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['bench/browser/worker.ts'], bundle: true, format: 'esm', target: 'es2022', outfile: `${out}/worker.js`, logLevel: 'warning' });
writeFileSync(`${out}/index.html`, `<!doctype html><meta charset="utf-8"><title>smaltdb bench</title><script type="module">
  window.runEngine = (msg) => new Promise((resolve) => {
    const w = new Worker('./worker.js', { type: 'module' });
    w.onmessage = (e) => { w.terminate(); resolve(e.data); };
    w.onerror = (e) => { w.terminate(); resolve({ ok: false, engine: msg.engine, error: e.message }); };
    w.postMessage(msg);
  });
</script>`);

const server = await serve({ '/nm/': 'node_modules/', '/': out });
const playwright = loadPlaywright();
const browserName = process.env.BROWSER ?? 'chromium';
const browser = await playwright[browserName].launch();
const page = await browser.newPage();
await page.goto(server.url + '/');
await page.waitForFunction(() => typeof window.runEngine === 'function');
const ua = await page.evaluate(() => `${navigator.userAgent} | cores=${navigator.hardwareConcurrency}`);
let commit = 'unknown';
try {
  commit = execSync('git rev-parse --short HEAD').toString().trim();
} catch {}
const env = {
  browser: `${browserName} ${browser.version()}`,
  userAgent: ua,
  host: `${os.cpus()[0]?.model} x${os.cpus().length}, ${Math.round(os.totalmem() / 2 ** 30)} GiB, load ${os.loadavg().map((x) => x.toFixed(2)).join('/')}`,
  commit,
  date: new Date().toISOString(),
  reps,
  rows,
  lookups,
  smallTxns,
  analyticRows,
};
console.log(`${env.browser}  commit ${commit}  reps=${reps} rows=${rows} analytic=${analyticRows}\nhost: ${env.host}\n`);

/** runs[engine] = list of successful repetition results */
const runs = Object.fromEntries(engines.map((e) => [e, []]));
const failures = [];
for (let rep = 0; rep < reps; rep++) {
  const order = engines.map((_, i) => engines[(i + rep) % engines.length]);
  for (const engine of order) {
    const r = await page.evaluate((msg) => window.runEngine(msg), { engine, rows, lookups, smallTxns, analyticRows });
    if (r.ok) runs[engine].push(r);
    else failures.push({ engine, rep, error: r.error });
    process.stdout.write(r.ok ? '.' : 'x');
  }
}
process.stdout.write('\n\n');
await browser.close();
server.close();

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const stats = (xs) => ({ median: median(xs), min: Math.min(...xs), max: Math.max(...xs), n: xs.length });

const summary = {};
for (const engine of engines) {
  const rs = runs[engine];
  if (rs.length === 0) continue;
  const workloads = rs[0].results.map((w) => w.workload);
  summary[engine] = {
    name: rs[0].engine,
    config: rs[0].config,
    atomicCommits: rs[0].atomicCommits,
    version: rs[0].version,
    open: stats(rs.map((r) => r.openMs)),
    workloads: Object.fromEntries(workloads.map((w, i) => [w, { ...stats(rs.map((r) => r.results[i].ms)), check: rs[0].results[i].check, ops: rs[0].results[i].ops }])),
  };
}

// Result agreement across engines and repetitions.
const mismatches = [];
for (const engine of Object.keys(summary)) {
  for (const r of runs[engine]) {
    for (const w of r.results) {
      const ref = summary[Object.keys(summary)[0]].workloads[w.workload];
      if (ref && w.check !== ref.check && !w.workload.startsWith('load') && !w.workload.includes('txns') && !w.workload.startsWith('bulk')) {
        mismatches.push(`${engine} / ${w.workload}: ${w.check.slice(0, 120)} vs ${ref.check.slice(0, 120)}`);
      }
    }
  }
}

const fmt = (x) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
for (const [engine, s] of Object.entries(summary)) {
  console.log(`== ${s.name}${s.version ? ' ' + s.version : ''}  [${s.config}]  atomic commits: ${s.atomicCommits ? 'yes' : 'NO'}  (n=${s.open.n})`);
  for (const [w, x] of Object.entries(s.workloads)) {
    const spread = ((x.max - x.min) / x.median) * 100;
    console.log(`  ${w.padEnd(40)} median ${fmt(x.median).padStart(8)} ms   range ${fmt(x.min)}–${fmt(x.max)} (±${spread.toFixed(0)}%)`);
  }
  console.log();
}

const base = summary[baseline];
if (base) {
  console.log(`Ratio = ${base.name} time / engine time (>1 = faster than baseline). Verdict only when ranges do not overlap.`);
  for (const [engine, s] of Object.entries(summary)) {
    if (engine === baseline) continue;
    console.log(`\n  ${s.name}${s.atomicCommits !== base.atomicCommits ? '   ⚠ different durability than baseline (commit numbers not comparable)' : ''}`);
    for (const [w, x] of Object.entries(s.workloads)) {
      const b = base.workloads[w];
      if (!b) continue;
      const ratio = b.median / x.median;
      const verdict = x.max < b.min ? 'faster' : x.min > b.max ? 'slower' : 'overlap (no clear difference)';
      console.log(`    ${w.padEnd(40)} ${ratio.toFixed(2).padStart(6)}x   ${verdict}`);
    }
  }
}
if (failures.length) console.log('\nFailures:\n' + failures.map((f) => `  ${f.engine} rep ${f.rep}: ${f.error.split('\n')[0]}`).join('\n'));
if (mismatches.length) console.log('\nRESULT MISMATCHES:\n  ' + [...new Set(mismatches)].slice(0, 10).join('\n  '));
else console.log('\nAll engines returned identical results for every read workload.');

if (save) {
  const file = `bench/results/${env.date.slice(0, 10)}-${browserName}-${commit}.json`;
  writeFileSync(file, JSON.stringify({ env, summary, failures, mismatches, raw: runs }, null, 2));
  console.log(`\nsaved ${file}`);
}
