# M3: optimizer results

- Date: 2026-11-01
- Design and decisions: [ADR 0005](../adr/0005-cost-based-optimizer.md); implementation summary in
  [QUERY_ENGINE.md §7](../QUERY_ENGINE.md#7-what-m3-implements).
- Workloads: [bench/shared/joins.ts](../../bench/shared/joins.ts). The tables are customers (10k), orders
  (200k), products (2k) and line_items (400k), with indexes on `orders(customer_id)` and `line_items(order_id)`.

| Query | Shape |
|---|---|
| J1 | customers ⋈ orders, GROUP BY region |
| J2 | a selective filter on customers (`region = 3 AND id < 600`), then its orders |
| J3 | written in a bad order: `orders JOIN customers … WHERE c.name = 'customer-42'` |
| J4 | 3-way join orders ⋈ line_items ⋈ products, `status = 1`, GROUP BY category |
| J5 | point join through a primary key |
| J6 | LEFT JOIN anti-join (customers without status-4 orders) |
| J7 | equi-join on non-indexed columns, with a range filter on the small side |

## What changed the numbers, in order

Node 22, both engines in memory, median of repeated runs (bench/micro/joins.ts, no `ANALYZE` unless stated).
Before M3, joins ran in FROM order with rule-based access paths.

1. **Cost-based order and join method** (statistics from the tree shape plus a fixed NDV default).
   - J3 is reordered: customers is scanned first, then its orders are probed.
   - J6 and J7 become hash joins (7.9× and 9.9× faster than SQLite).
   - J4 stays an index nested loop over 40k outer rows: 205 ms vs SQLite's 176 ms. The default NDV of rows/10 made `status = 1`
     look 4000× more selective than it is.
2. **Sampled statistics** when `ANALYZE` has not run. J4 switches to two hash joins: 66 ms, 2.7× faster than SQLite.
   - *First sampler:* evenly spaced runs aliased with the periodic `customer_id` data (NDV 395 instead of 10k). The GEE
     estimator also underestimated unique columns 2.5×. J2 regressed to a 10 ms hash join.
   - *Fix:* jittered run starts and the Duj1 estimator brought the estimates to 11.7k (customer_id), 967 (amount, actual 1000),
     5 (status, actual 5) and 10,048 (name, actual 10,000).
3. **Text equality in generated code**, plus a raw-byte prefilter for `textcol = 'literal'` in fused scans. J3's 10k-row
   scan for one name went from 1.8 ms to 0.09 ms (SQLite 0.46 ms).
4. **Rowid suffix of index entries read without the generic key decoder.** That decoder was 36% of J2's profile.
   J2 went from 1.08 to 0.47 ms.

Final Node results (no `ANALYZE`):

| Query | smaltdb | SQLite WASM | ratio | plan |
|---|---|---|---|---|
| J1 | 30.9 ms | 89.5 ms | 2.90× | hash join, fused scans |
| J2 | 0.53 ms | 1.18 ms | 2.23× | rowid range on customers → index nested loop |
| J3 | 0.09 ms | 0.46 ms | 5.29× | fused scan with byte prefilter → index nested loop |
| J4 | 59.9 ms | 171.6 ms | 2.87× | two hash joins |
| J5 | 0.003 ms | 0.014 ms | 4.79× | rowid → rowid |
| J6 | 7.85 ms | 76.8 ms | 9.78× | left hash join |
| J7 | 21.7 ms | 220.2 ms | 10.14× | hash join |

## Estimates vs actuals (`EXPLAIN ANALYZE`)

`EXPLAIN ANALYZE` makes misestimates visible. The largest remaining one is J7's range predicate `price > 120`.
The fixed range selectivity of 0.33 gives 717 rows where 92 qualify, so the join output is estimated at 5.65M rows (actual 686k).
The chosen plan is still right, because the hash join is the cheapest method at either size. Histograms (deferred)
would fix the estimate.

```
id parent detail                                  est_rows loops rows    time_ms
3  2      HASH JOIN                               5651509  1     685716  111.6
4  3      SCAN line_items (fused scan + filter)   394240   1     400000   26.7
5  3      SCAN products (fused scan + filter)        717   1         92    0.8
```

## Known costs

- **First execution of a statement on a table** pays for sampling: about 1 ms per table, once per session.
  This is visible only on sub-millisecond queries (J2/J3/J5 first runs in the browser table below). Every
  repeated run, and every first run of a query that does real work, is faster than SQLite.
- `EXPLAIN ANALYZE` timings include two `performance.now()` calls per operator call.

## Browser results (Chromium 153, OPFS, 5 repetitions)

Raw data: [bench/results/2026-11-01-chromium-67bb868.json](../../bench/results/2026-11-01-chromium-67bb868.json).
The run used the working tree on top of 67bb868, which included the sampling and execution changes above.
Both engines run in a worker against OPFS, with no `ANALYZE`. Each row is compared against the faster of
SQLite's two crash-safe modes. Values are median (min–max) in ms. All engines returned identical results.

| Query | smaltdb | best crash-safe SQLite | ratio | verdict |
|---|---|---|---|---|
| J1 (first run) | 36.2 (31.5–39.1) | 87.3 (86.6–92.2) TRUNCATE | 2.41× | **faster** |
| J1 (repeat) | 20.6 (20.3–22.5) | 86.1 (85.3–87.4) WAL | 4.17× | **faster** |
| J2 (first run) | 5.66 (5.42–7.77) | 2.29 (2.24–2.33) WAL | 0.40× | **slower** |
| J2 (repeat) | 1.05 (1.02–1.78) | 1.22 (1.19–1.25) WAL | 1.17× | overlap |
| J3 (first run) | 2.05 (1.93–2.70) | 0.64 (0.62–0.66) TRUNCATE | 0.31× | **slower** |
| J3 (repeat) | 0.16 (0.14–0.30) | 0.55 (0.51–0.56) WAL | 3.58× | **faster** |
| J4 (first run) | 80.4 (72.7–89.2) | 177.6 (173.5–184.6) TRUNCATE | 2.21× | **faster** |
| J4 (repeat) | 48.6 (45.3–50.8) | 177.8 (174.5–178.9) TRUNCATE | 3.66× | **faster** |
| J5 (first run) | 0.71 (0.69–0.82) | 0.31 (0.25–0.35) WAL | 0.43× | **slower** |
| J5 (repeat) | 0.005 | 0.02 TRUNCATE | ~4× | **faster** |
| J6 (first run) | 16.4 (15.7–17.5) | 75.7 (73.7–93.9) TRUNCATE | 4.62× | **faster** |
| J6 (repeat) | 8.18 (8.10–9.08) | 74.4 (73.1–77.6) TRUNCATE | 9.09× | **faster** |
| J7 (first run) | 25.6 (24.2–31.2) | 192.5 (189.6–198.8) WAL | 7.53× | **faster** |
| J7 (repeat) | 21.1 (20.2–34.0) | 190.2 (187.9–195.0) TRUNCATE | 9.01× | **faster** |

**Summary:** 10 of 14 rows are faster, 3 are slower and 1 overlaps.
- The three slower rows are first runs of millisecond queries. They pay one-time costs: sampling (about 1 ms per table), planning,
  and compiling generated code (J2: 5.7 ms first, 1.05 ms after).
- J2's repeat is not a clear win: its range overlaps SQLite's because of one 1.78 ms outlier.
- Next steps for first runs: cheaper sampling (hash raw column bytes instead of decoding), and deferring sampling until a
  plan choice actually depends on the estimate.
