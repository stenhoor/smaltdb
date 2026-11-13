# Benchmark methodology and the first rigorous baseline

- Date: 2026-10-31
- Harness: `npm run bench:browser -- [--reps 5] [--engines …|all] [--baseline sqlite-off] [--save]`
- Raw data: [bench/results/2026-10-31-chromium-87091ad.json](../../bench/results/2026-10-31-chromium-87091ad.json)
  (includes the environment, every repetition, and the result checksums).

## Rules the harness enforces

1. **Same storage for everyone.** Every engine runs in its own dedicated worker and persists to OPFS:
   smaltdb on sync access handles, SQLite on `opfs-sahpool`, PGlite on `opfs-ahp`, DuckDB on an `opfs://` file.
2. **Like-for-like durability.** Every engine declares whether its commits are crash-atomic. The default baseline is
   **SQLite with `journal_mode=OFF`**, which matches smaltdb before M2 (no WAL). Commit-sensitive rows are flagged when engines
   differ. SQLite with `TRUNCATE` and `WAL` journals is kept as a reference.
3. **Repetitions.** By default each engine runs 5 times, each in a fresh worker on a fresh database. Engine order rotates per
   repetition so slow drift (thermal, GC, background load) does not favour one engine.
4. **Verdicts, not just ratios.** Each workload reports median, min, max and spread. A difference is reported as
   faster/slower **only when the min–max ranges do not overlap**; otherwise it is "overlap (no clear difference)".
5. **Cold and warm reads.** "Warm" rows read right after loading, with the data in the engine cache. "Cold" rows close and reopen the
   database first, so the engine cache is empty. The OS/browser file cache is not cleared, and cannot be from a page.
6. **Analytical queries**: filter + sum, GROUP BY, and arithmetic-heavy filter + aggregate over a 200k-row table.
7. **Correctness cross-check.** Every read workload returns a canonical checksum of its results. The run fails loudly if engines
   disagree.
8. **Environment recorded:** browser and user agent, host CPU / RAM / load average, and git commit.

Known limitation: DuckDB-WASM's OPFS tables did not survive terminate + reopen in our harness, so its "cold" rows are warm.

## Results (Chromium 153, 4-vCPU container, 5 repetitions, median and range in ms)

| Workload | smaltdb (non-atomic) | SQLite OFF (non-atomic, baseline) | SQLite TRUNCATE | SQLite WAL | smaltdb vs baseline |
|---|---|---|---|---|---|
| Bulk insert 100k rows (1 txn) | 250 (250–259) | 578 (567–618) | 590 | 804 | **2.3× faster** |
| Point lookup ×10k (warm) | 28 (27–41) | 38 (35–44) | 39 | 41 | overlap |
| Scan, read values (warm) | 59 (56–82) | 110 (107–113) | 117 | 113 | **1.9× faster** |
| 200 single-row durable txns | 174 (159–188) | 91 (84–96) | 659 | 458 | **1.9× slower** |
| Point lookup ×10k (cold) | 388 (347–393) | 129 (126–138) | 133 | 1,713 | **3.0× slower** |
| Scan, read values (cold) | 398 (392–431) | 231 (210–244) | 222 | 239 | **1.7× slower** |
| Load analytic table (200k rows) | 520 (496–532) | 1,171 (1,103–1,181) | 1,185 | 1,479 | **2.3× faster** |
| Analytic: filter + sum | 15.5 (15.1–49.9) | 10.4 (10.3–10.6) | 10.6 | 10.3 | **1.5× slower** |
| Analytic: GROUP BY (100 groups) | 25.5 (24.7–30.3) | 67.5 (66.1–78.4) | 67.9 | 66.4 | **2.6× faster** |
| Analytic: arithmetic filter + aggregate | 20.9 (20.5–26.5) | 8.3 (8.2–12.0) | 8.7 | 8.3 | **2.5× slower** |

