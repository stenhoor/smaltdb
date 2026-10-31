# M1 baseline: smaltdb with its SQL layer vs. SQLite WASM, PGlite, DuckDB-WASM

> **Correction (2026-10-31): the multipliers below overstate smaltdb.**
> 1. **Small durable commits are not a win.** smaltdb commits are not crash-atomic before M2. Compared with SQLite in
>    `journal_mode=OFF` (equally non-atomic), smaltdb is about **2× slower** (repeated in two runs). Its apparent 3.4–4.3× lead came
>    from SQLite paying for a rollback journal. Run `npm run bench:browser -- --engines smaltdb,sqlite,sqlite-nojournal`.
> 2. **Run-to-run variance is much larger than ±30%.** In consecutive runs smaltdb's bulk-insert ratio moved from 1.3× to 2.2×,
>    and the scan ratio from 1.5× to 2.0×. Single runs on a shared container do not support these multipliers. The defensible
>    reading is: on par with or faster than SQLite for bulk insert, point lookups, and scans; tied on `count(*)`.
> 3. **All reads are warm-cache**, measured right after loading. Cold reads from OPFS have not been measured.
> 4. **Scan-heavy analytical queries are slower than SQLite.** In Node with both engines in memory, smaltdb takes 1.3× as long on
>    filter+sum and 2.4× as long on expression-heavy aggregation. It is 3.2× faster on GROUP BY. These queries are not yet in this suite.
>
> Before quoting performance again, the harness needs repeated runs with medians and spread, like-for-like durability
> configurations, cold-cache workloads, and analytical queries.

- Date: 2026-10-31
- Environment: Chromium 153 (Playwright, headless), 4-vCPU Xeon @ 2.3 GHz container. Same workload as [M0](m0-baseline.md).
- Run with `npm run bench:browser -- --save`. Raw data: [bench/results/2026-10-31-chromium.json](../../bench/results/2026-10-31-chromium.json).
  This file now holds the M1 run; the M0 numbers are in the M0 write-up and in git history.

Each engine runs in its own dedicated worker, persists to OPFS, and uses prepared statements where it supports them.
smaltdb now goes through its full SQL pipeline: parse once, plan, execute, and decode records.

| Engine | Bulk insert 100k (1 txn) | 10k point lookups | count(*) | Scan, read all values | 200 single-row durable txns | Open |
|---|---|---|---|---|---|---|
| **smaltdb M1 (SQL)** | **259 ms** | **27 ms** | 0.6 ms | **59 ms** | **178 ms** | **16 ms** |
| SQLite WASM 3.54.1 (opfs-sahpool, EXCLUSIVE, TRUNCATE journal, synchronous=FULL) | 611 ms | 38 ms | 0.5 ms | 111 ms | 608 ms | 98 ms |
| PGlite | 1,936 ms | 6,926 ms | 14 ms | 206 ms | 183 ms | 7,826 ms |
| DuckDB-WASM | 984 ms | 10,101 ms | 5.7 ms | 188 ms | 201 ms | 2,674 ms |

Relative to SQLite WASM: bulk insert **2.4×**, point lookup **1.4×**, `count(*)` parity (0.6 vs 0.5 ms, within noise),
scanning values **1.9×**, small durable transactions **3.4×** (repeated runs gave 1.0–1.1× for `count(*)` and 3.4–4.3× for
small transactions).

## Caveats

- **Commits are still not crash-atomic.** There is no WAL until M2; SQLite pays for its rollback journal. The small-transaction
  column will narrow in M2.
- **The worker hop is not included** for any engine. smaltdb's client API round trip, measured separately in the
  browser test, adds about 70 µs per call: prepared lookup 73 µs end to end vs. the 150 µs target.
- Single runs on a shared container. Sub-millisecond rows vary by ±30%.

## What it took

| Change | Bulk insert per row (Node, MemoryVfs) |
|---|---|
| First working M1 build | ~20 µs (47 µs in the browser) |
| Reuse B+tree handles and table writers across executions | — |
| Header-only statement snapshots; skip the statement journal when it cannot matter (ADR 0003) | ~1.9 µs |

`count(*)` gained a planner fast path that sums leaf cell counts, as SQLite's `OP_Count` does.
