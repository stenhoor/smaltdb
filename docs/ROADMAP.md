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

**In progress:** M7, analytics. Done: mixed storage environments (TEMP tables, `location = 'memory'` MVs), spill-to-OPFS for sorts and hash aggregates, columnar base tables, and morsel parallelism for large aggregates (ADR 0010). Next: MV matching.

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
| **M6: Concurrency** ✅ (2026-11-01; parallel readers on Chromium, others in M8) | Multi-tab leader election, parallel reader workers (when crossOriginIsolated), cancellation, backpressure |
| **M7: Analytics** | Spill-to-OPFS, morsel parallelism, updatable columnar base tables (delta stores), MV matching (route queries to fresh columnar MVs), **mixed storage environments**: per-object placement in one database, e.g. memory-resident materialized views or tables inside an OPFS database (`WITH (location = 'memory')`, rebuilt on open or first use), via a second, in-memory page store (shared groundwork with `ATTACH`) |
| **M8: Parallel readers everywhere** | Shared buffer pool in `SharedArrayBuffer` (page cache shared by the owner and reader workers, page reads proxied to the file owner with `Atomics.wait`/`notify`), so parallel reads work in every cross-origin isolated browser. M6 ships parallel readers only where OPFS `readwrite-unsafe` handles exist (Chromium) |
| **1.0** | Format freeze, docs, performance targets met on Chromium, Firefox, and Safari |
| **Post-1.0** | Incremental/on-commit MVs, triggers, JSON functions, JS UDFs, live queries, encryption at rest, SQLite import, ATTACH, locale collations, newer-browser fast paths (`readwrite-unsafe`, etc.) |
