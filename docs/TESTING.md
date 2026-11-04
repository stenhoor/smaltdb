# Testing Strategy

- **Unit tests** for each module (Vitest), run in Node against the in-memory VFS.
- **sqllogictest**: run the SQLite sqllogictest corpus (filtered to the supported subset) and our own `.test` files.
  Differential testing against SQLite (native in Node) checks query results.
- **Browser integration**: Playwright tests that exercise the real OPFS, worker topology, and multi-tab leader failover.
- **Crash/recovery tests**: inject faults in the VFS (torn writes, missing flush, killed worker) and check that
  committed data survives and nothing else does.
- **Fuzzing**: grammar-based SQL fuzzing (SQLancer-style TLP/NoREC oracles for optimizer bugs) and page-level corruption fuzzing.
- **Property tests** for the B+tree, key encoding (order preservation), and record format round trips.
- **Benchmarks** as tests. See [PERFORMANCE.md](PERFORMANCE.md).

## Running the tests

| Command | What it runs |
|---|---|
| `npm test` | Unit, property, and model-based tests in Node (Vitest + fast-check) against `MemoryVfs` |
| `BTREE_SEEDS=200 npm test -- btree` | Longer B+tree stress run: 200 seeds × 6,000 random operations, with reopen-from-storage checks |
| `DIFF_QUERIES=20000 DIFF_DML=3000 npm test -- differential` | Differential testing against SQLite WASM (in Node): random queries and random writes; results and table contents must match |
| `npm run typecheck` | `tsc --noEmit` over `src`, `test`, and `bench` |
| `npm run slt` | sqllogictest subset (122k records) against the engine; see [research/sqllogictest.md](research/sqllogictest.md) |
| `npm run test:browser` | Builds, then runs the OPFS storage test and the client API test (main thread → engine worker → OPFS) in a real browser (Playwright). `BROWSERS=chromium,firefox,webkit` picks the browsers. WebKit runs with a persistent profile, because Playwright's default (ephemeral) WebKit contexts have no OPFS; `PERSISTENT_CONTEXT=1` uses one for every browser |
| `npm run bench` | Storage micro-benchmarks in Node |
| `npm run bench:browser [-- --reps 5 --engines smaltdb,sqlite-off,… or all --baseline sqlite-off --save]` | Repeated, like-for-like engine comparison in a browser, with cross-engine result checks (see [research/benchmark-methodology.md](research/benchmark-methodology.md)). `--save` writes `bench/results/<date>-<browser>-<commit>.json` |

What M0 covers:
- **Key codec:** property tests check that byte order equals a reference model of SQLite value ordering
  (NULL < numbers < text < blob; int64/real mixing near and beyond 2^53; NOCASE/RTRIM; DESC). Round-trip decoding is also tested.
- **Pager:** init and reopen, rejection of non-smaltdb files, commit and rollback, freelist reuse (including trunk overflow),
  eviction under a tiny cache, checksum corruption detection, and flush policy.
- **B+tree:** seeded random put/delete/get sequences compared against a `Map` model. Each pass checks forward and backward scans,
  `checkIntegrity()`, page accounting (header + tree + freelist = file), no leaked pins, and persistence across reopen.
  Also tested: overflow values, oversized-key rejection, rollback, `destroy()`, and `count()`.
- **Browser (OPFS):** create, insert 50k, commit, reopen, verify; exclusive-lock behaviour (a second sync handle is rejected);
  small-commit latency; and capability detection.

What M2 adds:
- **Crash injection** (`test/crash.test.ts`, `test/crash-vfs.ts`). Every write, truncate, and flush to the database and WAL
  files is logged. Storage is rebuilt at every crash point under three models: prefix, torn last write, and lost unflushed writes.
  Each image is reopened and must pass `integrity_check` and equal a committed state. Run more seeds with
  `CRASH_SEEDS=20 npm test -- crash`. A control test shows the no-WAL mode corrupts.
