# ADR 0015: SQL moves to smaltql; packages publish as `@smaltworks/<repository>`

- **Status:** proposed (draft for the owner's review)
- **Date:** 2026-11-04

## Context

[ADR 0014](0014-shared-plan-layer.md) put a typed, positional plan layer between the languages and the engine. SQL is
now one front end on it: the SQL front end (`sql/frontend/`) turns the parser's output into plans, and the physical
planner, the optimizations and writes read plans. The planner's AST path has been deleted. What is left of ADR 0014 is
step 7d (morsel parts travel to reader workers as serialized plans, not SQL text) and step 9 (the public `plan` API). Some engine
files still import the SQL AST (`exec/planner.ts`, `exec/expr.ts`, `exec/morsel.ts`, `exec/sql-meta.ts`).

The owner's direction (2026-11-04):

- **SQL becomes its own product, smaltql** (`stenhoor/smaltql`), a peer of smaltdf. smaltdb's job narrows to execution
  performance: the plan layer, the optimizer, the operators and storage. smaltql's job is the language, which can grow
  its own identity.
- **smaltdb ships with smaltql by default.** Installing smaltdb still gives a database you query with SQL.
- **Packages publish to npm under the smaltworks organisation, named after their repositories**, for example
  `@smaltworks/smaltdb` and `@smaltworks/smaltql`.
- **Distributions** (the engine alone, or the engine with particular languages) are agreed in principle; their names
  and packaging are decided later.

Today one package, `smaltdb` (0.8.3 on npm, 0.9.0 in the repository), holds the engine and SQL. The plugins are named
`@smaltdb/io`, `@smaltdb/external` and `@smaltdb/parquet`, and smaltdf `@smaltdb/df`; none of those has been
published.

## Decision

### 1. What moves to smaltql

- **The SQL language:** the lexer and parser (`src/engine/sql/`), the SQL front end (`src/engine/sql/frontend/`), and
  the AST-level rewrites the front end still applies (flattening and materialized-view matching, `exec/flatten.ts`
  and `exec/mv-match.ts`).
- **SQL's semantics:** the functions the SQL front end selects for SQL's rules (ADR 0014, section 2). Functions that
  any language could use stay in the engine's registries.
- **SQL's tests:** the sqllogictest subset (`npm run slt`), the differential tests against SQLite, and the SQL
  examples in the docs.
- **SQL's documentation:** the SQL reference moves to smaltql. The engine's docs describe the plan layer, storage,
  plugins and the client.

### 2. What stays in smaltdb

The plan layer and its public API, the optimizer and physical planner, operators and code generation, storage (pager,
WAL, B-trees, columnar segments), the VFS, the catalog, the worker runtime and protocol, the client, and the plugin
host. smaltdb's tests keep the plan-shape corpus, the performance invariants, storage and durability tests, and the
browser tests.

### 3. smaltql is a client of the public plan API

smaltql reaches the engine only through the API of ADR 0014 step 9 (builders, the validator, `preparePlan` /
`queryPlan`), the same way smaltdf does. Step 9 is designed with smaltql as its first outside client, so what a full
SQL front end needs (parameters, output names, positions for error messages, `EXPLAIN`) is part of the API rather than
a private shortcut.

### 4. smaltdb ships with smaltql

`@smaltworks/smaltdb` includes smaltql, so `db.query(sql)` and every SQL entry point keep working. The published
worker bundles are built with smaltql in them. smaltql builds against smaltdb's public types, as the plugins do; how
smaltdb takes in smaltql at build time (a pinned build, as `packed.json` does for the plugins today, or a dependency)
is settled in the implementation plan. Versions are released together, so a smaltdb release names one smaltql
version.

### 5. smaltql's language rule

Familiar SQL always works. The dialect follows SQLite today; smaltql may add syntax of its own, but only on top of SQL,
never by changing what working SQL means. A change to the meaning of existing SQL needs a versioned dialect setting
and its own ADR.

### 6. Package names

Every package publishes under the smaltworks npm organisation as `@smaltworks/<repository name>`:

| Repository | Package |
| --- | --- |
| `stenhoor/smaltdb` | `@smaltworks/smaltdb` (entry points as today: `/engine`, `/worker`, `/worker-runtime`) |
| `stenhoor/smaltql` | `@smaltworks/smaltql` |
| `stenhoor/smaltdf` | `@smaltworks/smaltdf` (was `@smaltdb/df`) |
| `stenhoor/smaltdb-io`, `-external`, `-parquet` | `@smaltworks/smaltdb-io`, `@smaltworks/smaltdb-external`, `@smaltworks/smaltdb-parquet` (were `@smaltdb/…`) |
| `stenhoor/smaltui`, `smaltbi`, `smaltkit` | `@smaltworks/<repository>`, when they publish |

- **The old name:** `smaltdb` 0.8.3 stays on npm. When `@smaltworks/smaltdb` first publishes, `smaltdb` is marked
  deprecated with a message naming the new package. Nothing under `@smaltdb` was published, so those names simply
  change.
- **Imports change** from `smaltdb` and `smaltdb/engine` to `@smaltworks/smaltdb` and `@smaltworks/smaltdb/engine`.
  The plugins' peer dependency, `packed.json`, the docs, `CLAUDE.md`, and smaltui and smaltbi follow.

### 7. Distributions

Ready-made distributions are planned: the engine without SQL, the engine with smaltdf, and the engine with both
languages. Each would assemble tested versions of its parts and its own prebuilt workers, with no code of its own.
Their names and packaging are left to a later decision. An engine without SQL needs worker bundles built without the
SQL front end; the prebuilt `dist/` bundles can't be tree-shaken by an application's bundler.

### 8. Order of work

Each step is its own PR, with every test suite green at each step.

1. This ADR.
2. **Package names,** one PR per repository: `@smaltworks/<repository>` in `package.json`, imports, peer dependencies,
   `packed.json` and docs. Before any publish, since nothing has been published under the new or the `@smaltdb` names.
3. **Finish ADR 0014:** step 7d, then step 9, with smaltql's needs (section 3).
4. **The boundary inside this repository:** move `src/engine/sql/` (with the front end and the AST rewrites) into its
   own workspace package that reaches the engine only through the public plan API, and add a check that engine code
   never imports it. The check finds the remaining AST imports listed under Context, which are removed here.
5. **Move it to `stenhoor/smaltql`,** with its tests and SQL docs. smaltdb's CI runs smaltql's suites against each
   engine change, so an engine change can't break SQL unnoticed.
6. **Publish** `@smaltworks/smaltdb` with smaltql in it, `@smaltworks/smaltql`, and the plugins, together.

## Open points for the owner

1. **Release order:** whether 0.9.0 waits for the split (one change of package and structure for users), or 0.9.0
   publishes after step 3 and the split follows.
2. **How smaltdb takes in smaltql** (section 4): a pinned build or a dependency.
3. **How to say it:** smalt-Q-L or smalt-quel (a brand question, recorded in `stenhoor/smalt-brand`).

## Alternatives considered

- **SQL stays in smaltdb, as a language inside smaltdb's brand.** No new repository or package, but SQL stays the
  engine's privileged language and smaltdf a second one. The owner chose full peers.
- **smaltdb without SQL by default.** The cleanest split, but `npm install smaltdb` would no longer give a database
  you can query, and existing users would have to change their setup.
- **Unscoped package names** owned by the organisation (`smaltdb`, `smaltql`). The owner chose the scope, so every
  smaltworks package is recognisable by its name.

## Consequences

- **The engine's work is about execution.** Changes to smaltdb are measured by speed, memory and durability; syntax
  and SQL semantics change in smaltql.
- **The plan API becomes the main contract,** used by two official languages from outside the engine, with the
  versioning ADR 0014 section 4 describes.
- **One more repository and package to release,** in step with smaltdb, and cross-repository CI.
- **Everyone who installs smaltdb changes one name,** from `smaltdb` to `@smaltworks/smaltdb`. SQL keeps working
  unchanged.
- **The brand:** smaltql has its own mark and colour (smalt-brand `BRAND.md`), and smaltdb keeps its tagline and
  positioning line.
