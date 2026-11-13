# Vectorization review: what would it add for math-heavy queries?

- Date: 2026-11-01
- Prototype: [`bench/micro/vectorization-review.ts`](../../bench/micro/vectorization-review.ts). All variants compute the same result, and the check is
  printed.
- Query: `SELECT count(*), sum(b * 2 + d), sum(c * 1.1) FROM a WHERE b % 7 = 3 AND c < 900`, 1M rows, Node 22 (V8), both engines in memory.

| Variant | ns/row | vs smaltdb now |
|---|---|---|
| SQLite WASM 3.54 (reference) | 41.0 | 0.58× |
| **V0** smaltdb now: one generated function per pipeline, row at a time, values in the register array | 23.3 | 1.0× |
| **V1** same row-at-a-time loop, values in JS locals instead of the register array | 11.0 | **2.2×** |
| **V2** vectorized over the current row store (each page decoded into typed arrays, selection vector, column loops) | 13.8 | 1.7× |
| **V3** columnar storage (typed arrays per column), fused vector loops with a selection vector | **2.8** | **8.4×** |
| **V4** columnar storage, classic vectorized engine (one primitive loop per operator, materialized intermediate vectors) | 13.6 | 1.7× |

## Findings

1. **Arithmetic itself is cheap. Moving values is what costs.** Going from V0 to V1 changes only *where* decoded values live. Storing
   REALs into the shared `SqlValue[]` register array boxes every double (a heap allocation and GC pressure), and register loads and
   stores are not as optimizable as locals. Halving the per-row cost requires no vectorization.
2. **Vectorizing the executor over the row store does not help (V2 vs V1).** The row format still has to be decoded row by row to
   fill the vectors, and the extra pass over the vectors costs more than it saves. This confirms the earlier M2-era prototype.
3. **"Classic" vectorization loses to fused loops in JavaScript (V4 vs V3).** Engines like DuckDB use one primitive per operator to
   amortize interpretation overhead and to let C++ compilers emit SIMD. smaltdb already removed interpretation overhead by
   generating code. V8 does **not** auto-vectorize JS loops into SIMD instructions, so materializing intermediate vectors is pure extra
   memory traffic (about 4.8× slower than V3).
4. **The big win is columnar storage plus generated fused loops (V3): about 8× over today** for scan-heavy math.
   Typed arrays keep values unboxed and contiguous, the predicate becomes a tight loop producing a selection vector, and the
   arithmetic runs over selected rows only. This is the design target for M7 columnar tables.
5. **SIMD would need WebAssembly.** JS has no SIMD API, and V8 does not auto-vectorize. WASM SIMD (128-bit) could add perhaps another 2–4× on
   pure arithmetic kernels over columnar data, but ADR 0001 decision 6 says "TypeScript, no WASM". This should only be revisited
   with measurements once V3 exists, and probably only for a small set of kernels (sum/filter over Float64Array/Int32Array).

## Recommendations

| Step | Expected gain on math-heavy scans | Effort | Notes |
|---|---|---|---|
| 1. Keep decoded columns and intermediates in **JS locals** in fused pipelines (spill to the register array only for closure-compiled fallback nodes) | ~2× (V0 → V1) | small | Works on today's row store; extends to fused projections and filters |
| 2. Extend fusion beyond ungrouped aggregates: **scan + filter + projection**, and **GROUP BY** with a generated hash aggregate | similar per-row savings for those shapes | medium | Needs a push-based "produce rows into a batch" interface at the pipeline sink |
| 3. **Columnar tables (M7)** with generated, fused vector loops over typed arrays and selection vectors, plus zone maps for skipping | ~4× beyond step 1 (~8× vs today) | large | The format work is the bulk; the executor side is a natural extension of the fused codegen |
| 4. Optional: WASM SIMD kernels for the hottest columnar primitives | maybe 2–4× on those kernels | medium, plus a policy change | Only after 3, and only if measurements justify relaxing "no WASM" |

**Do not build** a classic one-primitive-per-operator vectorized interpreter (V4). In JavaScript, with code generation available, it is
slower than fused generated loops and adds a second execution engine to maintain.

Caveats: Node/V8 only. Browser V8 behaves the same, but Firefox (SpiderMonkey) and Safari (JavaScriptCore) need measuring, because
JIT behaviour around typed arrays, `new Function` and boxing differs. V3 is a best case: real columnar storage adds null bitmaps,
encodings and page boundaries. Expect roughly 5–10× over today rather than 8.4×.

## Follow-up (2026-11-01): what step 1 actually needed

Moving decoded columns into JS locals (recommendation 1) alone gave almost nothing, about 23 → 22 ns/row. Hand-written variants showed
the real cost was **representation**: a variable that can hold either `null` or a double forces V8 to box every double
(V1b 12.2 → V1d 15.8 → V1c 17.2 ns/row). The exact SQLite `sum()` semantics (int-exact, Neumaier) cost only about 0.6 ns/row (V1 vs V1b).
The generator now carries SQL NULL in a separate boolean next to each numeric value, with a 0 placeholder, for columns, arithmetic
and comparisons. Numeric variables therefore stay unboxed. The fused arithmetic query went from ~22 to **18.7 ns/row** (SQLite: ~40). The rest of the
gap to the hand-written loop (~11) is per-row generality (overflow/short-record checks, int64 high words, `-0` normalization).

## GPU (WebGPU) and typed-array libraries

**WebGPU is not suitable for exact SQL arithmetic:**
- WGSL has no `f64` and no `i64` (only f32/i32/u32). SQL INTEGER sums must be exact to 2^63 and REAL is binary64. f32 sums are wrong
  beyond 2^24. Emulating 64-bit with paired 32-bit values costs several times the work.
- The workloads are memory-bound with a few operations per row. Uploading about 20 MB of columns for 1M rows costs milliseconds, and readback
  requires async `mapAsync` (about 0.1–1 ms latency). The columnar CPU loop does the whole query in 1.25–2.8 ms.
- Readback is async, but the engine is synchronous by design.
- WebGPU shipped in Chrome 113, Safari 26 and Firefox 141 (Windows first), so it is mostly absent from the supported minimum (Chrome 108, Firefox 111, Safari 17).
- This container has no GPU. Chromium only exposes WebGPU via the SwiftShader software adapter when forced, so we could not time it.

Possible future niche: approximate analytics or vector/ML functions over data kept resident on the GPU, as an optional extension.

**Typed-array libraries vs. generated loops:** same query, 1M rows, columnar typed arrays, identical results:
| | ms |
|---|---|
| Fused typed-array loop (what smaltdb's codegen would emit for M7 columnar tables) | 1.25 |
| Arquero 8 (optimized typed-array dataframe library) | 14.2 |

General-purpose libraries evaluate one operator at a time and materialize intermediate arrays (the V4 pattern). That is about 10× slower than
a loop generated per query. Typed arrays are the right storage for M7; a library on top would add overhead rather than remove it.
Apache Arrow remains interesting as an **interchange format** (zero-copy result export), not as a compute engine.

## Follow-up: recommendation 2 done (2026-11-01)

Fusion now also covers scan + filter feeding any consumer (rows handed over in batches of 256) and GROUP BY (key computation,
hash lookup and aggregate steps inline). Node, 200k rows: GROUP BY 16.3 → 8.3 ms, filtered GROUP BY with
arithmetic 11.3 → 5.1 ms, filter + arithmetic projection 7.2 → 4.7 ms. The next step is recommendation 3,
columnar tables (M7).