**Summary:** smaltdb is faster at bulk loading, warm scans, and hash GROUP BY. It is on par for warm point lookups. It is
**slower** on durable small commits, cold reads, and scan-heavy filtering/arithmetic. This replaces the earlier
"beats SQLite on every workload" claim, which compared against a crash-safe SQLite and used single runs.

## Why cold reads are slow: an OPFS per-call cost

`bench/browser/opfs-probe.ts` measures `FileSystemSyncAccessHandle.read` directly. In this environment every call costs about
**190–215 µs regardless of size or pattern**: 4 KiB 196 µs, 8 KiB 215 µs, 64 KiB 269 µs, sequential 204 µs, rereading the same
page 189 µs. Buffer choice (arena views vs. separate buffers) makes no difference. CRC verification adds about 8 µs per 8 KiB page.

Implications for M2's I/O layer:
- read multi-page extents and read ahead on sequential scans, since 8× the data costs only about 1.25× the time;
- keep page checksums, but verify a run of pages after one read.

**Open questions:**
- SQLite's cold numbers imply fewer read calls than its page count suggests. We have not explained this yet.
- The per-call cost may be specific to headless Chromium in this container. Re-measure on real hardware and on Firefox/Safari
  before relying on it.

## Update after M2 (WAL + read-ahead), both sides crash-safe

Raw data: [bench/results/2026-10-31-chromium-35ea267.json](../../bench/results/2026-10-31-chromium-35ea267.json). Same machine,
5 repetitions. Each workload is compared against **the faster of SQLite's two crash-safe modes** (WAL or TRUNCATE), so smaltdb
never gets credit for SQLite's weaker configuration. For example, SQLite WAL's cold lookups take 1.7 s.

| Workload | smaltdb (WAL) | best crash-safe SQLite | ratio | verdict |
|---|---|---|---|---|
| Bulk insert 100k rows (1 txn) | 353 (330–394) | 601 (573–661) TRUNCATE | 1.70× | **faster** |
| Point lookup ×10k (warm) | 30.8 (27.9–32.5) | 36.7 (36.1–47.4) TRUNCATE | 1.19× | **faster** |
| Scan, read values (warm) | 60.7 (58.0–64.7) | 112 (103–140) TRUNCATE | 1.85× | **faster** |
| 200 single-row durable txns | 109 (98–115) | 460 (434–484) WAL | 4.22× | **faster** |
| Point lookup ×10k (cold) | 97.5 (92.7–105) | 134 (128–149) TRUNCATE | 1.37× | **faster** |
| Scan, read values (cold) | 143 (140–178) | 230 (223–260) TRUNCATE | 1.61× | **faster** |
| Load analytic table (200k rows) | 644 (632–649) | 1,171 (1,157–1,190) TRUNCATE | 1.82× | **faster** |
| Analytic: filter + sum | 17.0 (14.9–19.8) | 10.4 (10.2–11.6) WAL | 0.61× | **slower** |
| Analytic: GROUP BY (100 groups) | 25.7 (25.0–29.2) | 65.9 (65.1–72.4) WAL | 2.56× | **faster** |
| Analytic: arithmetic filter + aggregate | 20.8 (20.3–22.4) | 8.6 (8.3–8.9) TRUNCATE | 0.41× | **slower** |

What changed and why:
- **Durable commits** went from 0.87 ms to 0.54 ms each. A WAL commit is one write plus one flush, instead of in-place page
  writes plus a header write.
- **Cold reads** went from 3× slower to 1.4–1.6× faster, thanks to 64 KiB read-ahead extents. Measured per-call OPFS read cost in this
  environment: no read-ahead 211 µs × 1,543 calls; 64 KiB extents 289 µs × 193 calls.
- **Bulk loads** got about 40% slower than in non-atomic mode (pages are written twice), but stay 1.7× faster than SQLite.

**Still slower:** the two scan-heavy analytical queries. The cause is executor and expression overhead plus row decoding
(see the vectorization analysis). It is the next performance priority.

**Open question, unchanged:** the probe measured about 200 µs per OPFS read call, yet SQLite's cold numbers imply fewer or cheaper calls
than its page count suggests. Re-measure on real hardware and on Firefox/Safari.

