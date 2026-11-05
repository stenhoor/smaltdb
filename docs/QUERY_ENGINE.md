# Query Engine

> Status: section 1 describes the pipeline as built, and the plan layer that [ADR 0014](adr/0014-shared-plan-layer.md)
> adds. Sections 2–4 began as design targets: §6–§8 say what each milestone built. Vectorized execution (§4) is not
> built as described: operators return one row per `next()`, and only fused and columnar pipelines loop over chunks.

## 1. Pipeline

**As built.** A SELECT goes through the plan layer ([ADR 0014](adr/0014-shared-plan-layer.md), step 6):

```
SQL text
  → Lexer (single-pass scanner over the string, no regex)            sql/lexer.ts
  → Parser (recursive descent + Pratt for expressions) → AST          sql/parser.ts
  → SQL front end: name resolution, typing, SQL's collation and       sql/frontend/select.ts
    affinity rules made explicit → plan (positional columns)          plan/
  → Physical planner: registers, projection pushdown, decorrelation,  exec/planner.ts (planPlan)
    costing, join ordering, access paths, operator construction
  → Pipeline fusion: scan → filter → aggregate chains compiled        exec/codegen.ts
    to generated code from plan expressions
  → Operators: a pull model over a shared register file, one row      exec/operators.ts
    per next() call
```

Every statement is bound before the engine compiles it (`sql/frontend/bind.ts`, ADR 0015 step 6): queries and
writes become plans, and transactions, settings (PRAGMA) and maintenance (ANALYZE, VACUUM, REFRESH) become bound
statements in the engine's terms (`plan/bound.ts`), which `Database.compile` dispatches on. DDL becomes schema
operations (`plan/schema.ts`, `sql/frontend/ddl.ts`): tables and indexes as language-neutral definitions whose CHECK,
DEFAULT and index expressions are plan expressions, views and materialized views as their language's source.
ALTER TABLE still reaches the engine as SQL: it rewrites the stored SQL of every object, as SQLite does, until the
catalog stores definitions (ADR 0015 step 7).

Before binding, the front end merges simple views and FROM subqueries into the query (`exec/flatten.ts`, an AST
rewrite). Materialized-view matching works on the bound plan (`exec/plan-mv-match.ts`), at any depth, including the
inner sides the planner builds when it decorrelates a subquery. Languages bind against the logical catalog
(`plan/bind-context.ts` `BindContext`); the planner plans against its physical environment (`PhysicalEnv`). A table's
own expressions (CHECK, DEFAULT, index keys and partial-index WHERE) are bound by the front end too, as plan
expressions over the table's row (`toRowExpr`, `toValueExpr`), and compiled like every other plan expression: the
engine has one expression compiler (`compileBoundExpr`). Morsel parallelism splits an aggregate's plan into partial
aggregates over rowid ranges and their merge (`exec/plan-morsel.ts`); reader workers receive the partial plan, encoded
(`plan/codec.ts`), validate it (`plan/validate.ts`, as every plan is) and plan it once per query. Every SELECT, INSERT, UPDATE and DELETE goes through the plan layer, and so do the queries
the engine plans for itself (materialized-view layout and refresh, view checks after DDL). The planner's AST path
(`Planner.planSelect` and the write compile functions in `database.ts`) has been deleted.

The steps after the parser depend on SQL text or AST in several places:
- operators keep parts of the AST (`Filter.ast`, `AggSpec.argAsts`) for fusion;
- output column names come from the query text;
- compiled statements are cached by their SQL text.

**Planned.** [ADR 0014](adr/0014-shared-plan-layer.md) adds a typed, positional plan layer
(`src/engine/plan/`) between the front ends and the physical planner. SQL and smaltdf both produce plans, and the
optimizations and physical planning move onto the plan:

```
smaltdf ───────────────→ plan builder ─┐
                                       ├→ plan → optimizer → physical planner → operators
SQL → parser → SQL front end ──────────┘
```

