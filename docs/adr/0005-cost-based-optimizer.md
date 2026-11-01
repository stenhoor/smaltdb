# ADR 0005: Cost-based optimizer (M3)

- **Status:** accepted
- **Date:** 2026-11-01

## Context

Before M3 the planner joined tables in FROM order and chose access paths by fixed rules: any usable index
beat a scan. That made the user's join order part of the query's performance. A query written in a bad
order, or a selective filter on the second table, could run 10× slower than necessary. Most browser
applications will also never run `ANALYZE`, so the optimizer has to make good choices without
collected statistics.

## Decisions

1. **Statistics (`ANALYZE`).**
   - *Table statistics:* row count, distinct values per column (HyperLogLog, 4096 registers, about 1.6% error) and NULL counts.
   - *Index statistics:* average rows per distinct key prefix, like `sqlite_stat1`.
   - *Storage:* JSON in the internal table `smalt_stat(tbl, idx, stat)`, loaded with the schema. JSON keeps the
     format extensible (histograms, most-common values) without a schema change.
2. **Statistics without `ANALYZE`.** The planner asks the database for statistics on demand.
   - Tables of at most 4096 estimated rows are scanned exactly.
   - Larger tables are sampled with 32 runs of 48 consecutive rows. Each run starts at a jittered position
     within an evenly spaced rowid stratum, because exactly periodic positions alias with periodic data:
     in testing, every run landed on the same customer ids.
   - Distinct counts are scaled up with the Duj1 estimator (Haas & Stokes): D = n·d / (n − f1 + f1·n/N).
     Duj1 gives N for all-distinct samples and d when there are no singletons. GEE, the first choice,
     underestimated near-unique columns by 2.5×.
   - The result is cached per schema object and recomputed when the table size changes 4× or more. The cost
     is about 1 ms per table, once per session.
   - Without these statistics, the default "NDV = rows/10" made `status = 1` (5 distinct values) look 4000×
     more selective than it is. The planner then chose an index nested loop over 40k outer rows: 205 ms, versus 66 ms for
   the hash plan it picks with statistics.
3. **Row counts** come from the B+tree shape (`estimateCount`: fanout along the leftmost path times the leaf
   fill), which costs a few cached page reads, so plans react to growth even when the statistics are stale.
4. **Cost model**: abstract units per operation:
   - scanned row 30;
   - index probe 1500;
   - row fetch 1200;
   - hash build 80 and probe 60;
   - nested-loop row 20;
   - output row 10.

   Selectivity: `=` is 1/NDV (for joins 1/max NDV), ranges 0.33 (0.25 with both bounds), `!=` 0.9, `IN`
   k/NDV, `IS NULL` from the NULL fraction, LIKE 0.25, and AND/OR/NOT combine assuming independence.
   The constants were calibrated on the join micro-benchmark (bench/micro/joins.ts).
5. **Join ordering.**
   - *Reordering:* consecutive INNER/comma/CROSS sources form a segment that is reordered by dynamic
     programming over subsets (up to 8 sources; greedy above).
   - *LEFT JOIN:* a LEFT JOIN source keeps its position, so everything before it is joined first. This keeps
     outer-join semantics without a general reordering theory.
   - *Cross products:* joins with no join conjunct are penalized 4×, so cross products come last unless they are cheaper anyway.
   - *Join method per step,* by cost:
     - *index nested loop:* outer rows × probe cost;
     - *hash join:* inner scan + build + outer rows × probe;
     - *nested loop:* over a materialized inner side.
6. **Plan caching with drift.** A prepared statement records the row estimate of each table it costed.
   When the database's change counter moves, the next execution re-checks those estimates and re-plans if
   any table grew or shrank 4×. This prevents a plan made on an empty table, a scan, from living on after the table holds
   millions of rows.
7. **`EXPLAIN ANALYZE`** runs the query with every operator instance wrapped (open/next) to count loops
   and rows and to measure inclusive time. It reports the planner's per-loop row estimate next to the
   actual values, then restores the operators. The wrapping adds two `performance.now()` calls per operator call
   (J1 measured 94 ms under `EXPLAIN ANALYZE` vs 33 ms normally), so times are for comparing operators within a
   query, not absolute.
8. **Code generation for joins' leaves**: in multi-table queries, full scans of a source with local
   filters run as generated scan + filter pipelines, as single-table queries already did. Generated code
   now also covers text `=`/`!=` under BINARY collation. Fused scans check `textcol = 'literal'` on the
   raw UTF-8 bytes before decoding, so rejected rows never build a string.

## Consequences

- With the join micro-benchmark and no `ANALYZE`, every query is faster than SQLite WASM (Node: 2.2–10×).
  Join order in the SQL text no longer matters. Results are in
  [research/m3-optimizer.md](../research/m3-optimizer.md).
- The differential suite now includes random 2–4 table INNER/LEFT/CROSS/comma joins over tables of very
  different sizes, run with and without `ANALYZE`, which exercises reordering against SQLite.
- First executions pay for sampling (about 1 ms per table, once per session). This dominates sub-millisecond
  queries on their first run only.
- Not done in M3 (deferred):
  - histograms and most-common values, so range predicates use fixed selectivities (visible in `EXPLAIN ANALYZE` as 5–10× misestimates);
  - transitive predicate inference;
  - merge join and interesting orders (sort elimination beyond rowid order);
  - covering (index-only) scans;
  - multi-index OR;
  - tracking the sqllogictest pass rate.
