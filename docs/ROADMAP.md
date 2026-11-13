# Roadmap (draft)

**Current (2026-11-07):** the engine runs plans and carries no language. SQL is its own package,
[smaltql](https://github.com/stenhoor/smaltql) (ADR 0015), and smaltdf, the dataframe language
([stenhoor/smaltdf](https://github.com/stenhoor/smaltdf)), builds plans with no SQL anywhere. ADR 0016's plan API is
in place through step 10: the catalog API, typed results and structured errors, order guarantees, definitions without
source text, and the new operations (values from columns, pivot, unpivot, asof joins, sample, ignoreNulls on
navigation windows). ADR 0017 removed the last SQL the engine and plugins relied on. smaltdf has steps 2–9 of its
design: frames, aggregation, joins, windows, reshaping, data from JavaScript, writing, views (stored as smaltdf's own
frames) and comparison tests against Polars. The first types of ADR 0016 step 11 are in
([ADR 0018](adr/0018-bool-and-nan.md)): `bool`, with a `BOOLEAN` storage type, and NaN as a value of `real` in a total
order, in format 4 (unreleased); the `sql.*` operation names are gone. So are dates and times
([ADR 0019](adr/0019-dates-and-times.md)): `date`, `datetime`, `time` and `duration` over integers, with their storage
types, operations, time zones as values (`Intl`), Parquet dates as typed columns, SQL reading them as text, and
smaltdf's `dt` methods. SQL's package is now named `@smaltworks/smaltql`. So are lists and structs
([ADR 0020](adr/0020-lists-and-structs.md)): `list<T>` and `struct<name T, …>` over encoded values, with `LIST` and
`STRUCT` storage types, the `list_*` and `struct_field` operations, `implode` and `explode`, Parquet's nested columns
as typed columns, SQL reading them as JSON text, and smaltdf's `list` and `struct` methods. Processing them
([ADR 0031](adr/0031-processing-lists-and-structs.md)): `explode` as a lateral join on `list_elements` (18× faster),
semi and anti joins against any input, functions of one list, and expressions over elements (`each`), in smaltdf's
`list` methods and SQL. M9 is done: parallel readers in
every cross-origin isolated browser ([ADR 0021](adr/0021-parallel-readers-everywhere.md)). **Next:** the 0.9.0 publish
(ADR 0015 steps 11 and 12), then M8.5 and M8.4.

Roadmap change (2026-11-08, owner's decision): the work left before M9 (M8.5 remote databases, M8.4 Excel) moves after
M9, still before 1.0.

**Current:** M3 (optimizer) is implemented, except tracking the sqllogictest pass rate: statistics/ANALYZE plus sampled
statistics, a cost model, join ordering, costed access paths and join methods, plan drift, and `EXPLAIN ANALYZE`
([ADR 0005](adr/0005-cost-based-optimizer.md), [research/m3-optimizer.md](research/m3-optimizer.md)).

M0, M1 and M2 are complete. M2 delivered the WAL, crash recovery, checkpoints, savepoints, crash-injection tests,
and OPFS read-ahead ([ADR 0004](adr/0004-wal-and-crash-safety.md)). Group commit across connections moves to M6, together with
multiple connections.

M1/M0 notes: M0 and M1 are complete. See [research/m0-baseline.md](research/m0-baseline.md) and
[research/m1-baseline.md](research/m1-baseline.md). Measured like-for-like (see the correction in the M1 baseline), small durable commits and scan-heavy analytical queries were smaltdb's slow paths.
Still open: running the browser tests and benchmarks on Firefox and WebKit, which are not installed in the dev container.
**Current:** M4 (dialect breadth) is complete.
- Views (with query flattening) and TEMP views.
- `information_schema` and the table-valued pragmas.
- `RETURNING`, upsert, `UPDATE … FROM`, `WITH` on DML.
- `WITH RECURSIVE`, window functions, date/time functions.
- `ALTER TABLE`, foreign-key enforcement.
- `RIGHT` / `FULL` joins, expression and partial indexes.
- CSV/JSON import and export.
- Subquery decorrelation.
- sqllogictest: 122,333 / 122,334 records of the tracked subset ([research/sqllogictest.md](research/sqllogictest.md)).

**Done:** M7, analytics (ADR 0010): mixed storage environments (TEMP tables, `location = 'memory'` MVs), spill-to-OPFS for sorts and hash aggregates, columnar base tables, morsel parallelism for large aggregates on parallel readers, and MV matching with freshness tracking. **Next:** M8, external tables (CSV / Parquet / Excel files, local or in cloud buckets, and remote databases, queried like local tables), then M9 (shared buffer pool for browsers without shared OPFS handles).

Roadmap change (2026-11-01, agreed): external tables become M8; parallel readers everywhere moves to M9. External tables are also the groundwork for a later `smaltdb-sync` plugin (one-way or bidirectional synchronization with local files, cloud stores and remote databases).

Roadmap change (2026-11-01, agreed): the columnar segment format and zone maps move from M7 into M5, with materialized
views as their first consumer; see [research/columnar-mv-assessment.md](research/columnar-mv-assessment.md).

Optimizer follow-ups from M3: histograms and most-common values, transitive predicate inference, covering index scans.

Carried over from M1, by decision (see [ADR 0003](adr/0003-m1-executor-and-transactions.md)):
- the vectorized executor (M1 shipped a register-based iterator executor);
- the `insertColumns` bulk API;
- RETURNING, upsert, UPDATE FROM, views, ALTER TABLE, expression/partial indexes, and window functions (all M4).

| Milestone | Scope |
|---|---|
| **M0: Foundations** ✅ (2026-10-31) | Repo tooling, VFS abstraction (memory + OPFS) with capability detection, pager, buffer pool, page format, B+tree with property tests, benchmark harness wired to SQLite WASM / DuckDB-WASM / PGlite |
| **M1: Minimal SQL** ✅ (2026-10-31) | Lexer/parser, catalog, CREATE TABLE/INDEX, INSERT/SELECT/UPDATE/DELETE, simple planner, row-at-a-time → vectorized executor, worker + client API |
| **M2: Durability** ✅ (2026-10-31, group commit → M6) | WAL, group commit, recovery, checkpointing, transactions/savepoints, crash tests |
| **M3: Optimizer** ✅ (2026-11-01, sqllogictest tracking → M4) | Statistics/ANALYZE, cost model, join ordering, access-path selection, EXPLAIN [ANALYZE], sqllogictest pass rate tracked |
| **M4: Dialect breadth** ✅ (2026-11-01) | Window functions, CTEs (recursive), subquery decorrelation, ON CONFLICT, RETURNING, date/time, information_schema, sqlite_schema/pragmas, CSV/JSON import/export |
| **M5: Materialized views + columnar segments** ✅ (2026-11-01) | Full refresh and `REFRESH … CONCURRENTLY` (copy-on-write swap); columnar segment format in pager pages, zone maps, columnar scans feeding the generated pipelines; MVs `WITH (storage = 'row' \| 'columnar')` ([research](research/columnar-mv-assessment.md)) |
| **M6: Concurrency** ✅ (2026-11-01; parallel readers on Chromium, others in M9) | Multi-tab leader election, parallel reader workers (when crossOriginIsolated), cancellation, backpressure |
| **M7: Analytics** ✅ | Spill-to-OPFS, morsel parallelism, updatable columnar base tables (delta stores), MV matching (route queries to fresh columnar MVs), **mixed storage environments**: per-object placement in one database, e.g. memory-resident materialized views or tables inside an OPFS database (`WITH (location = 'memory')`, rebuilt on open or first use), via a second, in-memory page store (shared groundwork with `ATTACH`) |
| **M8: External tables** ([ADR 0011](adr/0011-external-tables.md), accepted; [research](research/m8-external-tables.md)) | One SQL surface for data that lives elsewhere. **Sources:** local files (Node `fs`; browser `File`/File System Access handles, OPFS), HTTP(S) URLs, cloud buckets (S3 and S3-compatible stores and Azure Blob Storage, via signed requests, SAS / bearer tokens or presigned URLs; GCS later), and remote databases through a connector SPI. **Formats:** CSV/TSV (required), Parquet, JSON/NDJSON; Excel (`.xlsx`; a sheet by name or index, optional A1 range, e.g. `range = 'Sales!A1:F200'`) is deferred to after the remote-database connectors. **SQL:** `CREATE EXTERNAL TABLE t [(columns)] WITH (location = …, format = …, …)`, named connections holding endpoints and credential providers (`CREATE CONNECTION`), and ad-hoc table functions (`read_csv`, `read_parquet`, `read_excel`). **Execution:** an async fetch phase before the synchronous executor (byte ranges for Parquet row groups), projection/filter pushdown (Parquet statistics as zone maps; WHERE/LIMIT to remote databases), local joins across sources; caching as materialized views (M5/M7 freshness) for offline and fast repeat reads. Read-only in M8; writes to remote databases later. In-process, statements over external tables run with `queryAsync`. Connectors and format readers ship as optional, lazily loaded packages. Phases: M8.1 ✅ connections, external tables, async fetch, `file:`/HTTP, CSV/JSON; M8.2 ✅ S3, Azure Blob Storage, globs, partitions; M8.3 ✅ Parquet; M8.5 and M8.4 move after M9 (see below) |
| **Plugins** ([ADR 0012](adr/0012-plugins.md), accepted; steps 1–6 ✅: plugin interface, `@smaltdb/parquet`, `@smaltdb/external`, `@smaltdb/io`, each in its own repository, API version 1 stable ([ADR 0013](adr/0013-plugin-api-v1.md)); the 0.9.0 release follows the plan layer) | A dependency-free core. Parquet (`@smaltdb/parquet`), external sources (`@smaltdb/external`) and CSV/JSON formats with import/export (`@smaltdb/io`) become separately published packages, each with its own licence and dependencies, loaded through a worker entry the application writes (`serve({ plugins })`). Released as 0.9.0. |
| **Plan layer** ([ADR 0014](adr/0014-shared-plan-layer.md), accepted 2026-11-03 ✅: carried out through ADRs 0015 and 0016) | One typed, positional plan that SQL and smaltdf both target, owned by the engine. The optimizations and physical planning move onto it. Steps, one PR each: 1. docs corrections; 2. a golden corpus of physical plan shapes; 3. plan expressions; 4. operators and fusion carry plan expressions instead of the AST; 5. the SQL front end produces plans for reading queries; 6. the physical planner reads plans; 7. the optimizations move onto the plan; 8. writes go through the plan; 9. the public `plan` API (in-process, worker protocol, plugins). smaltdf builds on step 9. Detailed plan: [research/plan-layer-implementation.md](research/plan-layer-implementation.md) |
| **smaltql and the language API** ([ADR 0015](adr/0015-smaltql.md), accepted; steps 1–10 ✅, SQL in `stenhoor/smaltql` and smaltdf on plans; steps 11–12, package names and publish, before the first npm release) | SQL moves to its own repository and package, smaltql (`stenhoor/smaltql`, `@smaltworks/smaltql`), a peer of smaltdf on one language interface; smaltdb keeps the engine with no language, and each language exports its own `open()`. The planner takes plans only, schema operations and catalog records are language-neutral (one file format change), morsels travel as plans, and the engine owns every function (one result per operation). Packages publish as `@smaltworks/<repository>`, renamed in a separate step before the first publish |
| **The plan API for every language** ([ADR 0016](adr/0016-plan-api-for-every-language.md), accepted; steps 1–10 ✅; [ADR 0017](adr/0017-remaining-sql-dependencies.md) ✅; step 11: [ADR 0018](adr/0018-bool-and-nan.md) `bool` and NaN ✅, [ADR 0019](adr/0019-dates-and-times.md) dates and times ✅, [ADR 0020](adr/0020-lists-and-structs.md) lists and structs ✅; [ADR 0031](adr/0031-processing-lists-and-structs.md) processing them, steps 1 and 3–6 ✅) | What SQL and smaltdf need from the engine as plans: traits and behaviour names for operations, meaning in the plan, a catalog API, typed results and errors that say where they came from, order guarantees, definitions without source text, and new operations. **Step 11, the types:** `bool` and NaN (ADR 0018) and dates and times (ADR 0019) and lists, structs and `explode` (ADR 0020) done |
| **smaltdf** ([stenhoor/smaltdf](https://github.com/stenhoor/smaltdf)) | A TypeScript language with dataframe interfaces that builds plans, never SQL. Steps 2–9 of its design ✅: frames, aggregation, joins, windows, reshaping, data from JavaScript, writing, views stored as its own frames, and comparison tests against Polars with the differences in its reference. Docs: [stenhoor.github.io/smaltdf](https://stenhoor.github.io/smaltdf/) (the [reference](https://stenhoor.github.io/smaltdf/REFERENCE) and [status](https://stenhoor.github.io/smaltdf/guide/status)); its plan: [DESIGN.md](https://github.com/stenhoor/smaltdf/blob/main/docs/DESIGN.md). Its types follow ADR 0016 step 11 |
| **M9: Parallel readers everywhere** ✅ (2026-11-08; [ADR 0021](adr/0021-parallel-readers-everywhere.md), [research](research/m9-parallel-readers.md)) | Parallel readers in every cross-origin isolated browser, not only where OPFS `readwrite-unsafe` handles exist (Chromium, M6). 1. readers on Firefox and Safari read the owner's files through it, over a `SharedArrayBuffer` channel with `Atomics.wait`/`notify`; 2. a block cache in `SharedArrayBuffer` shared by the owner and those readers, with read-ahead; 3. the owner's WAL index in shared memory, which every reader refreshes its snapshot from; 4. on by default, without morsels for readers through the owner, measured on Chromium, Firefox and WebKit |
| **M8.5: Remote databases** (after M9) | From M8: remote databases queried like local tables, through a connector interface and `smaltdb-gateway` |
| **M8.4: Excel** (after M8.5) | From M8: `.xlsx` files as external tables (a sheet by name or index, optional A1 range, e.g. `range = 'Sales!A1:F200'`) |
| **1.0** | Format freeze, docs, performance targets met on Chromium, Firefox, and Safari |
| **Sync groundwork** (before the sync plugin; own ADR) | Change capture in the same commit (`track_changes`), a hybrid logical clock, `uuid7()` / `ulid()` helpers for stable row identity (ADR 0011, section 9) |
| **Post-1.0** | `smaltdb-sync` plugin (full or partial, one-way or bidirectional sync with files, cloud stores and remote databases; needs change tracking and conflict policies), incremental/on-commit MVs, triggers, JSON functions, JS UDFs, live queries, encryption at rest, SQLite import, ATTACH, locale collations, newer-browser fast paths (`readwrite-unsafe`, etc.) |
