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

**Honest summary:** smaltdb is faster at bulk loading, warm scans, and hash GROUP BY. It is on par for warm point lookups. It is
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
