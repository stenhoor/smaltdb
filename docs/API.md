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

**In-memory databases.** `open(name, { storage: 'memory' })` or `open(':memory:')` (engine:
`Database.openMemory()` or `Database.open(vfs, ':memory:')`) creates a database that lives only in
memory and is discarded when it is closed. It has no file, no write-ahead log and no page checksums.
Transactions, savepoints and statement rollback work as usual: each page's contents before its
first change in a transaction are kept in memory for rollback.

**Implemented in M6:**
- **Streaming.** `db.stream(sql, params?, { rowMode, batchSize, highWaterMark, signal })` and `stmt.stream(params?, opts)`
  return async iterators over result batches: `for await (const rows of db.stream(sql)) …`. The engine sends at most
  `highWaterMark` batches (default 4) ahead of the consumer and pauses until they are consumed. Leaving the loop early
  closes the result. While a stream is open, the same tab's writes fail with `SMALT_BUSY`, other tabs' writes wait, and
  reads continue.
- **Cancellation.** `signal` (an `AbortSignal`) on `query`, `exec`, `stream` and prepared statements. A queued request or
  an open stream stops at once. On cross-origin isolated pages, a statement that is already running in this tab's
  engine worker is interrupted and rolled back; elsewhere it is stopped at its next result batch. The error code is
  `SMALT_INTERRUPT`.
- **Multi-tab.** `open(name, { multiTab })` defaults to on for OPFS databases when Web Locks and BroadcastChannel exist.
  - *Ownership:* one tab's engine worker owns the file (`db.isLeader`). Other tabs send it their requests.
  - *Transactions:* a transaction belongs to its tab, and the other tabs' statements wait until it ends. If a tab closes
    with a transaction open, its transaction is rolled back.
  - *Failover:* when the owning tab closes, a waiting tab takes over and recovers committed data. Requests in flight
    then fail with `SMALT_RETRY` (safe to retry), and statements prepared under the old owner must be prepared again.

- **Parallel readers (Chromium).** With multi-tab on and OPFS `readwrite-unsafe` handles available, concurrent
  read-only queries outside transactions run on up to three reader workers, each reading a snapshot of the latest
  commit. They run in parallel and do not block writers. Nothing changes in the API: `db.stats.readerQueries` counts
  the queries readers served. In other browsers, reads run on the owning worker (a shared buffer pool is planned as M9).

*(planned)* `insertColumns`, `explain`.
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

**Import / export (implemented, M4).** These run inside the engine worker; the client transfers the bytes.

| Call | Notes |
|---|---|
| `db.importCSV(table, source, opts?)` → `{ rows }` | `source`: string, `Uint8Array`, `ArrayBuffer` or `Blob`/`File`. RFC 4180 (quoted fields, embedded delimiters/newlines, CRLF, BOM). An unquoted empty field is NULL; a quoted `""` is an empty string. Options: `header` (default true; maps fields by column name), `columns`, `delimiter`, `quote`, `emptyAsNull`, `create` (creates a missing table with INTEGER / REAL / TEXT inferred per column). |
| `db.importJSON(table, source, opts?)` → `{ rows }` | A JSON array of objects (keys matched to columns case-insensitively; missing keys take the column DEFAULT) or of arrays (positional), or NDJSON. Booleans become 1/0; nested arrays and objects are stored as JSON text. Options: `create`, `columns`. |
| `db.exportCSV(sql, params?, opts?)` → string | Header row by default. Values are quoted when needed; REALs print like SQLite (`2.0`); blobs print as hex. Options: `header`, `delimiter`, `nullString`, `crlf`. |
| `db.exportJSON(sql, params?, opts?)` → string | An array of objects, or `{ format: 'ndjson' }`. Integers beyond 2^53 are written as exact digits. |

**External data (M8.1).** SQL can read files and URLs directly ([SQL_DIALECT.md §5a](SQL_DIALECT.md), ADR 0011).

| Call | Notes |
|---|---|
| `db.registerFile(name, file)` | Makes `file` readable as `file:<name>`: a `File` / `Blob`, a File System Access handle, bytes or text. `null` removes it. Registered files live in the engine worker's memory; nothing is copied into the database. |
| `db.registerCredentials(name, { endpoint, headers })` | Headers for connections that name these credentials (`CREATE CONNECTION … WITH (credentials = 'name')`), sent only with requests to URLs that start with `endpoint`. `headers` is an object, or a function `(url) => headers` (sync or async) for tokens that change: the function stays in this tab, and the engine worker asks it for every request (it fails a request after 30 s without an answer, or at once when the tab closes). Credentials are never stored in SQL or the database file, so they must be registered again after reopening. `null` removes them. |

Registered files and credentials live in the owning engine worker. When another tab takes over (multi-tab), each tab
registers its own again with the new owner automatically. `exportCSV` / `exportJSON` work over external data too.

In-process (`smaltdb/engine`, Node and tests), statements over external data run with
`await db.queryAsync(sql, params?, { signal })`, `db.runAsync(…)` and `db.execAsync(…)`; the synchronous `query` /
`run` / `exec` fail with `SMALT_ASYNC_REQUIRED` for them. The engine `Database` also has `registerFile`,
`registerCredentials` (whose `headers` may be a function of the URL, sync or async) and `setFetch(fetchFn)` to replace
the transport. `exportCSVAsync` / `exportJSONAsync` export queries over external data.

Imports run as one prepared INSERT, in one transaction (or inside the caller's). Every constraint, type
conversion and foreign key applies. On error the import is rolled back, and the message names the CSV line or
JSON item (`CSV line 3: NOT NULL constraint failed: t.v`). The same functions are exported from `smaltdb/engine`
for direct use (`importCSV(db, table, text, opts)`, …).
