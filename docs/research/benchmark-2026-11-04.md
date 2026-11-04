# smaltdb against SQLite WASM and native SQLite (2026-11-04)

Two comparisons over the same workloads (`bench/shared/workloads.ts`), with the same cross-engine result checks:
every engine returned identical results for every read workload in all four runs.

- **Like for like: SQLite WASM in the same browser.** `npm run bench:browser` (Chromium 153), smaltdb at
  5e5f9df. Both engines run in a dedicated worker, persist to OPFS, and are called synchronously with prepared statements.
- **Most aggressive: native SQLite.** `npm run bench:native` (Node 22.23, native SQLite 3.53.4 through `node:sqlite`).
  smaltdb runs on a benchmark-only Node file VFS (`bench/node/node-vfs.ts`, fsync on flush), on the same ext4 disk
  as SQLite's files. SQLite WASM 3.54.1 also runs in Node, in memory, to separate WebAssembly from the engine.

Host: Intel Xeon @ 2.80 GHz, 4 vCPUs, 16 GiB (a cloud container). 5 repetitions per engine, each in a fresh worker or
process, engine order rotating. Cells give the median in ms and, in parentheses, the other engine's time divided by
smaltdb's (above 1 means smaltdb is faster), marked ✓ when smaltdb is faster with no overlap of the min–max ranges,
✗ when slower with no overlap, and ≈ when the ranges overlap.

Raw data: [chromium OPFS](../../bench/results/2026-11-04-chromium-5e5f9df.json),
[chromium in memory](../../bench/results/2026-11-04-chromium-5e5f9df-cpu.json),
[Node](../../bench/results/2026-11-04-node-16e96e4.json).

## Summary

**Against SQLite WASM in the browser, smaltdb is faster or even on almost every workload.**
- **Durable (OPFS):** most workloads are 1.2–39× faster than SQLite WAL; the 39× is cold point lookups. Most
  analytic, materialized-view and join repeats are 2.5–14× faster. Warm point lookups and indexed equality, range and
  composite lookups are even.
- **First runs of short statements:** J2, J3 and J5 are 2.6–3.6× slower on their first run, because planning and
  code generation dominate a 1–9 ms statement. They win once repeated.
- **In memory:** SQLite WASM is ahead on these workloads:

  | Workload | SQLite WASM ahead by |
  |---|---|
  | UPDATE of an indexed column (10k rows, 3 indexes) | 3.3× |
  | Building a projection | 2.8× |
  | DELETE of 10k rows (3 indexes) | 1.7× |
  | Expression-index build | 1.5× |
  | Refreshing a projection | 1.5× |
  | Indexed range lookups | 1.3× |
  | First runs of joins J3 and J5 | 2.3–3.1× |

  The OPFS numbers hide these because SQLite's durable writes are slower there.

**Against native SQLite, smaltdb wins on analytics and loses on row-at-a-time work by 1.5–5×.**
- **Where smaltdb wins:** scans, repeated aggregates, materialized views and joins, by 1.5–9.5×. First runs of the
  simple analytic queries lose 1.6–1.8×. Native SQLite's row-at-a-time
  executor doesn't benefit from smaltdb's fused, generated pipelines and columnar projections.
- **Where it loses:**

  | Workload | Native SQLite ahead by |
  |---|---|
  | Prepared point lookups (warm, cold) | 2.3–4.5× |
  | Bulk loads (inserts, analytic and join tables) | 2.1–2.8× |
  | Index builds (1 column, expression) | 2.4–2.6× |
  | Indexed lookups (equality, composite, expression, range) | 1.5–2.6× |
  | Indexed UPDATE / DELETE (10k rows, 3 indexes) | 2.6–3.7× |
  | Durable single-row commits (`synchronous=FULL`) | 3.2× |

  That's the cost of a JavaScript engine against compiled C, on the paths where per-row interpretation and record
  decoding are the work.
