// Engine comparison in a real browser: `npm run bench:browser [-- --engines smaltdb,sqlite --rows 100000 --save]`.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadPlaywright } from '../../test/browser/playwright.mjs';
import { serve } from '../../test/browser/serve.mjs';

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const engines = arg('engines', 'smaltdb,sqlite,pglite,duckdb').split(',');
const rows = Number(arg('rows', 100000));
const lookups = Number(arg('lookups', 10000));
const smallTxns = Number(arg('small-txns', 200));
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
const env = { browser: `${browserName} ${browser.version()}`, date: new Date().toISOString(), rows, lookups, smallTxns };
console.log(`${env.browser}  rows=${rows} lookups=${lookups} smallTxns=${smallTxns}\n`);

const all = [];
for (const engine of engines) {
  const r = await page.evaluate((msg) => window.runEngine(msg), { engine, rows, lookups, smallTxns });
  all.push(r);
  if (!r.ok) {
    console.log(`== ${engine}: FAILED\n${r.error}\n`);
    continue;
  }
  console.log(`== ${r.engine}${r.version ? ' ' + r.version : ''}  [${r.config}]  open ${r.openMs.toFixed(1)} ms`);
  for (const x of r.results) {
    console.log(`  ${x.workload.padEnd(36)} ${x.ms.toFixed(1).padStart(9)} ms ${Math.round(x.opsPerSec).toLocaleString('en-US').padStart(13)} ops/s ${x.usPerOp.toFixed(2).padStart(9)} µs/op`);
  }
  console.log();
}
await browser.close();
server.close();

// Relative summary vs SQLite (the bar from ADR 0002).
const base = all.find((r) => r.ok && r.engine.startsWith('SQLite'));
if (base) {
  console.log('Speed relative to SQLite WASM (>1 = faster than SQLite):');
  for (const r of all.filter((x) => x.ok)) {
    const cells = r.results.map((x, i) => `${(base.results[i].ms / x.ms).toFixed(2)}x`);
    console.log(`  ${r.engine.padEnd(28)} ${cells.join('  ')}`);
  }
}
if (save) {
  const file = `bench/results/${env.date.slice(0, 10)}-${browserName}.json`;
  writeFileSync(file, JSON.stringify({ env, results: all }, null, 2));
  console.log(`\nsaved ${file}`);
}
