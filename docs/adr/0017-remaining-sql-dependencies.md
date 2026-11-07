# ADR 0017: The remaining SQL dependencies in the engine, client and plugins

- **Status:** proposed
- **Date:** 2026-11-07
- **Builds on:** [ADR 0015](0015-smaltql.md) (the engine carries no language), [ADR 0016](0016-plan-api-for-every-language.md)
  (the plan API for every language)

## Context

ADR 0015 made SQL smaltql's: the engine carries no language, and every language reaches it through plans. ADR 0016
checked the plan API against what a second language needs, by running doubtful points with no language registered.
Neither found the dependencies below, for two reasons:

- **The boundary test checks imports only.** `test/boundary.test.ts` fails if a source file imports smaltql. Code that
  writes SQL text, runs it, or assumes SQL is the language passes it.
- **The probes covered statements, not the rest of the engine.** ADR 0016's runs exercised queries, writes and schema
  statements given as plans. They did not cover the client's transactions, work the engine starts itself (scheduled
  refreshes), ALTER TABLE once the engine's own tables exist, parallel readers, or plugins.

A report that materialized views break without smaltql started this review. The review was done twice on `main`
(`b74c6dd`): by reading every path that names SQL or runs text, then by running the engine's features through plans in
the test harness with no SQL language registered, in process and through the client and worker server.

### What works without SQL

Tables (with keys, CHECK, DEFAULT, foreign keys with cascades), columnar tables and `compact`, indexes, TEMP tables,
writes with RETURNING, transactions as plans in process, settings, ANALYZE, EXPLAIN, `pragma_table_info`,
`information_schema`, `sqlite_schema`, the catalog, views and materialized views (create, read, refresh, columnar and
memory storage, rewriting queries from them), ALTER TABLE ADD COLUMN, reopening a file, and through the client: open,
`queryPlan`, `preparePlan`, `streamPlan`, `catalog()`.

### What depends on SQL

| # | Dependency | Where | Effect without smaltql |
|---|---|---|---|
| 1 | The client's `transaction()` begins with the SQL text `BEGIN` | `src/client/index.ts` (`runTransaction`) | A transaction of plans fails: "this is written in sql, which is not registered" |
| 2 | Scheduled refreshes (`refresh_every`, `refresh_on_reconnect`) are queued as the SQL text `REFRESH MATERIALIZED VIEW … IF CHANGED` | `src/engine/server.ts` (`queueRefresh`) | Every scheduled refresh fails; the error shows only in `information_schema.materialized_views.last_refresh_error` |
| 3 | `REFRESH … IF CHANGED` checks its view's sources only for statements given as SQL text | `src/engine/database.ts` (`runExternal`, called from `execAsync` / `queryAsync`) | The same refresh as a plan fails with `SMALT_ASYNC_REQUIRED`, also through `queryPlanAsync` |
| 4 | The engine writes SQL text for its own tables: system tables (`systemTableSql`, `systemTableOp`) and materialized views' storage layouts (`layoutSql`) | `src/engine/catalog/stored.ts`, `src/engine/database.ts` | ALTER TABLE RENAME (table or column) edits every catalog row's text with its language's editor; system tables have no definition, so the editor defaults to SQL's: "ALTER TABLE needs the sql language" once ANALYZE, a columnar table or a materialized view has created one |
| 5 | Parallel aggregates (morsels on reader workers) run only for SQL text | `src/engine/server.ts` (`toMorsels`), `src/engine/database.ts` (`morselQuery` parses SQL) | Plans run, without the speed-up |
| 6 | External tables report their source language as `sql`, whichever language created them | `src/engine/catalog/logical.ts` (`describeExternal`) | The catalog is wrong for other languages |
| 7 | `@smaltdb/io` builds SQL text: `importCSV` / `importJSON` write `CREATE TABLE` and `INSERT`, and `exportCSV` / `exportJSON` take a SQL query | `stenhoor/smaltdb-io` (`ctx.query(sql)`, `db.exec`, `db.prepare`) | Import and export fail without smaltql |

A stale comment says a view's refresh policy is "parsed from `sql`": it is read from the view's stored options
(`src/engine/catalog/schema.ts`, `matviewPolicy`).

### Not dependencies

These name or serve SQL, and stay as they are:

- **The text API:** `exec`, `query`, `prepare`, `run` and their async forms, and the worker requests `exec`, `query`
  and `prepare`, take SQL text by design: SQL is the language that has text. Without smaltql they fail with a clear
  error. A language's own text API is its own.