## Update: generated row decoders, append-optimized splits, first-run vs repeat (2026-11-01)

Raw data: [bench/results/2026-11-01-chromium-5e9a80f.json](../../bench/results/2026-11-01-chromium-5e9a80f.json). Both sides are crash-safe,
there are 5 repetitions, and each workload is compared against the faster of SQLite's WAL and TRUNCATE modes. Analytical queries are now reported twice:
the **first run** in a fresh worker (which includes JIT warm-up of smaltdb's generated code and engine code) and the **repeat** (median
of 5 further runs, e.g. a refreshed dashboard). SQLite's WebAssembly is compiled ahead of time and barely changes between the two.

| Workload | smaltdb | best crash-safe SQLite | verdict |
|---|---|---|---|
| Bulk insert 100k rows | 253 | 607 | **2.40× faster** |
| Point lookup ×10k (warm) | 30.5 | 40.3 | **1.32× faster** |
| Scan, read values (warm) | 55.6 | 114 | **2.05× faster** |
| 200 single-row durable txns | 101 | 498 | **4.94× faster** |
| Point lookup ×10k (cold) | 59.8 | 134 | **2.25× faster** |
| Scan, read values (cold) | 103 | 238 | **2.31× faster** |
| Load analytic table (200k rows) | 504 | 1,209 | **2.40× faster** |
| Filter + sum: first run / repeat | 10.3 / 5.8 | 10.4 / 9.0 | tie / **1.55× faster** |
| GROUP BY: first run / repeat | 20.0 / 15.7 | 67.6 / 55.0 | **3.37× / 3.49× faster** |
| Arithmetic filter + aggregate: first run / repeat | 11.9 / 7.4 | 8.6 / 8.1 | **1.38× slower** / **1.09× faster** |

**What changed:**
- **The marginal cost of arithmetic is not the bottleneck.** In Node with both engines in memory, smaltdb's arithmetic costs about 0–2 ns
  per operation versus 1–5 ns for SQLite (measured as query time with versus without the arithmetic). The remaining gap was per-row
  pipeline cost.
- **Generated row decoders** read columns straight from leaf page bytes, with offsets and types baked in. Integers that fit in int32
  are produced as int32, so V8 keeps them as small integers; integer `%` on doubles had been calling `fmod`.
- **Append-optimized leaf splits.** Sequential inserts left every page half full. A 200k-row table shrank from 22.3 to 11.1 MiB,
  which halves the pages read by scans and cold reads.

**Remaining gap:** the arithmetic query's first run in a fresh worker. That run is 4–5 ms slower than its repeats because of JIT warm-up of
the generated per-query functions and of the engine. Statement preparation is about 0.3 ms once the engine is warm, but
about 3 ms for the very first statement in a worker. Options: fuse scan, filter and aggregate into one generated function per pipeline
(fewer cold functions), and reduce first-statement compile cost.

## Update: fused scan + filter + aggregate (2026-11-01)

Raw data: [bench/results/2026-11-01-chromium-aab7a9e.json](../../bench/results/2026-11-01-chromium-aab7a9e.json). Ungrouped aggregates over a
full scan now compile into one generated function per pipeline. Versus the faster crash-safe SQLite mode:

| Analytical query | first run | repeat (median of 5) |
|---|---|---|
| Filter + sum | 8.1 vs 10.4 ms: **1.29× faster** | 3.1 vs 9.0 ms: **2.92× faster** |
| GROUP BY (100 groups) (not fused) | **3.33× faster** | **3.72× faster** |
| Arithmetic filter + aggregate | 8.4 vs 8.7 ms: tie (ranges overlap) | 4.0 vs 8.1 ms: **2.01× faster** |

All other workloads are unchanged (1.2–4.8× faster). No workload in the suite has a longer median in smaltdb than in crash-safe SQLite WASM. See also [vectorization-review.md](vectorization-review.md).

## Update: fused pipelines for scan + filter and GROUP BY (2026-11-01)

