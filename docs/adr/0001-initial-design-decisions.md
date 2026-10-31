# ADR 0001: Initial design decisions

- **Status:** accepted
- **Date:** 2026-10-31

## Context

These decisions come from the first design interview. They fix the scope of v1 and the architectural baselines.

## Decisions

1. **Workload:** mixed OLTP + reporting. Design and benchmark targets assume databases up to ~1 GB (~10M rows).
2. **Storage:** own page format (not SQLite-compatible). Row-oriented clustered B+trees by default, with columnar tables as a later opt-in.
3. **Typing:** STRICT tables by default. SQLite affinity semantics through opt-in `LOOSE` tables.
4. **Concurrency:** one engine worker per database owns OPFS. Tabs share it through Web Locks leader election.
   SharedArrayBuffer-based parallel reader workers are enabled only when the page is cross-origin isolated.
5. **Execution:** expression code generation with `new Function` when CSP permits it, with an automatic closure-compiler fallback.
6. **Language:** TypeScript only, no WASM.
7. **Materialized views (v1):** `REFRESH MATERIALIZED VIEW` (full) and `REFRESH … CONCURRENTLY`.
   Incremental and on-commit maintenance are deferred.
8. **Deferred to after v1:** triggers, JSON functions, JS UDFs, live queries, encryption at rest, SQLite import, SQL dump.
   The architecture must leave room for each of them, but none blocks the initial release.
9. **Import/export (v1):** CSV and JSON/NDJSON.
10. **Durability:** `synchronous=full` by default, with group commit.
11. **Platforms:** Chromium, Firefox, and Safari/iOS (current + previous stable). Node is used only to run unit tests.
12. **License:** MIT.

## Consequences

- No need to match SQLite's varint record format. Column-addressable records and memcmp-comparable keys are allowed.
- The fixed-width vector paths can assume declared types. `LOOSE` tables take a tagged-value slow path.
- The engine is correct and useful in a single worker. Parallelism is an additive optimization.
- We must test on WebKit early, because Safari's OPFS behaviour differs (quotas, handle limits, no `readwrite-unsafe`).
- Function and catalog registries must be extensible, so UDFs, JSON, and triggers can be added without format changes.
