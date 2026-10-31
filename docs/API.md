# Public API

> Status: the M1 API is implemented in `src/client/index.ts`. Planned extensions are marked *(planned)*.

**Implemented in M1:**
- `open(name, { storage, pageSize, cacheMB, durable, worker })`
- `db.query(sql, params?, { rowMode: 'object' | 'array' | 'columnar', batchSize })`
- `db.exec(sql, params?)`, which returns `{ changes, lastInsertRowid }`. Without params it accepts a multi-statement script.
- `db.prepare(sql)`, giving `stmt.query(params?, opts)`, `stmt.run(params?)`, and `stmt.finalize()`.
- `db.transaction(async (tx) => ...)`: COMMIT on success, ROLLBACK on throw; other calls wait until it finishes.
- `db.close()`.
- Errors are `SmaltdbError` with a `code`, e.g. `SMALT_CONSTRAINT_UNIQUE`, `SMALT_SYNTAX`, `SMALT_UNSUPPORTED`.
- Parameters are positional arrays, or objects keyed by name (`{ id: 1 }` matches `:id`, `@id`, `$id`).

The synchronous engine is also available directly (`smaltdb/engine`: `Database.open(vfs, path)`, `db.query/run/exec/prepare`),
for use inside your own worker or in Node.

*(planned)* `workers`, `multiTab`, streaming iteration (`stmt.stream`), `insertColumns`, `explain`, and import/export helpers.
The draft below shows the long-term shape.

```ts
import { open } from 'smaltdb';

const db = await open('app', {
  storage: 'opfs',          // 'opfs' | 'memory'
  cache: { mode: 'lru', sizeMB: 64 },   // or { mode: 'full' } = memory-cached
  workers: 'auto',          // number of reader workers; requires crossOriginIsolated
  multiTab: true,
  // worker: new URL('./my-worker.js', import.meta.url)  // optional override; default auto-spawns
});

// One-shot. The default returns an array of objects: [{ id, name }, ...]
const rows = await db.query('SELECT id, name FROM users WHERE age > ?', [30]);
const tuples = await db.query(sql, params, { rowMode: 'array' });     // [[id, name], ...] + .columns
const cols   = await db.query(sql, params, { rowMode: 'columnar' });  // { id: Float64Array, name: string[] }

// Prepared + streaming
const stmt = await db.prepare('SELECT * FROM events WHERE ts BETWEEN :from AND :to');
for await (const batch of stmt.stream({ from, to })) {
  // batch.columns.ts : Float64Array, batch.length, batch.row(i), batch.toObjects()
}

// Transactions
await db.transaction(async (tx) => {
  await tx.exec('INSERT INTO t VALUES (?, ?)', [1, 'a']);
  await tx.exec('UPDATE c SET n = n + 1');
});

// Bulk load (fast path, bypasses per-row SQL)
await db.insertColumns('events', { ts: Float64Array.from(...), kind: ['a','b', ...] });

// Introspection
await db.query('SELECT * FROM information_schema.columns WHERE table_name = ?', ['users']);
await db.explain('SELECT ...', { analyze: true });

await db.close();
```

Result shape (ADR 0002): the engine always sends columnar batches with transferred buffers. Rows are built on the
client by a generated, monomorphic factory for each result shape. See [research/result-shape-benchmark.md](research/result-shape-benchmark.md).

Open design point: bigint handling (safe-range integers as `number` by default; `bigint: 'always' | 'auto' | 'never'`).
Post-v1: UDF registration, live queries / change notifications, and framework bindings.

Import/export (v1): `db.importCSV(table, source, opts)`, `db.importJSON(...)` (array or NDJSON stream),
`db.exportCSV(query)`, `db.exportJSON(query)`.
