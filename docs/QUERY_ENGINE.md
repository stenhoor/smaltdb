# Query Engine

> Status: M1 implemented. Sections 1–2 describe the pipeline as built. The cost-based optimizer (§3) and vectorized
> execution (§4) are M3/M7 targets; what M1 actually does is described in §6.

## 1. Pipeline

```
SQL text
  → Lexer (single-pass scanner over the string, no regex)
  → Parser (recursive descent + Pratt for expressions) → AST
  → Binder (name resolution, type inference, view expansion) → Bound logical plan
  → Rewriter (rule-based, to a fixed point)
  → Cost-based optimizer (join ordering, access paths, physical operators)
  → Physical plan (immutable, cacheable)
  → Executor (vectorized)
```

**Plan caching:** prepared statements cache the physical plan. Cached plans are invalidated when the schema cookie changes,
or when statistics drift by more than a threshold.

## 2. Logical rewrites (rule-based)

- Constant folding and expression simplification
- Predicate pushdown (through projections, joins, and aggregates where valid)
- Projection pushdown, which pairs with the column-addressable record format
- Subquery decorrelation (`EXISTS`/`IN`/scalar subqueries become semi/anti/outer joins)
- Outer-to-inner join conversion when null-rejecting predicates allow it
- View and CTE inlining (non-recursive, single-reference CTEs)
- Transitive predicate inference (`a=b AND b=5` ⇒ `a=5`)
- `LIMIT` pushdown and Top-N conversion (`ORDER BY … LIMIT k` becomes a heap)
- **Materialized-view matching**: rewrite queries to read from a matching MV (post-v1)

## 3. Cost-based optimization

- **Cardinality estimation** uses per-column statistics: row count, NDV (HyperLogLog), equi-depth histograms,
  most-common values, and null fraction. It assumes independence and applies a correlation dampening factor.
- **Cost model** components: page I/O (cached vs. OPFS), CPU per tuple per operator, and memory and spill cost.
  Constants are calibrated by a micro-benchmark suite on reference hardware.
- **Join ordering**:
  - ≤ 10 relations: DPccp (exhaustive dynamic programming over connected subgraphs).
  - > 10 relations: greedy (GOO) followed by local improvement.
- **Access path selection**: full scan, index range scan, index-only (covering) scan, rowid lookup, multi-index OR-union, and skip-scan.
- **Physical operator choice**: hash join vs. merge join vs. index nested loop. Hash aggregate vs. sort/stream aggregate.
  Sort elimination via interesting orders.

## 4. Execution model

- **Vectorized pull model**: `next(): Batch | null`. A `Batch` holds up to 1024 rows (tunable):
  - one vector per column: `Float64Array`, `Int32Array`, `BigInt64Array`, string arenas (offsets into a `Uint8Array`), and a validity bitmap
  - a selection vector (`Uint16Array`), so filters avoid copying data
- **Expression evaluation**: expressions compile to tight loops over vectors.
  - Preferred: generate JS source and call `new Function` (the JIT can inline it fully).
  - Fallback when CSP forbids eval: pre-built closure trees specialized by type **[Q-9]**.
- **Operators**: TableScan, IndexScan, Filter, Project, HashJoin (build/probe with a typed-array open-addressing table),
  MergeJoin, IndexNLJoin, HashAggregate, StreamAggregate, Sort (radix sort for fixed-width keys, otherwise a normalized-key comparator sort),
  TopN, Limit, Window, Union/Intersect/Except, RecursiveCTE, Values, Insert/Update/Delete.
- **Memory budgets**: every blocking operator gets a budget. Above it, the operator spills to OPFS temp files (grace hash join, external merge sort).
- **Parallelism** (when the reader pool exists **[Q-4]**): morsel-driven. Scans are split into page ranges,
  and an exchange operator combines partial aggregates, sorts, or join builds.
- **Result streaming**: results go to the client as columnar batches with transferable buffers. The client can
  materialize rows lazily (`row.get('col')`) or eagerly as objects or arrays.

## 5. EXPLAIN

- `EXPLAIN <stmt>`: the physical plan tree with estimated rows and cost.
- `EXPLAIN ANALYZE <stmt>`: the same tree with actual rows, time per operator, pages read, and cache hits.
- `EXPLAIN QUERY PLAN`: SQLite-compatible summary output.
- Plans are also available as JSON for tooling.

## 6. What M1 implements

Source: `src/engine/exec/` — `planner.ts`, `operators.ts`, `expr.ts`, `functions.ts`, `write.ts`.

- **Execution:** pull-based iterators (`open` / `next` / `close`) over a shared register file. Expressions compile to closures
  over registers, with constant folding and a fast path for statically numeric comparisons.
- **Expression code generation** (`codegen.ts`): when the CSP allows `new Function`, arithmetic, numeric comparisons and AND/OR/NOT
  roots are emitted as straight-line JavaScript. Register reads and constants are inlined, and fast paths are chosen from static
  types (INTEGER: exact safe-integer ops with overflow fallback; REAL: plain float ops). Each expression gets its own V8 type feedback,
  which closures cannot have because instances of a closure literal share feedback. Other nodes, and every slow path, call the closure
  compiler, which defines the semantics. Differential tests run in both modes (`SMALT_NO_CODEGEN=1` forces closures). Zero allocation per row in scans,
  filters, and joins. See [ADR 0003](adr/0003-m1-executor-and-transactions.md).
- **Access paths** (heuristic, chosen per table from conjuncts that reference only that table and earlier ones): rowid
  equality / `IN` / range; index equality prefix plus a range on the next ASC column, used only when collation and affinity make
  the index order match the comparison; otherwise a full scan. `x BETWEEN a AND b` is split into two bounds.
- **Joins**, in FROM order (cost-based ordering comes in M3):
  - index or rowid nested loop when the inner side can be probed with values from outer rows;
  - otherwise a hash join on equality conjuncts, built once per execution, with affinity and collation applied to both key sides;
  - otherwise a nested loop, with uncorrelated derived tables materialized.

  LEFT JOIN is supported for all three.
- **Predicate placement:** every conjunct is evaluated at the earliest join level where its tables are available. Filters
  on the inner side of a LEFT JOIN stay in the join condition.
- **Aggregation:** hash aggregation; GROUP BY expressions, aggregate calls, and bare columns are mapped to registers.
- **Sorting:** in-memory stable sort with a top-N cap when `LIMIT` is known. `ORDER BY rowid` on a single-table scan uses the
  table order, scanning in reverse for DESC.
- **`count(*)` fast path:** summing leaf cell counts, as SQLite's `OP_Count` does.
- **Subqueries:** uncorrelated ones are evaluated once per execution. Correlated ones re-run per outer row (decorrelation is M4).
