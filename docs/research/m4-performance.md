# Performance after M4

- Date: 2026-11-01. Chromium 153, OPFS, 4-vCPU container, 5 repetitions with rotating engine order.
- Raw data:
  - [bench/results/2026-11-01-chromium-8157a64.json](../../bench/results/2026-11-01-chromium-8157a64.json) (after the fix below);
  - [bench/results/2026-11-01-chromium-c9d96db.json](../../bench/results/2026-11-01-chromium-c9d96db.json) (the run that found the regression).
- Each workload is compared with **the faster of SQLite WASM's two crash-safe modes** (WAL or TRUNCATE journal).
  Both engines are crash-safe. "faster"/"slower" is claimed only when the min–max ranges do not overlap.
- All engines returned identical results for every read workload.

| Workload | smaltdb, ms (min–max) | best crash-safe SQLite, ms | ratio | verdict |
|---|---|---|---|---|
| bulk insert 100000 rows (1 txn) | 257.7 (254–284) | 609.4 TRUNCATE | 2.36× | **faster** |
| point lookup x10000 (warm) | 32.8 (29–34) | 38.9 TRUNCATE | 1.18× | **faster** |
| scan read values (warm) | 57.1 (55–90) | 116.0 TRUNCATE | 2.03× | **faster** |
| 200 single-row durable txns | 104.8 (93–130) | 469.1 WAL | 4.47× | **faster** |
| point lookup x10000 (cold) | 80.5 (58–100) | 136.9 TRUNCATE | 1.70× | **faster** |
| scan read values (cold) | 103.5 (99–117) | 236.3 TRUNCATE | 2.28× | **faster** |
| load analytic table (200000 rows) | 520.4 (505–579) | 1180.9 TRUNCATE | 2.27× | **faster** |
| analytic: filter + sum — first run | 7.28 (6.77–7.48) | 10.5 TRUNCATE | 1.44× | **faster** |
| analytic: filter + sum — repeat | 2.40 (2.29–2.59) | 8.72 TRUNCATE | 3.64× | **faster** |
| analytic: group by (100 groups) — first run | 17.2 (12–19) | 64.8 TRUNCATE | 3.76× | **faster** |
| analytic: group by (100 groups) — repeat | 6.89 (6.59–7.13) | 53.6 TRUNCATE | 7.77× | **faster** |
| analytic: arith filter + aggregate — first run | 7.35 (6.96–7.55) | 8.33 TRUNCATE | 1.13× | **faster** |
| analytic: arith filter + aggregate — repeat | 3.72 (3.61–3.84) | 8.02 TRUNCATE | 2.16× | **faster** |
| load join tables (612000 rows, 2 indexes) | 2341.1 (2199–2476) | 2425.1 TRUNCATE | 1.04× | overlap |
| join: J1 join + group by (10k x 200k) — first run | 34.6 (33–40) | 94.4 TRUNCATE | 2.73× | **faster** |
| join: J1 join + group by (10k x 200k) — repeat | 21.6 (21–23) | 89.8 TRUNCATE | 4.16× | **faster** |
| join: J2 selective filter on small side — first run | 5.17 (5.01–6.67) | 2.40 WAL | 0.46× | **slower** |
| join: J2 selective filter on small side — repeat | 1.10 (1.02–1.28) | 1.29 WAL | 1.18× | overlap |
| join: J3 written in a bad order — first run | 2.22 (2.12–2.80) | 0.70 WAL | 0.32× | **slower** |
| join: J3 written in a bad order — repeat | 0.18 (0.15–0.30) | 0.57 WAL | 3.23× | **faster** |
| join: J4 3-way join + group by — first run | 73.0 (67–79) | 183.5 TRUNCATE | 2.51× | **faster** |
| join: J4 3-way join + group by — repeat | 47.9 (46–54) | 173.4 TRUNCATE | 3.62× | **faster** |
| join: J5 point join — first run | 0.88 (0.80–1.26) | 0.28 WAL | 0.31× | **slower** |
| join: J5 point join — repeat | 0.01 (0.01–0.01) | 0.02 WAL | 4.00× | **faster** |
| join: J6 left join, unmatched — first run | 16.4 (16–21) | 73.5 TRUNCATE | 4.47× | **faster** |
| join: J6 left join, unmatched — repeat | 8.77 (8.32–8.91) | 72.8 TRUNCATE | 8.31× | **faster** |
| join: J7 join on non-indexed column — first run | 26.5 (26–57) | 197.3 TRUNCATE | 7.44× | **faster** |
| join: J7 join on non-indexed column — repeat | 22.0 (21–23) | 192.9 TRUNCATE | 8.78× | **faster** |

**Summary:** 23 of 28 rows are faster, 2 overlap and 3 are slower.

The three slower rows are the *first* executions of millisecond-scale joins (J2, J3, J5) in a fresh worker. They are
0.4–2.8 ms slower than SQLite because V8 still has to warm up those code paths; SQLite WASM is compiled ahead of time.
Their repeated runs are 1.2–4× faster or overlap. See the first-run analysis in
[m3-optimizer.md](m3-optimizer.md#follow-up-first-run-cost-2026-11-01).

## Regression found and fixed

The first post-M4 run loaded the join tables (612k rows plus 2 CREATE INDEX) in 2,597 ms, against 2,153 ms at M3.
Plain inserts and CREATE INDEX were also slower in Node. Two M4 changes caused it:

1. **Per-row foreign-key check.** Every written row asked whether its table takes part in foreign keys, by
   lower-casing the table name and doing two map lookups. The answer is now cached per table.
2. **CREATE INDEX on plain columns.** To support expression indexes, it decoded every column of every row; it now
   decodes only the indexed columns again. Expression and partial indexes keep the full-row path.

| Test | M3 | Before the fix | After the fix |
|---|---|---|---|
| Node: insert 612k join rows | 868 ms | 961 ms | ~915 ms |
| Node: insert 400k rows into one table | 507 ms | — | 499 ms |
| Node: 2 × CREATE INDEX | 880 ms | 1,053 ms | ~780–960 ms |
| Browser: load join tables | 2,153 ms | 2,597 ms | 2,341 ms (range 2,199–2,476) |

## Compared with the M3 runs (smaltdb medians)

| Workload | M3 | after M4 |
|---|---|---|
| Bulk insert 100k rows | 250 ms | 258 ms |
| 200 single-row durable txns | 94 ms | 105 ms |
| Point lookup ×10k (warm / cold) | 32 / 60 ms | 33 / 81 ms |
| Scan (warm / cold) | 55 / 109 ms | 57 / 104 ms |
| Analytic group by, repeat | 6.8 ms | 6.9 ms |
| J1 / J4 / J6 / J7, repeat | 21 / 45 / 8.4 / 22 ms | 22 / 48 / 8.8 / 22 ms |

Most rows are within run-to-run noise. Cold point lookups show the widest spread of any row in both runs
(58–100 ms here), so the 60 → 81 ms median difference is not a clear regression. They are still 1.7× faster
than SQLite.