- **Savepoints:** nested `SAVEPOINT` / `RELEASE` / `ROLLBACK TO`, DDL inside savepoints, and WAL pragmas.
- **Read-ahead:** prefetched pages are served without extra reads, and corruption in a prefetched page is still detected on use.

What M1 adds:
- **Differential testing vs SQLite** (`test/differential.test.ts`). Random typed expressions run through filters, LEFT and inner joins,
  GROUP BY / HAVING / aggregates, IN / EXISTS / scalar subqueries, compound selects, derived tables, and fully ordered
  `LIMIT` / `OFFSET` queries. Results are compared as multisets, or as exact sequences when fully ordered. Random
  INSERT / UPDATE / DELETE statements, including constraint violations and `OR IGNORE` / `OR REPLACE`, are compared table-for-table
  after every statement, ending with `PRAGMA integrity_check`. A default run covers about 3,000 queries and about 1,800 writes; it has
  been run at 15,000 queries and 6,000 writes.
- **Parser tests** (126): precedence, literals, parameters, spans, every statement form, and error messages.
- **Statement savepoints:** model-based tests that interleave statement and transaction commits and rollbacks.
- **Record format:** property tests for round trips and for rowid key ordering.
- **SQL smoke tests:** constraints, transactions, persistence, `EXPLAIN QUERY PLAN`.

## Plan shapes

`test/plan-shapes.test.ts` is a golden corpus of physical plans ([ADR 0014](adr/0014-shared-plan-layer.md), step 2).
Over a fixed database (row tables with indexes, a columnar table, views, materialized views, statistics), it renders
each query's operator tree with every operator's class, `EXPLAIN` detail and row estimate. It also records the plans of
subqueries inside expressions and the result columns, and compares all of it with `test/plan-shapes/*.txt`. The
queries cover access paths, join orders and methods, aggregates, ordering and top-N, subqueries and decorrelation, views
and materialized-view matching, columnar scans, windows and compound selects.

A planner change that alters a plan fails the test. When the change is intended, update the files with
`npx vitest run test/plan-shapes.test.ts -u` and review the diff with the PR. The corpus describes the default
configuration, so it skips under `SMALT_NO_CODEGEN`, `SMALT_NO_FLATTEN` and `SMALT_NO_DECORRELATE`.
## Generated code

`test/codegen-source.test.ts` records the JavaScript that code generation emits (expressions, fused pipelines over
row and columnar tables, row loaders) for a corpus of queries over typed tables, and compares it with
`test/codegen-source/*.txt`. Generated code carries the performance of [ADR 0003](adr/0003-m1-executor-and-transactions.md),
and the plan layer ([ADR 0014](adr/0014-shared-plan-layer.md)) moves code generation onto plan expressions, so a change
to it must show in review: update the files with `npx vitest run test/codegen-source.test.ts -u`. It skips under
`SMALT_NO_CODEGEN`.

## The SQL front end and the physical planner (`SMALT_PLAN`)

While the plan layer ([ADR 0014](adr/0014-shared-plan-layer.md)) is built, `SMALT_PLAN` selects how SELECTs are
planned (`src/engine/exec/plan-shadow.ts`):

- unset or `plan` (the default): the SQL front end (`src/engine/sql/frontend/`, step 5) makes a plan, and the physical planner
  (`Planner.planPlan`, step 6) builds its operators.
- `legacy`: the planner's AST path for every SELECT, until it is deleted after step 8.
- `shadow` (tests): both. The front end must agree with the planner on every result column's name, type, collation,
  declared type and affinity, and on planning errors; the physical planner's operators must give the planner's
  `EXPLAIN` rows and record the same subplans (subqueries), and then they run. A disagreement fails the statement
  with `SMALT_INTERNAL`. Statements answered from materialized views are compared too, and so are writes that go
  through the plan layer (DELETE): their target scan's `EXPLAIN` rows, subplans, RETURNING columns and errors.

