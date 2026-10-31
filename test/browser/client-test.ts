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
  (e) => ((window as unknown as { __clientResult: unknown }).__clientResult = { ok: false, error: String(e?.stack ?? e) }),
);
