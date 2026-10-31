# Research: result row shape (objects vs. arrays vs. columnar)

Date: 2026-10-31. Node 22.23 (V8), 1M rows × 5 columns (float64 id, string name, int32 age, float64 score, bool).
Scripts: [`bench/micro/result-shape.mjs`](../../bench/micro/result-shape.mjs) plus an ad-hoc `structuredClone` test.

| Measurement | Objects | Arrays | Columnar (typed arrays) |
|---|---|---|---|
| Build 1M rows from column vectors | ~50–100 ms | ~50–100 ms | n/a (0) |
| Heap per row | ~104 B | ~104 B | ~25 B |
| Filter + sum loop | ~18 ms | ~18 ms | ~2.4 ms |
| `structuredClone` (≈ `postMessage` copy) | ~1,030 ms | ~860 ms | ~12 ms (≈0 when transferred) |

## Findings

1. **Objects and arrays cost the same to build and to read** when the row factory is monomorphic.
   The first run showed objects 10× slower, but that was an artifact of run order and GC heap growth. Reversing the order flipped it.
2. **The worker boundary dominates.** Cloning row objects or arrays across `postMessage` is 70–90× slower than
   sending column vectors, and transferable buffers make the columnar path effectively free.
3. Columnar loops are about 7× faster than loops over row objects, which matters for charting and analytics consumers.

## Decision (ADR 0002)

- The wire format between engine and client is **always columnar batches** with transferred buffers.
- `db.query()` returns an **array of objects** by default. Objects are built on the client by a generated, monomorphic
  factory for each result shape.
- `rowMode: 'array'` and `rowMode: 'columnar'` are available. Columnar gives zero-copy access to the typed arrays.

Caveat: these are Node/V8 figures. Re-measure in Chromium, Firefox, and WebKit once the harness exists (M0).
