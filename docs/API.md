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

**Import / export (implemented, M4).** These run inside the engine worker; the client transfers the bytes.

| Call | Notes |
|---|---|
| `db.importCSV(table, source, opts?)` → `{ rows }` | `source`: string, `Uint8Array`, `ArrayBuffer` or `Blob`/`File`. RFC 4180 (quoted fields, embedded delimiters/newlines, CRLF, BOM). An unquoted empty field is NULL; a quoted `""` is an empty string. Options: `header` (default true; maps fields by column name), `columns`, `delimiter`, `quote`, `emptyAsNull`, `create` (creates a missing table with INTEGER / REAL / TEXT inferred per column). |
| `db.importJSON(table, source, opts?)` → `{ rows }` | A JSON array of objects (keys matched to columns case-insensitively; missing keys take the column DEFAULT) or of arrays (positional), or NDJSON. Booleans become 1/0; nested arrays and objects are stored as JSON text. Options: `create`, `columns`. |
| `db.exportCSV(sql, params?, opts?)` → string | Header row by default. Values are quoted when needed; REALs print like SQLite (`2.0`); blobs print as hex. Options: `header`, `delimiter`, `nullString`, `crlf`. |
| `db.exportJSON(sql, params?, opts?)` → string | An array of objects, or `{ format: 'ndjson' }`. Integers beyond 2^53 are written as exact digits. |

Imports run as one prepared INSERT, in one transaction (or inside the caller's). Every constraint, type
conversion and foreign key applies. On error the import is rolled back, and the message names the CSV line or
JSON item (`CSV line 3: NOT NULL constraint failed: t.v`). The same functions are exported from `smaltdb/engine`
for direct use (`importCSV(db, table, text, opts)`, …).
