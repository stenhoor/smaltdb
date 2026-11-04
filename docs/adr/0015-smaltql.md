# ADR 0015: smaltql and the language API: SQL in its own repository, smaltdf on plans

- **Status:** accepted (owner's decisions below, 2026-11-04)
- **Date:** 2026-11-04
- **Builds on:** [ADR 0012](0012-plugins.md) (plugins), [ADR 0013](0013-plugin-api-v1.md) (plugin API v1),
  [ADR 0014](0014-shared-plan-layer.md) (shared plan layer)

This record merges two drafts written the same day: the first one (#77), on smaltql and the package names, and the
language API (#78). Where they differed, the owner decided; section 11 lists what changed from the first draft.

## Context

The owner's direction (2026-11-04):

- **SQL becomes its own product, smaltql** (`stenhoor/smaltql`, empty today), a peer of smaltdf. smaltdb's job narrows
  to execution performance: the plan layer, the optimizer, the operators and storage. smaltql's job is the language,
  which can grow its own identity.
- **One API serves every language.** SQL (smaltql) and dataframes (smaltdf, `stenhoor/smaltdf`) are peers on it.
- **The repositories are separated by function** to avoid collisions and keep each one's space enforced. Each has its
  own audience:

  | Layer | Repository | Who uses it |
  | --- | --- | --- |
  | Engine | smaltdb | Language developers, and anyone who wants to work with the engine directly |
  | Languages | smaltql, smaltdf | Developers building their own apps with SQL queries or a dataframe interface |
  | Applications | smaltui, smaltbi, smaltnb | People who want a complete browser experience |

- **Packages publish under the smaltworks npm organization,** named after their repositories.

ADR 0014 steps 1–8 have landed. Every SELECT, INSERT, UPDATE and DELETE goes from the SQL front end to a plan, and
from the plan to the physical planner. The AST path was deleted in #76. Plans are the common language, but SQL is
still tied into the engine in many places. Each place is listed below with what it needs.

Today one package, `smaltdb` (0.8.3 on npm, 0.9.0 in the repository), holds the engine and SQL. The plugins are named
`@smaltdb/io`, `@smaltdb/external` and `@smaltdb/parquet`, and smaltdf `@smaltdb/df`. None of those has been published.

### Where SQL is still part of the engine

| # | Coupling | Where | What it needs |
| --- | --- | --- | --- |
| 1 | The engine parses SQL text itself: `prepare`, `exec` and `query` take SQL, and `smaltdb/engine` exports `parse` / `parseOne`. | `database.ts`, `engine/index.ts` | A language registered with the engine turns source text into bound statements. |
| 2 | Statements are dispatched on SQL syntax trees: 20 statement kinds in `database.ts` (4.4k lines), DDL included. | `database.ts`, `catalog/schema.ts`, `catalog/alter.ts` | A bound-statement type the engine dispatches on, and language-neutral schema operations. |
| 3 | **The catalog is stored as SQL text.** Opening a database parses every `CREATE` statement in the schema table, and the system tables are created from SQL strings. | `database.ts` (load, ~15 `parseOne` calls), `catalog/schema.ts` | Catalog records the engine can read without a parser. |
| 4 | CHECK, DEFAULT, index expressions, partial-index WHERE and PRAGMA values are compiled from the syntax tree (`compileExpr`), beside the plan compiler (`compileBoundExpr`). | `database.ts`, `exec/expr.ts` | Expressions stored and compiled as plan expressions. One compiler. |
| 5 | The planner still takes syntax trees: plan leaves become `FromItem`s (`leafItem`, `NO_SELECT`), and the planner calls back with syntax and text (`PlannerEnv.planSql`, `rewriteSelect`) to match materialized views for decorrelated inner sides. Materialized-view matching itself works on the syntax tree (`exec/mv-match.ts`). | `exec/planner.ts`, `exec/mv-match.ts` | The planner takes plans only. Materialized-view matching works on plans. |
| 6 | The physical planner rebinds plan expressions to registers and precompiled values (`slot`, `native`). | `exec/planner.ts`, `plan/expr.ts` | Compiling directly from plans. Plans with no closures can be serialized. |
| 7 | Morsel parallelism analyses the syntax tree and sends SQL text to reader workers, which parse and plan it again (ADR 0014 step 7d). | `exec/morsel.ts`, `shared/protocol.ts` (`partial`) | Morsel parts sent as serialized plans. |
| 8 | Two catalog interfaces overlap: `FrontEndCatalog` (names and types) and `PlannerEnv` (the same, plus trees, statistics, spilling and execution state). | `sql/frontend/select.ts`, `exec/planner.ts` | A logical catalog for languages and a physical environment for the planner. |
| 9 | The front end has four entry points with different shapes (`toPlan`, `toInsertPlan`, `toUpdatePlan`, `toDeletePlan`). For the three writes, `database.ts` has already resolved the target table and the INSERT column list. | `sql/frontend/select.ts`, `database.ts` | One entry point that resolves its own targets. |
| 10 | The worker protocol and the plugin `MethodContext` carry SQL only (`exec`, `query`, `prepare`, `partial`, `MethodContext.query`). | `shared/protocol.ts`, `plugin.ts` | Plan requests beside the SQL requests (ADR 0014 section 4). |

### What smaltdf needs

smaltdf is inspired by Polars. It is not Polars, and it is not a mapping onto SQL. Version 0.1 compiles frames to
one SQL statement (`src/compile.ts`, 820 lines) and runs it through `query(sql, params, { rowMode: 'columnar' })`, so
it inherits SQL's results. Its divergence list (`docs/divergences.md`) records where those results differ from
Polars. On the plan API it needs:

- **Plan building:** typed operations and expressions with column references by position (ADR 0014's format),
  checked by the engine before planning.
- **The operations it means:** for example float division for `truediv`, where SQL's `/` on two integers is
  integer division (section 6).
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

### 1. Packages, dependencies and delivery

```
@smaltworks/smaltql ──┐                         ┌── @smaltworks/smaltdf
  lexer, parser,      │                         │     frames, expressions,
  binder, SQL         ├── language API ─────────┤     plan builder
  rewrites, DDL       │                         │
  syntax, EXPLAIN     ▼                         ▼
@smaltworks/smaltdb: engine and client, with no language: catalog, plan format and
                     validator, function library, optimizer and physical planner,
                     operators, storage, plugin interface
```

- **`@smaltworks/smaltdb`** holds the engine and the client. It has no SQL parser and no language built in. It owns
  the plan format, the catalog, the function library, the optimizer (materialized-view matching included), the
  planner, the operators and storage. It is for language developers and for applications that work with the
  engine directly.
- **`@smaltworks/smaltql`** holds what is SQL:
  - lexer, parser, syntax tree and binder (today's front end);
  - view and subquery flattening (`exec/flatten.ts`);
  - SQL's DDL syntax, translated to schema operations;
  - parameter names, EXPLAIN text and SQLite-compatible error wording;
  - SQL's tests and the SQL reference (section 9).
- **`@smaltworks/smaltdf`** builds plans.
- **Languages and plugins** declare `@smaltworks/smaltdb` as a peer dependency, so an application has one engine,
  and they import only types from its engine entry, the same rule as plugins (ADR 0012).
- **Languages run in the engine's worker,** registered as plugins are.
- **Each language exports a ready `open()`** with itself registered: `import { open } from '@smaltworks/smaltql'`
  is the SQL database for app developers, and smaltdf does the same. An application that uses both registers both.
- **Building a worker:** a helper in smaltdb, roughly `defineWorker({ languages, plugins })`, builds a worker that
  contains the engine and what it registers.
- **Applications depend on the repository packages directly.** smaltui, smaltbi and smaltnb list smaltdb,
  smaltql, smaltdf and the plugins they use. Their builds already combine everything they use, every version is
  pinned explicitly, and npm keeps one copy of each.
- **Distributions are optional prebuilt artifacts,** added later: a worker and client with a fixed content, for
  developers who use no build tool (a script tag or a CDN). For example "database" (engine and SQL) and "analyst"
  (engine, SQL and dataframes). They have no code of their own. A distribution is an end product: no package depends
  on one, so an application never ends up with two engines. Their names are decided later.

### 2. Package names

Every package publishes under the smaltworks npm organization as `@smaltworks/<repository name>`:

| Repository | Package |
| --- | --- |
| `stenhoor/smaltdb` | `@smaltworks/smaltdb` (entry points as today: `/engine`, `/worker`, `/worker-runtime`) |
| `stenhoor/smaltql` | `@smaltworks/smaltql` |
| `stenhoor/smaltdf` | `@smaltworks/smaltdf` (was `@smaltdb/df`) |
| `stenhoor/smaltdb-io`, `-external`, `-parquet` | `@smaltworks/smaltdb-io`, `@smaltworks/smaltdb-external`, `@smaltworks/smaltdb-parquet` (were `@smaltdb/…`) |
| `stenhoor/smaltui`, `smaltbi`, `smaltnb`, `smaltkit` | `@smaltworks/<repository>`, when they publish |

- **The old name:** `smaltdb` 0.8.3 stays on npm. When `@smaltworks/smaltdb` first publishes, `smaltdb` is marked
  deprecated with a message naming the new packages. Nothing under `@smaltdb` was published, so those names simply
  change.
- **Imports change** from `smaltdb` and `smaltdb/engine` to `@smaltworks/smaltdb` (engine and client) and
  `@smaltworks/smaltql` (`open()` for SQL). The plugins' peer dependency, `packed.json`, the docs, `CLAUDE.md`, and
  smaltui and smaltbi follow.
- **The rename is a separate issue,** one PR per repository, just before the first publish (step 11).

### 3. The language interface

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
  | `schema` | a schema operation (section 5) |
  | `transaction` | begin (deferred / immediate / exclusive), commit, rollback, savepoint, release |
  | `setting` | read or set a setting (SQL's PRAGMA) |
  | `maintenance` | analyze, vacuum, refresh a materialized view |
  | `explain` | an inner bound statement and the EXPLAIN mode |

- **Parameters** are positional in plans (`param` nodes). Mapping names to positions (`:name`, `$name`, `?NNN`) is
  the language's job.
- **smaltql uses only this interface and the public plan API,** as smaltdf does. What a full SQL front end needs
  (parameters, output names, positions for error messages, EXPLAIN) is part of the API, not a private shortcut.

### 4. The engine's entry points

- **The physical planner takes plans only.** No syntax trees, no SQL text, and no callbacks into a language:
  - materialized-view matching, and the decorrelated inner sides it answers, work on plans (ADR 0014 section 3);
  - `leafItem` / `FromItem` and `PlannerEnv.planSql` / `rewriteSelect` go;
  - INSERT gets its own entry point instead of being assembled in `database.ts`.
- **Public API:**
  - `db.query(source, params, { language })` and `exec` / `prepare`, for the languages registered;
  - `db.preparePlan(plan)` and `db.queryPlan(plan, params)` in-process, over the worker protocol and in
    `MethodContext` (ADR 0014 section 4 and step 9).
- **The engine validates every plan before planning it,** because a builder is not trusted: types, column positions,
  nesting depth, functions and their arities. A plan from SQL passes the same check, which costs a single walk.
- **Caching:** statements by language and source text, as today. Plans by a hash of their canonical form.

### 5. Schema operations, language-neutral

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

### 6. Catalog storage

- **The engine stores a language-neutral, versioned definition** for each table, index, connection, external table
  and materialized view, with its source text and language beside it for display. A SQL-created object still shows
  its SQL in `sqlite_schema.sql`.
- **Opening a database parses nothing.** This also makes opening faster.
- **The system tables are defined in code,** not in SQL strings.
- **A view stays as its language's source,** bound where it is read, as SQLite does. Reading a view needs its
  language registered; without it the error names the package (`SMALT_MISUSE`: "view v is written in sql: register
  @smaltworks/smaltql").
- **The file format changes on its own,** separately from the WAL frame-checksum change.

### 7. Operations and results

**One result per operation.** The engine defines each operation once, and every language that uses it gets the same
result from it.

- **Operations are named for what they do,** not for the language that uses them: integer division and float
  division, rounding half away from zero and half to even, SQLite's affinity conversions and comparison rules, and
  so on.
- **Each language maps its own syntax onto the operation it means.** SQL's `/` on two integers is integer division
  (`7 / 2 = 3`), as SQLite defines it. smaltdf's `truediv` is float division (`3.5`), because that is what smaltdf
  means. Either language can reach any operation.
- **The same plan gives the same result** whichever language built it. Results never depend on how a language
  processes engine output: a language returns the engine's values and does not post-process them.
- **smaltdf documents its own semantics** in its own docs. They are no longer divergences from SQL, and smaltdf
  reviews its divergence list once it is on plans (step 10).
- **The engine owns every implementation, SQL's rules included.** Code generation inlines them, so moving them out
  would cost speed. The registry publishes each function's metadata through `BindContext`. A language that needs an
  operation the engine lacks adds it to the engine, with a PR in smaltdb.
- **Today's `sql.*` functions** hold SQLite's conversion and comparison rules. They are operations like any other,
  open to every language; renaming them by behaviour is part of step 2.

### 8. smaltql's language rule

Familiar SQL always works. The dialect follows SQLite today. smaltql may add syntax of its own, but only on top of
SQL, never by changing what working SQL means. A change to the meaning of existing SQL needs a versioned dialect
setting and its own ADR.

### 9. The plan format as the contract

- **Serializable:** JSON-safe and safe for `structuredClone`, with no closures. `slot` and `native` go when code is
  compiled directly from plans.
- **Versioned:** `PLAN_FORMAT_VERSION` (ADR 0014 section 4), with the validator from section 4.
- **Provenance:** an optional `origin` on plan nodes, defined by the language (a SQL text span, a smaltdf call
  site). Errors carry it, so each language words where the error came from.
- **Additive growth:** each new operation or type is an additive format change, with its own PR and, for types, an
  ADR:
  - the operations smaltdf needs (Context), in the order smaltdf needs them;
  - a columnar `values` source for JavaScript data;
  - boolean, date and time types first, then lists and structs.
- **Errors:** engine errors keep their codes and gain structured details (constraint, table, column) that languages
  can reword. The SQLite wording moves to smaltql.
- **Stability:** the language API, the plan format and the schema operations may change until 1.0, and freeze at 1.0.
  1.0 includes smaltql and smaltdf, so both run on them before the freeze. Until then smaltdb, smaltql and smaltdf
  are released together: a smaltdb release names the smaltql and smaltdf versions it was tested with.

### 10. Performance

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

### 11. Tests and documentation across repositories

- **smaltql runs SQL's tests:** sqllogictest, the differential tests against SQLite, and the parser and binder tests.
- **The SQL reference moves to smaltql.** smaltdb's docs describe the plan layer, storage, plugins and the client.
  Until the move, SQL's docs examples stay on smaltdb.dev, marked as the Parquet ones are
  (`<!-- docs:plugin @smaltworks/smaltql -->`), and run in smaltql.
- **smaltdb's engine tests:**
  - many are written in SQL, so they use smaltql as a dev dependency pinned in `packed.json` (as the plugins are
    today), and smaltdb's CI runs smaltql's suites against each engine change, so an engine change can't break SQL
    unnoticed;
  - the plan-shape corpus, the performance invariants, storage, durability and browser tests stay;
  - new plan-level tests, which need no language, cover the planner and the validator.
- **smaltdf:** its own tests on plans, against the semantics it documents.

### 12. Changes from the first draft (#77)

- **smaltdb has no language** (the draft: "smaltdb ships with smaltql"). Installing smaltdb gives the engine;
  smaltql's `open()` gives a SQL database. So the draft's open point on how smaltdb takes in smaltql goes.
- **The engine owns every function, SQL's rules included** (the draft moved SQL's semantic functions to smaltql).
- **Materialized-view matching moves onto plans in the engine,** as ADR 0014 section 3 says (the draft moved the
  AST-level matching to smaltql). Flattening moves to smaltql, as the draft said.
- **Distributions:** the draft's distributions are the prebuilt artifacts of section 1.

## Order of work

Each step is its own PR. Every suite and benchmark gate (section 10) stays green at every step.

1. This ADR.
2. **Compile from plans:** remove `slot` / `native` and the rebinding (coupling 6, and the register half of 5).
   Functions are named by behaviour (section 7).
3. **The planner takes plans only:** materialized-view matching on plans, no `FromItem` or SQL callbacks, and
   `PlannerEnv` split into `BindContext` and the physical environment (couplings 5 and 8).
4. **One expression compiler:** CHECK, DEFAULT, index and partial-index expressions as plan expressions
   (coupling 4).
5. **Plan serialization and the validator.** Morsel parts travel as plans (coupling 7; ADR 0014 step 7d).
6. **Bound statements and `bind()`:** `database.ts` dispatches on bound statements; DDL becomes schema operations;
   transactions, settings and maintenance become bound kinds (couplings 2 and 9).
7. **Language-neutral catalog storage,** and opening without a parser (coupling 3). This is its own file format
   change.
8. **The public plan API:** `preparePlan` / `queryPlan` in-process, over the worker protocol and in `MethodContext`
   (coupling 10; ADR 0014 step 9), with smaltql's needs (section 3).
9. **The boundary, then the move:**
    - `src/engine/sql/`, the front end and `exec/flatten.ts` become a workspace package in this repository that
      reaches the engine only through the language interface and the plan API, with a check that engine code never
      imports it;
    - then the package moves to `stenhoor/smaltql` with its tests and SQL docs;
    - smaltql exports its `open()`, and smaltdb gains `defineWorker`;
    - smaltdb stops exporting `parse` and no longer registers SQL itself;
    - smaltui and smaltbi import `open()` from smaltql.
10. **smaltdf on plans,** in its own repository: its compiler builds plans instead of SQL, maps each method to the
    operation it means (section 7), and reviews its divergence list.
11. **Package names** (section 2): a separate issue, one PR per repository, just before the first publish.
    Nothing depends on the names until then.
12. **Publish** `@smaltworks/smaltdb`, `@smaltworks/smaltql`, `@smaltworks/smaltdf` and the plugins together.

Steps 2–5 are refactors inside smaltdb with no public change. Steps 6–9 change the engine's exports, and step 9
moves `open()` for SQL into smaltql.

## Owner's decisions (2026-11-04)

1. **SQL is its own product,** smaltql, a peer of smaltdf on the plan layer. smaltdb's job is execution performance.
2. **Packages:**
   - every repository publishes `@smaltworks/<repository name>`, and SQL is `@smaltworks/smaltql`;
   - smaltdb has no language, and each language exports a ready `open()`;
   - applications depend on the repository packages directly;
   - distributions are optional prebuilt artifacts, added later;
   - the rename is a separate issue, before the first publish.
3. **Catalog storage:** language-neutral records, as a file format change of its own, separate from the WAL
   frame-checksum change.
4. **Results:** one result per operation from the engine, whichever language uses it. smaltdf is inspired by Polars,
   and Polars does not map onto SQL: each language maps its syntax to the operations it means. If a language ever
   needed to process engine output to get its result, that is discussed with the owner first.
5. **Stability:** the language API and the plan format freeze at 1.0, which includes smaltql and smaltdf.
6. **Functions:** the engine owns every implementation, SQL's rules included.
7. **One record:** the two drafts are one ADR 0015.
8. **The rename comes last:** the package names change just before the first publish, not before the engine work.

Earlier owner decisions this ADR relies on are in ADR 0014 ("Owner's decisions").

## Open points for the owner

1. **Release order:** whether 0.9.0 waits for the split (one change of package and structure for users), or 0.9.0
   publishes after step 8 and the split follows.
2. **How to say it:** smalt-Q-L or smalt-quel (a brand question, recorded in `stenhoor/smalt-brand`).

## Alternatives considered

- **SQL stays in smaltdb,** as a language inside smaltdb's brand. No new repository or package, but SQL stays the
  engine's privileged language and smaltdf a second one. The owner chose full peers.
- **smaltdb ships with smaltql.** `npm install` of the engine would give a SQL database, but every engine install
  would carry SQL, and the engine package would serve two audiences. The owner chose an engine with no language, and
  `open()` from each language.
- **Keep the parser in the engine and move only the binder.** The engine would still parse SQL to open a database
  and for morsels, so SQL could not be versioned or replaced on its own, and smaltdf-only applications would still
  ship it.
- **Store bound plans for views.** A stored plan goes stale when its tables change, and SQLite binds views late.
  Views stay as their language's source.
- **Let languages compile their own expressions or bring their own functions.** Code generation and fusion would be
  duplicated, functions could not be inlined, and the same operation could give different results in different
  languages. Rejected for speed and for consistent results (sections 7 and 10).
- **Open a database by requiring the language that created each object.** It avoids the format change, but a
  smaltdf-only application could not open a database with SQL-created tables without loading SQL. Rejected in
  favour of neutral records (section 6).
- **Distributions as packages that applications depend on.** They add a layer to keep in sync with the repository
  packages, and an application that depended on a distribution and on a language could end up with two engines.
  Rejected: distributions are end products (section 1).
- **Unscoped package names** owned by the organization (`smaltdb`, `smaltql`). The owner chose the scope, so every
  smaltworks package is recognisable by its name.

## Consequences

- **The engine's work is about execution.** Changes to smaltdb are measured by speed, memory and durability; syntax
  and SQL semantics change in smaltql.
- **SQL becomes one language among peers,** versioned and tested in its own repository. The engine gets smaller and
  has no parser.
- **smaltdf leaves SQL generation behind** and maps its methods to the operations it means.
- **The plan format, the language API and the schema operations become public surfaces,** frozen at 1.0.
- **One file-format change before 1.0,** for the catalog.
- **Applications change their imports:** the package rename, and `open()` from the language they use. smaltui and
  smaltbi change in steps 9 and 11.
- **One more repository and package to release,** in step with smaltdb, and cross-repository CI.
- **The brand:** smaltql has its own mark and colour (smalt-brand `BRAND.md`), and smaltdb keeps its tagline and
  positioning line.
