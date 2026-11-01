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
4. **The big win is columnar storage plus generated fused loops (V3): about 8× over today, about 15× over SQLite** for scan-heavy math.
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
