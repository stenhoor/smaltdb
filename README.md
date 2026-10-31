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
4. **Materialized views** are first-class objects.
5. **Off the main thread.** The engine runs in Web Workers, and it can run several queries at once.
6. **Durable local storage** on OPFS, with an optional memory-cached mode for hot data.

## Non-goals (initially)

- Network replication or sync. It may come later; see [Open Questions](docs/OPEN_QUESTIONS.md).
- Running on a server. A Node/Deno build may come later.
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

## License

TBD (see [OPEN_QUESTIONS.md](docs/OPEN_QUESTIONS.md)).
