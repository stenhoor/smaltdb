# ADR 0008: Materialized views and columnar segments (M5)

- **Status:** accepted
- **Date:** 2026-11-01

## Context

M5 combines materialized views (MVs) with the columnar segment format that was moved up from M7
([research/columnar-mv-assessment.md](../research/columnar-mv-assessment.md)). Full-refresh MVs are
written in bulk and read many times. Columnar storage is good at exactly that pattern, and
immutable segments avoid columnar's hard part, updating in place.

## Decisions

### Materialized views

1. **Storage.** An MV is a table whose columns take the query's result types.
   - A column copied from a table keeps that column's declared type and collation.
   - A computed value gets its static type (INTEGER, REAL, TEXT, BLOB) or ANY.
   - The catalog holds the `CREATE MATERIALIZED VIEW` text (`sqlite_schema` type `matview`).
   - The internal table `smalt_matview(name, layout, populated, refreshed_at)` holds the storage
     layout and the refresh state.
2. **One refresh path.** Every refresh builds new trees (the table, plus rebuilt indexes for row
   storage) and then swaps the catalog root pages and frees the old trees (copy-on-write).
   - *Failure:* a failed refresh leaves the old rows, and a rolled-back transaction restores them.
   - *CONCURRENTLY:* `REFRESH … CONCURRENTLY` never blocks readers by construction. Unlike
     PostgreSQL it needs no unique index, because nothing is diffed.
   - *Single connection:* both forms behave the same; they differ only once M6 adds concurrent
     readers.
3. **Exact values.** A refresh fails if the query produces a value its stored column cannot hold
   exactly (for example a REAL in an INTEGER column). The error suggests adding a CAST.
4. **PostgreSQL semantics where they exist:**
   - `WITH NO DATA` creates the view unpopulated, and reading it is an error until REFRESH;
   - `REFRESH … WITH NO DATA` empties it again;
   - the view is read-only.
5. **Options.**
   - `WITH (storage = 'row' | 'columnar')`, default row.
   - `refresh = 'manual'`; the incremental and on-commit modes are reserved for later.
6. **Catalog views.** `information_schema.tables` reports `MATERIALIZED VIEW`. A new
   `information_schema.materialized_views` (an extension) gives the definition, storage, refresh
   mode, population state and last refresh time.

### Columnar segments (`storage = 'columnar'`)

7. **Layout inside the existing B+tree.**
   - *Keys and values:* a columnar MV's tree is keyed by (u32 row group, u16 column), and the
     values are encoded column chunks. Large chunks use ordinary overflow pages.
   - *Zone maps:* key (rg, 0xFFFF) holds the row count and a zone map per column (null count,
     numeric min/max, BINARY text min/max up to 64 bytes).
   - *Header:* key (0xFFFFFFFF, 0) holds the row-group and row counts.
   - *What this inherits:* WAL atomicity, crash safety, free-page handling and the integrity check,
     with no new page types.
8. **Row groups and encodings.**
   - Row groups hold 8,192 rows.
   - Encodings are chosen per chunk from the values: all-NULL, F64, I32 (every value an int32),
     dictionary text (at most half as many distinct values as rows), plain text, blob, and a tagged
     encoding for mixed types and int64 beyond 2^53.
   - NULLs are a bitmap.
   - The payload is 8-byte aligned, so decoding builds typed-array views over a copy of the value
     without converting anything.
9. **Scans.**
   - *Plain scan:* the only access path is `ColumnScan`. It decodes only the referenced columns
     and skips row groups whose zone maps rule out a comparison with a constant or parameter
     (=, <, <=, >, >=). Zone maps only prune; the filters above still apply every predicate.
   - *Text:* text zones are used only for BINARY comparisons.
   - *Generated code:* aggregate and GROUP BY pipelines run as generated code straight over the
     chunk arrays. Per row group, a dense variant runs when every numeric column has no NULLs:
     values are read by index and the NULL flags are constants the JIT folds away.
10. **Cache.** Decoded chunks are cached per MV (64 MiB budget) until the next refresh, because
    segments never change in place.
11. **Not in M5:**
    - indexes on columnar MVs (zone maps prune instead);
    - columnar base tables (they need delta stores; M7);
    - MV matching (routing queries to fresh MVs automatically; later);
    - generated non-aggregate scans over columns (non-aggregate queries use `ColumnScan`).

## Consequences

Columnar projections of the 200k-row analytic table: see
[research/m5-materialized-views.md](../research/m5-materialized-views.md) for browser numbers.
In Node, in memory, against smaltdb's own fused row store:
- filter + sum: 2.3 → 0.48 ms;
- arithmetic filter + aggregate: 2.7 → 0.48 ms;
- GROUP BY (100 groups): 5.2 → 2.4 ms;
- clustered 5% range: 0.59 → 0.04 ms.

GROUP BY gains least, because hashing the group key per row dominates.

A second on-disk structure now has to be frozen by 1.0. It uses ordinary B+tree pages, so the
format work is the chunk encodings and the zone-map layout described above.
