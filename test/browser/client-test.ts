// Runs on the page main thread: exercises the public client API against the real engine worker + OPFS.
import { open } from '../../src/client/index.js';
import { signV4 } from '../../src/engine/external/sign.js';

type Check = { name: string; ok: boolean; detail?: string };

async function run(): Promise<{ checks: Check[]; timings: Record<string, number> }> {
  const checks: Check[] = [];
  const timings: Record<string, number> = {};
  const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, detail: detail === undefined ? undefined : JSON.stringify(detail) });

  const db = await open('client-test', { worker: new URL('./smaltdb-worker.js', location.href) });
  await db.exec('DROP TABLE IF EXISTS items');
  await db.exec('CREATE TABLE items(id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL, qty INT)');
  let t0 = performance.now();
  await db.transaction(async (tx) => {
    for (let i = 1; i <= 2000; i++) await tx.exec('INSERT INTO items(name, price, qty) VALUES (?, ?, ?)', [`item-${i}`, i / 4, i % 7 === 0 ? null : i % 10]);
  });
  timings.insert2000InTxnMs = performance.now() - t0;

  const objs = await db.query<{ id: number; name: string }>('SELECT id, name FROM items WHERE id <= 3 ORDER BY id');
  check('object rows', JSON.stringify(objs) === JSON.stringify([{ id: 1, name: 'item-1' }, { id: 2, name: 'item-2' }, { id: 3, name: 'item-3' }]), objs);
  const arr = await db.query('SELECT count(*), sum(qty) FROM items', undefined, { rowMode: 'array' });
  check('array rows + columns', arr.length === 1 && arr[0][0] === 2000 && arr.columns[0] === 'count(*)', [arr, arr.columns]);
  const colr = await db.query('SELECT id, price, qty FROM items ORDER BY id', undefined, { rowMode: 'columnar', batchSize: 512 });
  check('columnar numeric zero-copy', colr.length === 2000 && colr.data.id instanceof Float64Array && (colr.data.id as Float64Array)[1999] === 2000, colr.length);
  check('columnar nulls preserved', Array.isArray(colr.data.qty) && (colr.data.qty as unknown[])[6] === null);

  // External data (M8): a CSV over HTTP from this page's server and a registered Blob, joined with
  // a local table, plus a materialized view caching the HTTP one.
  await db.exec('DROP MATERIALIZED VIEW IF EXISTS prices_cache; DROP EXTERNAL TABLE IF EXISTS prices; DROP CONNECTION IF EXISTS site');
  await db.registerFile('stock', new Blob(['id,qty\n1,10\n2,0\n3,7\n']));
  await db.exec(`CREATE CONNECTION site WITH (url = '${location.origin}')`);
  await db.exec("CREATE EXTERNAL TABLE prices WITH (connection = 'site', location = 'prices.csv')");
  const ext = await db.query("SELECT p.name, p.price, s.qty, i.name AS item FROM prices p JOIN read_csv('file:stock') s ON s.id = p.id JOIN items i ON i.id = p.id ORDER BY p.id", undefined, { rowMode: 'array' });
  check('external: HTTP CSV joined with a registered file and a local table', JSON.stringify(ext) === JSON.stringify([['apple', 1.5, 10, 'item-1'], ['pear, green', 2, 0, 'item-2'], ['plum', null, 7, 'item-3']]), ext);
  const extCols = await db.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'prices' ORDER BY ordinal_position", undefined, { rowMode: 'array' });
  check('external: columns inferred at creation', JSON.stringify(extCols) === JSON.stringify([['id', 'INTEGER'], ['name', 'TEXT'], ['price', 'REAL']]), extCols);
  await db.exec('CREATE MATERIALIZED VIEW prices_cache AS SELECT * FROM prices');
  const cached = await db.query('SELECT count(*), sum(price) FROM prices_cache', undefined, { rowMode: 'array' });
  check('external: cached in a materialized view', JSON.stringify(cached) === JSON.stringify([[3, 3.5]]), cached);
  // Credentials computed per request by a callback in this tab (the engine worker asks for them).
  const asked: string[] = [];
  await db.registerCredentials('site-token', { endpoint: location.origin + '/', headers: async (url) => (asked.push(url), { 'x-token': 'abc' }) });
  await db.exec(`CREATE CONNECTION site_auth WITH (url = '${location.origin}', credentials = 'site-token')`);
  await db.exec("CREATE EXTERNAL TABLE prices_auth WITH (connection = 'site_auth', location = 'prices.csv')");
  const csv = await db.exportCSV('SELECT name FROM prices_auth ORDER BY id');
  check('external: credentials callback asked per request; export over external data', csv === 'name\napple\n"pear, green"\nplum\n' && asked.length === 2 && asked[1] === location.origin + '/prices.csv', [csv, asked]);
  await db.exec('REFRESH MATERIALIZED VIEW prices_cache IF CHANGED');
  await db.exec('DROP EXTERNAL TABLE prices_auth; DROP CONNECTION site_auth');
  await db.registerCredentials('site-token', null);
  await db.exec('DROP MATERIALIZED VIEW prices_cache; DROP EXTERNAL TABLE prices; DROP CONNECTION site');
  await db.registerFile('stock', null);

  // Object-store signing (M8.2) runs on this browser's WebCrypto: AWS's published SigV4 test vector.
  const v4 = await signV4({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { Range: 'bytes=0-9' } }, { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' }, 'us-east-1', 's3', new Date('2013-05-24T00:00:00Z'));
  check('S3 request signing (SigV4 test vector) with WebCrypto', v4.authorization.endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'), v4.authorization);

  // Spill to OPFS: a tiny work_mem makes the sort and the GROUP BY go through the scratch file.
  const plain = await db.query('SELECT price % 37 AS k, count(*) AS n, sum(id) AS s FROM items GROUP BY k ORDER BY k, n', undefined, { rowMode: 'array' });
  const sorted = await db.query('SELECT name FROM items ORDER BY name DESC, id', undefined, { rowMode: 'array' });
  const spillBefore = (await db.query('PRAGMA spill_bytes', undefined, { rowMode: 'array' }))[0][0] as number;
  await db.exec('PRAGMA work_mem = 2048');
  const spilledAgg = await db.query('SELECT price % 37 AS k, count(*) AS n, sum(id) AS s FROM items GROUP BY k ORDER BY k, n', undefined, { rowMode: 'array' });
  const spilledSort = await db.query('SELECT name FROM items ORDER BY name DESC, id', undefined, { rowMode: 'array' });
  const spillAfter = (await db.query('PRAGMA spill_bytes', undefined, { rowMode: 'array' }))[0][0] as number;
  await db.exec('PRAGMA work_mem = 268435456');
  check('spill to OPFS (sort + GROUP BY)', spillAfter > spillBefore && JSON.stringify(plain) === JSON.stringify(spilledAgg) && JSON.stringify(sorted) === JSON.stringify(spilledSort) && sorted.length === 2000, [plain.length, spilledAgg.length, spillBefore, spillAfter]);

  const st = await db.prepare('SELECT name FROM items WHERE id = ?');
  t0 = performance.now();
  let found = 0;
  for (let i = 1; i <= 500; i++) found += (await st.query<{ name: string }>([i])).length;
  timings.preparedLookupRoundTripUs = ((performance.now() - t0) * 1000) / 500;
  check('prepared statement lookups', found === 500);
  await st.finalize();

  try {
    await db.transaction(async (tx) => {
      await tx.exec("INSERT INTO items(name) VALUES ('rolled-back')");
      throw new Error('boom');
    });
  } catch {
    /* expected */
  }
  const rb = await db.query("SELECT count(*) AS n FROM items WHERE name = 'rolled-back'");
  check('transaction rollback on throw', rb[0].n === 0, rb);

  try {
    await db.exec('INSERT INTO items(name) VALUES (NULL)');
    check('constraint error surfaces', false);
  } catch (e) {
    check('constraint error surfaces', (e as { code: string }).code === 'SMALT_CONSTRAINT_NOTNULL', String(e));
  }
  // CSV / JSON import and export through the worker (bytes transferred, Blob source).
  const imported = await db.importCSV('people', new Blob(['id,name,age\n1,"Lee, A",31\n2,Kim,\n']), { create: true });
  const asJson = await db.exportJSON('SELECT id, name, age FROM people ORDER BY id');
  check('import CSV / export JSON', imported.rows === 2 && asJson === '[{"id":1,"name":"Lee, A","age":31},{"id":2,"name":"Kim","age":null}]', [imported, asJson]);
  await db.importJSON('people', '{"id":3,"name":"Ng"}\n');
  const asCsv = await db.exportCSV('SELECT id, name FROM people WHERE id > ?', [1]);
  check('import NDJSON / export CSV', asCsv === 'id,name\n2,Kim\n3,Ng\n', asCsv);

  // Streaming with backpressure: batches arrive as they are consumed; leaving early closes the stream.
  let streamed = 0;
  let batches = 0;
  for await (const rows of db.stream<{ id: number }>('SELECT id FROM items ORDER BY id', undefined, { batchSize: 100, highWaterMark: 2 })) {
    streamed += rows.length;
    batches++;
  }
  check('stream delivers every row in batches', streamed === 2000 && batches === 20, [streamed, batches]);
  let early = 0;
  for await (const rows of db.stream('SELECT id FROM items', undefined, { batchSize: 50 })) {
    early += rows.length;
    if (early >= 100) break;
  }
  const afterBreak = await db.exec("UPDATE items SET qty = qty WHERE id = 1");
  check('breaking out of a stream releases it (writes allowed again)', early === 100 && afterBreak.changes === 1, early);
  // A stream served by the owner holds a cursor there: this tab's own writes fail fast instead of
  // deadlocking. A stream served by a parallel reader reads a snapshot: writes go ahead.
  const before = db.stats.readerQueries;
  const it = db.stream('SELECT id FROM items', undefined, { batchSize: 10, highWaterMark: 1 });
  await it.next();
  const onReader = db.stats.readerQueries > before;
  let busy = '';
  try {
    await db.exec("UPDATE items SET qty = qty WHERE id = 1");
  } catch (e) {
    busy = (e as { code: string }).code;
  }
  await it.return!();
  check(`own write during an open stream (${onReader ? 'reader: proceeds' : 'owner: SMALT_BUSY'})`, onReader ? busy === '' : busy === 'SMALT_BUSY', busy);

  // Cancellation: a running statement is interrupted (shared-memory flag) and rolled back.
  await db.exec('CREATE TABLE big(a INT, b TEXT)');
  await db.exec("WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 200000) INSERT INTO big SELECT i, hex(randomblob(16)) FROM n");
  const ac = new AbortController();
  t0 = performance.now();
  const slow = db.exec("UPDATE big SET b = b || b || b", undefined, { signal: ac.signal });
  setTimeout(() => ac.abort(), 5);
  let code = '';
  try {
    await slow;
  } catch (e) {
    code = (e as { code: string }).code;
  }
  timings.cancelLatencyMs = performance.now() - t0;
  const unchanged = await db.query('SELECT max(length(b)) AS m FROM big');
  check('abort interrupts a running statement and rolls it back', code === 'SMALT_INTERRUPT' && unchanged[0].m === 32, [code, unchanged]);
  const pre = new AbortController();
  pre.abort();
  let preCode = '';
  try {
    await db.query('SELECT 1', undefined, { signal: pre.signal });
  } catch (e) {
    preCode = (e as { code: string }).code;
  }
  check('already-aborted signal rejects at once', preCode === 'SMALT_INTERRUPT', preCode);
  // Parallel readers (Chromium: shared OPFS handles): concurrent queries agree with serial ones.
  const qs = [
    'SELECT count(*), sum(a) FROM big WHERE a % 3 = 0',
    'SELECT count(*), max(b) FROM big WHERE a > 1000',
    'SELECT a % 7, count(*) FROM big GROUP BY 1 ORDER BY 1',
    'SELECT sum(length(b)) FROM big',
  ];
  const all = [...qs, ...qs];
  const serial: unknown[] = [];
  t0 = performance.now();
  for (const q of all) serial.push(await db.query(q, undefined, { rowMode: 'array' }));
  timings.serial8QueriesMs = performance.now() - t0;
  const r0 = db.stats.readerQueries;
  t0 = performance.now();
  const parallel = await Promise.all(all.map((q) => db.query(q, undefined, { rowMode: 'array' })));
  timings.concurrent8QueriesMs = performance.now() - t0;
  timings.servedByReaders = db.stats.readerQueries - r0;
  // Warm: readers have their caches and compiled code now.
  for (let round = 0; round < 2; round++) {
    t0 = performance.now();
    await Promise.all(all.map((q) => db.query(q, undefined, { rowMode: 'array' })));
    timings[`concurrent8WarmMs${round}`] = performance.now() - t0;
  }
  t0 = performance.now();
  for (const q of all) await db.query(q, undefined, { rowMode: 'array' });
  timings.serial8WarmMs = performance.now() - t0;
  check('concurrent queries return the same results', JSON.stringify(parallel) === JSON.stringify(serial));
  const caps = (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated;
  if (timings.servedByReaders > 0) {
    // Snapshot isolation: a reader's stream keeps its snapshot while the owner commits.
    // A second request queued behind the stream is concurrent demand: the stream goes to a reader.
    // Whether the second request is still queued when the owner picks the stream up depends on
    // message timing between page and worker, so a stream that lands on the owner is closed and
    // the attempt repeated. (The concurrent request is a PRAGMA, which always runs on the owner,
    // so the reader count tells exactly where the stream went.)
    let s2: AsyncIterableIterator<{ n: number }[]> | null = null;
    let firstBatch: { n: number }[] = [];
    for (let attempt = 0; attempt < 10 && s2 === null; attempt++) {
      const r1 = db.stats.readerQueries;
      const s = db.stream<{ n: number }>('SELECT a AS n FROM big ORDER BY a', undefined, { batchSize: 1000, highWaterMark: 1 });
      const first = s.next();
      const other = db.query('PRAGMA page_size');
      firstBatch = (await first).value as { n: number }[];
      await other;
      if (db.stats.readerQueries > r1) s2 = s;
      else await s.return?.(undefined); // served by the owner this time: close it and try again
    }
    check('a stream issued under concurrent demand is served by a reader', s2 !== null);
    if (s2 === null) throw new Error('no stream was served by a reader in 10 attempts');
    await db.exec('UPDATE big SET a = -a');
    let total = firstBatch.reduce((x, r) => x + r.n, 0);
    for await (const rows of s2) for (const r of rows) total += r.n;
    const now = await db.query('SELECT sum(a) AS s FROM big');
    check('a reader stream keeps its snapshot while the owner writes', total === 20000100000 && now[0].s === -20000100000, [total, now]);
    // PRAGMA settings reach the readers (separate connections): with matview_rewrite turned on at
    // the owner, a query served by a reader is answered from the view. As above, the query goes to a
    // reader only if the concurrent PRAGMA is still queued, so it is repeated until one served it.
    await db.exec('CREATE MATERIALIZED VIEW big_mv AS SELECT a % 7 AS k, count(*) AS n FROM big GROUP BY a % 7');
    await db.exec('PRAGMA matview_rewrite = 1');
    let readerPlan: unknown[][] | null = null;
    for (let attempt = 0; attempt < 20 && readerPlan === null; attempt++) {
      const r1 = db.stats.readerQueries;
      const plan = db.query('EXPLAIN QUERY PLAN SELECT a % 7, count(*) FROM big GROUP BY a % 7', undefined, { rowMode: 'array' });
      const other = db.query('PRAGMA page_size');
      const rows = await plan;
      await other;
      if (db.stats.readerQueries > r1) readerPlan = rows;
      else await new Promise((r) => setTimeout(r, 20)); // let the readers report idle
    }
    check('PRAGMA matview_rewrite set on the owner applies on readers', readerPlan !== null && JSON.stringify(readerPlan).includes('big_mv'), readerPlan);
    await db.exec('PRAGMA matview_rewrite = 0');
    await db.exec('DROP MATERIALIZED VIEW big_mv');
    // Morsel parallelism: a large aggregate runs as partial aggregates on the readers, merged by the owner.
    await db.exec('CREATE TABLE huge(id INTEGER PRIMARY KEY, g INT, x REAL)');
    await db.exec('WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 600000) INSERT INTO huge SELECT i, i % 50, i / 3.0 FROM n');
    const aggSql = 'SELECT g, count(*), sum(x), avg(x) FROM huge WHERE x > 10 GROUP BY g ORDER BY g';
    const ownerSql = aggSql;
    const rounded = (rows: unknown[][]) => JSON.stringify(rows, (_k, v) => (typeof v === 'number' ? Math.round(v * 1000) / 1000 : v));
    await db.exec('PRAGMA parallel_aggregates = 0');
    const ownerRows = await db.query(ownerSql, undefined, { rowMode: 'array' });
    await db.exec('PRAGMA parallel_aggregates = 1');
    // Morsels need at least two idle readers. Readers report "idle" asynchronously, so a query
    // right after another one may find them still busy and run on the owner: each measured run
    // retries (after a pause) until it was served as morsels, and only morsel runs are timed.
    const morselRun = async (): Promise<{ rows: unknown[][]; ms: number } | null> => {
      for (let attempt = 0; attempt < 20; attempt++) {
        const m0 = db.stats.morselQueries;
        const t = performance.now();
        const rows = await db.query(aggSql, undefined, { rowMode: 'array' });
        const ms = performance.now() - t;
        if (db.stats.morselQueries > m0) return { rows, ms };
        await new Promise((r) => setTimeout(r, 20));
      }
      return null;
    };
    await morselRun(); // warm-up
    let morselRows: unknown[][] = [];
    let usedMorsels = 0;
    let morselMs = 0;
    for (let i = 0; i < 3; i++) {
      const run = await morselRun();
      if (!run) break;
      usedMorsels++;
      morselMs += run.ms;
      morselRows = run.rows;
    }
    timings.morselAggregateMs = morselMs / Math.max(1, usedMorsels);
    await db.exec('PRAGMA parallel_aggregates = 0');
    t0 = performance.now();
    for (let i = 0; i < 3; i++) await db.query(ownerSql, undefined, { rowMode: 'array' });
    timings.ownerAggregateMs = (performance.now() - t0) / 3;
    await db.exec('PRAGMA parallel_aggregates = 1');
    check('morsels: a large aggregate is split across readers and merged', usedMorsels === 3 && rounded(morselRows) === rounded(ownerRows), [usedMorsels, morselRows.length]);
    await db.exec('DROP TABLE huge');
  } else check(`parallel readers not available here (isolated: ${caps})`, true);
  await db.exec('DROP TABLE big');
  await db.close();

  // Reopen: data persisted in OPFS.
  const db2 = await open('client-test', { worker: new URL('./smaltdb-worker.js', location.href) });
  const n = await db2.query('SELECT count(*) AS n FROM items');
  check('persisted across close/reopen', n[0].n === 2000, n);
  await db2.exec('DROP TABLE items');
  await db2.close();
  return { checks, timings };
}

run().then(
  (r) => ((window as unknown as { __clientResult: unknown }).__clientResult = { ok: true, ...r }),
  (e) => ((window as unknown as { __clientResult: unknown }).__clientResult = { ok: false, error: `${e?.name ?? 'Error'}: ${e?.message ?? String(e)}${e?.code ? ' [' + e.code + ']' : ''}${e?.stack ? '\n' + e.stack : ''}` }),
);
