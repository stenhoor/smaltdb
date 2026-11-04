# ADR 0015: The language API: SQL in its own repository, smaltdf on plans

- **Status:** proposed (draft for the owner's review)
- **Date:** 2026-11-04
- **Builds on:** [ADR 0012](0012-plugins.md) (plugins), [ADR 0013](0013-plugin-api-v1.md) (plugin API v1),
  [ADR 0014](0014-shared-plan-layer.md) (shared plan layer)

## Context

The owner's direction (2026-11-04):

- The SQL language moves into its own repository. `stenhoor/smaltql` exists and is empty.
- One API serves every language. SQL and smaltdf (`stenhoor/smaltdf`, `@smaltdb/df`) are peers on it.

ADR 0014 steps 1–8 have landed. Every SELECT, INSERT, UPDATE and DELETE goes from the SQL front end to a plan, and
from the plan to the physical planner. The AST path was deleted in #76. Plans are the common language, but SQL is
still tied into the engine in many places. Each place is listed below with what it needs.

### Where SQL is still part of the engine

| # | Coupling | Where | What it needs |
| --- | --- | --- | --- |
| 1 | The engine parses SQL text itself: `prepare`, `exec` and `query` take SQL, and `smaltdb/engine` exports `parse` / `parseOne`. | `database.ts`, `engine/index.ts` | A language registered with the engine turns source text into bound statements. |
| 2 | Statements are dispatched on SQL syntax trees: 20 statement kinds in `database.ts` (4.4k lines), DDL included. | `database.ts`, `catalog/schema.ts`, `catalog/alter.ts` | A bound-statement type the engine dispatches on, and language-neutral schema operations. |
| 3 | **The catalog is stored as SQL text.** Opening a database parses every `CREATE` statement in the schema table, and the system tables are created from SQL strings. | `database.ts` (load, ~15 `parseOne` calls), `catalog/schema.ts` | Catalog records the engine can read without a parser. |
| 4 | CHECK, DEFAULT, index expressions, partial-index WHERE and PRAGMA values are compiled from the syntax tree (`compileExpr`), beside the plan compiler (`compileBoundExpr`). | `database.ts`, `exec/expr.ts` | Expressions stored and compiled as plan expressions. One compiler. |
| 5 | The planner still takes syntax trees: plan leaves become `FromItem`s (`leafItem`, `NO_SELECT`), and the planner calls back with syntax and text (`PlannerEnv.planSql`, `rewriteSelect`) to match materialized views for decorrelated inner sides. | `exec/planner.ts` | The planner takes plans only. Materialized-view matching works on plans. |
| 6 | The physical planner rebinds plan expressions to registers and precompiled values (`slot`, `native`). | `exec/planner.ts`, `plan/expr.ts` | Compiling directly from plans. Plans with no closures can be serialized. |
| 7 | Morsel parallelism analyses the syntax tree and sends SQL text to reader workers, which parse and plan it again. | `exec/morsel.ts`, `shared/protocol.ts` (`partial`) | Morsel parts sent as serialized plans. |
| 8 | Two catalog interfaces overlap: `FrontEndCatalog` (names and types) and `PlannerEnv` (the same, plus trees, statistics, spilling and execution state). | `sql/frontend/select.ts`, `exec/planner.ts` | A logical catalog for languages and a physical environment for the planner. |
| 9 | The front end has four entry points with different shapes (`toPlan`, `toInsertPlan`, `toUpdatePlan`, `toDeletePlan`). For the three writes, `database.ts` has already resolved the target table and the INSERT column list. | `sql/frontend/select.ts`, `database.ts` | One entry point that resolves its own targets. |
| 10 | The worker protocol and the plugin `MethodContext` carry SQL only (`exec`, `query`, `prepare`, `partial`, `MethodContext.query`). | `shared/protocol.ts`, `plugin.ts` | Plan requests beside the SQL requests (ADR 0014 section 4). |

### What smaltdf needs

smaltdf 0.1 compiles Polars-style frames to one SQL statement (`src/compile.ts`, 820 lines) and runs it through
`query(sql, params, { rowMode: 'columnar' })`. ADR 0014 says smaltdf does not generate SQL. On the plan API it needs:

- **Plan building:** typed operations and expressions with column references by position (ADR 0014's format),
  checked by the engine before planning.
- **Its own semantics:** many of its documented divergences from Polars (`docs/divergences.md`) come from SQL's
  semantics: integer `truediv`, `round` halves away from zero, NULLs first by default, `CAST` of non-numeric text
  to 0. On plans, smaltdf picks the engine functions with the semantics it wants (ADR 0014 section 2).
- **Catalog reads:** tables, columns, types, views and external tables, with the same information SQL gets.
- **Execution:** prepare and run plans in-process, through the worker client and from plugins, with columnar
  results. Writes (`append`, `update`, `delete`) and creating tables (`collect()` into a table, `writeTable`).
- **Data in:** JavaScript columns as a plan source, without creating a temporary table and inserting rows.
- **Operations it emulates in SQL today or cannot express:** `tail`, `unique(keep=first|last)`, `maintainOrder`,
  `first` / `last` aggregates, `withRowIndex`, `concat` (by name), `pivot` / `unpivot`, `join_asof`, `explode`,
  `fill_null` strategies, `sample`.
- **Types SQL lacks:** a boolean type (stored as 0 / 1 today), NaN as a value distinct from NULL, dates and times,
  lists and structs.
- **Errors at the call site:** an error names the frame expression that caused it, as a SQL error names its text.

## Decision

### 1. Packages and dependency direction

```
@smaltdb/sql (stenhoor/smaltql) ──┐                     ┌── @smaltdb/df (stenhoor/smaltdf)
  lexer, parser, syntax tree,     │  language API (v1,   │     frames, expressions,
  binder, SQL rewrites, DDL       ├─ experimental) ──────┤     plan builder
  syntax, EXPLAIN text            │                      │
                                  ▼                      ▼
smaltdb: client, worker, engine — catalog, plan format and validator, function library,
         optimizer and physical planner, operators, storage, plugins
```

- **`smaltdb`** holds the engine and the client. It has no SQL parser. It owns the plan format, the catalog, the
  function library, the planner, the operators and storage.
- **`@smaltdb/sql`** (repository `stenhoor/smaltql`) holds what is SQL: lexer, parser, syntax tree, binder (today's
  front end), view and subquery flattening, SQL's DDL syntax translated to schema operations, parameter names,
  EXPLAIN text and SQLite-compatible error wording.
- **`@smaltdb/df`** builds plans.
- **Languages import only types from `smaltdb/engine`**, the same rule as plugins (ADR 0012). They are registered
  with an engine as plugins are, and run in the worker.
- **SQL is registered by default** (decision D1): `smaltdb` depends on `@smaltdb/sql`, and `@smaltdb/sql` has
  `smaltdb` as a peer dependency for types only. `open()`, `db.query(sql)` and `db.exec(sql)` keep working, so
  smaltui and smaltbi need no changes.

### 2. The language interface

```ts
interface SmaltLanguage {
  name: string;                 // 'sql', 'df'
  version: string;
  apiVersion: number;           // LANGUAGE_API_VERSION
  /** Source text to bound statements (SQL: one per statement in the text). */
  bind(source: string, ctx: BindContext): BoundStatement[];
  /** A stored view written in this language, bound where a query reads it (late binding, as SQLite). */
  bindView(view: StoredView, ctx: BindContext): BoundQuery;
  /** Optional: an EXPLAIN rendering of a plan in this language's terms. */
  explain?(stmt: BoundStatement, rows: ExplainRow[]): ExplainRow[];
}
```

- **One entry point for statements.** Today's `toPlan`, `toInsertPlan`, `toUpdatePlan` and `toDeletePlan` become
  `bind`. The language resolves its targets itself: tables, columns and the INSERT column list.
- **`BindContext`** is the logical catalog, read-only and the same for every language:
  - tables, with each column's plan type, declared type, affinity, collation, nullability and rowid alias;
  - views (each with its language and source), materialized views, external tables and connections;
  - table functions and virtual tables, with their columns;
  - the function registry's metadata: name, arity, argument and result types, determinism, and whether it is a
    scalar, aggregate or window function;
  - the settings that affect binding.

  It replaces both `FrontEndCatalog` and the name and type half of `PlannerEnv`. The physical environment (trees,
  statistics, spilling, execution state) stays private to the planner.
- **Bound statements:**

  | Kind | Contents |
  | --- | --- |
  | `query` | plan, result columns (name, type, declared type, collation, affinity), parameter count |
  | `write` | `append` / `update` / `delete` plan, RETURNING columns |
  | `schema` | a schema operation (section 4) |
  | `transaction` | begin (deferred / immediate / exclusive), commit, rollback, savepoint, release |
  | `setting` | read or set a setting (SQL's PRAGMA) |
  | `maintenance` | analyze, vacuum, refresh a materialized view |
  | `explain` | an inner bound statement and the EXPLAIN mode |

- **Parameters** are positional in plans (`param` nodes). Mapping names to positions (`:name`, `$name`, `?NNN`) is
  the language's job.

### 3. The engine's entry points

- **The physical planner takes plans only.** No syntax trees, no SQL text, and no callbacks into a language:
  - materialized-view matching and the decorrelated inner sides it answers work on plans (ADR 0014 section 3);
  - `leafItem` / `FromItem` and `PlannerEnv.planSql` / `rewriteSelect` go;
  - INSERT gets its own entry point instead of being assembled in `database.ts`.
- **Public API:**
  - `db.query(source, params, { language })` and `exec` / `prepare`, with SQL as the default;
  - `db.preparePlan(plan)` and `db.queryPlan(plan, params)` in-process, over the worker protocol and in
    `MethodContext` (ADR 0014 section 4).
- **The engine validates every plan before planning it,** because a builder is not trusted: types, column positions,
  nesting depth, functions and their arities. A plan from SQL passes the same check, which costs a single walk.
- **Caching:** statements by language and source text, as today. Plans by a hash of their canonical form.

### 4. Schema operations, language-neutral

- **The operations:**
  - `createTable`: columns with plan type, declared type, affinity, collation and nullability; primary key; UNIQUE;
    CHECK and DEFAULT as plan expressions over the row; generated columns; foreign keys; storage options.
  - `createIndex`: keys as plan expressions, uniqueness, a partial WHERE.
  - `createView` (language and source), `createMaterializedView`.
  - `createConnection`, `createExternalTable`.
  - `drop`, and `alterTable`: add, drop and rename a column, rename the table.
- **Who produces them:** SQL's DDL syntax becomes these operations. smaltdf calls them directly to create tables.
  Connection types stay registered by plugins (ADR 0012).
- **One expression compiler.** CHECK, DEFAULT, index and partial-index expressions are plan expressions compiled
  with `compileBoundExpr`. AST compilation (`compileExpr`, the planner's compile scope) goes.

### 5. Catalog storage

- **The engine stores a language-neutral, versioned definition** for each table, index, connection, external table
  and materialized view, with its source text and language beside it for display. A SQL-created object still shows
  its SQL in `sqlite_schema.sql`.
- **Opening a database parses nothing.** This also makes opening faster.
- **The system tables are defined in code,** not in SQL strings.
- **A view stays as its language's source,** bound where it is read, as SQLite does. Reading a view needs its
  language registered; without it the error names the package (`SMALT_MISUSE`: "view v is written in sql: register
  @smaltdb/sql").
- **This changes the file format** (decision D3).

### 6. Functions and semantics

- **The engine owns every function implementation** (decision D6). Code generation inlines them, so moving them out
  would cost speed:
  - `sql.*` functions hold SQLite's semantics (affinity, comparison, integer division, rounding);
  - core math and statistics functions are shared by every language;
  - functions a language needs with other semantics are added under its own namespace (e.g. `df.truediv` always
    returns a float).
- **A language maps its names onto registry entries.** The registry publishes metadata through `BindContext`, and
  the engine never sees a language's function names.
- **Which semantics smaltdf uses on plans** is its own decision (decision D4).

### 7. The plan format as the contract

- **Serializable:** JSON-safe and safe for `structuredClone`, with no closures. `slot` and `native` go when code is
  compiled directly from plans.
- **Versioned:** `PLAN_FORMAT_VERSION` (ADR 0014 section 4), with the validator from section 3.
- **Provenance:** an optional `origin` on plan nodes, defined by the language (a SQL text span, a smaltdf call
  site). Errors carry it, so each language words where the error came from.
- **Additive growth:** each new operation or type is an additive format change, with its own PR and, for types, an
  ADR:
  - the operations smaltdf needs (Context), in the order smaltdf needs them;
  - a columnar `values` source for JavaScript data;
  - boolean, date and time types first, then lists and structs.
- **Errors:** engine errors keep their codes and gain structured details (constraint, table, column) that languages
  can reword. The SQLite wording moves to `@smaltdb/sql`.

### 8. Performance

Performance is non-negotiable, so every step has a measured budget:

- **No new passes in-process:** a language hands the engine plan objects, and the only addition is the validator's
  walk. Compiling directly from plans (removing the rebinding) pays for it. Today the plan layer plans small
  statements 1.0–1.45× as slowly as the deleted AST path did (#46).
- **Faster where SQL is reparsed today:** morsel workers receive plans instead of SQL text, which saves a parse and a
  bind per morsel and per reader, and opening a database parses no DDL.
- **The gates for every step:**
  - `bench/micro/prepare.ts` (planning cost) and the browser benchmark compared with `bench/results/`;
  - `test/perf-invariants.test.ts`;
  - sqllogictest, the differential tests and the plan-shape and generated-code corpora.

### 9. Tests across repositories

- **`smaltql` runs SQL's tests:**
  - sqllogictest;
  - the SQLite differential tests;
  - the parser and binder tests;
  - the docs examples, marked as the Parquet ones are (`<!-- docs:plugin @smaltdb/sql -->`). The docs site stays
    in smaltdb.
- **smaltdb's engine tests:**
  - most are written in SQL, so they use `@smaltdb/sql` as a dev dependency pinned in `packed.json` (as plugins
    are today);
  - new plan-level tests, which need no language, cover the planner and the validator.
- **smaltdf:** its differential tests against Polars run on plans.

## Order of work

Each step is its own PR. Every suite and benchmark gate (section 8) stays green at every step.

1. This ADR.
2. **Compile from plans:** remove `slot` / `native` and the rebinding (couplings 6 and 5's register half).
3. **The planner takes plans only:** materialized-view matching on plans, no `FromItem` or SQL callbacks, and
   `PlannerEnv` split into `BindContext` and the physical environment (couplings 5 and 8).
4. **One expression compiler:** CHECK, DEFAULT, index and partial-index expressions as plan expressions
   (coupling 4).
5. **Plan serialization and the validator.** Morsel parts travel as plans (coupling 7).
6. **Bound statements and `bind()`:** `database.ts` dispatches on bound statements; DDL becomes schema
   operations; transactions, settings and maintenance become bound kinds (couplings 2 and 9).
7. **Language-neutral catalog storage,** and opening without a parser (coupling 3). This is the file format change.
8. **The public plan API:** `preparePlan` / `queryPlan` in-process, over the worker protocol and in `MethodContext`
   (coupling 10; ADR 0014 step 9).
9. **The language interface and the move:** `src/engine/sql/`, the front end, `exec/flatten.ts` and
   `exec/sql-meta.ts` move to `stenhoor/smaltql` as `@smaltdb/sql`. `smaltdb` depends on it and registers it by
   default; `smaltdb/engine` stops exporting `parse`.
10. **smaltdf on plans,** in its own repository: its compiler builds plans instead of SQL, and it reviews its
    divergences against the semantics it then picks (D4).

Steps 2–5 are refactors inside smaltdb with no public change. Steps 6–9 change `smaltdb/engine`'s exports. The
client API is unchanged when SQL is registered by default.

## Owner's decisions needed

| # | Decision | Recommendation |
| --- | --- | --- |
| D1 | Is SQL registered by default in `smaltdb`, or does an application add it, as it adds plugins? | **By default.** `open()` and `query(sql)` keep working, and smaltui and smaltbi need no changes. |
| D2 | The package name for `stenhoor/smaltql`. | **`@smaltdb/sql`,** matching `@smaltdb/df` and the plugins. |
| D3 | Language-neutral catalog storage: a file format change before 1.0. | **Yes,** together with the pending WAL frame-checksum change, in one format bump. |
| D4 | smaltdf's semantics on plans: keep SQL's (DESIGN.md decision 5), or follow Polars through `df.*` functions. | **The owner's call,** and smaltdf's DESIGN.md records it. On plans, either costs the same. |
| D5 | Stability: the language API and the plan format stay experimental until smaltdf and SQL both run on them, then each gets a stability ADR (as ADR 0013 did for plugins). | **Yes.** Until then the three packages are released together. |
| D6 | Where SQL's function semantics live. | **In the engine** (`sql.*`), for code generation and speed. `@smaltdb/sql` chooses them by name. |

## Alternatives considered

- **Keep the parser in the engine and move only the binder.** The engine would still parse SQL to open a database
  and for morsels, so SQL could not be versioned or replaced on its own, and smaltdf-only applications would still
  ship it.
- **Store bound plans for views.** A stored plan goes stale when its tables change, and SQLite binds views late.
  Views stay as their language's source.
- **Let languages compile their own expressions.** Code generation and fusion would be duplicated, and a language's
  functions could not be inlined. Rejected for speed (section 8).
- **Open a database by requiring the language that created each object.** It avoids the format change, but a
  smaltdf-only application could not open a database with SQL-created tables without loading SQL. Rejected in
  favour of neutral records (section 5).

## Consequences

- SQL becomes one language among peers, versioned and tested in its own repository. The engine gets smaller and has
  no parser.
- smaltdf leaves SQL generation behind, and its semantics become its own.
- The plan format, the language API and the schema operations become public surfaces, experimental until D5.
- One file-format change before 1.0 (D3).
- smaltdb's tests depend on `@smaltdb/sql` the way they depend on the plugins today: pinned in `packed.json` until the
  packages are on npm.
