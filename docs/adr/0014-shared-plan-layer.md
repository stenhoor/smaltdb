# ADR 0014: A shared logical plan layer, with SQL and smaltdf as front ends

- **Status:** proposed (draft for the owner's review)
- **Date:** 2026-11-03

## Context

smaltdf (`stenhoor/smaltdf`) is a TypeScript language for smaltdb with dataframe interfaces. Polars inspired its
functions, but it is its own language. The owner's direction:
- smaltdf is a separate language on top of the engine. It does not compile to SQL: neither SQL text nor the SQL
  syntax tree.
- It builds on a plan layer shared with SQL.
- Display is the job of smaltui and, later, smaltnb.

The engine has no such layer today. [QUERY_ENGINE.md](../QUERY_ENGINE.md) §1 and [ARCHITECTURE.md](../ARCHITECTURE.md)
describe a binder producing a bound logical plan, then a rewriter, but neither exists. In the code:

- **Parsing:** `Database.compile` (`database.ts`) parses SQL into the syntax tree (`sql/ast.ts`) and hands a
  `SelectStmt` to `Planner.planSelect` (`exec/planner.ts`).
- **One pass from syntax tree to operators:** that call goes straight to physical operators. Name binding (`Scope`),
  typing (`compileExpr`), register allocation, projection pushdown (`TableAccess.use`), costing and operator
  construction all happen together.
- **Operators carry syntax-tree pieces:** `Filter.ast`, `AggSpec.argAsts` and `filterAst` (`exec/operators.ts`) are
  there so that pipeline fusion (`exec/codegen.ts`) can recompile them after planning.
- **Costing reads the syntax tree:** access paths, selectivity, columnar zone-map checks and join ordering all read
  SQL syntax-tree conjuncts.
- **Rewrites are on the syntax tree too:** `exec/flatten.ts`, decorrelation, `exec/mv-match.ts` and
  `exec/morsel.ts` all rewrite syntax trees. Morsel partials travel to reader workers as SQL text and are parsed
  again (`shared/protocol.ts`, `worker-runtime.ts`).
- **Text-based naming and caching:** output column names come from slices of the SQL text, and the plan, morsel and
  internal-program caches are keyed by SQL text.
- **Already free of the syntax tree:** window evaluation (`exec/window.ts`), statistics, spilling, `EXPLAIN` (which
  walks operators), and the physical operators' own inputs (compiled `Fn`s, registers, `SortKey`, `AggSpec`).

So a second language can't reach the optimizer, fused scans, columnar zone maps, morsels or spilling without either
generating SQL or exposing internals that aren't a contract.

## Decision

### 1. A logical plan layer between the front ends and the physical planner

There is a new module, `src/engine/plan/`: a bound, typed, immutable relational plan. Every query goes through it:

```
SQL text → parser → SQL syntax tree → SQL binder ─┐
                                                 ├→ logical plan → rewrites → physical planner → operators
smaltdf (TypeScript DSL) → plan builder ─────────┘
```

- **Nodes:** `Scan(table, columns)`, `Filter`, `Project`, `Aggregate(keys, aggregates)`,
  `Join(kind: inner | left | right | full | semi | anti | cross, condition)`, `Sort`, `Limit`, `Distinct`, `Window`,
  `SetOp`, `Values`, `RecursiveCte`, and `Apply` (correlated subqueries until decorrelation removes them).
- **Expressions are bound:** column references point to a node's output by index (`ColRef(input, i)`), never by
  name. There are literals and parameters, `Call(function, args)`, `Cast`, `Case`, and subqueries as plans.
- **Annotations:** every expression carries its static type, collation and affinity, and every node its output schema.
- **No implicit conversions:** where SQL applies affinity or coercion, the SQL binder inserts it as explicit `Cast` and
  `Call` nodes.

### 2. Semantics belong to the front end, as functions

Shared code keeps one meaning per node. Behaviour that differs between languages is chosen by calling a different
function, not by a mode flag in the executor:

- **Operators:** `/`, comparison with affinity, `LIKE` and text–number coercion are named functions in the plan
  (`sql.div`, `sql.compare`, …). The SQL binder chooses these; smaltdf chooses its own (for example a true division).
  The SQL meanings don't change: they move from `exec/expr.ts` into those functions.
- **Aggregates and NULL handling:** these stay per function, in the existing scalar and aggregate registries. A
  language that needs different behaviour registers a function under its own name.
- **Collation:** a plan-level attribute, as `Collation` already is.

This is what lets smaltdf define its own semantics while sharing the optimizer and operators.

### 3. One optimizer, on the plan

- **The rewrites move to the logical plan** and become independent of the language: view and subquery flattening
  (largely replaced by binding views into the plan), decorrelation, materialized-view matching, and morsel
  partial/merge.
- **The physical planner takes the plan instead of the SQL syntax tree.** Join ordering, access paths, columnar
  zone-map derivation, Top-N, fusion and estimates keep their logic; only their input changes.
- **Operators lose their syntax-tree fields.** Fusion works from plan expressions.
- **Caching:** plans are cached by a hash of their canonical form, not by SQL text. Morsel partials travel to readers
  as serialized plans.

### 4. How front ends reach it

- **In-process:** `smaltdb/engine` gains a `plan` namespace: node and expression builders, a validator, and
  `db.preparePlan(plan)` / `db.queryPlan(plan, params)`.
- **Worker clients:** the worker protocol gains `queryPlan` and `preparePlan` requests that carry the plan as JSON with
  a `planVersion`. Results stream as columnar batches, as for SQL. The protocol isn't part of plugin API v1, because
  client and worker are always the same smaltdb version ([ADR 0013](0013-plugin-api-v1.md)).
- **Plugins:** an optional `MethodContext.queryPlan(plan, params)` beside `query(sql)`. This is an additive change,
  allowed in v1.
- **Versioning:** the plan format has its own version, `PLAN_FORMAT_VERSION`, separate from `PLUGIN_API_VERSION`. It
  is experimental until smaltdf has proven it, then gets its own stability ADR, as plugins did with
  [ADR 0012](0012-plugins.md) and ADR 0013.
- **Never exposed:** operators and registers.

smaltdf is a client package. It builds plans in TypeScript and sends them through one of these routes, generating no
SQL. Its own semantics, documented in smaltdf, are expressed through the functions of section 2.

### 5. Order of work

Each step is its own PR, with the SQL test suites green at every step:

1. This ADR, and corrections to QUERY_ENGINE.md §1 and ARCHITECTURE.md, which describe a binder and a logical plan
   that don't exist.
2. A golden corpus of `EXPLAIN` plan shapes (join orders, access paths, fused and columnar scans), so drift shows up in
   later steps.
3. Bound expressions: a binder from SQL `Expr` to plan expressions using today's `Scope` logic, with `compileExpr` and
   codegen taking bound expressions.
4. Operators and fusion carry bound expressions instead of syntax-tree pieces.
5. The SQL binder producing the logical plan for SELECT: names, `*`, USING/NATURAL, aliases, views and CTEs resolved
   there.
6. The physical planner taking the plan. The SQL syntax-tree path stays behind a switch, like `SMALT_NO_FLATTEN`, until
   this step has landed.
7. Rewrites on the plan: decorrelation, materialized-view matching, morsels (with serialized plans to readers).
8. DML (INSERT, UPDATE, DELETE, RETURNING, CHECK) through the binder.
9. The public `plan` builder, `queryPlan` and `preparePlan` in process and over the worker protocol, and
   `MethodContext.queryPlan`. smaltdf starts building on this step.

Each step runs `npm run check`, `npm run slt`, the differential tests against SQLite (`test/differential.test.ts`,
`differential-joins.test.ts`, also with `SMALT_NO_CODEGEN`, `SMALT_NO_FLATTEN` and `SMALT_NO_DECORRELATE`), the
plan-shape corpus and `test/perf-invariants.test.ts`.

## Alternatives considered

- **A typed builder for today's SQL syntax tree.** Cheap, and it would reach every optimization at once. But it *is*
  the SQL syntax tree under another name: it inherits SQL scoping, aliases, affinity and text-based output names, and
  dataframe chains would depend on flattening succeeding. It doesn't meet the owner's direction.
- **Exposing physical operators.** Operators are low-level, mutable and tied to the register file. Costing, access
  paths and fusion live in the planner, not in operators, so a front end would reimplement the optimizer on
  internals that aren't a contract.
- **Separate execution in smaltdf over a storage API.** smaltdf would own its semantics fully, but it would duplicate
  the operators, the optimizer and spilling. The owner chose the shared plan layer.

## Consequences

- **The engine gains the logical layer its design documents already describe.** The rewrites stop depending on SQL
  text, and an `EXPLAIN LOGICAL` becomes possible.
- **A large refactor.** Most of `exec/planner.ts`, `exec/expr.ts` and `exec/codegen.ts` is affected, plus the
  compile paths in `database.ts`.
- **Risks:**
  - SQLite's affinity and collation rules (where they come from, and hash-key conversions in joins and
    decorrelation);
  - projection pushdown, which today happens as a side effect of binding;
  - output-name compatibility;
  - codegen performance (closure identity and V8 feedback, [ADR 0003](0003-m1-executor-and-transactions.md));
  - one more pass when planning point queries.

  The step order and test gates above exist to contain these.
- **smaltdf waits for step 9** before it can run queries. Until then it can be specified, and its plan builder written
  against the plan types from steps 3–5.
- **The plan format is a new public surface,** with its own versioning (section 4).

## Questions for the owner

1. **Scope of the first version:** SELECT only (steps 1–7 and 9), with DML (step 8) later, or all of it before smaltdf
   builds on it?
2. **Timing against 0.9.0** (issue #36): should this work wait until 0.9.0 is published, or go on in parallel on
   branches?
3. **Who does the work:** one session working through the steps in order, or split across sessions by step?