- **`synchronous=NORMAL`:** native SQLite skips the fsync per commit, which smaltdb always does. That makes its
  single-row commits about 47× faster. The two are not comparable on durability.
- **WASM costs SQLite 1.2–6.6× against native,** about 3–4× on bulk loads and point lookups (Node, in memory). That
  is why, in the browser, smaltdb is even with SQLite WASM or ahead on the same workloads.

**What to work on, from these numbers:**
1. **First-run cost of short statements.** J2, J3 and J5 first runs lose 5–14× to native, even though their repeats
   win. This is the planning and code generation per new statement that #69–#71 reduced. The remaining step is
   compiling straight from the plan once the AST path is deleted.
2. **Bulk load and index maintenance:** about 2.5× behind native, and behind WASM in memory on indexed UPDATE/DELETE.
   The record encoder, key encoder and B-tree insert path are the place to look.
3. **Prepared point lookups:** 2.3–4.5× behind native, and even with WASM in the browser.

## Like for like: browser, OPFS (smaltdb against SQLite WASM)

| Workload | smaltdb | SQLite WASM (journal WAL) | SQLite WASM (journal TRUNCATE) | SQLite WASM (journal OFF) |
|---|---|---|---|---|
| bulk insert 100000 rows (1 txn) | 595 | 2074 (3.49× ✓) | 1302 (2.19× ≈) | 1340 (2.25× ≈) |
| point lookup x10000 (warm) | 55.8 | 80.5 (1.44× ≈) | 79.7 (1.43× ≈) | 78.8 (1.41× ≈) |
| scan read values (warm) | 31.5 | 280 (8.88× ✓) | 254 (8.05× ✓) | 241 (7.65× ✓) |
| 200 single-row durable txns | 227 | 1200 (5.28× ✓) | 1607 (7.07× ✓) | 207 (0.91× ≈) |
| point lookup x10000 (cold) | 110 | 4244 (38.64× ✓) | 375 (3.41× ✓) | 399 (3.63× ✓) |
| scan read values (cold) | 115 | 754 (6.56× ✓) | 700 (6.09× ✓) | 615 (5.35× ✓) |
| load analytic table (200000 rows) | 1126 | 3941 (3.50× ✓) | 2793 (2.48× ✓) | 2682 (2.38× ✓) |
| analytic: filter + sum (first run) | 20.0 | 23.7 (1.19× ✓) | 26.2 (1.31× ✓) | 25.3 (1.27× ≈) |
| analytic: filter + sum (repeat, median of 5) | 4.73 | 18.6 (3.93× ✓) | 19.5 (4.13× ✓) | 18.8 (3.98× ✓) |
| analytic: group by (100 groups) (first run) | 28.6 | 221 (7.73× ✓) | 215 (7.50× ✓) | 190 (6.65× ✓) |
| analytic: group by (100 groups) (repeat, median of 5) | 13.0 | 177 (13.62× ✓) | 143 (11.01× ✓) | 145 (11.19× ✓) |
| analytic: arith filter + aggregate (first run) | 22.4 | 20.9 (0.93× ≈) | 20.4 (0.91× ≈) | 20.5 (0.92× ≈) |
| analytic: arith filter + aggregate (repeat, median of 5) | 5.85 | 21.4 (3.66× ✓) | 19.3 (3.29× ✓) | 27.7 (4.73× ✓) |
| mv: build projection of a (200000 rows) | 278 | 4786 (17.19× ✓) | 857 (3.08× ✓) | 897 (3.22× ✓) |
| mv: filter + sum on projection (first run) | 15.7 | 19.8 (1.26× ≈) | 25.4 (1.62× ≈) | 30.7 (1.96× ≈) |
| mv: filter + sum on projection (repeat, median of 5) | 1.53 | 19.2 (12.55× ✓) | 18.6 (12.18× ✓) | 26.9 (17.58× ✓) |
| mv: group by (100 groups) on projection (first run) | 27.2 | 157 (5.77× ✓) | 156 (5.72× ✓) | 233 (8.57× ✓) |
| mv: group by (100 groups) on projection (repeat, median of 5) | 13.4 | 159 (11.82× ✓) | 155 (11.54× ✓) | 155 (11.58× ✓) |
| mv: arith filter + aggregate on projection (first run) | 19.6 | 23.1 (1.18× ≈) | 19.9 (1.02× ≈) | 20.0 (1.02× ≈) |
| mv: arith filter + aggregate on projection (repeat, median of 5) | 1.79 | 20.5 (11.45× ✓) | 19.9 (11.11× ✓) | 23.3 (13.03× ✓) |
| mv: clustered range x20 on projection (5% of rows each) | 31.9 | 294 (9.24× ✓) | 273 (8.57× ✓) | 296 (9.28× ✓) |
| mv: refresh projection (200000 rows) | 225 | 1739 (7.72× ✓) | 3267 (14.50× ✓) | 792 (3.52× ✓) |
| index: create on 1 column (200000 rows) | 211 | 640 (3.03× ✓) | 405 (1.92× ✓) | 408 (1.93× ✓) |
| index: create on 2 columns (200000 rows) | 229 | 4142 (18.09× ✓) | 699 (3.05× ✓) | 696 (3.04× ✓) |
| index: create on expression lower(e) (200000 rows) | 456 | 849 (1.86× ✓) | 520 (1.14× ≈) | 567 (1.24× ≈) |
| index: equality lookups x10k (200 rows each) | 206 | 206 (1.00× ≈) | 209 (1.01× ≈) | 210 (1.02× ≈) |
| index: range lookups x1k (1% of rows each) | 1279 | 1088 (0.85× ≈) | 1150 (0.90× ≈) | 1212 (0.95× ≈) |
| index: composite lookups x1k (d = ? AND c > 500) | 69.6 | 68.0 (0.98× ≈) | 68.2 (0.98× ≈) | 79.2 (1.14× ≈) |
| index: expression lookups x1k (lower(e) = ?) | 338 | 499 (1.48× ≈) | 470 (1.39× ≈) | 426 (1.26× ≈) |
| index: update indexed column, 10k rows (3 indexes) | 458 | 3983 (8.69× ✓) | 3461 (7.55× ✓) | 888 (1.94× ✓) |
| index: delete 10k rows (3 indexes) | 395 | 1742 (4.41× ✓) | 3710 (9.40× ✓) | 905 (2.29× ✓) |
| index: bulk insert 100k rows into a table with 3 indexes | 1570 | 6935 (4.42× ✓) | 2666 (1.70× ✓) | 2526 (1.61× ✓) |
| load join tables (612000 rows, 2 indexes) | 3146 | 11147 (3.54× ✓) | 6367 (2.02× ✓) | 6211 (1.97× ✓) |
| join: J1 join + group by (10k x 200k) (first run) | 81.3 | 230 (2.83× ✓) | 229 (2.81× ✓) | 256 (3.15× ✓) |
| join: J1 join + group by (10k x 200k) (repeat, median of 5) | 40.3 | 216 (5.36× ✓) | 240 (5.95× ✓) | 258 (6.40× ✓) |
| join: J2 selective filter on small side (first run) | 8.54 | 2.80 (0.33× ✗) | 2.93 (0.34× ✗) | 3.12 (0.37× ✗) |
| join: J2 selective filter on small side (repeat, median of 5) | 2.11 | 2.26 (1.07× ≈) | 2.33 (1.10× ≈) | 2.58 (1.22× ≈) |
| join: J3 written in a bad order (first run) | 3.85 | 1.48 (0.38× ✗) | 1.42 (0.37× ✗) | 1.45 (0.38× ✗) |
| join: J3 written in a bad order (repeat, median of 5) | 0.41 | 1.18 (2.88× ✓) | 1.25 (3.05× ✓) | 1.25 (3.05× ✓) |
| join: J4 3-way join + group by (first run) | 125 | 317 (2.54× ✓) | 336 (2.69× ✓) | 375 (3.01× ✓) |
| join: J4 3-way join + group by (repeat, median of 5) | 103 | 362 (3.50× ✓) | 330 (3.20× ✓) | 339 (3.28× ✓) |
| join: J5 point join (first run) | 1.34 | 0.49 (0.36× ✗) | 0.37 (0.28× ✗) | 0.46 (0.34× ✗) |
| join: J5 point join (repeat, median of 5) | 0.02 | 0.05 (2.50× ✓) | 0.06 (2.75× ✓) | 0.06 (2.75× ✓) |
| join: J6 left join, unmatched (first run) | 34.0 | 138 (4.07× ✓) | 134 (3.95× ✓) | 137 (4.03× ✓) |
| join: J6 left join, unmatched (repeat, median of 5) | 17.9 | 129 (7.21× ✓) | 124 (6.93× ✓) | 162 (9.05× ✓) |
| join: J7 join on non-indexed column (first run) | 78.9 | 465 (5.90× ✓) | 457 (5.79× ✓) | 471 (5.97× ✓) |
| join: J7 join on non-indexed column (repeat, median of 5) | 57.3 | 496 (8.65× ✓) | 462 (8.06× ✓) | 454 (7.91× ✓) |

