// Runs the OPFS integration test in a real browser via Playwright: `npm run test:browser`.
// Uses the pre-installed Chromium; set BROWSERS=chromium,firefox,webkit when those are installed.
import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPlaywright } from './playwright.mjs';
import { serve } from './serve.mjs';

const playwright = loadPlaywright();

const out = '.cache/browser-test';
mkdirSync(out, { recursive: true });
await build({ entryPoints: ['test/browser/opfs-worker.ts'], bundle: true, format: 'esm', target: 'es2022', outfile: `${out}/opfs-worker.js`, logLevel: 'warning' });
// The plugins (ADR 0012) come from their pinned packages in node_modules (scripts/fetch-packed.mjs).
await build({ entryPoints: ['test/browser/client-test.ts'], bundle: true, format: 'esm', target: 'es2022', outfile: `${out}/client-test.js`, logLevel: 'warning' });
await build({ entryPoints: ['test/browser/tab-test.ts'], bundle: true, format: 'esm', target: 'es2022', outfile: `${out}/tab-test.js`, logLevel: 'warning' });
await build({ entryPoints: ['src/engine/worker.ts'], bundle: true, format: 'esm', target: 'es2022', outfile: `${out}/smaltdb-worker.js`, logLevel: 'warning' });
// A worker entry with plugins, as applications write it (ADR 0012); the client test reads external data and CSV through it.
// Parquet, and hosts that compress responses (issue #32), are tested in the browser by stenhoor/smaltdb-parquet.
await build({ entryPoints: ['test/browser/plugin-worker.ts'], bundle: true, format: 'esm', target: 'es2022', outfile: `${out}/plugin-worker.js`, logLevel: 'warning' });
// External data (M8): a CSV the client test reads over HTTP from this server.
writeFileSync(`${out}/prices.csv`, 'id,name,price\n1,apple,1.5\n2,"pear, green",2\n3,plum,\n');
writeFileSync(`${out}/tab.html`, '<!doctype html><meta charset="utf-8"><title>smaltdb tab</title><script type="module" src="./tab-test.js"></script>');
writeFileSync(`${out}/client.html`, '<!doctype html><meta charset="utf-8"><title>smaltdb client test</title><script type="module" src="./client-test.js"></script>');
writeFileSync(
  `${out}/index.html`,
  `<!doctype html><meta charset="utf-8"><title>smaltdb browser test</title><script type="module">
    const w = new Worker('./opfs-worker.js', { type: 'module' });
    w.onmessage = (e) => { window.__result = e.data; };
    // WebKit reports module-load failures with an empty message: include whatever location info exists.
    w.onerror = (e) => { window.__result = { ok: false, error: (e.message || 'worker error with no message') + (e.filename ? ' at ' + e.filename + ':' + e.lineno + ':' + e.colno : '') }; };
    w.onmessageerror = () => { window.__result = { ok: false, error: 'worker message could not be deserialized' }; };
  </script>`,
);

