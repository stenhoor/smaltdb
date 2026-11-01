<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-on-dark.svg">
    <img alt="smaltdb" src="docs/brand/lockup.svg" width="320">
  </picture>
</h1>

**Small. Alternate. Fast.**

**smaltdb** is an embedded SQL database engine for web browsers, written in JavaScript/TypeScript.
It stores data in the [Origin Private File System (OPFS)](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system),
can keep data in an optional in-memory cache for speed, and runs inside Web Workers so the main thread never blocks.

> **Status: 0.8.3, preview.** Durable, atomic commits on OPFS (write-ahead log, crash-injection tested), a
> cost-based planner, views and materialized views, columnar tables, multi-tab access with parallel readers, spilling
> sorts and aggregates, and external tables over CSV, JSON and Parquet files on HTTP, S3 and Azure Blob Storage
> (milestones M0–M8.3 of the [roadmap](docs/ROADMAP.md)). The SQL dialect follows SQLite and is checked against it with
> differential tests and a sqllogictest subset; see the [supported SQL](docs/SQL_DIALECT.md). Benchmarks against
> crash-safe SQLite WASM: [methodology and results](docs/research/benchmark-methodology.md). The on-disk format may
> still change before 1.0.

## Install

```sh
npm install smaltdb
```

The engine runs in a module worker, `dist/smaltdb-worker.js` (with its `dist/chunks/`), which the client loads with
`new URL('./smaltdb-worker.js', import.meta.url)`: Vite and webpack 5 bundle it from there. With other setups, copy
those files to your site and pass the worker's URL: `open('app', { worker: new URL('/smaltdb-worker.js', location.href) })`.
Storage works on any page; interrupting a running statement uses `SharedArrayBuffer`, which needs a cross-origin
isolated page (COOP / COEP headers). Parquet support needs `npm install hyparquet` (and `hyparquet-compressors` for
codecs other than Snappy).

## Quick start

```js
import { open } from 'smaltdb';

const db = await open('app'); // engine runs in a worker, data lives in OPFS
await db.exec('CREATE TABLE IF NOT EXISTS todo(id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INT DEFAULT 0)');
await db.exec('INSERT INTO todo(title) VALUES (?)', ['write docs']);
const rows = await db.query('SELECT id, title FROM todo WHERE done = 0'); // [{ id: 1, title: 'write docs' }]
const cols = await db.query('SELECT id FROM todo', [], { rowMode: 'columnar' }); // { data: { id: Float64Array } }
await db.transaction(async (tx) => {
  await tx.exec('UPDATE todo SET done = 1 WHERE id = ?', [1]);
});
await db.close();
```

## Goals

1. **Fast queries in the browser.** We treat performance as a feature. The project depends on two
   things: an efficient on-disk format and a cost-based query planner.
2. **SQLite-flavoured SQL.** The dialect is based on SQLite, so existing SQL knowledge and most queries carry over.
3. **Introspection.** The engine provides an `information_schema` (plus SQLite-style `sqlite_schema` / `PRAGMA` compatibility).
4. **Materialized views** are first-class objects (v1: full and concurrent refresh).
5. **Off the main thread.** The engine runs in Web Workers, and it can run several queries at once.
6. **Durable local storage** on OPFS, with an optional memory-cached mode for hot data.

## Non-goals (for now)

- Replication or sync (a separate `smaltdb-sync` plugin is planned; external tables are its groundwork).
- Server-side use as the main target: the synchronous engine (`smaltdb/engine`) runs in Node, mainly for tests and tools.
- Reading or writing SQLite database files.
- Full SQLite compatibility (extensions, virtual-table modules, every pragma).

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview, components, threading model |
| [docs/STORAGE_FORMAT.md](docs/STORAGE_FORMAT.md) | On-disk layout, pages, B+trees, WAL, caching |
| [docs/QUERY_ENGINE.md](docs/QUERY_ENGINE.md) | Parser → binder → optimizer → execution |
| [docs/SQL_DIALECT.md](docs/SQL_DIALECT.md) | Supported SQL, type system, information_schema, materialized views |
| [docs/WORKER_MODEL.md](docs/WORKER_MODEL.md) | Workers, concurrency, transactions, multi-tab |
| [docs/API.md](docs/API.md) | Public JavaScript API (draft) |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Performance targets, benchmarks, profiling strategy |
| [docs/TESTING.md](docs/TESTING.md) | Test strategy and correctness tooling |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones |
| [docs/OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md) | Decisions that still need input |
| [docs/adr/](docs/adr/) | Architecture Decision Records |
| [docs/research/](docs/research/) | Benchmarks and investigations behind decisions |

## Development

Requires Node 20+.

```bash
npm install
npm run check          # typecheck + unit/property tests
npm run test:browser   # OPFS integration test in Chromium (Playwright)
npm run bench          # storage micro-benchmarks (Node)
npm run bench:browser  # smaltdb vs SQLite WASM / PGlite / DuckDB-WASM in Chromium
```

See [docs/TESTING.md](docs/TESTING.md) for details.

## Key decisions (see [ADR 0001](docs/adr/0001-initial-design-decisions.md))

- Mixed OLTP + reporting workload. Databases up to ~1 GB.
- Own storage format (not SQLite-file compatible). Row B+trees, with opt-in columnar tables later.
- STRICT typing by default. SQLite affinity is available through `LOOSE` tables.
- TypeScript, no WASM. Supports Chromium, Firefox, and Safari/iOS.
- Multi-tab sharing via leader election. Parallel workers when the page is cross-origin isolated.
- Snapshot isolation with a single writer. Minimum browsers: Chrome 108, Firefox 111, Safari 17.
- Columnar wire protocol. `query()` returns objects by default.
- Performance bar: beat SQLite WASM on every workload, and stay competitive with DuckDB-WASM on analytics ([ADR 0002](docs/adr/0002-second-round-decisions.md)).
- Planned after v1: triggers, JSON functions, JS UDFs, live queries, encryption, newer-browser fast paths.

## License

[MIT](LICENSE)
