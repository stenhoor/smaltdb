# Plan layer: implementation plan (ADR 0014, steps 3–9)

> Status: plan, 2026-11-03. It works out section 5 of [ADR 0014](../adr/0014-shared-plan-layer.md) against the code as
> it stands. Function names are stable references; line numbers are left out on purpose, because the steps move code.
> Open points that need the owner are in [section 5](#_5-open-points-for-the-owner).

## 1. What the code does today

- **Expressions.** `compileExpr(e, scope)` (`exec/expr.ts`) compiles an AST node to a closure (`compileNode`) or to
  generated code (`generate`, `exec/codegen.ts`). The result, `Compiled`, carries the function, static type, collation,
  collation source and affinity.
- **Names are resolved while compiling.** The `CompileScope` resolves columns (`resolveColumn`), post-aggregate
  references (`groupRef`, `aggregateRef`), window calls (`windowRef`) and plans subqueries (`scalarSubquery`,
  `existsSubquery`, `inSubquery`), all as side effects of compiling.
- **Projection pushdown is a side effect of compiling, not of name resolution.** `Planner.resolveIn` marks a column
  as read (`access.use`, `external.projection.add`) each time an expression that reads it is compiled. Costing compiles
  in a dry mode (`dryCompile`) that marks nothing, and conjuncts an index enforces exactly are never compiled, so their
  columns are never decoded. Fused pipelines resolve columns while they emit code, and the decode list is computed
  afterwards. Every step below keeps this: name resolution (*bind*) becomes pure, and the marking stays in *compile*.
- **Operators keep AST.** `Filter.ast` and `AggSpec.argAsts` / `filterAst` (`exec/operators.ts`) and the planner's
  group ASTs exist so that fusion can recompile them (`tryFuseScanFilter`, `tryFuseGroupAggregate`,
  `tryFuseAggregate`).
- **Optimizations rewrite AST.** Flattening (`flattenCore`), materialized-view matching (`matchMatview`), decorrelation
  (`Planner.decorrelate`, which builds new `SelectStmt`s) and the morsel split (`analyzeMorsels`, whose parts reach
  reader workers as SQL text in the `partial` message and are parsed again).
- **Names and caches.** Output names are slices of the query text (`expandResultColumns`). Statements are cached by
  text (`Database.cached`), and so are morsel analyses.
- **Already language-neutral:** windows (`WindowDef` / `WindowCall` hold compiled functions), `Sort`,
  `HashAggregate`, `HashJoin`, registers and collations, and the function registries.

## 2. Plan types (from step 3)

`src/engine/plan/`: `types.ts`, `expr.ts`, `ops.ts`, `schema.ts` (output schema of each operation), `print.ts`,
`canon.ts` (canonical JSON and hash) and, from step 9, `validate.ts`. `PLAN_FORMAT_VERSION = 0` (experimental).

**Expressions** (every node carries its static type; comparisons, sorts and groupings carry their collation):

| Kind | Meaning |
| --- | --- |
| `col { input, index, depth }` | Column `index` of input `input` of the owning operation; `depth > 0` reads that many enclosing dependent evaluations out (a correlated reference). Correlation is derived from the plan rather than tracked in scopes. |
| `lit`, `param { index }` | A literal; a positional parameter (the front end maps `?NNN` and `:name`). |
| `call { fn, args, collation? }` | A registered function. Language semantics are functions (section 3). |
| `cast { fn, to, arg }` | An explicit conversion chosen by the language. |
| `and`, `or`, `not`, `isNull`, `case` | Three-valued logic over 0 / 1 / NULL. |
| `subquery { mode: scalar \| exists }`, `inSubquery` | Dependent evaluation of a nested plan. |
| `lookup` | Step 7: a decorrelated dependent evaluation (keys, probe, guards, empty-set plan), lazy and cached per execution, as `decorrelate` is today. |
| `slot`, `native` (internal) | Only while steps 3–5 run next to the current planner: an aggregate, group or window output register, and a subexpression the current planner compiled. Rejected by the validator, never serialized, removed in step 6d. |

**Operations:** `scan` (table and column positions, rowid as -1), `filter`, `project` (with output names), `limit`,
`join` (inner, left, right, full, semi, anti, cross; output is the inputs concatenated), `sort`, `aggregate` (keys,
then aggregate calls), `distinct`, `window` (output is the input followed by the window calls), `append`, `update`,
`delete`; and, needed by SQL as it is today (section 5, item 1): `setop` (union, union all, intersect, except),
`values`, `source` (table functions, `information_schema`, pragmas, external tables), `iterate` and `working`
(recursive queries), `partials` (the morsel merge input).

## 3. SQL semantics that become named functions

The implementations exist; they move and are wrapped, not rewritten. Proposed namespace `sql.*` (section 5, item 6).

| Function | Today |
| --- | --- |
| `sql.eq`, `ne`, `lt`, `le`, `gt`, `ge`, `is`, `is_not` | `comparison`, `cmpTest` (`exec/expr.ts`): NULL propagation, SQLite storage-class order, collation |
| `sql.affinity_numeric`, `sql.affinity_text` | `comparisonConverters` (`exec/expr.ts`), `applyNumericAffinity` / `applyTextAffinity` (`exec/convert.ts`): inserted by the front end around the operand that converts |
| `sql.add`, `sub`, `mul`, `div`, `mod`, `neg` | `arithImpl`, `realMod`, `negate`: integer overflow to REAL, integer division, division by zero is NULL, text-to-number coercion |
| `sql.bitand`, `bitor`, `shl`, `shr`, `concat` | `bitwise`, the `\|\|` operator |
| `sql.truthy` | `truthy`, `isTrue`: the front end wraps non-integer operands of logic, CASE and filters |
| `sql.like`, `sql.glob`, `sql.in_list` | `compileLike`, `likeMatch`, `compileInList` |
| `sql.cast_integer`, `_real`, `_text`, `_blob`, `_numeric` | `compileCast`, `castTo*` |

The front end lowers `BETWEEN`, `CASE base WHEN`, `COLLATE` (the collation attribute of the enclosing comparison,
sort or grouping) and the collation-source precedence, keeping today's evaluation order and counts. Constant folding,
hashing and the value order inside sort, aggregate and join stay in the engine (section 5, item 2).

## 4. Steps

Every PR runs the ADR's gates (`npm run check`, `npm run slt`, the differential tests also with `SMALT_NO_CODEGEN`,
`SMALT_NO_FLATTEN` and `SMALT_NO_DECORRELATE`, `test/plan-shapes.test.ts`, `test/perf-invariants.test.ts`), plus the
generated-code snapshot from 3a and, from step 3, a budget for prepare time on small queries.

