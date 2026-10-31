# ADR 0002: Isolation, browser floor, packaging, results, collation, performance targets

- **Status:** accepted
- **Date:** 2026-10-31

## Decisions

1. **Isolation:** snapshot isolation with a single writer (as in SQLite WAL mode). Serializable isolation is out of scope.
2. **Minimum browsers:** Chrome/Edge 108, Firefox 111, and Safari 17. The baseline must work with only these features.
   **Future option:** feature-detected fast paths for newer browsers (e.g. `readwrite-unsafe` sync handles for
   multi-handle reads, JSPI, newer OPFS APIs). The VFS and worker layers must expose capability flags so these
   can be added without changing the format or the API.
3. **Packaging:** the library spawns its own worker through `new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })`,
   a form Vite, webpack 5, esbuild, and Rollup all handle. Apps can override it with `worker: URL | string | Worker`.
4. **Results:** the wire is always columnar with transferable buffers. `query()` returns an array of objects by default.
   `rowMode: 'array' | 'columnar'` is available. Rationale: [research/result-shape-benchmark.md](../research/result-shape-benchmark.md).
5. **Collation:** SQLite built-ins only: `BINARY` (default), `NOCASE` (ASCII), and `RTRIM`. Locale-aware collation is a possible future extension.
6. **Performance:** aggressive targets. smaltdb must **beat SQLite WASM (OPFS VFS) on every benchmark workload**,
   and it must be competitive with DuckDB-WASM on analytical workloads up to 1 GB. PGlite is also a baseline.
   See [PERFORMANCE.md](../PERFORMANCE.md).

## Consequences

- No read-set tracking is needed. Write conflicts cannot happen because there is a single writer.
- The comparable-key encoding for `BINARY` and `NOCASE` can be computed byte-wise, with no ICU dependency.
- The benchmark harness, with all three competitors, must exist from M0 so that every milestone is measured against them.
