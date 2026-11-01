# M5: materialized views and columnar projections

- Date: 2026-11-01
- Design: [ADR 0008](../adr/0008-materialized-views-and-columnar-segments.md)
- Benchmark: `bench/browser`, section `mv:` (`--no-matviews` skips it)
- Runs (Chromium 153, 5 repetitions):
  - `bench/results/2026-11-01-chromium-2ae210c.json` (OPFS);
  - `bench/results/2026-11-01-chromium-34ea74c-cpu.json` (CPU-only: both engines in memory).

## Workload

The analytic table `a` has 200k rows (`b = i % 1000`, `c` real, `d = i % 100`, `e` text). Its projection is
`a_proj`:
- **smaltdb:** `CREATE MATERIALIZED VIEW a_proj WITH (storage = 'columnar') AS SELECT * FROM a`.
- **SQLite:** has no materialized views, so it uses the closest equivalent, `CREATE TABLE a_proj AS SELECT * FROM a`.
  Its refresh is `DELETE` plus `INSERT … SELECT` in one transaction.

Each engine runs the three analytic queries against `a_proj` (repeat runs; median of 5), then 20 range queries over
a clustered 5% window of `id`, then a refresh. All engines returned identical results.

"Best SQLite" is the faster of WAL and TRUNCATE for each row. A verdict is given only when the min–max ranges do not
overlap.

## OPFS

| Workload | smaltdb | Best SQLite | Ratio |
|---|---|---|---|
| Build the projection (200k rows) | 403 ms | 340 ms (TRUNCATE) | **0.84× slower** |
| filter + sum | 0.70 ms | 8.87 ms | 12.7× faster |
| GROUP BY, 100 groups | 5.61 ms | 54.5 ms | 9.7× faster |
| arithmetic filter + aggregate | 1.49 ms | 8.09 ms | 5.4× faster |
| Clustered range ×20 (5% each) | 12.3 ms | 119 ms | 9.7× faster |
| Refresh (200k rows) | 412 ms | 599 ms (WAL) | 1.45× faster |

## CPU-only (both engines in memory)

| Workload | smaltdb | SQLite | Ratio |
|---|---|---|---|
| Build the projection (200k rows) | 344 ms | 31.5 ms | **0.09× (11× slower)** |
| filter + sum | 0.72 ms | 9.17 ms | 12.7× faster |
| GROUP BY, 100 groups | 5.75 ms | 57.4 ms | 10.0× faster |
| arithmetic filter + aggregate | 1.51 ms | 8.66 ms | 5.7× faster |
| Clustered range ×20 (5% each) | 12.3 ms | 122 ms | 9.9× faster |
| Refresh (200k rows) | 378 ms | 42.3 ms | **0.11× (9× slower)** |

## Against smaltdb's own row table (same run, CPU-only)

| Query (repeat) | Row table `a` (fused) | Columnar projection |
|---|---|---|
| filter + sum | 2.02 ms | 0.72 ms |
| GROUP BY, 100 groups | 6.60 ms | 5.75 ms |
| arithmetic filter + aggregate | 3.15 ms | 1.51 ms |

GROUP BY gains least, because hashing the group key per row dominates. The first run of each query includes code
generation and chunk decoding: filter + sum takes 5.4 ms on the first run, against 0.72 ms on repeats.

## Findings

- **Reads.** Queries on columnar projections are 5–13× faster than SQLite reading its copy, in both environments.
- **Build and refresh are the weak spot.** SQLite's `CREATE TABLE … AS SELECT` copies records almost directly: 31.5 ms
  in memory, against 344 ms for smaltdb.
  - smaltdb runs the view's query through the generic row-at-a-time path, collects each column's values into arrays,
    then encodes the chunks.
  - On OPFS, storage costs hide most of the gap: smaltdb is 0.84× against SQLite's best mode for the build, and
    1.45× faster for refresh.
  - The in-memory gap is real CPU work. Likely fixes: a generated scan that writes straight into column buffers, and
    typed-array accumulation instead of per-row JS arrays.