### Step 3: plan expressions

- **3a, types and named functions** (about 800 lines, no behaviour change). The `plan/` types and printer; the `sql.*`
  functions registered from the existing helpers, with the closure compiler calling them (its specialized fast paths
  stay). `ScalarFunction` gains an optional inline description so code generation recognises functions by id. A new
  snapshot test of generated source (expressions and fused pipelines) guards ADR 0003 performance through 3b–3c.
- **3b, binder and compiler** (done). `bindExpr(ast, scope)` produces a plan expression, in the same recursion
  order as the closure compiler, so errors keep their order; `compilePlanExpr` compiles it to the same closures.
  Comparisons carry their collation, affinity conversions are explicit `sql.affinity_*` calls, and operators are
  `sql.*` calls. Columns, GROUP BY keys and aggregate and window results bind to register `slot`s, and subqueries
  and select-list aliases to `native` nodes (planned and compiled at bind time, as before), so name resolution and
  projection pushdown are unchanged; positional `col` references come with the SQL front end (step 5), where the
  split of `CompileScope` into a pure lookup and the column marking moves too. SQL metadata (affinity, collation
  source) is a symbol-keyed property beside the plan. Functions gain an optional `resultType`, so binding types a
  call without compiling it. `compileExpr` and `compileNode` keep their signatures; code generation still reads
  the AST. Planning cost of small statements is unchanged within noise (`bench/micro/prepare.ts`).