const server = await serve({ '/': out });
const names = (process.env.BROWSERS ?? 'chromium').split(',');
let failed = false;
for (const name of names) {
  // WebKit's default contexts are ephemeral (like private browsing), where OPFS may be unavailable:
  // use a persistent profile there.
  const persistent = name === 'webkit' || !!process.env.PERSISTENT_CONTEXT;
  const browser = persistent ? null : await playwright[name].launch();
  const context = persistent ? await playwright[name].launchPersistentContext(mkdtempSync(join(tmpdir(), 'smaltdb-' + name + '-'))) : await browser.newContext();
  const page = context.pages()[0] ?? (await context.newPage());
  // Collected for diagnostics: printed when a test fails or times out.
  const log = [];
  page.on('console', (m) => log.push(`console.${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => log.push(`pageerror: ${e.stack ?? e.message}`));
  page.on('worker', (w) => { log.push(`worker started: ${w.url()}`); w.on('console', (m) => process.env.WORKER_LOG && console.log('W', m.text())); });
  page.on('requestfailed', (r) => log.push(`request failed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  const waitFor = async (expr, what) => {
    try {
      await page.waitForFunction(expr, null, { timeout: 60_000 });
      return true;
    } catch (e) {
      log.push(`timeout waiting for ${what}: ${e.message.split('\n')[0]}`);
      return false;
    }
  };
  await page.goto(server.url + '/');
  const result = (await waitFor(() => window.__result !== undefined, 'OPFS worker result').then(async (ok) => {
    if (!ok) return { ok: false, error: 'no result from the OPFS worker' };
    return page.evaluate(() => window.__result);
  })) ?? { ok: false, error: 'empty result' };
  // Client API test (main thread -> engine worker -> OPFS).
  await page.goto(server.url + '/client.html');
  const client = (await waitFor(() => window.__clientResult !== undefined, 'client result'))
    ? await page.evaluate(() => window.__clientResult)
    : { ok: false, error: 'no result from the client test' };
  if (client.ok) {
    result.checks?.push(...client.checks.map((c) => ({ ...c, name: 'client: ' + c.name })));
    Object.assign(result.timings ?? {}, Object.fromEntries(Object.entries(client.timings).map(([k, v]) => ['client.' + k, v])));
  } else if (result.ok) {
    result.checks.push({ name: 'client test ran', ok: false, detail: client.error });
  }
  // Multi-tab: several pages of one context share a database through the leader's engine worker.
  try {
    for (const c of await multiTab(context, server.url)) result.checks?.push({ ...c, name: 'tabs: ' + c.name });
  } catch (e) {
    result.checks?.push({ name: 'tabs: test ran', ok: false, detail: String(e?.stack ?? e) });
  }
  const version = browser ? browser.version() : `${playwright[name].name()} (persistent profile)`;
  await context.close();
  await browser?.close();
  console.log(`\n== ${name} ${version}`);
  if (!result.ok) {
    console.log('FAIL  ' + (result.error || JSON.stringify(result)));
    if (!client.ok) console.log('FAIL  client: ' + (client.error || JSON.stringify(client)));
    for (const l of log) console.log('  ' + l);
    failed = true;
    continue;
  }
  if (result.checks.some((c) => !c.ok)) for (const l of log) console.log('  ' + l);
  for (const c of result.checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail && !c.ok ? `  (${c.detail})` : ''}`);
    if (!c.ok) failed = true;
  }
  console.log('timings', JSON.stringify(result.timings, (k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v)));
  console.log('capabilities', JSON.stringify(result.capabilities));
}
server.close();
process.exit(failed ? 1 : 0);

async function multiTab(context, url) {
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });
  const tab = async () => {
    const p = await context.newPage();
    await p.goto(url + '/tab.html');
    await p.waitForFunction(() => window.tabReady === true);
    return p;
  };
  const call = (p, fn, ...args) => p.evaluate(([f, a]) => window.tab[f](...a), [fn, args]);
  const db = 'tabs-' + Date.now();
  const A = await tab();
  const B = await tab();
  check('first tab owns the database', (await call(A, 'open', db)) === true);
  check('second tab joins as a client', (await call(B, 'open', db)) === false);
  await call(B, 'exec', 'CREATE TABLE t(a INT)');
  await call(B, 'exec', 'INSERT INTO t VALUES (?)', [1]);
  check("one tab's writes are visible to the other", JSON.stringify(await call(A, 'query', 'SELECT sum(a) FROM t')) === '[[1]]');
  // A transaction belongs to its tab: the other tab waits until it ends.
  await call(A, 'exec', 'BEGIN; INSERT INTO t VALUES (10)');
  await call(B, 'startQuery', 'SELECT sum(a) FROM t');
  await new Promise((r) => setTimeout(r, 300));
  const waiting = await B.evaluate(() => window.__pending.done);
  await call(A, 'exec', 'COMMIT');
  await B.waitForFunction(() => window.__pending.done === true);
  const seen = await B.evaluate(() => window.__pending.rows);
  check("other tabs wait for a tab's transaction, then see its commit", waiting === false && JSON.stringify(seen) === '[[11]]', [waiting, seen]);
  // A tab that disappears mid-transaction: its transaction is rolled back.
  await call(B, 'exec', 'BEGIN; INSERT INTO t VALUES (100)');
  await B.close();
  let afterB = null;
  for (let i = 0; i < 50 && JSON.stringify(afterB) !== '[[11]]'; i++) {
    afterB = await call(A, 'query', 'SELECT sum(a) FROM t').catch((e) => String(e));
    await new Promise((r) => setTimeout(r, 100));
  }
  check("a closed tab's open transaction is rolled back", JSON.stringify(afterB) === '[[11]]', afterB);
  // Failover: the owner closes; a waiting tab takes over and recovers the committed data.
  const C = await tab();
  check('third tab joins as a client', (await call(C, 'open', db)) === false);
  await A.close();
  let leader = false;
  for (let i = 0; i < 50 && !leader; i++) {
    leader = await call(C, 'isLeader');
    await new Promise((r) => setTimeout(r, 100));
  }
  let rows = null;
  for (let i = 0; i < 20; i++) {
    rows = await call(C, 'query', 'SELECT sum(a) FROM t').catch((e) => String(e));
    if (Array.isArray(rows)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  check('another tab takes over when the owner closes, with all committed data', leader && JSON.stringify(rows) === '[[11]]', [leader, rows]);
  await call(C, 'exec', 'DROP TABLE t');
  await call(C, 'close');
  await C.close();
  return checks;
}
