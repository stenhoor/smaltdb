# M5: materialized views and columnar projections

- Date: 2026-11-01
- Design: [ADR 0008](../adr/0008-materialized-views-and-columnar-segments.md)
- Benchmark: `bench/browser` section `mv:` (`--no-matviews` skips it)

> **Status:** interim. The numbers below come from a single browser repetition and from Node. The 5-repetition
> Chromium runs (OPFS and CPU-only) will replace them.

## Workload

The analytic table `a` has 200k rows (`b = i % 1000`, `c` real, `d = i % 100`, `e` text). Its columnar projection
is `a_proj`:
- **smaltdb:** `CREATE MATERIALIZED VIEW a_proj WITH (storage = 'columnar') AS SELECT * FROM a`.
- **SQLite:** has no materialized views, so it uses the closest equivalent, `CREATE TABLE a_proj AS SELECT * FROM a`.
  Its refresh is `DELETE` plus `INSERT … SELECT` in one transaction.

Each engine runs the three analytic queries against `a_proj`, then 20 clustered range queries
(`id` in a 5% window), then a refresh. Results are compared across engines.

## Interim results (Chromium, OPFS, 1 repetition)

| Workload | smaltdb | SQLite (WAL) | Ratio |
|---|---|---|---|
| Build the projection (200k rows) | 430 ms | 1,644 ms | 3.8× |
| filter + sum (repeat) | 0.73 ms | 9.57 ms | 13× |
| GROUP BY, 100 groups (repeat) | 4.82 ms | 56.7 ms | 12× |
| arithmetic filter + aggregate (repeat) | 1.55 ms | 8.47 ms | 5.5× |
| Clustered range ×20 (5% each) | 13.8 ms | 125 ms | 9.0× |
| Refresh (200k rows) | 389 ms | 611 ms | 1.6× |

All engines returned identical results.

## Columnar vs smaltdb's own row store (Node, in memory, 200k rows)

| Query | Fused row store | Columnar MV |
|---|---|---|
| filter + sum | 2.3 ms | 0.48 ms |
| arithmetic filter + aggregate | 2.7 ms | 0.48 ms |
| GROUP BY (100 groups) | 5.2 ms | 2.4 ms |
| Clustered 5% range | 0.59 ms | 0.04 ms |

GROUP BY gains least, because hashing the group key per row dominates.