- **3c, code generation on plan expressions** (done). The emitter reads plan expressions: it recognises `sql.add`
  and the other operators and the math functions by name, and compares the operands of a comparison without their
  affinity calls (it only emits comparisons where those change nothing). `compileExpr` binds once and generates code
  or compiles closures from the same tree. The SQL forms code generation always left to the closure compiler (BETWEEN,
  NOT LIKE, NOT IN, COLLATE, unary +) are marked by the binder, so generated code stays byte-identical (the snapshot
  covers them). Fused pipelines still receive the parser's expressions until step 4 and bind them first.
- **Risks.** Error order between binding and `def.compile`; one more allocation per node while planning; the fold
  rule of `isCodegenRoot`.

### Step 4: operators and fusion carry plan expressions (done)

`Filter.expr` and `AggSpec.argExprs` / `filterExpr` hold the bound plan expressions, and GROUP BY terms keep theirs
(`compileWithPlan` returns the compiled and the bound form). Fused pipelines compile those instead of binding the
parser's expressions again, so names are resolved once; columns were already marked as read when the operators were
compiled, so decode lists and generated code are unchanged. Fusion declines on `native` nodes from subqueries, where
it declined on subquery AST (a compiled alias is a `native` node too, and fuses as before).

### Step 4b (added): FROM/WHERE machinery on bound conjuncts (about 600 lines)

The conjunct pool keeps a bound form next to the AST (null while a conjunct holds a subquery, which keeps subquery
planning lazy). Access options, `columnOf`, `colRef`, `selectivity`, `hashKeys`, partition pruning, row-group checks,
columnar options and expression-index keys read the bound form. Index probes see through `sql.affinity_*`. The
step-6 planner then reuses the access-path, cost and join-order code unchanged. Gate: no change in the plan-shape
corpus.

### Step 5: the SQL front end produces plans for reading queries (about 2.5k lines, two PRs)

`src/engine/sql/frontend/`: `toPlan(stmt, text, catalog)` returns the plan and SQL-only column metadata (affinity,
collation source, declared type). It ports the name-resolution half of the planner: scopes and CTEs, `*` expansion,
USING / NATURAL, select-list aliases, GROUP BY ordinals, aggregate extraction and its misuse errors, window
resolution and frame checks, compound ORDER BY, VALUES naming, LIMIT / OFFSET errors, views with their own text for
names, recursive CTEs, table functions and external sources. Flattening and materialized-view matching stay as AST
pre-passes until step 7.
- **5a:** a test-only `SMALT_PLAN=shadow` mode builds the plan next to today's compile and checks names, types,
  collations, declared types and errors against it over the differential tests, slt and `sqlite-compat`.
- **5b:** the remaining shapes (CTEs, windows, external sources).

### Step 6: the physical planner reads plans (`SMALT_PLAN=legacy|plan|shadow`)

`exec/physical.ts` assigns registers to each operation's output and compiles plan expressions against them, calling
the column marking as today. Shapes it does not handle yet return null and go through the current planner, so each
part can be on by default. Shadow mode also compares `EXPLAIN` rows from both paths.
- **6a, one source** (about 1.2k lines): scan, filter, project, limit, sort, distinct, values, aggregate; the count
  fast path, rowid ORDER BY elimination, top-N, fusion.
- **6b, join regions** (about 1.5k lines): the inner-join region becomes sources and a conjunct pool; outer joins,
  table functions, derived tables, external projection, expression indexes.
- **6c, the rest** (about 1.2k lines): subqueries and decorrelation on `subquery` plans, windows, `setop`, `iterate`,
  EXPLAIN estimates. The default becomes `plan`.
