# Architecture

> Status: draft. Items marked **[Q-n]** depend on an open question in [OPEN_QUESTIONS.md](OPEN_QUESTIONS.md).

## 1. High-level picture

```
 ┌──────────────────────── Browser tab(s) ────────────────────────┐
 │  Application code                                              │
 │     │  smaltdb client API (Promise/async-iterator based)       │
 │     ▼                                                          │
 │  Client proxy  ──── MessagePort / BroadcastChannel ────┐       │
 └────────────────────────────────────────────────────────┼───────┘
                                                          ▼
 ┌──────────────────── Engine (Dedicated Worker) ─────────────────┐
 │  Session manager ─ Transaction manager ─ Lock manager          │
 │        │                                                       │
 │  Language (smaltql for SQL): Lexer → Parser → plans            │
 │        │         (registered; views kept as their source)      │
 │  Planner: names, types, costing, joins, access paths → ops     │
 │        │            ▲ statistics, catalog                      │
 │  Executor: pull operators over a register file, fused codegen  │
 │        │                                                       │
 │  Access methods: table B+tree, index B+tree, (columnar segs)   │
 │        │                                                       │
 │  Buffer pool / page cache  (ArrayBuffer or SharedArrayBuffer)  │
 │        │                                                       │
 │  WAL + Pager ── OPFS FileSystemSyncAccessHandle                │
 └────────────────────────────────────────────────────────────────┘
          ▲ optional: read-only executor workers sharing the
          │ buffer pool through SharedArrayBuffer   [Q-4]
```

## 2. Components

| Component | Responsibility |
|---|---|
| **Client API** | Thin library on the main thread or another worker. Serializes requests and streams results back as columnar batches using transferable `ArrayBuffer`s. |
| **Session manager** | One session per connection. Holds the prepared-statement cache, transaction state, and settings. |
| **Languages** | A language parses its source and binds it to plans; the engine never reads its syntax and carries none. Languages register with the engine (`registerLanguage`, or a worker's `defineWorker`), which keeps views and stored objects as their language's source ([ADR 0015](adr/0015-smaltql.md)). SQL is [smaltql](https://github.com/stenhoor/smaltql), which reaches the engine only through `smaltdb/language` (`language-support.ts`). |
| **Lexer / Parser** | smaltql's: a hand-written recursive-descent parser with Pratt parsing for expressions. |
| **Rewrites** | View/subquery flattening rewrites SQL's parse tree (in smaltql); materialized-view matching rewrites plans (`exec/plan-mv-match.ts`). |
| **Planner** | A language's front end (SQL's in smaltql) resolves names against the catalog, infers types, expands `*` and makes SQL's rules explicit in a positional plan ([ADR 0014](adr/0014-shared-plan-layer.md)); the physical planner (`exec/planner.ts`) decorrelates subqueries, chooses join order and access paths by cost, and builds operators. Writes and a few SELECTs still go from the AST to operators in one pass. See [QUERY_ENGINE.md](QUERY_ENGINE.md). |
| **Executor** | Vectorized operators that process batches of about 1024 rows held in typed arrays. Expressions compile to specialized JS closures, or to generated code if CSP allows it **[Q-9]**. |
| **Catalog** | System tables stored in the database itself, holding each object's language-neutral definition beside its source text ([STORAGE_FORMAT.md](STORAGE_FORMAT.md)): opening a database parses nothing. `information_schema` and `sqlite_schema` are views over the catalog. |
| **Statistics** | Row counts, NDV sketches (HyperLogLog), histograms, and min/max per column. Updated by `ANALYZE` and incrementally on write. |
| **Access methods** | Table B+tree (clustered on rowid or primary key), secondary index B+trees, and optional columnar segments **[Q-2]**. |
| **Buffer pool** | Fixed-size page cache with a CLOCK-Pro or 2Q replacement policy. In "memory cached" mode the whole database is pinned. |
| **Pager / WAL** | Page-level write-ahead log, group commit, checkpointing, and crash recovery. |
| **OPFS I/O** | `FileSystemSyncAccessHandle` (synchronous, worker-only) for the data and WAL files. |

## 3. Design principles

1. **Avoid per-row allocation on hot paths.** Rows are never materialized as JS objects inside the engine.
   Data stays in typed arrays and `DataView`s. Strings are decoded lazily.
2. **Use synchronous I/O inside the engine.** OPFS sync access handles let the pager stay synchronous,
   which avoids the large overhead of `await` per page read. The only async boundary is the worker message channel.
3. **Batch everything.** Operators exchange batches, results cross the worker boundary as batches,
   and inserts are bulk-loaded where possible.
4. **The planner decides, the executor follows.** Physical plans carry all decisions up front
   (algorithms, batch sizes, memory budgets), so execution has no branches it could have resolved earlier.
5. **Pay for what you use.** The core is small. Future features (JSON, UDFs, triggers, FTS, and columnar storage) plug into extensible function, catalog, and storage registries.

## 4. Process / threading model (summary)

See [WORKER_MODEL.md](WORKER_MODEL.md) for details.

- Each database has **one engine worker** that owns the OPFS file handles. OPFS sync handles are exclusive per file by default.
- Tabs and windows on the same origin find the owner through the Web Locks API (leader election), then talk to it over `MessagePort`s.
- Concurrency **inside** the engine (proposed):
  - Single writer and multiple readers under MVCC snapshot isolation, using the WAL.
  - Optional **reader worker pool** for parallel query execution. This requires `SharedArrayBuffer` and therefore cross-origin isolation **[Q-4]**.

## 5. Module layout

One npm package. Plugins are separate packages ([ADR 0012](adr/0012-plugins.md)).

```
src/
  client/             public client API (open(), Database)
  shared/             worker protocol
  engine/
    vfs/              Vfs interface, MemoryVfs, OpfsVfs, capability detection
    storage/          pager, WAL, B-trees, key codec, record format, columnar segments, CRC-32C
    language-support.ts  what a language reaches in the engine (`smaltdb/language`); the engine carries no language
    exec/             planner, rewrites (plan-mv-match, plan-morsel, plan-normalize), operators, expression
                      compiler, code generation, functions, window, spill, statistics, writes
    catalog/          schema, stored definitions, information_schema
    external/         external tables (the plugin host side)
    plan/             the shared plan layer (ADR 0014): plan operations and expressions
    database.ts       the engine's Database: statements, transactions, catalog loading
    server.ts         the worker server; worker.ts and worker-runtime.ts start it
test/                 unit, differential and property tests (Vitest, Node + MemoryVfs)
test/browser/         real-browser tests via Playwright (OPFS, workers)
test/slt/             the sqllogictest runner
bench/micro/          micro-benchmarks (Node)
bench/browser/        engine comparison harness: smaltdb vs SQLite WASM, PGlite, DuckDB-WASM
bench/results/        saved benchmark runs (JSON)
```

## 6. Key external constraints

| Constraint | Impact |
|---|---|
| `createSyncAccessHandle()` exists only in **dedicated workers** (not SharedWorkers or service workers). | The engine must live in a dedicated worker, and multiple tabs need leader election. |
| Sync access handles take an exclusive lock unless `mode: "readwrite-unsafe"` is used, which only some browsers support. | A single owner per file. Readers in other workers cannot open the file directly. |
| `SharedArrayBuffer` requires COOP/COEP headers. | Parallel reader workers sharing a page cache depend on the hosting environment **[Q-4]**. |
| Strict CSP may forbid `new Function`. | The expression JIT needs an interpreter fallback **[Q-9]**. |
| Storage quotas and eviction. | Call `navigator.storage.persist()` and handle `QuotaExceededError` gracefully. |
