// Runs on the page main thread: exercises the public client API against the real engine worker + OPFS.
import { open } from '../../src/client/index.js';

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
  // While a stream is open, this tab's own writes fail fast instead of deadlocking.
  const it = db.stream('SELECT id FROM items', undefined, { batchSize: 10, highWaterMark: 1 });
  await it.next();
  let busy = '';
  try {
    await db.exec("UPDATE items SET qty = 0 WHERE id = 1");
  } catch (e) {
    busy = (e as { code: string }).code;
  }
  await it.return!();
  check('own write during an open stream is SMALT_BUSY', busy === 'SMALT_BUSY', busy);

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