- **6d, deletion** (about 2k lines removed): the AST paths of the planner and the internal `slot` / `native` nodes.
- **Hardest parts:** projection-pushdown parity, register order (window snapshots), outer references from subqueries
  over aggregate rows, correlation of derived tables, estimates keyed by the same operators.

### Step 7: the optimizations move onto the plan (four PRs)

- **7a, flattening** (`plan/opt/flatten.ts`), with the decline rules of `exec/flatten.ts`.
- **7b, decorrelation** into `lookup`, or a semi join for a top-level WHERE conjunct; it stays lazy and keeps today's
  equivalence conditions (collation, no COLLATE on the inner side, affinity converters).
- **7c, materialized-view matching** on canonical plans, by column position.
- **7d, morsels.** The parts are plans: the `partial` reader message carries the serialized plan, its format version
  and a schema cookie instead of SQL text; the merge reads a `partials` input instead of the `smalt_partials()` table.
- A plan-hash cache sits behind the text-keyed statement cache.

### Step 8: writes through the plan (three PRs)

`delete`, then `update`, then `append` (column mapping, conflict modes, upsert with `excluded.*` as a second input,
RETURNING, the single-row fast path). They compile to today's `TableWriter` programs. What belongs to the table stays
in the engine for every language: storage affinity, defaults, CHECK, NOT NULL, foreign keys, AUTOINCREMENT,
columnar compaction. Risks: RETURNING names, `changes()` and `last_insert_rowid()` order, statement rollback, REPLACE
with foreign keys.

### Step 9: the public `plan` API (three PRs)

- **9a, in-process:** builders, `validatePlan`, `Database.preparePlan` / `queryPlan`, exported from `smaltdb/engine`;
  round-trip tests SQL → plan → JSON → plan → results over the differential corpus.
- **9b, worker protocol:** `queryPlan` and `preparePlan` requests with `planVersion`, results as columnar batches.
- **9c, plugins:** optional `MethodContext.queryPlan(plan, params)`, an additive v1 change with a test in
  `test/plugin-api.test.ts`.

## 5. Open points for the owner

1. **Operations beyond the ADR's list** that SQL needs today: `setop` (INTERSECT / EXCEPT), `values`, `source` (table
   functions, virtual tables, external tables), `iterate` / `working` (recursion), `partials` (morsels) and the
   `lookup` expression.
2. **Mixed-type comparison per language** is only practical in scalar comparison functions. B-tree key order, hashing
   and the sort, group, distinct and join comparators fix one value order (SQLite's storage-class order).
   Recommendation: one engine value order; languages differ through functions and explicit key transforms.
3. **Affinity.** Storage affinity is a column property, so the engine applies it for every language. For comparisons
   the SQL front end inserts explicit `sql.affinity_*` calls, which the physical planner sees through for index probes.
4. **Bare columns** in aggregate queries (SQLite takes them from the min / max row) need an aggregate attribute that
   only SQL uses.
5. **Format details:** the plan type is `StaticType` (no nullability, no boolean) while the format is experimental;
   literals need a tagged JSON encoding for bigint and blob values.
6. **Namespace** `sql.*` for SQL-semantic functions; user-visible functions (`abs`, `sum`) keep bare names.
7. **Caching:** the text-keyed statement cache stays in front of a plan-hash cache; the hash includes output names.
8. **Client method** for worker clients (`Database.queryPlan` in the `smaltdb` client): not in the ADR.
9. **Builders and the catalog:** do builders resolve names to positions through a catalog handle, or do clients pass
   positions?
10. **Morsel readers** resolve tables by position, so a plan sent to a reader carries a schema cookie.
11. **Deleting the current planner** at the end of step 6 (6d), not after step 9, so step 7 is written once.
12. **Gates:** add a prepare-time budget for small queries.
13. **PR series:** step 4b is added and steps are split into short PR series (3a–c, 5a–b, 6a–d, 7a–d, 8a–c, 9a–c),
    where the ADR says one PR per step.
