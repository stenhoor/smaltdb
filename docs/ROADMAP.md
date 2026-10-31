# Roadmap (draft)

**Current:** M0 and M1 are complete. See [research/m0-baseline.md](research/m0-baseline.md) and
[research/m1-baseline.md](research/m1-baseline.md). smaltdb now beats or matches SQLite WASM on every workload in the suite.
Still open: running the browser tests and benchmarks on Firefox and WebKit, which are not installed in the dev container.
**Next:** M2 (durability: WAL, crash safety, savepoints).

Carried over from M1, by decision (see [ADR 0003](adr/0003-m1-executor-and-transactions.md)):
- the vectorized executor (M1 shipped a register-based iterator executor);
- the `insertColumns` bulk API;
- RETURNING, upsert, UPDATE FROM, views, ALTER TABLE, expression/partial indexes, and window functions (all M4).

| Milestone | Scope |
|---|---|
| **M0: Foundations** ✅ (2026-10-31) | Repo tooling, VFS abstraction (memory + OPFS) with capability detection, pager, buffer pool, page format, B+tree with property tests, benchmark harness wired to SQLite WASM / DuckDB-WASM / PGlite |
| **M1: Minimal SQL** ✅ (2026-10-31) | Lexer/parser, catalog, CREATE TABLE/INDEX, INSERT/SELECT/UPDATE/DELETE, simple planner, row-at-a-time → vectorized executor, worker + client API |
| **M2: Durability** | WAL, group commit, recovery, checkpointing, transactions/savepoints, crash tests |
| **M3: Optimizer** | Statistics/ANALYZE, cost model, join ordering, access-path selection, EXPLAIN [ANALYZE], sqllogictest pass rate tracked |
| **M4: Dialect breadth** | Window functions, CTEs (recursive), subquery decorrelation, ON CONFLICT, RETURNING, date/time, information_schema, sqlite_schema/pragmas, CSV/JSON import/export |
| **M5: Materialized views** | Full refresh and `REFRESH … CONCURRENTLY` |
| **M6: Concurrency** | Multi-tab leader election, parallel reader workers (when crossOriginIsolated), cancellation, backpressure |
| **M7: Analytics** | Columnar segments, zone maps, spill-to-OPFS, morsel parallelism |
| **1.0** | Format freeze, docs, performance targets met on Chromium, Firefox, and Safari |
| **Post-1.0** | Incremental/on-commit MVs, triggers, JSON functions, JS UDFs, live queries, encryption at rest, SQLite import, ATTACH, locale collations, newer-browser fast paths (`readwrite-unsafe`, etc.) |