The ADR's section 5 gives the order of work, and [research/plan-layer-implementation.md](research/plan-layer-implementation.md) works it out against the code. Until those steps land, the description above is the code.

**Plan caching:** the database caches prepared statements by SQL text. A cached statement compiles again when the
schema version changes (any DDL, or a setting that changes planning).

## 2. Logical rewrites (rule-based)

- Constant folding and expression simplification
- Predicate pushdown (through projections, joins, and aggregates where valid)
- Projection pushdown, which pairs with the column-addressable record format
- Subquery decorrelation (`EXISTS`/`IN`/scalar subqueries become semi/anti/outer joins)
- Outer-to-inner join conversion when null-rejecting predicates allow it
- View and CTE inlining (non-recursive, single-reference CTEs)
- **Subquery/view flattening** (implemented in M4, `src/engine/exec/flatten.ts`): a view or FROM subquery whose body is a plain
  projection/filter/join over tables is merged into the outer query. Its tables are renamed to unique aliases, its WHERE
  is ANDed in (into the ON clause for a single-table LEFT JOIN source), and outer references are replaced by its column
  expressions. Anything else, or anything ambiguous, is planned as a sub-plan. `SMALT_NO_FLATTEN=1` disables it for tests.
- Transitive predicate inference (`a=b AND b=5` ⇒ `a=5`)
- `LIMIT` pushdown and Top-N conversion (`ORDER BY … LIMIT k` becomes a heap)
- **Materialized-view matching**: rewrite queries to read from a matching MV (post-v1)

## 3. Cost-based optimization

> **Status (M3):** statistics, a cost model, join ordering and per-step join methods are implemented; see §7
> and [ADR 0005](adr/0005-cost-based-optimizer.md). Histograms, most-common values, DPccp, merge join, covering
> scans, multi-index OR and skip-scan are not implemented yet. The bullets below describe the target design.

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
  *Implemented in M3 (SELECT only):* columns `id, parent, detail, est_rows, loops, rows, time_ms`. Pages read and
  cache hits are not reported yet.
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
- **Access paths** (M1: heuristic; since M3 costed, see §7), from conjuncts that reference only that table and earlier ones: rowid
  equality / `IN` / range; index equality prefix plus a range on the next ASC column, used only when collation and affinity make
  the index order match the comparison; otherwise a full scan. `x BETWEEN a AND b` is split into two bounds.
- **Joins** (M1: in FROM order; since M3 cost-based, see §7):
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
- **Subqueries:** uncorrelated ones are evaluated once per execution. Since M4, correlated `[NOT] EXISTS` and
  scalar-aggregate subqueries whose correlation is a set of equalities (`inner = outer`) are **decorrelated**.
  The inner side runs once per execution, as a hash semi-join (EXISTS) or one GROUP BY on the correlation keys
  (scalar aggregates, with the empty-set value such as `count` = 0 for missing keys). Hashing uses the comparison's
  collation and affinity, so it is exactly `=`. Conjuncts over the outer row alone act as per-row guards. Anything
  else (non-equality correlation, correlated IN, LIMIT/ORDER BY in a scalar subquery, views or derived tables
  inside) re-runs per outer row as before. `SMALT_NO_DECORRELATE=1` disables it for tests.
- **Fused pipelines** (generated per query when code generation is allowed). Single-table full scans with WHERE compile into one function
  that walks leaf pages, decodes the needed columns into per-row locals (numeric values with separate NULL flags, so they stay unboxed) and
  evaluates the conjuncts. Three consumers are fused: ungrouped aggregates (`FusedScanAggregate`), GROUP BY with an inline hash aggregate
  (`FusedGroupAggregate`), and anything else via row batches (`FusedScanFilter`). Range/index scans, joins, DISTINCT aggregates,
  predicates with subqueries and bare columns in aggregates keep the operator-at-a-time plan.

## 7. What M3 implements

