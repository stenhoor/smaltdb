# Roadmap (draft)

| Milestone | Scope |
|---|---|
| **M0: Foundations** | Repo tooling, VFS abstraction (memory + OPFS), pager, buffer pool, page format, B+tree with property tests, benchmark harness |
| **M1: Minimal SQL** | Lexer/parser, catalog, CREATE TABLE/INDEX, INSERT/SELECT/UPDATE/DELETE, simple planner, row-at-a-time → vectorized executor, worker + client API |
| **M2: Durability** | WAL, group commit, recovery, checkpointing, transactions/savepoints, crash tests |
| **M3: Optimizer** | Statistics/ANALYZE, cost model, join ordering, access-path selection, EXPLAIN [ANALYZE], sqllogictest pass rate tracked |
| **M4: Dialect breadth** | Window functions, CTEs (recursive), subquery decorrelation, ON CONFLICT, RETURNING, date/time, information_schema, sqlite_schema/pragmas |
| **M5: Materialized views** | Manual refresh, CONCURRENTLY, then incremental maintenance |
| **M6: Concurrency** | Multi-tab leader election, parallel reader workers (when crossOriginIsolated), cancellation, backpressure |
| **M7: Analytics** | Columnar segments, zone maps, spill-to-OPFS, morsel parallelism **[Q-2]** |
| **1.0** | Format freeze, docs, performance targets met |
