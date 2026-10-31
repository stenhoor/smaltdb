# M0 baseline: storage layer vs. SQLite WASM, PGlite, DuckDB-WASM

- Date: 2026-10-31
- Environment: Chromium 153 (Playwright, headless), 4-vCPU Intel Xeon @ 2.3 GHz container, Linux. This is not the
  reference laptop from [PERFORMANCE.md](../PERFORMANCE.md).
- Run with: `npm run bench:browser -- --save`. Raw data: [bench/results/2026-10-31-chromium.json](../../bench/results/2026-10-31-chromium.json).

Workload: table `t(k INTEGER PRIMARY KEY, v TEXT)` with 100,000 rows and a 32-character `v`. Each engine runs in its own dedicated
worker and stores its data in OPFS.

| Engine (configuration) | Bulk insert 100k (1 txn) | 10k random point lookups | count(*) | Scan, read all values | 200 single-row durable txns | Open |
|---|---|---|---|---|---|---|
| **smaltdb M0** (storage layer only; OPFS sync handle; flush per commit) | **273 ms** | **12 ms** | **0.3 ms** | **13 ms** | **169 ms** | 14 ms |
| SQLite WASM 3.54.1 (opfs-sahpool, `locking_mode=EXCLUSIVE`, `journal_mode=TRUNCATE`, `synchronous=FULL`) | 610 ms | 39 ms | 0.5 ms | 115 ms | 675 ms | 100 ms |
| PGlite (opfs-ahp; lookups in one read-only txn; 1000-row INSERT batches) | 2,078 ms | 7,258 ms | 12 ms | 195 ms | 176 ms | 7,332 ms |
| DuckDB-WASM (eh build, OPFS file; 1000-row INSERT batches) | 1,003 ms | 10,730 ms | 5.6 ms | 91 ms | 201 ms | 784 ms |

Speed relative to SQLite WASM (>1 means faster than SQLite):

| | Bulk insert | Point lookup | count(*) | Scan values | Small txns |
|---|---|---|---|---|---|
| smaltdb M0 | 2.2× | 3.2× | 1.8× | 8.8× | 4.0× |
| PGlite | 0.29× | 0.01× | 0.05× | 0.59× | 3.8× |
| DuckDB-WASM | 0.61× | <0.01× | 0.10× | 1.3× | 3.4× |

## Read these numbers with care

The smaltdb column **overstates** what a full smaltdb will deliver:

1. **No SQL layer yet.** smaltdb calls the B+tree directly. The other engines parse and execute SQL and convert values
   between JS and WASM. M1 adds parsing, planning, record decoding, and the worker message hop.
2. **No crash atomicity yet.** M0 commit writes pages in place, then flushes. SQLite's `TRUNCATE` journal writes more data
   to make commits atomic. The small-transaction column will narrow when the WAL lands in M2. The goal is still under 1 ms per commit.
3. **Single run on a shared container.** Run-to-run variance is roughly ±30% on the sub-20 ms rows.

Even so, the storage layer leaves real headroom against the bar in ADR 0002, which is to beat SQLite WASM on every workload.
Every M1+ milestone reruns this suite.

## Configuration notes

- **SQLite:** with the default `locking_mode=NORMAL`, point lookups took about 725 µs each, because every autocommit read
  re-validates its cache. `EXCLUSIVE` is the usual recommendation for opfs-sahpool, which supports only one connection anyway, so we benchmark that.
- **PGlite:** about 0.75 ms per query even inside a single read-only transaction. This looks like per-query overhead
  in its async query path. Bulk insert uses multi-row `INSERT`; `COPY` would probably be faster.
- **DuckDB-WASM:** it is an analytics engine behind its own worker, so per-statement round trips dominate point lookups.
  Its strengths (vectorized aggregates and joins over columnar data) are not exercised here. The TPC-H suite (M3/M7)
  is the right comparison for it.

## Optimizations found during M0

- **Coalescing commit writes** (runs of consecutive pages, up to 1 MiB per write) cut bulk-insert time from 892 ms to
  254 ms. Per-call OPFS overhead dominates when writing 8 KiB at a time.
- **`count()` from leaf cell counts** (what SQLite does for `count(*)`) is 0.3 ms instead of 1.6–4 ms for a cursor walk.

## Storage micro-benchmarks (Node 22, MemoryVfs, `npm run bench`)

| Case | ns/op |
|---|---|
| B+tree sequential insert (100k, then commit) | ~880 |
| B+tree random insert | ~1,240 |
| Point get, random, warm cache | ~850 |
| `has`, random, warm cache | ~600 |
| Cursor full scan | ~7 |
| Encode int key | ~6 |
| Encode (int, text) key | ~70 |

Known hot spots for later: `DataView` accessor calls in binary search, the `Map` lookup per page fetch, and per-insert
cell allocations during splits.
