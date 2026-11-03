# ADR 0014: A shared engine plan layer for several languages

- **Status:** proposed (draft for the owner's review)
- **Date:** 2026-11-03

## Context

smaltdb gets a second language: smaltdf (`stenhoor/smaltdf`), a TypeScript language with dataframe interfaces.
The owner's direction:
- smaltdf is its own language on the engine. It does not generate SQL in any form.
- It and SQL meet in a plan layer that belongs to the engine and to neither language.
- Display is the job of smaltui and, later, smaltnb.

Today the engine has only one way in. Its planner (`exec/planner.ts`) takes the SQL parser's output and builds
physical operators in a single pass: name resolution, typing, register allocation, projection pushdown, costing and
operator construction happen together. The pieces after it are tied to SQL as well:

- **Operators:** they keep parts of the parser's output (`Filter.ast`, `AggSpec.argAsts` in `exec/operators.ts`), so
  that pipeline fusion (`exec/codegen.ts`) can recompile them.
- **Optimizations:** query flattening, decorrelation, materialized-view matching and the morsel split (`exec/flatten.ts`,
  `exec/mv-match.ts`, `exec/morsel.ts`) all rewrite parser output. Morsel parts are sent to reader workers as text
  and parsed again.
- **Naming and caching:** output column names come from the query text, and compiled plans are cached by it.

Already independent of any language: physical operators and their inputs (compiled functions, registers, sort keys,
aggregate specs), window evaluation, statistics, spilling and `EXPLAIN`.

[QUERY_ENGINE.md](../QUERY_ENGINE.md) §1 and [ARCHITECTURE.md](../ARCHITECTURE.md) describe a bound logical plan
between parsing and physical planning. No such stage exists in the code.

## Decision

### 1. One plan layer, owned by the engine

There is a new module, `src/engine/plan/`: an immutable, typed plan of relational operations, defined in the engine's
own terms. Every language is a client of it, and none is privileged:

```
smaltdf (TypeScript) ───────────→ plan builder ─┐
                                               ├→ plan → optimizer → physical planner → operators → storage
SQL text → parser → SQL front end ─────────────┘
```

**Operations:**

| Group | Operations |
| --- | --- |
| Reading | `scan` (a table's columns) |
| Row operations | `filter`, `project` (computed columns), `limit` (offset and count) |
| Combining | `join` (inner, left, right, full, semi, anti, cross), `union` |
| Ordering and grouping | `sort`, `aggregate` (keys and aggregate functions), `distinct`, `window` |
| Writing | `append`, `update` and `delete` rows of a table |

Each language maps its own constructs onto these. Where a language needs more (SQL's recursive queries and
correlated subqueries, for example), the engine adds a neutral operation for it (an iteration and a dependent
evaluation), documented as part of the layer rather than as part of that language.

**Expressions:**
- **References by position:** columns are referenced by input and position (never by name), alongside literals,
  parameters, calls to registered functions, casts, conditionals, and nested plans.
- **Typed:** every expression has a static type and every operation an output schema.
- **Explicit:** the layer does no implicit conversions. Any conversion a language makes is an explicit cast or
  function call in the plan.
- **Ordering rules:** how text compares and sorts is an explicit attribute of comparisons, sorts, groupings and joins.

### 2. Meaning lives in functions, and each language chooses its own

The shared layer gives each operation one meaning. Behaviour that differs between languages (division, how mixed
types compare, what an aggregate of no values gives, how text is converted to numbers) lives in named functions in
the engine's function registries. Each language's front end picks the functions that give its own semantics:

- **SQL's behaviour stays in the SQL front end.** It moves out of shared code (`exec/expr.ts`, `exec/convert.ts`)
  into functions that the SQL front end selects, without changing.
- **smaltdf's semantics are specified by smaltdf.** Where it needs functions the engine lacks, they are added to the
  engine's registries.

### 3. One optimizer, working on the plan

- **The optimizations work on the plan,** so they serve every language: merging nested operations, removing dependent
  evaluations, materialized-view matching, and the morsel split.
- **The physical planner reads the plan.** Join ordering, access paths, columnar zone maps, top-N, pipeline fusion and
  estimates keep their logic; only their input changes.
- **Operators lose their parser-output fields.** Fusion works from plan expressions.
- **Caching:** plans are cached by a hash of their canonical form. Morsel parts travel to readers as serialized
  plans.

### 4. How clients reach the layer

- **In-process:** `smaltdb/engine` gains a `plan` namespace with builders for operations and expressions, a validator,
  and `db.preparePlan(plan)` / `db.queryPlan(plan, params)`.
- **Worker clients:** the worker protocol gains `queryPlan` and `preparePlan` requests that carry the plan as JSON with
  a `planVersion`. Results stream as columnar batches. The protocol isn't part of plugin API v1, because client and
  worker are always the same smaltdb version ([ADR 0013](0013-plugin-api-v1.md)).
- **Plugins:** an optional `MethodContext.queryPlan(plan, params)`. This is an additive change, allowed in v1.
- **Versioning:** the plan format has its own version, `PLAN_FORMAT_VERSION`. It is experimental until smaltdf has
  proven it, then gets its own stability ADR, as plugins did with [ADR 0012](0012-plugins.md) and ADR 0013.
- **Never exposed:** operators and registers.

### 5. Order of work

Each step is its own PR. Every existing test suite stays green at every step.

1. This ADR, and corrections to QUERY_ENGINE.md §1 and ARCHITECTURE.md.
2. A golden corpus of physical plan shapes (join orders, access paths, fused and columnar scans), so later steps can't
   change them unnoticed.
3. Plan expressions: today's name resolution and typing produce them, and expression compilation and code generation
   take them as input.
4. Operators and fusion carry plan expressions instead of parser output.
5. The SQL front end produces plans for reading queries.
6. The physical planner reads plans. The current path stays behind a switch until this step has landed.
7. The optimizations move onto the plan (dependent evaluations, materialized views, morsels).
8. Writing operations (`append`, `update`, `delete`) go through the plan.
9. The public `plan` API: in-process, over the worker protocol, and for plugins. smaltdf builds on this step.

Each step runs `npm run check`, `npm run slt`, the differential tests (also with `SMALT_NO_CODEGEN`,
`SMALT_NO_FLATTEN` and `SMALT_NO_DECORRELATE`), the plan-shape corpus and `test/perf-invariants.test.ts`.

## Alternatives considered

- **Letting smaltdf build the SQL parser's output.** It is cheap, but it is SQL under another name: SQL's scoping and
  semantics would come with it. Rejected by the owner's direction.
- **Exposing physical operators.** Operators are low-level, mutable and tied to the register file, and costing,
  access paths and fusion live in the planner. A client would have to reimplement the optimizer on internals that
  aren't a contract.
- **Separate execution in smaltdf over a storage API.** It would duplicate operators, the optimizer and spilling. The
  owner chose the shared plan layer.

## Consequences

- **Languages are peers.** The engine gains a layer that any language can target, SQL among them. The optimizations
  serve all of them.
- **A large refactor** of the planner, expression compilation, code generation and the compile paths in
  `database.ts`.
- **Risks, contained by the step order and the test gates:**
  - keeping SQL's exact behaviour when it moves into functions;
  - projection pushdown, which today is a side effect of name resolution;
  - SQL's output column names;
  - code-generation performance ([ADR 0003](0003-m1-executor-and-transactions.md));
  - one more pass when planning small queries.
- **smaltdf builds on the layer once all nine steps have landed** (owner's decision below). Until then its language
  is specified, and its plan builder can be written against the plan types from steps 3–5.
- **The plan format is a new public surface,** with its own versioning (section 4).

## Owner's decisions (2026-11-03)

1. **Scope:** reading and writing. All nine steps of section 5 land before smaltdf builds on the layer.
2. **Timing:** the plan layer comes before any npm publish of smaltdb.
3. **Who:** one session works through the steps in order.