## Like for like: browser, in memory (CPU only)

| Workload | smaltdb (:memory:) | SQLite WASM (:memory:) |
|---|---|---|
| bulk insert 100000 rows (1 txn) | 433 | 778 (1.80× ✓) |
| point lookup x10000 (warm) | 54.4 | 71.9 (1.32× ≈) |
| scan read values (warm) | 32.6 | 254 (7.78× ✓) |
| 200 single-row durable txns | 2.05 | 2.44 (1.19× ≈) |
| load analytic table (200000 rows) | 881 | 2052 (2.33× ✓) |
| analytic: filter + sum (first run) | 19.6 | 20.7 (1.06× ≈) |
| analytic: filter + sum (repeat, median of 5) | 6.25 | 17.9 (2.86× ✓) |
| analytic: group by (100 groups) (first run) | 40.3 | 213 (5.29× ✓) |
| analytic: group by (100 groups) (repeat, median of 5) | 13.4 | 173 (12.86× ✓) |
| analytic: arith filter + aggregate (first run) | 21.5 | 21.1 (0.98× ≈) |
| analytic: arith filter + aggregate (repeat, median of 5) | 6.11 | 20.4 (3.33× ✓) |
| mv: build projection of a (200000 rows) | 175 | 63.3 (0.36× ✗) |
| mv: filter + sum on projection (first run) | 14.3 | 18.8 (1.32× ✓) |
| mv: filter + sum on projection (repeat, median of 5) | 1.56 | 18.3 (11.72× ✓) |
| mv: group by (100 groups) on projection (first run) | 27.2 | 170 (6.23× ✓) |
| mv: group by (100 groups) on projection (repeat, median of 5) | 9.86 | 177 (18.00× ✓) |
| mv: arith filter + aggregate on projection (first run) | 20.7 | 21.1 (1.02× ≈) |
| mv: arith filter + aggregate on projection (repeat, median of 5) | 2.82 | 22.4 (7.93× ✓) |
| mv: clustered range x20 on projection (5% of rows each) | 38.4 | 299 (7.79× ✓) |
| mv: refresh projection (200000 rows) | 157 | 103 (0.65× ✗) |
| index: create on 1 column (200000 rows) | 173 | 125 (0.72× ≈) |
| index: create on 2 columns (200000 rows) | 151 | 219 (1.45× ≈) |
| index: create on expression lower(e) (200000 rows) | 293 | 194 (0.66× ✗) |
| index: equality lookups x10k (200 rows each) | 225 | 229 (1.02× ≈) |
| index: range lookups x1k (1% of rows each) | 1482 | 1119 (0.76× ✗) |
| index: composite lookups x1k (d = ? AND c > 500) | 93.8 | 76.9 (0.82× ≈) |
| index: expression lookups x1k (lower(e) = ?) | 343 | 445 (1.30× ≈) |
| index: update indexed column, 10k rows (3 indexes) | 215 | 64.3 (0.30× ✗) |
| index: delete 10k rows (3 indexes) | 123 | 71.2 (0.58× ✗) |
| index: bulk insert 100k rows into a table with 3 indexes | 1305 | 1476 (1.13× ✓) |
| load join tables (612000 rows, 2 indexes) | 2404 | 3507 (1.46× ✓) |
| join: J1 join + group by (10k x 200k) (first run) | 74.4 | 242 (3.26× ✓) |
| join: J1 join + group by (10k x 200k) (repeat, median of 5) | 45.8 | 222 (4.84× ✓) |
| join: J2 selective filter on small side (first run) | 6.93 | 3.04 (0.44× ≈) |
| join: J2 selective filter on small side (repeat, median of 5) | 1.21 | 2.46 (2.03× ✓) |
| join: J3 written in a bad order (first run) | 4.42 | 1.40 (0.32× ✗) |
| join: J3 written in a bad order (repeat, median of 5) | 0.39 | 1.20 (3.06× ✓) |
| join: J4 3-way join + group by (first run) | 155 | 337 (2.17× ✓) |
| join: J4 3-way join + group by (repeat, median of 5) | 110 | 380 (3.46× ✓) |
| join: J5 point join (first run) | 1.12 | 0.48 (0.43× ✗) |
| join: J5 point join (repeat, median of 5) | 0.01 | 0.06 (4.33× ✓) |
| join: J6 left join, unmatched (first run) | 38.6 | 142 (3.69× ✓) |
| join: J6 left join, unmatched (repeat, median of 5) | 18.8 | 142 (7.53× ✓) |
| join: J7 join on non-indexed column (first run) | 64.0 | 432 (6.75× ✓) |
| join: J7 join on non-indexed column (repeat, median of 5) | 60.5 | 417 (6.90× ✓) |

