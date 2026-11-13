# Should columnar storage (M7) come before materialized views (M5)?

- Date: 2026-11-01
- Status: accepted (2026-11-01); the roadmap is updated
- Spike: [bench/micro/columnar-spike.ts](../../bench/micro/columnar-spike.ts)

## Question

M5 (materialized views) is scheduled before M7 (columnar segments, zone maps, spill-to-OPFS, morsel
parallelism). Could materialized views benefit from a columnar format? Could columnar MVs give
users a way to get analytical performance without changing their base tables?

## Measurement

The spike compares today's row store with a columnar layout. The row store is B+tree records with
generated fused scan/filter/aggregate pipelines.
The columnar layout is one typed array per column plus per-4096-row min/max zone maps. Both run in
memory, in Node, and report the median of 21 runs. The data is the browser harness's analytic table
plus a clustered `ts` column (insertion order, like a timestamp).

| Query | 200k rows: row store | 200k rows: columnar | 200k ratio | 2M rows: row store | 2M rows: columnar | 2M ratio |
|---|---|---|---|---|---|---|
| `sum(b) WHERE c > 500` | 2.60 ms | 0.28 ms | 9.3× | 31.2 ms | 3.12 ms | 10.0× |
| GROUP BY, 100 groups | 8.38 ms | 1.67 ms | 5.0× | 84.9 ms | 16.8 ms | 5.1× |
| arithmetic filter + aggregate | 3.35 ms | 0.41 ms | 8.2× | 37.7 ms | 3.85 ms | 9.8× |
| 5% range on a clustered column | 3.01 ms | 0.02 ms | 171× | 32.7 ms | 0.08 ms | 391× |

**Caveat.** The columnar side is an upper bound: hand-written loops over arrays already in
memory, no NULL bitmaps, and no reading or decoding of pages. An engine with generated code over
column chunks will reach part of this, not all of it. The direction and the order of magnitude are
still clear:
- **Scans and aggregates:** about 5–10× faster, because nothing per row is decoded.
- **Clustered range predicates:** two orders of magnitude faster, because zone maps skip whole blocks.

The table is narrow (5 columns). For wide tables, the I/O saved by reading only the referenced
columns, which this in-memory spike does not show, adds to the gap.

## Why materialized views are the natural first consumer

The hard part of columnar storage is updating it in place. That needs delta stores, deletion
vectors and merges, as in DuckDB, Vertica and SQL Server columnstore. Full-refresh MVs avoid all of it:

- **Write pattern:** written once in bulk (`REFRESH` recomputes everything) and read many times,
  which is exactly what columnar formats are good at.
- **Concurrent refresh:** `REFRESH … CONCURRENTLY` becomes copy-on-write. Build the new
  segments, then atomically swap the root pointer in the catalog. Readers keep the old version; no
  row-level diffing is needed.
- **Snapshot isolation:** immutable segments also make it simple for the M6 multi-reader work.
- **Content:** MV contents are usually analytical (aggregates and denormalized projections), so they
  are the queries that benefit most.

## "Performance alternatives": columnar projections

`CREATE MATERIALIZED VIEW sales_col WITH (storage = 'columnar') AS SELECT * FROM sales` is a
columnar replica of a row table, which Vertica calls a *projection*. On its own, applications can
query it explicitly for analytics while OLTP traffic stays on the row table.

Combined with **MV matching** (already in QUERY_ENGINE.md §2 as a post-v1 rewrite), the optimizer could
route analytical queries to a fresh columnar MV automatically. That would give "HTAP-lite": a row store for
transactions and columnar projections for analytics, without changing the base table's format. Since a
manually refreshed MV can be stale, automatic routing must be opt-in or limited to MVs known to be current.

## Recommendation

**Split M7. Do not pull all of it up.**

1. **Move up, and build together with M5:**
   - the columnar segment format (column chunks in pager pages, so they inherit WAL atomicity and
     crash safety);
   - zone maps;
   - a columnar scan feeding the generated pipelines.

   MVs get `WITH (storage = 'row' | 'columnar')`. Start with row as the default; columnar MVs use
   zone maps instead of secondary indexes at first.
2. **Keep in M7:**
   - spill-to-OPFS;
   - morsel parallelism, which depends on M6's reader workers;
   - columnar *base tables*, which need the update path.
3. **Later:** MV matching, to route queries to columnar projections automatically.

Proposed order: M4 → M5 + columnar segments → M6 → M7 (the rest).

**Costs and risks:**
- A second on-disk format to freeze by 1.0.
- Page layout must keep typed-array views aligned (8-byte alignment for Float64Array).
- Columnar segments need their own encodings for TEXT/BLOB columns (dictionary, offsets).
- The executor needs a column-at-a-time entry point into the generated pipelines, alongside the row-at-a-time one.

None of this blocks M5's catalog and refresh semantics. Those are independent of the storage format,
so M5 can be designed with a storage abstraction from the start.