CI runs the whole suite in the default mode and with `SMALT_PLAN=shadow`, and `test/plan-shapes.test.ts` and
`test/codegen-source.test.ts` also with `SMALT_PLAN=legacy`: both paths give the same plan shapes and generated code
(shadow mode generates code for both planners, so the generated-code snapshot skips there). Run `npm run slt` or the
differential tests the same way.
`SMALT_PLAN_STATS=<file>` appends each skipped statement to `<file>` as a JSON line with the reason, and each
statement the physical planner does not handle yet (reason `physical planner: not handled yet`).
`test/plan-physical.test.ts` checks the physical planner's shapes in each mode.

## Plugins

The plugins live in their own repositories ([ADR 0012](adr/0012-plugins.md)): `stenhoor/smaltdb-io`,
`stenhoor/smaltdb-external` and `stenhoor/smaltdb-parquet`, each with its own tests (the Parquet fixtures written by
pyarrow are in `smaltdb-parquet`). This repository tests the plugin interface with plugins defined in
`test/plugins.test.ts`. The docs examples and the browser tests also use `@smaltdb/io` and `@smaltdb/external`:
- `packed.json` pins them to commits of their repositories.
- `npm run deps` (`scripts/fetch-packed.mjs`) builds those commits and installs them with `npm install --no-save`.
  Run it after every `npm ci` or `npm install`; `npm test` and `npm run typecheck` stop with a message when they are
  missing.
- To test against an unmerged plugin change, run `node scripts/fetch-packed.mjs --local @smaltdb/io=../smaltdb-io`.

## Documentation examples

`test/docs-examples.test.ts` keeps the user documentation (`docs/guide`, `docs/reference`) honest:
- Every `sql` block runs. A page runs top to bottom on one fresh in-memory database, and the files in `docs/examples/`
  are registered as `file:<name>`.
- A Markdown table directly after a `sql` block is the expected result of the block's last statement. The header row
  is the column names, `NULL` is NULL, blobs are `x'hex'`, and numbers print as JavaScript does (REAL 2.0 is `2`).
- Every `ts` block is type-checked against the public API: `smaltdb` and `smaltdb/engine` resolve to `src/`, and the
  plugins to their installed packages. `db` is predeclared as a client `Database` unless the block declares its own.
- Markers go in an HTML comment on the line before a block:
  - `<!-- docs:skip -->`: the block is not run, e.g. a URL or S3 example.
  - `<!-- docs:error SMALT_CODE -->`: the block's last statement must fail with this code.
  - `<!-- docs:unordered -->`: compare the rows in any order.
  - `<!-- docs:setup SQL -->`: hidden SQL that runs before the block.
  - `<!-- docs:plugin @smaltdb/parquet -->`: the block needs Parquet, which this repository doesn't install. It is
    skipped here; `smaltdb-parquet` runs every page with such a block, top to bottom with all plugins, against the
    docs at the smaltdb commit it pins. Mark later blocks that use what a marked block created, too.

## Timing in tests

Tests must not depend on scheduling luck. CI runners are slower and busier than a development machine, and several
"flaky" failures came from tests that slept a fixed time and then asserted.
- **Waiting for something to happen:** poll for the exact response being checked, with `until(what, done)` from
  `test/helpers/wait.ts`. It polls every 5 ms and fails after a deadline, naming what never arrived, so a real
  deadlock still fails clearly.
- **Checking that something has *not* happened** (a request still waiting): `pause()` is fine. Extra load can only
  keep such a check passing, never make it flake.
- **Routing to parallel readers or morsels** depends on message timing between page and worker. A browser test that
  needs a query to run on a reader detects where it actually ran (`db.stats.readerQueries` / `morselQueries`, with a
  concurrent request that always stays on the owner, such as a PRAGMA) and retries, instead of assuming it.
