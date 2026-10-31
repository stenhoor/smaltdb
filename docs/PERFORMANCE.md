# Performance

## 1. Targets (proposed, to be confirmed **[Q-1]**)

The reference device is a mid-range 2024 laptop running Chrome stable, with a warm cache unless noted.

| Workload | Target |
|---|---|
| Point lookup by PK (prepared, cached) | < 20 µs engine time; < 0.3 ms round trip including the worker hop |
| Bulk insert | > 1M rows/s (narrow rows, `insertColumns`); > 200K rows/s via prepared `INSERT` in a transaction |
| Full scan + filter + aggregate, 10M rows × 5 numeric cols | < 300 ms single worker; scales roughly linearly with reader workers |
| Hash join 1M × 10M | < 1.5 s single worker |
| Cold open of a 1 GB database | < 50 ms (lazy load; no full read) |

## 2. Benchmarks

- Comparison baselines: **SQLite WASM (OPFS VFS)**, **DuckDB-WASM**, and **PGlite**, where they apply.
- Suites: micro (operators, B+tree, record decode), TPC-H SF 0.1/1 (analytical), a YCSB-like workload (OLTP),
  and an app-like mixed workload.
- The suites run automatically in CI through Playwright on Chromium, Firefox, and WebKit. A regression of more than 5% fails the build.

## 3. Engineering rules

- Monomorphic hot loops: one typed-array kind per loop, with no polymorphic call sites inside them.
- No `async` inside the engine core. All engine code is synchronous.
- Avoid `BigInt` on hot paths. Represent int64 as two int32 halves, or as float64 when the value is known to be safe **[Q-5]**.
- Pool and reuse batches and buffers. Allocation sites are tracked in profiles.
- UTF-8 is decoded lazily with `TextDecoder` over subarrays. Comparisons run on raw bytes where the collation allows it.
