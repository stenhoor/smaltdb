# Roadmap (draft)

**Current:** M3 (optimizer) is implemented, except tracking the sqllogictest pass rate: statistics/ANALYZE plus sampled
statistics, a cost model, join ordering, costed access paths and join methods, plan drift, and `EXPLAIN ANALYZE`
([ADR 0005](adr/0005-cost-based-optimizer.md), [research/m3-optimizer.md](research/m3-optimizer.md)).

M0, M1 and M2 are complete. M2 delivered the WAL, crash recovery, checkpoints, savepoints, crash-injection tests,
and OPFS read-ahead ([ADR 0004](adr/0004-wal-and-crash-safety.md)). Group commit across connections moves to M6, together with
multiple connections.

M1/M0 notes: M0 and M1 are complete. See [research/m0-baseline.md](research/m0-baseline.md) and
[research/m1-baseline.md](research/m1-baseline.md). Performance versus SQLite WASM is mixed once measured like-for-like (see the correction in the M1 baseline): smaltdb is slower on small durable commits and on scan-heavy analytical queries.
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
| **M8: External tables** ([ADR 0011](adr/0011-external-tables.md), accepted; [research](research/m8-external-tables.md)) | One SQL surface for data that lives elsewhere. **Sources:** local files (Node `fs`; browser `File`/File System Access handles, OPFS), HTTP(S) URLs, cloud buckets (S3 and S3-compatible stores and Azure Blob Storage, via signed requests, SAS / bearer tokens or presigned URLs; GCS later), and remote databases through a connector SPI. **Formats:** CSV/TSV (required), Parquet, JSON/NDJSON; Excel (`.xlsx`; a sheet by name or index, optional A1 range, e.g. `range = 'Sales!A1:F200'`) is deferred to after the remote-database connectors. **SQL:** `CREATE EXTERNAL TABLE t [(columns)] WITH (location = …, format = …, …)`, named connections holding endpoints and credential providers (`CREATE CONNECTION`), and ad-hoc table functions (`read_csv`, `read_parquet`, `read_excel`). **Execution:** an async fetch phase before the synchronous executor (byte ranges for Parquet row groups), projection/filter pushdown (Parquet statistics as zone maps; WHERE/LIMIT to remote databases), local joins across sources; caching as materialized views (M5/M7 freshness) for offline and fast repeat reads. Read-only in M8; writes to remote databases later. In-process, statements over external tables run with `queryAsync`. Connectors and format readers ship as optional, lazily loaded packages. Phases: M8.1 ✅ connections, external tables, async fetch, `file:`/HTTP, CSV/JSON; M8.2 ✅ S3, Azure Blob Storage, globs, partitions; M8.3 ✅ Parquet; M8.5 remote databases and `smaltdb-gateway`; M8.4 Excel after that |
| **M9: Parallel readers everywhere** | Shared buffer pool in `SharedArrayBuffer` (page cache shared by the owner and reader workers, page reads proxied to the file owner with `Atomics.wait`/`notify`), so parallel reads work in every cross-origin isolated browser. M6 ships parallel readers only where OPFS `readwrite-unsafe` handles exist (Chromium) |
| **1.0** | Format freeze, docs, performance targets met on Chromium, Firefox, and Safari |
| **Sync groundwork** (before the sync plugin; own ADR) | Change capture in the same commit (`track_changes`), a hybrid logical clock, `uuid7()` / `ulid()` helpers for stable row identity (ADR 0011, section 9) |
| **Post-1.0** | `smaltdb-sync` plugin (full or partial, one-way or bidirectional sync with files, cloud stores and remote databases; needs change tracking and conflict policies), incremental/on-commit MVs, triggers, JSON functions, JS UDFs, live queries, encryption at rest, SQLite import, ATTACH, locale collations, newer-browser fast paths (`readwrite-unsafe`, etc.) |