## Most aggressive: Node, files on disk (smaltdb against native SQLite)

`synchronous=FULL` fsyncs every commit, as smaltdb does. `synchronous=NORMAL` fsyncs only at checkpoints, so it can
lose the last commits on power failure: its commit-sensitive rows (single-row txns) are not comparable on durability.

| Workload | smaltdb | SQLite native (WAL, synchronous=FULL) | SQLite native (WAL, synchronous=NORMAL) |
|---|---|---|---|
| bulk insert 100000 rows (1 txn) | 557 | 219 (0.39× ✗) | 224 (0.40× ✗) |
| point lookup x10000 (warm) | 93.5 | 20.8 (0.22× ✗) | 28.5 (0.30× ✗) |
| scan read values (warm) | 44.7 | 134 (2.99× ✓) | 127 (2.83× ✓) |
| 200 single-row durable txns | 138 | 42.8 (0.31× ✗) | 2.95 (0.02× ✗) |
| point lookup x10000 (cold) | 57.2 | 25.4 (0.44× ✗) | 33.4 (0.58× ✗) |
| scan read values (cold) | 53.3 | 114 (2.14× ✓) | 139 (2.61× ✓) |
| load analytic table (200000 rows) | 1000 | 360 (0.36× ✗) | 363 (0.36× ✗) |
| analytic: filter + sum (first run) | 26.3 | 14.5 (0.55× ✗) | 13.9 (0.53× ✗) |
| analytic: filter + sum (repeat, median of 5) | 7.24 | 14.5 (2.00× ✓) | 13.3 (1.84× ✓) |
| analytic: group by (100 groups) (first run) | 40.5 | 116 (2.86× ✓) | 114 (2.81× ✓) |
| analytic: group by (100 groups) (repeat, median of 5) | 17.0 | 102 (5.99× ✓) | 103 (6.10× ✓) |
| analytic: arith filter + aggregate (first run) | 24.9 | 15.5 (0.62× ≈) | 15.1 (0.61× ✗) |
| analytic: arith filter + aggregate (repeat, median of 5) | 7.27 | 15.8 (2.17× ✓) | 17.1 (2.36× ✓) |
| mv: build projection of a (200000 rows) | 234 | 94.3 (0.40× ✗) | 93.5 (0.40× ✗) |
| mv: filter + sum on projection (first run) | 14.6 | 16.2 (1.11× ≈) | 14.7 (1.01× ≈) |
| mv: filter + sum on projection (repeat, median of 5) | 1.94 | 18.4 (9.49× ✓) | 15.3 (7.87× ✓) |
| mv: group by (100 groups) on projection (first run) | 28.5 | 105 (3.69× ✓) | 130 (4.54× ✓) |
| mv: group by (100 groups) on projection (repeat, median of 5) | 11.1 | 93.2 (8.38× ✓) | 91.6 (8.23× ✓) |
| mv: arith filter + aggregate on projection (first run) | 17.5 | 14.9 (0.85× ≈) | 15.3 (0.87× ≈) |
| mv: arith filter + aggregate on projection (repeat, median of 5) | 2.23 | 14.7 (6.59× ✓) | 15.3 (6.89× ✓) |
| mv: clustered range x20 on projection (5% of rows each) | 36.9 | 230 (6.22× ✓) | 287 (7.77× ✓) |
| mv: refresh projection (200000 rows) | 201 | 113 (0.56× ✗) | 116 (0.58× ✗) |
| index: create on 1 column (200000 rows) | 208 | 80.6 (0.39× ✗) | 97.1 (0.47× ✗) |
| index: create on 2 columns (200000 rows) | 203 | 152 (0.75× ≈) | 183 (0.90× ≈) |
| index: create on expression lower(e) (200000 rows) | 263 | 110 (0.42× ✗) | 102 (0.39× ✗) |
| index: equality lookups x10k (200 rows each) | 225 | 91.5 (0.41× ✗) | 88.9 (0.40× ✗) |
| index: range lookups x1k (1% of rows each) | 1358 | 916 (0.67× ✗) | 974 (0.72× ✗) |
| index: composite lookups x1k (d = ? AND c > 500) | 100 | 39.0 (0.39× ✗) | 36.5 (0.36× ✗) |
| index: expression lookups x1k (lower(e) = ?) | 398 | 261 (0.65× ✗) | 221 (0.55× ✗) |
| index: update indexed column, 10k rows (3 indexes) | 363 | 98.2 (0.27× ✗) | 102 (0.28× ✗) |
| index: delete 10k rows (3 indexes) | 228 | 86.2 (0.38× ✗) | 94.4 (0.41× ✗) |
| index: bulk insert 100k rows into a table with 3 indexes | 1277 | 618 (0.48× ✗) | 602 (0.47× ✗) |
| load join tables (612000 rows, 2 indexes) | 3585 | 1433 (0.40× ✗) | 1518 (0.42× ✗) |
| join: J1 join + group by (10k x 200k) (first run) | 135 | 149 (1.11× ≈) | 196 (1.45× ≈) |
| join: J1 join + group by (10k x 200k) (repeat, median of 5) | 94.7 | 137 (1.45× ✓) | 143 (1.51× ✓) |
| join: J2 selective filter on small side (first run) | 11.3 | 2.01 (0.18× ✗) | 1.99 (0.18× ✗) |
| join: J2 selective filter on small side (repeat, median of 5) | 3.66 | 1.42 (0.39× ✗) | 1.56 (0.43× ✗) |
| join: J3 written in a bad order (first run) | 6.04 | 0.58 (0.10× ✗) | 0.58 (0.10× ✗) |
| join: J3 written in a bad order (repeat, median of 5) | 0.77 | 0.49 (0.65× ≈) | 0.49 (0.64× ✗) |
| join: J4 3-way join + group by (first run) | 197 | 311 (1.58× ✓) | 334 (1.70× ✓) |
| join: J4 3-way join + group by (repeat, median of 5) | 175 | 332 (1.90× ✓) | 317 (1.81× ✓) |
| join: J5 point join (first run) | 1.94 | 0.14 (0.07× ✗) | 0.11 (0.06× ✗) |
| join: J5 point join (repeat, median of 5) | 0.01 | 0.02 (1.64× ✓) | 0.02 (1.79× ✓) |
| join: J6 left join, unmatched (first run) | 57.6 | 141 (2.44× ✓) | 135 (2.34× ✓) |
| join: J6 left join, unmatched (repeat, median of 5) | 20.8 | 144 (6.94× ✓) | 137 (6.58× ✓) |
| join: J7 join on non-indexed column (first run) | 89.6 | 344 (3.84× ✓) | 331 (3.69× ✓) |
| join: J7 join on non-indexed column (repeat, median of 5) | 66.4 | 311 (4.68× ✓) | 305 (4.59× ✓) |