Sources: `src/engine/exec/planner.ts` (cost model, join order), `src/engine/exec/stats.ts` (ANALYZE, sampling),
`src/engine/database.ts` (`smalt_stat`, plan drift), `src/engine/exec/operators.ts` (`explainAnalyze`).
Decisions and their rationale: [ADR 0005](adr/0005-cost-based-optimizer.md).

- **Statistics.** `ANALYZE [table]` stores per-table row count, distinct values (HyperLogLog) and NULL counts,
  and per-index rows per key prefix, as JSON in `smalt_stat`. Tables without them get sampled statistics on
  first use: an exact scan up to 4096 rows, otherwise about 1.5k rows from jittered runs with the Duj1
  distinct-value estimator. Sampled statistics are cached until the table's size changes 4×.
- **Cardinality.** Row counts come from the B+tree shape. Selectivity is 1/NDV for equality (1/max NDV for
  equi-joins), fixed fractions for ranges, `!=` and LIKE, k/NDV for IN, and the NULL fraction for IS NULL.
- **Access paths** are costed alternatives: full scan, rowid `=`/IN/range, and index equality prefix plus
  range. An index costs a probe plus a fetch per matching row, so a scan wins when the filter is not selective.
- **Join order.** Runs of INNER/comma/CROSS sources are ordered by dynamic programming over subsets (up to 8
  sources; greedy beyond). LEFT JOIN sources keep their position. Joins without a join conjunct are
  penalized, so cross products come last.
- **Join method per step**: index nested loop, hash join, or nested loop over a materialized inner side,
  whichever is cheapest for the estimated outer rows.
- **Plan drift.** Cached plans record the table sizes they assumed and are re-planned when a table grows
  or shrinks 4×.
- **`EXPLAIN ANALYZE`** shows, per operator, the planner's estimate (rows per loop), loops, actual rows and
  inclusive time. Operators without an EXPLAIN QUERY PLAN line appear under their class name (FILTER, PROJECT, …).
- **Generated code in joins.** Standalone scans of join sources run as fused scan + filter pipelines. Text
  `=`/`!=` under BINARY collation is generated code. `textcol = 'literal'` in a fused scan is checked on the raw
  UTF-8 bytes before the row is decoded.
- **Literals in generated code.** Per-row expression functions read text and numeric literals from their
  constants (`K`), so statements that differ only in their literals share one compiled function: a new point query
  or projection costs no `new Function`. Integer divisors of `/` and `%` stay in the source, where V8 turns the
  division into a multiplication. Pipelines (fused scans and aggregates) keep numeric literals in the source: they
  scan whole tables, where V8 specializing on the constant is worth a compile. Rowid seeks and rowid ranges enforce
  their conditions exactly, so those conditions get no filter.
- **Verification.** The differential test `test/differential-joins.test.ts` runs random 2–4 table
  INNER/LEFT/CROSS/comma joins over tables of very different sizes against SQLite, with and without `ANALYZE`,
  in both code generation modes.

## 8. What M5 adds: columnar scans

- **Access path.** A `storage = 'columnar'` materialized view has one access path, `ColumnScan`. It decodes only
  the referenced columns of each 8,192-row group. Comparisons of a column with a constant or parameter
  (`=`, `<`, `<=`, `>`, `>=`) become zone-map tests that skip whole row groups. TEXT comparisons prune only under
  BINARY collation. The filters above the scan still apply every predicate; zone maps only prune.
- **Generated pipelines.** `Filter* → ColumnScan` under an aggregate or GROUP BY is fused into generated code
  (`PipelineSource` `columns` in `codegen.ts`). Each row group binds its chunk arrays once, and rows read values
  by index. A dense variant runs when every numeric chunk of the row group has no NULLs. Non-aggregate queries
  use `ColumnScan` row by row.
- **No row-store shortcuts.** The `count(*)` shortcut, statistics sampling and ANALYZE skip columnar views. Their
  row count comes from the store header.
- **EXPLAIN** shows `SCAN t (columnar[, fused scan + filter + …][, zone maps: col op ? …])`.

See [ADR 0008](adr/0008-materialized-views-and-columnar-segments.md).