Raw data: [bench/results/2026-11-01-chromium-5ba5455.json](../../bench/results/2026-11-01-chromium-5ba5455.json). Single-table scans with WHERE
(non-aggregate queries) and GROUP BY aggregations now also run as one generated function per query. Versus the faster crash-safe SQLite mode:

| Analytical query | first run | repeat (median of 5) |
|---|---|---|
| Filter + sum | **1.42× faster** | **3.66× faster** |
| GROUP BY (100 groups) | **5.44× faster** (was 3.37×) | **8.08× faster** (was 3.49×) |
| Arithmetic filter + aggregate | **1.24× faster** (was a tie) | **2.29× faster** |

Every workload's range, first runs included, now lies below crash-safe SQLite WASM's, with no overlap (tables above).

Caveat on cold reads: in this run smaltdb's cold point lookups measured 97 ms (90–103) while running after the other engines. Re-run alone
they measured 59–63 ms, matching earlier runs, and one standalone repetition spiked to 98 ms. Cold OPFS I/O in this shared container is noisy
and sensitive to the I/O of preceding engines. Cold-read comparisons should be confirmed on dedicated hardware.

## Baseline after the plan API and SQL split (Node, 2026-11-07)

Raw data: [bench/results/2026-11-07-node-fabbd86.json](../../bench/results/2026-11-07-node-fabbd86.json) (`main` after
ADR 0016's code, #104–#130, and ADR 0017, #131–#134) and [bench/results/2026-11-07-node-d94769b.json](../../bench/results/2026-11-07-node-d94769b.json)
(the last `main` before them). Run on the same machine with `npm run bench:native -- --engines smaltdb,smaltdb-mem,native-wal,native-mem --reps 5`, with
the "after" run repeated once to measure the machine's drift, and SQL from each commit's smaltql pin (`32c3de0` and
`fca25f9`).

- **Workloads:** over the 46 workloads, the geometric mean of after / before is 0.96 on file and 1.03 in memory.
  Native SQLite drifted 0.98 and 1.01 over the same runs. A second comparison of smaltdb alone (7 repetitions, two
  rounds each, alternating) gave 0.98 and 0.99. No workload was slower in every round, except one:
- **The first query of a process** (`analytic: filter + sum (first run)`) is about 16% slower (about 2–3 ms, once). The
  generated code is byte-for-byte the same. About 1 ms was the function catalog compiling every function on the
  first lookup; that is fixed by computing result types when read. The rest is the first execution of the same
  generated loop.
- **Statement compile** (smaltql's `npm run slt`, which compiles a new statement for nearly every record) is 3.6%
  slower in total: 38.8 s → 40.2 s (two runs each), with the same 122,333 / 122,334 passing. The cost is in the
  catalog API's expression descriptions (smaltql asks the engine to compile each expression it describes), not in
  execution.
- **Storage micro-benchmarks** (`npm run bench`): unchanged (geometric mean 0.91, within noise).

### Statement compile: accepted (2026-11-07)

A compile-only measurement (every query of an SLT file prepared and run 25 times in one process, best pass) puts the
cost at 0–18% by kind of statement: `random/expr` 52 → 63 ms, `random/aggregates` 141 → 166 ms, `select1` unchanged,
`index/between/1` 815 → 846 ms. It is spread over the plan API's layers rather than one place: asking the catalog to
describe expressions (about 1.5 ms of `random/expr`'s 11), function name and trait lookups (about 2 ms), and meaning
fields added to nodes after they are built (about 2.7 ms: copies of nodes, such as the planner's `rebind`, see more
object shapes).

Two fixes were measured and not taken. Walking each described expression once and a `Map` for aliases removed what
they targeted but changed nothing measurable. Giving every node all its meaning fields from creation (one shape per
kind) recovered most of the aggregate cost but made `index/between/1` 4% slower than `main`, as every node grew. The
owner accepted the cost: query execution is unchanged, and the compile cost is the price of the language-neutral
plan API. A narrower shape fix (only the nodes a language marks) is the place to start if it is revisited.
