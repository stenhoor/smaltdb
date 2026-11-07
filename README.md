<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/lockup-on-dark.svg">
    <img alt="smaltdb" src="docs/brand/lockup.svg" width="320">
  </picture>
</h1>

**Small. Alternative. Fast.**

**smaltdb** is an embedded database engine for web browsers, written in TypeScript. It stores data in the
[Origin Private File System (OPFS)](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system),
can keep data in an optional in-memory cache for speed, and runs inside Web Workers so the main thread never blocks.

The engine runs **plans**: queries and writes as plain data. It carries no query language: SQL is
**[smaltql](https://github.com/stenhoor/smaltql)**, which parses the SQLite dialect into plans
([ADR 0015](docs/adr/0015-smaltql.md)), and other languages or applications can build plans directly.

> **Status: 0.9.0, preview.** Durable, atomic commits on OPFS (write-ahead log, crash-injection tested), a
> cost-based planner, views and materialized views, columnar tables, multi-tab access with parallel readers, spilling
> sorts and aggregates, and external tables over CSV, JSON and Parquet files on HTTP, S3 and Azure Blob Storage
> (milestones M0–M8.3 of the [roadmap](docs/ROADMAP.md)). Benchmarks against crash-safe SQLite WASM:
> [methodology and results](docs/research/benchmark-methodology.md). The on-disk format may still change before 1.0.

## Install

For a SQL database in a page, install smaltql with the engine:

```sh
npm install @smaltworks/smaltql smaltdb
```

```js
import { open } from '@smaltworks/smaltql';

const db = await open('app'); // the engine runs in a worker, data lives in OPFS
await db.exec('CREATE TABLE IF NOT EXISTS todo(id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INT DEFAULT 0)');
await db.exec('INSERT INTO todo(title) VALUES (?)', ['write docs']);
const rows = await db.query('SELECT id, title FROM todo WHERE done = 0'); // [{ id: 1, title: 'write docs' }]
await db.close();
```

smaltql's [docs](https://stenhoor.github.io/smaltql/) cover the guide, the SQL and functions reference and the client API. This repository's
[docs](https://smaltdb.dev) cover the engine: [plans](docs/reference/engine/index.md),
[writing a language](docs/reference/engine/languages.md), the [engine API](docs/reference/api/engine.md) and
[plugins](docs/reference/api/plugins.md). Optional features are plugins in their own packages: `@smaltdb/io`,
`@smaltdb/external` and `@smaltdb/parquet`.

## Goals

1. **Fast queries in the browser.** We treat performance as a feature. The project depends on two
   things: an efficient on-disk format and a cost-based query planner.
2. **Languages on plans.** The engine reads plans; SQL (smaltql, based on SQLite) is one language on top.
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

For users of SQL ([smaltql's docs](https://stenhoor.github.io/smaltql/)):
- [Getting started](https://stenhoor.github.io/smaltql/guide/getting-started), the [user guide](https://stenhoor.github.io/smaltql/guide/databases) and the [FAQ](https://stenhoor.github.io/smaltql/guide/faq)
- [SQL reference](https://stenhoor.github.io/smaltql/reference/sql/), [functions](https://stenhoor.github.io/smaltql/reference/functions/) and the [client API](https://stenhoor.github.io/smaltql/reference/api/client)

For the engine: [plans and languages](docs/reference/engine/index.md), the [engine API](docs/reference/api/engine.md),
[writing plugins](docs/reference/api/plugins.md) and [error codes](docs/reference/api/errors.md).

Design and internals:

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System overview, components, threading model |
| [docs/STORAGE_FORMAT.md](docs/STORAGE_FORMAT.md) | On-disk layout, pages, B+trees, WAL, caching |
| [docs/QUERY_ENGINE.md](docs/QUERY_ENGINE.md) | Parser → binder → optimizer → execution |
| [docs/SQL_DIALECT.md](docs/SQL_DIALECT.md) | Design notes for the SQL dialect (now smaltql's) |
| [docs/WORKER_MODEL.md](docs/WORKER_MODEL.md) | Workers, concurrency, transactions, multi-tab |
| [docs/API.md](docs/API.md) | Design notes for the JavaScript API |
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
- STRICT typing: values must fit the column type (`ANY` columns hold anything). SQLite-style `LOOSE` tables are not supported yet.
- TypeScript, no WASM. Supports Chromium, Firefox, and Safari/iOS.
- Multi-tab sharing via leader election. Parallel reader workers where OPFS supports `readwrite-unsafe` handles (Chromium).
- Snapshot isolation with a single writer. Minimum browsers: Chrome 108, Firefox 111, Safari 17.
- Columnar wire protocol. `query()` returns objects by default.
- Performance bar: beat SQLite WASM on every workload, and stay competitive with DuckDB-WASM on analytics ([ADR 0002](docs/adr/0002-second-round-decisions.md)).
- Planned after v1: triggers, JSON functions, JS UDFs, live queries, encryption, newer-browser fast paths.

## License

[MIT](LICENSE)
