// Runs the OPFS integration test in a real browser via Playwright: `npm run test:browser`.
// Uses the pre-installed Chromium; set BROWSERS=chromium,firefox,webkit when those are installed.
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { loadPlaywright } from './playwright.mjs';
import { serve } from './serve.mjs';

const playwright = loadPlaywright();

const out = '.cache/browser-test';
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['test/browser/opfs-worker.ts'], bundle: true, format: 'esm', target: 'es2022', outfile: `${out}/opfs-worker.js`, logLevel: 'warning' });
writeFileSync(
  `${out}/index.html`,
  `<!doctype html><meta charset="utf-8"><title>smaltdb browser test</title><script type="module">
    const w = new Worker('./opfs-worker.js', { type: 'module' });
    w.onmessage = (e) => { window.__result = e.data; };
    w.onerror = (e) => { window.__result = { ok: false, error: e.message }; };
  </script>`,
);

const server = await serve({ '/': out });
const names = (process.env.BROWSERS ?? 'chromium').split(',');
let failed = false;
for (const name of names) {
  const browser = await playwright[name].launch();
  const page = await browser.newPage();
  await page.goto(server.url + '/');
  await page.waitForFunction(() => window.__result !== undefined, null, { timeout: 120_000 });
  const result = await page.evaluate(() => window.__result);
  const version = browser.version();
  await browser.close();
  console.log(`\n== ${name} ${version}`);
  if (!result.ok) {
    console.log(result.error);
    failed = true;
    continue;
  }
  for (const c of result.checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail && !c.ok ? `  (${c.detail})` : ''}`);
    if (!c.ok) failed = true;
  }
  console.log('timings', JSON.stringify(result.timings, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)));
  console.log('capabilities', JSON.stringify(result.capabilities));
}
server.close();
process.exit(failed ? 1 : 0);
