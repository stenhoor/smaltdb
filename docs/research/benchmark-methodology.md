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