- **Names from SQLite:** `sqlite_schema`, settings named as SQLite's pragmas, and the `sql.*` function aliases, which go
  once smaltql uses the behaviour names (ADR 0016 section 1).
- **SQLite's semantics as engine functions** (the `cmp_*`, `cast_*`, `affinity_*` operations): engine functions any
  language may call (ADR 0014 section 2).
- **Stored definitions without a `language`** mean SQL: the format's default for objects whose source is SQL text.
  Objects with another language, or none (ADR 0016 section 6), record it.
- **The plugin API's `query(sql)`:** part of plugin API v1, which only grows (ADR 0013). It stays for plugins that run
  SQL; plugins that must work without SQL use `queryPlan`.

## Decision

1. **Transactions:** the client begins a transaction with the plan statement `{ kind: 'transaction', action: 'begin' }`,
   as it already ends one with `endTransaction`.
2. **Scheduled refreshes:** the server queues the refresh as a plan statement (`{ kind: 'maintenance', action:
   'refresh', ifChanged: true }`), not as text.
3. **`IF CHANGED` for every statement:** the check of a view's sources moves to where statements of any kind run
   asynchronously (`queryPlanAsync`, the server's plan requests), so a refresh given as a plan checks its sources as a
   SQL one does.
4. **The engine's own tables carry no SQL text:** system tables and storage layouts are defined without source text
   (ADR 0016 section 6), so the catalog shows their description, and ALTER TABLE never edits them with a language.
   Existing files keep their stored text: ALTER TABLE leaves system tables' rows unedited, whatever text they hold. No
   file-format change.
5. **Parallel aggregates for plans:** the server sends plan queries to `planMorsels` as it does SQL ones; the morsel
   path takes the statement's plan, not its text.
6. **External tables** record the language that created them, or none, as other objects do.
7. **`@smaltdb/io` without SQL:** import builds its writes as plans (a schema operation without source text, and
   `append` over values from columns); export accepts a plan statement beside the SQL forms, which stay for SQL users.
   This is a change in `stenhoor/smaltdb-io`.
8. **A guard that runs the engine without SQL:** a test project with no language registered (its own vitest
   configuration, without `test/setup-sql.ts`), run in CI. It covers what this record's review ran and the items above:
   the engine through plans, the client and worker server, scheduled refreshes, ALTER TABLE after system tables exist,
   parallel readers, and the plugins pinned in `packed.json`. The boundary test also keeps a list of the places that may
   reach SQL (the text API), and fails when another one appears.

## Order of work

Each step is one PR into `main`, opened after the one before it has merged: no PR depends on an unmerged one.

1. **This ADR.**
2. **smaltdb:** decisions 1–6 and 8, with the stale comment fixed. Gates: `npm run check`, `SMALT_NO_CODEGEN=1`,
   `SMALT_PLAN_ROUNDTRIP=1`, the new no-SQL project, the browser tests (client and worker change), and smaltql's suite
   and `npm run slt` against the change, since `sqlite_schema` shows new text for system tables.
3. **smaltdb-io:** decision 7, pinned to step 2's `main`; then smaltdb's `packed.json` pins it, and the no-SQL project
   runs its import and export.
4. **smaltql:** pin smaltdb to step 2's `main`, updating any test or docs example that prints the system tables' text.
5. **Re-review**, after steps 2–4 have merged, by a method that does not reuse this record's list:
   - Repeat the review from the start on the new `main`: read every path that names SQL, runs text, or defaults a
     language, in smaltdb, its client and worker, and the plugins.
   - Have a reviewer who has not seen this record's findings look for the same thing, given only the goal ("find any
     code in the engine, client, worker or plugins that depends on SQL or smaltql").
   - Run the no-SQL project and the probes again.
   - Record the result here (status, evidence, anything found). Anything found is fixed before this record is marked
     done.

## Consequences

- **The engine, client and pinned plugins work with no SQL registered,** and CI keeps it so: a dependency like these
  fails a test rather than waiting for a report.
- **`sqlite_schema` shows the engine's description** for system tables in new files, not a `CREATE TABLE` statement.
- **Plugin API v1 is unchanged;** `@smaltdb/io` gains plan-based export alongside its SQL forms.
- **ADR 0016's no-language check was narrower than it read:** this record's re-review step is the check it should have
  had.
