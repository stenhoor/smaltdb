# Roadmap (draft)

| Milestone | Scope |
|---|---|
| **M0: Foundations** | Repo tooling, VFS abstraction (memory + OPFS), pager, buffer pool, page format, B+tree with property tests, benchmark harness |
| **M1: Minimal SQL** | Lexer/parser, catalog, CREATE TABLE/INDEX, INSERT/SELECT/UPDATE/DELETE, simple planner, row-at-a-time → vectorized executor, worker + client API |
| **M2: Durability** | WAL, group commit, recovery, checkpointing, transactions/savepoints, crash tests |
| **M3: Optimizer** | Statistics/ANALYZE, cost model, join ordering, access-path selection, EXPLAIN [ANALYZE], sqllogictest pass rate tracked |
| **M4: Dialect breadth** | Window functions, CTEs (recursive), subquery decorrelation, ON CONFLICT, RETURNING, date/time, information_schema, sqlite_schema/pragmas, CSV/JSON import/export |
| **M5: Materialized views** | Full refresh and `REFRESH … CONCURRENTLY` |
| **M6: Concurrency** | Multi-tab leader election, parallel reader workers (when crossOriginIsolated), cancellation, backpressure |
| **M7: Analytics** | Columnar segments, zone maps, spill-to-OPFS, morsel parallelism |
| **1.0** | Format freeze, docs, performance targets met on Chromium, Firefox, and Safari |
| **Post-1.0** | Incremental/on-commit MVs, triggers, JSON functions, JS UDFs, live queries, encryption at rest, SQLite import, ATTACH |
