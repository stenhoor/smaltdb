# smaltdb

**smaltdb** is an embedded SQL database engine for web browsers, written in JavaScript/TypeScript.
It stores data in the [Origin Private File System (OPFS)](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API/Origin_private_file_system),
can keep data in an optional in-memory cache for speed, and runs inside Web Workers so the main thread never blocks.

> Status: **design phase**. This repository holds the design documents. No code has been written yet.

## Goals

1. **Fast queries in the browser.** We treat performance as a feature. The project depends on two
   things: an efficient on-disk format and a cost-based query planner.
2. **SQLite-flavoured SQL.** The dialect is based on SQLite, so existing SQL knowledge and most queries carry over.
3. **Introspection.** The engine provides an `information_schema` (plus SQLite-style `sqlite_schema` / `PRAGMA` compatibility).
4. **Materialized views** are first-class objects (v1: full and concurrent refresh).
5. **Off the main thread.** The engine runs in Web Workers, and it can run several queries at once.
6. **Durable local storage** on OPFS, with an optional memory-cached mode for hot data.

## Non-goals (initially)

- Network replication or sync.
- Server-side runtimes (Node/Deno/Bun). Node is used only to run unit tests.
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
