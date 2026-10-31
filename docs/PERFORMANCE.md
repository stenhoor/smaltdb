# Performance

## 1. Targets (aggressive; ADR 0002)

**Relative bar (must hold for 1.0):**
- **Beat SQLite WASM (official build, OPFS VFS) on every workload** in the suite: point reads, range scans, inserts,
  updates, joins, aggregates, and commit latency.
- **Competitive with DuckDB-WASM** on analytical queries up to 1 GB: within 1.5× on TPC-H SF1 using columnar tables,
  with a stretch goal of parity. smaltdb should win clearly on OLTP-style workloads.
- **PGlite** is tracked as a baseline. smaltdb should beat it across the board.

**Absolute targets.** The reference device is a mid-range 2024 laptop running Chrome stable, with a warm cache unless noted.
These are re-baselined once the M0 harness exists.

| Workload | Target |
|---|---|
| Point lookup by PK (prepared, cached) | < 5 µs engine time; < 0.15 ms round trip including the worker hop |
| Bulk insert | > 3M rows/s (narrow rows, `insertColumns`); > 500K rows/s via prepared `INSERT` in a transaction |
| Full scan + filter + aggregate, 10M rows × 5 numeric cols | < 150 ms single worker (row store); < 50 ms columnar; near-linear scaling with reader workers |
| Hash join 1M × 10M | < 800 ms single worker |
| Cold open of a 1 GB database | < 20 ms (lazy load; no full read) |
| Commit latency, `synchronous=full`, single small txn | < 1 ms where OPFS `flush()` allows; never slower than SQLite WASM |
| Result delivery, 1M rows × 5 cols to client | < 30 ms columnar; < 120 ms as objects |

## 2. Benchmarks

- Comparison baselines, run from M0 onward: **SQLite WASM (OPFS VFS)**, **DuckDB-WASM**, and **PGlite**.
- Supported-browser floor for benchmarks: Chrome 108 / Firefox 111 / Safari 17, plus current stable.
- Suites: micro (operators, B+tree, record decode), TPC-H SF 0.1/1 (analytical), a YCSB-like workload (OLTP),
  and an app-like mixed workload.
- The suites run automatically in CI through Playwright on Chromium, Firefox, and WebKit (all three are supported targets). A regression of more than 5% fails the build.

## 3. Engineering rules

- Monomorphic hot loops: one typed-array kind per loop, with no polymorphic call sites inside them.
- No `async` inside the engine core. All engine code is synchronous.
- Avoid `BigInt` on hot paths. Represent int64 as two int32 halves, or as float64 when the value is known to be safe .
- Pool and reuse batches and buffers. Allocation sites are tracked in profiles.
- UTF-8 is decoded lazily with `TextDecoder` over subarrays. Comparisons run on raw bytes where the collation allows it.

## 4. Prior measurements

- [Benchmark methodology and current results](research/benchmark-methodology.md): the rules every comparison must follow.

- [Result row shape](research/result-shape-benchmark.md): the columnar wire format is 70–90× cheaper than cloning rows.