## Most aggressive: Node, in memory (CPU only)

| Workload | smaltdb (:memory:) | SQLite native (:memory:) | SQLite WASM (:memory:) |
|---|---|---|---|
| bulk insert 100000 rows (1 txn) | 458 | 217 (0.47× ✗) | 797 (1.74× ✓) |
| point lookup x10000 (warm) | 64.0 | 18.7 (0.29× ✗) | 77.5 (1.21× ≈) |
| scan read values (warm) | 42.5 | 117 (2.75× ✓) | 246 (5.77× ✓) |
| 200 single-row durable txns | 2.49 | 0.80 (0.32× ✗) | 2.56 (1.03× ≈) |
| load analytic table (200000 rows) | 820 | 298 (0.36× ✗) | 1975 (2.41× ✓) |
| analytic: filter + sum (first run) | 27.4 | 18.1 (0.66× ✗) | 28.8 (1.05× ≈) |
| analytic: filter + sum (repeat, median of 5) | 7.59 | 17.8 (2.34× ✓) | 24.5 (3.23× ✓) |
| analytic: group by (100 groups) (first run) | 39.3 | 135 (3.44× ✓) | 194 (4.94× ✓) |
| analytic: group by (100 groups) (repeat, median of 5) | 23.4 | 110 (4.71× ✓) | 186 (7.94× ✓) |
| analytic: arith filter + aggregate (first run) | 29.1 | 15.4 (0.53× ✗) | 23.3 (0.80× ≈) |
| analytic: arith filter + aggregate (repeat, median of 5) | 8.06 | 15.6 (1.94× ≈) | 22.3 (2.76× ✓) |
| mv: build projection of a (200000 rows) | 249 | 69.2 (0.28× ✗) | 82.0 (0.33× ✗) |
| mv: filter + sum on projection (first run) | 19.9 | 18.8 (0.95× ≈) | 22.7 (1.14× ✓) |
| mv: filter + sum on projection (repeat, median of 5) | 3.04 | 18.1 (5.95× ✓) | 24.8 (8.15× ✓) |
| mv: group by (100 groups) on projection (first run) | 35.0 | 97.8 (2.79× ✓) | 183 (5.22× ✓) |
| mv: group by (100 groups) on projection (repeat, median of 5) | 15.6 | 98.6 (6.31× ✓) | 190 (12.17× ✓) |
| mv: arith filter + aggregate on projection (first run) | 19.1 | 15.9 (0.83× ≈) | 23.3 (1.22× ✓) |
| mv: arith filter + aggregate on projection (repeat, median of 5) | 3.28 | 20.2 (6.14× ✓) | 23.8 (7.25× ✓) |
| mv: clustered range x20 on projection (5% of rows each) | 46.4 | 301 (6.48× ✓) | 362 (7.80× ✓) |
| mv: refresh projection (200000 rows) | 174 | 62.6 (0.36× ✗) | 115 (0.66× ≈) |
| index: create on 1 column (200000 rows) | 220 | 78.1 (0.36× ✗) | 133 (0.61× ≈) |
| index: create on 2 columns (200000 rows) | 235 | 105 (0.45× ✗) | 217 (0.92× ≈) |
| index: create on expression lower(e) (200000 rows) | 291 | 97.0 (0.33× ✗) | 210 (0.72× ≈) |
| index: equality lookups x10k (200 rows each) | 301 | 85.9 (0.29× ✗) | 217 (0.72× ✗) |
| index: range lookups x1k (1% of rows each) | 1587 | 918 (0.58× ✗) | 1180 (0.74× ✗) |
| index: composite lookups x1k (d = ? AND c > 500) | 98.0 | 38.4 (0.39× ✗) | 73.9 (0.75× ≈) |
| index: expression lookups x1k (lower(e) = ?) | 504 | 225 (0.45× ✗) | 498 (0.99× ≈) |
| index: update indexed column, 10k rows (3 indexes) | 172 | 49.9 (0.29× ✗) | 61.1 (0.36× ✗) |
| index: delete 10k rows (3 indexes) | 115 | 55.8 (0.48× ✗) | 62.5 (0.54× ✗) |
| index: bulk insert 100k rows into a table with 3 indexes | 1090 | 623 (0.57× ✗) | 1564 (1.44× ✓) |
| load join tables (612000 rows, 2 indexes) | 2832 | 1279 (0.45× ✗) | 4563 (1.61× ✓) |
| join: J1 join + group by (10k x 200k) (first run) | 109 | 157 (1.43× ✓) | 245 (2.24× ✓) |
| join: J1 join + group by (10k x 200k) (repeat, median of 5) | 86.7 | 138 (1.59× ✓) | 245 (2.82× ✓) |
| join: J2 selective filter on small side (first run) | 6.88 | 2.74 (0.40× ✗) | 3.17 (0.46× ✗) |
| join: J2 selective filter on small side (repeat, median of 5) | 2.47 | 2.71 (1.10× ≈) | 2.65 (1.07× ≈) |
| join: J3 written in a bad order (first run) | 5.86 | 0.88 (0.15× ✗) | 1.51 (0.26× ✗) |
| join: J3 written in a bad order (repeat, median of 5) | 0.49 | 0.56 (1.14× ≈) | 1.22 (2.49× ≈) |
| join: J4 3-way join + group by (first run) | 171 | 315 (1.85× ✓) | 383 (2.25× ✓) |
| join: J4 3-way join + group by (repeat, median of 5) | 158 | 347 (2.20× ✓) | 374 (2.37× ✓) |
| join: J5 point join (first run) | 1.51 | 0.12 (0.08× ✗) | 0.39 (0.26× ✗) |
| join: J5 point join (repeat, median of 5) | 0.01 | 0.02 (2.26× ≈) | 0.08 (10.07× ✓) |
| join: J6 left join, unmatched (first run) | 55.0 | 125 (2.27× ✓) | 144 (2.62× ✓) |
| join: J6 left join, unmatched (repeat, median of 5) | 21.8 | 129 (5.93× ✓) | 142 (6.55× ✓) |
| join: J7 join on non-indexed column (first run) | 80.4 | 300 (3.73× ✓) | 459 (5.71× ✓) |
| join: J7 join on non-indexed column (repeat, median of 5) | 66.3 | 303 (4.57× ✓) | 521 (7.86× ✓) |

## Caveats

- **SQLite versions differ:** native 3.53.4 (bundled with Node 22.23) and WASM 3.54.1 (the npm package).
- **"Cold" rows reopen the database, but the operating system's file cache stays warm,** in Node as in the browser.
- **smaltdb's Node file VFS exists only for this benchmark,** to give it the same disk as native SQLite. smaltdb ships
  OPFS and memory VFSs.
- **The machine:** one 4-vCPU cloud container with a load average around 1 during the Node run. Spreads on
  millisecond-scale rows are wide, which is why verdicts need non-overlapping ranges.
