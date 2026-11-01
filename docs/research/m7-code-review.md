# M7 code review (2026-11-01)

This is a maximum-effort review of the M7 code: `git diff c7cefe3..HEAD -- src test`, about 3.5k lines. It covers the
memory store and TEMP tables, spilling, columnar base tables, morsel parallelism and materialized-view matching
(ADR 0010).

**Method.** Ten independent finder passes, then a verification pass and a gap sweep:
- *Finder passes:* line-by-line (twice), removed behavior, cross-file callers, language and SQL-semantics pitfalls,
  wrapper correctness, reuse, simplification, efficiency, altitude and conventions.
- *Verification:* each candidate not already reproduced by its finder got a verifier that tried to reproduce it
  against the real engine. Reproductions used MemoryVfs file databases and the Node server harness; none changed
  the repository.
- *Gap sweep:* a final pass looked only for defects not yet on the list.

There is no CLAUDE.md, so no conventions findings were possible.

**Status:** all 25 confirmed defects (S1, S2, S3) are fixed, each with regression tests (`test/s1-regressions.test.ts`, `test/s2-regressions.test.ts`, `test/s3-regressions.test.ts`); the performance and cleanup items are open. Each item below records how it was reproduced and the suggested direction. Severity:
**S1** corrupts data or returns wrong results silently; **S2** wrong results or errors in specific shapes; **S3**
lifecycle, robustness and edge cases; **P** performance; **C** cleanup.

## Confirmed defects

### S1: data corruption and silent wrong results

1. **Fixed. A re-run INSERT on a columnar table reuses rowids after compaction.**
   - *Where:* `exec/columnar-table.ts:143` and `database.ts:2614`.
   - *Cause:* `ColumnarTableWriter` caches `segMax` (and its `ColumnStore`) forever. The INSERT program keeps one
     writer across executions (`writer ??= this.writerFor(table)`). Compaction (`appendDelta`) does not bump the
     schema version, and `resetStatement` is not overridden.
   - *Repro:* run `prepare('INSERT INTO c VALUES (?)')` 8200 times on an empty columnar table.
     `count(*) = 8200` but `count(DISTINCT rowid) = 8192`. An explicit INSERT of an id already in the segments is
     also accepted.
   - *After a rollback:* `dropColumnarCaches()` leaves the writer holding the old `ColumnStore` object.
   - *Fix (done):* `ColumnarTableWriter.resetStatement()` clears `segMax` and re-reads the table's current segment
     reader each execution.
2. **Fixed. A failed `CREATE UNIQUE INDEX` on a TEMP table corrupts it.**
   - *Where:* `database.ts:1862`.
   - *Cause:* the index is registered (`table.indexes.push`, `this.indexes.set`) before `checkUniqueIndex`. For TEMP
     tables `dirtySchema` is false, and `memDirty` is set only after the check. When the check fails, the pages roll
     back but the phantom index stays.
   - *Repro:* `CREATE TEMP TABLE tt(x); INSERT INTO tt VALUES (1),(1); CREATE UNIQUE INDEX ui ON tt(x)` fails, as it
     should. Afterwards every `INSERT INTO tt` and `PRAGMA integrity_check` fails with "page 2 out of range", and
     `ui` is still listed. This also happens on `:memory:` databases, where `memBefore` is null.
   - *Fix (done):* temp index creation sets `memDirty` before changing state, and every write statement now takes a
     memory snapshot (a shared empty one when there are no memory objects), so `:memory:` databases restore too.
3. **Fixed. Morsel and MV merges accept aggregates they cannot merge.**
   - *Where:* `exec/morsel.ts:173`, also reached through `mv-match.ts` `rollUp`.
   - *Cause:* only bare-column arguments of non-mergeable aggregates are rejected.
     `group_concat`/`string_agg`/`json_group_*`/user aggregates over constants or GROUP BY keys are copied into the
     merge query and aggregated over partial rows.
   - *Repro:* `SELECT g, length(group_concat('x','')) FROM t GROUP BY g` (1000 rows) gives `[[0,500],[1,500]]`
     normally and `[[0,4],[1,4]]` through `queryMorsels`.
   - *Fix (done):* any aggregate call outside the mergeable set rejects the query, using the planner's
     `isAggregateCall`, which the view matcher now also uses instead of its own list.
4. **Fixed. Materialized views stay "fresh" when they are not.**
   - *Where:* `database.ts:1645` (`touchTable`) and `:1619` (`selectDeps`).
   - *Cause:* freshness tracks base tables by name, with dependencies cached in `m.deps ??=`. With
     `matview_rewrite = 1` this gives stale or unrelated answers.
   - *Repros:*
     - `DROP TABLE t; CREATE TABLE t(x)`: `SELECT count(*) FROM t` returns the old count 3 instead of 0. The same
       happens with `ALTER TABLE u RENAME TO t`.
     - Redefining a plain view the MV reads, once its dependencies are cached, leaves the MV fresh, and writes to
       the new base table never make it stale.
     - `WITH t AS (SELECT * FROM t WHERE …) SELECT … FROM t` gets empty dependencies (CTE names are hidden
       globally, including inside the CTE body), so inserts never make it stale.
     - A TEMP table shadowing `t` is answered from the main table's MV.
   - *Fix (done):*
     - DROP TABLE, ALTER (including RENAME onto the name), CREATE and DROP VIEW and DROP MATERIALIZED VIEW mark
       dependent views stale and clear cached dependencies.
     - Dependencies now include view names, and CTE names are scoped (visible in their own body only when
       RECURSIVE).
     - View rewrite skips any view whose dependencies a TEMP table or view shadows.
5. **Fixed. `main.`-qualified statements reach a shadowing TEMP table.**
   - *Where:* `database.ts:2398` (`targetTable`) and `:2086` (DROP TABLE).
   - *Repro:* main `t` with 2 rows, then `CREATE TEMP TABLE t`, then `DROP TABLE main.t`. This destroys the temp
     table's trees but the main table's catalog row. Main `t` is gone, and `integrity_check` reports
     `2 in use + 0 free != 3 total` permanently.
   - *Also:* `INSERT INTO main.t` writes into the temp table.
   - *Fix (done):*
     - Shadowed main tables are kept in a `shadowedMain` map, and `getTable(name, schema)` resolves `main.` and
       `temp.` against the right one.
     - The planner (FROM items, the `count(*)` shortcut, decorrelation) and DML targets pass the schema through.
     - DROP TABLE removes the right entry, and its foreign-key cascade names `main.`.
     - Scans carry their table, so a fused scan never re-resolves it by name.

### S2: wrong results or errors in specific shapes

6. **Fixed. The server's morsel path breaks request scheduling.**
   - *Where:* `server.ts:398` (`toMorsels` `finish`).
   - *Deadlock:* a local query with a finite credit, while another session runs BEGIN and then INSERT. The query
     receives only `columns`, and the INSERT never answers: the stream waits for `allowed()`, and the INSERT waits
     for `streams.length === 0`.
   - *Rejected write:* a write pipelined after the same session's own morsel query fails with `SMALT_BUSY` "query
     cursor is open". Before M7 it succeeded.
   - *Closed database:* after `close`, `finish()` still merges and streams from the closed `Database`.
   - *Fix:*
     - start the merged stream only when its session is allowed (queue it otherwise);
     - let the requesting session's own writes wait (or treat its morsel job like its own stream);
     - cancel pending morsel jobs on close, and check `this.db === db` in `finish`;
     - use a read-hold counter instead of a fake `RowCursor`.
   - *Fix (done):* Merged morsel results are precomputed rows that hold no reads, so writers don't wait for their client. A write during pending morsel work waits in the queue, the requesting session's own included. A reader failure re-queues the query to run normally on the owner, under the usual scheduling. Close fails pending morsel queries, and `finish()` never answers from a closed database.
7. **Fixed. min/max merges ignore column collation.**
   - *Where:* `exec/morsel.ts:163`.
   - *Repro:* `ci TEXT COLLATE NOCASE` holding `'b','a','B','C'`. `SELECT min(ci), max(ci)` gives `['a','C']`
     normally and `['B','b']` through morsels. The MV roll-up has the same bug.
   - *Fix:* reject non-BINARY `min`/`max` arguments, or carry the collation into the merge.
   - *Fix (done):* a min/max argument compared with a non-BINARY collation declines the split.
8. **Fixed. An MV roll-up `count` returns NULL instead of 0 when no view rows match.**
   - *Where:* `exec/mv-match.ts:151`.
   - *Cause:* an ungrouped query merges `count` as `sum` over the view's group rows, which are zero when nothing
     matches.
   - *Repro:* `SELECT count(*) FROM t WHERE g = 999` returns `[[null]]`. An empty base table gives the same.
   - *Fix:* merge `count` as `coalesce(sum(n), 0)`, or `total(n)` cast to integer.
   - *Fix (done):* `count` merges as `coalesce(sum(n), 0)`.
9. **Fixed. The morsel range filter binds to a user column named `rowid`.**
   - *Where:* `exec/morsel.ts:249`.
   - *Cause:* the filter uses a column reference named `rowid`, while `rowidBounds` splits by true B+tree rowids.
   - *Repro:* `CREATE TABLE t(rowid INT, v INT)` with user `rowid` values outside the true range.
     `sum(v), count(*)` gives `[[500500,1000]]` normally and `[[null,0]]` through morsels. The same happens with
     columnar tables and columnar views.
   - *Fix:* refuse morsels when a column is named `rowid`, `_rowid_` or `oid`, or filter on an internal rowid
     reference.
   - *Fix (done):* the range filter uses the first of `rowid` / `_rowid_` / `oid` that no user column takes, and declines when all three are taken.
10. **Fixed. The morsel merge loses REAL typing.**
    - *Where:* `database.ts:560`.
    - *Cause:* `smalt_partials` columns are typed `any`.
    - *Repro:* `x REAL` holding `2.0, 4.0, …`. `typeof(max(x))` and `min(x) || ''` give `real`/`2.0` normally and
      `integer`/`2` through morsels.
    - *Fix:* type the partial columns from the partial query's output types.
   - *Fix (done):* `smalt_partials()` columns are typed from the partial query's output types.
11. **Fixed. A HAVING alias that matches a table column breaks morsel queries.**
    - *Where:* `exec/morsel.ts:171`.
    - *Repro:* `SELECT g, sum(a) AS a FROM t GROUP BY g HAVING a > 5` works normally but fails through morsels with
      "misuse of aggregate function sum()".
    - *Fix:* resolve HAVING names the way the planner does (table column first), or decline when an alias shadows
      a column.
   - *Fix (done):* in HAVING, a table column takes precedence over an output alias, as the planner resolves it; the query then declines.
12. **Fixed. Rewriting a query to an MV breaks `t.*` and renames `SELECT *` columns.**
    - *Where:* `exec/mv-match.ts` `project`.
    - *Repros:*
      - `SELECT t.* FROM t` fails with "no such table: t": the star's qualifier is not normalized.
      - `SELECT * FROM t` against `CREATE MATERIALIZED VIEW mv(x, y) AS SELECT * FROM t` returns columns `x, y`
        instead of `a, b`.
   - *Fix (done):* `*` and `t.*` are spelled out from the view's columns under the base table's names (`MatviewCandidate.baseColumns`), which also fixes column mapping for renamed `SELECT *` views.
13. **Fixed. ALTER TABLE on a TEMP table does nothing, or rewrites the main table.**
    - *Where:* `database.ts:2146`.
    - *Repros:*
      - `ALTER TABLE tmp ADD COLUMN y DEFAULT 3` succeeds without effect.
      - With main `t` and TEMP `t(a,b)`, `ALTER TABLE t ADD COLUMN c` writes `a,b,c` into main `t`'s catalog row
        over records shaped `(a)`.
    - *Fix:* support ALTER for temp tables in memory, or reject it.
   - *Fix (done):* ALTER resolves `main.` / `temp.` and rejects TEMP tables (`SMALT_UNSUPPORTED`). `ALTER TABLE main.t` alters a shadowed main table.
14. **Fixed. Persistent views and MVs may read TEMP tables.**
    - *Where:* `database.ts:986` (`createMatview`) and `createView`.
    - *Repro:* `CREATE MATERIALIZED VIEW m AS SELECT x FROM tt` (`tt` is TEMP) persists this connection's private
      rows to the file, visible to readers and other tabs. After reopen, `REFRESH` fails with "no such table: tt".
    - *Fix:* reject persistent objects with temp dependencies (SQLite makes such views TEMP, or rejects them when
      `main` is explicit).
   - *Fix (done):* a materialized view over a TEMP object is rejected. A plain view over one becomes a TEMP view, as in SQLite, or is rejected when written `main.`.
15. **Fixed. TEMP views are not treated as connection-local.**
    - *Where:* `database.ts:298` (`usesMemoryObjects`).
    - *Repro:* `CREATE TEMP VIEW tv AS SELECT * FROM t`, then `SELECT * FROM tv`. It can be routed to a parallel
      reader, which fails with "no such table: tv".
   - *Fix (done):* TEMP views count as connection-local.
16. **Fixed. ANALYZE includes TEMP tables.**
    - *Where:* `database.ts:1664`.
    - *Effect:* their statistics are written into `smalt_stat` in the file and survive reopen. A TEMP `t` shadowing
      main `t` overwrites main `t`'s statistics, with the wrong column count.
   - *Fix (done):* ANALYZE skips TEMP tables, includes shadowed main tables, and loads statistics onto main tables only.
17. **Fixed. A TEMP table hides the main table from information_schema.**
    - *Where:* `catalog/information-schema.ts:56` and `database.ts:587`.
    - *Repro:* with main `t` and TEMP `t`, `information_schema.tables` and `.columns` lose main `t` entirely.
   - *Fix (done):* `information_schema` includes shadowed main tables.
18. **Fixed. A columnar table wraps past the maximum rowid.**
    - *Where:* `exec/columnar-table.ts:146`.
    - *Cause:* there is no `I64_MAX` check, unlike `TableWriter.newRowid`.
    - *Repro:* with segments holding 9223372036854775807, an INSERT succeeds with rowid 2^63, which reads back as
      -9223372036854775808. A row table raises `SMALT_FULL`.
   - *Fix (done):* `SMALT_FULL` past the maximum rowid, as for row tables.
19. **Fixed. TEMP and main indexes can share a name.**
    - *Where:* `database.ts` `createIndex` and `loadSchema`.
    - *Cause:* `checkNewName` checks only the persisted catalog, so a main index may reuse a TEMP index's name.
    - *Effect:* depending on whether the schema was reloaded, `DROP INDEX i` drops one of the two, and the other can
      then never be dropped.
   - *Fix (done):* main indexes share one namespace with TEMP indexes.

**Found while fixing S2** (fixed in the same change):
- *View flattening:* `flatten.ts` re-emitted a view's base tables as `main.<name>`. Since the S1 schema fix, that made
  views and subqueries over TEMP tables fail with "no such table: main.x". It now uses the resolved table's own
  schema.
- *Integrity check:* `PRAGMA integrity_check` skipped main tables shadowed by a TEMP table, so their pages looked
  leaked ("page accounting"). Shadowed main tables are now checked.
- *HAVING alias of an aggregate (open):* `SELECT g, sum(a) AS s FROM t GROUP BY g HAVING s > 100` fails with "misuse
  of aggregate function sum()", also on the normal path. This is an older planner gap, not an M7 bug; SQLite accepts
  it.

### S3: lifecycle, robustness and edge cases

20. **Fixed. Reopening a database with memory views leaves writes uncommitted in the main pager.**
    - *Where:* `database.ts:228`.
    - *Cause:* `rebuildMemoryViews` runs outside a transaction. `fillMatview` calls `touchTable`, which writes
      `smalt_matview` and bumps the cookie on the main pager when a file MV depends on a memory MV, but only the
      memory pager is committed.
    - *Effect:* after open, `pager.inTransaction` is true. The next failing write silently discards that metadata,
      the next successful write commits it, and `checkpoint()` throws while the WAL is non-empty.
    - *Ordering:* views rebuild in catalog order, so after DROP and re-CREATE of a base memory view, a memory view
      over it stays unpopulated after reopen.
   - *Fix (done):* the rebuild at open runs in dependency order (a memory view over pending memory views waits for them) and marks nothing stale. It recomputes the same rows from the same committed data, so the main file is not written and `pager.inTransaction` stays false.
21. **Fixed. A re-opened fused GROUP BY can leak a spill hold.**
    - *Where:* `exec/operators.ts:2350`.
    - *Cause:* `FusedGroupAggregate.open` resets `delegated` without closing the fallback `HashAggregate`.
    - *Trigger:* a correlated derived table on the inner side of a nested loop, where one re-open spills and the
      next does not. Reproduced only with a non-deterministic filter (`random()`).
    - *Effect:* the `-spill` file is never truncated and keeps growing.
    - *Fix:* close the fallback first in `open()`.
   - *Fix (done):* `open()` closes a fallback still delegated from the previous open.
22. **Fixed. The multi-pass external sort is not stable.**
    - *Where:* `exec/operators.ts` (Sort merge passes).
    - *Cause:* with more than 64 runs, the merged run holding the earliest input is appended after later runs, so
      ties favor later input. The code comment claims stability.
    - *Fix:* replace the merged group at the front of `runs`, not the end.
   - *Fix (done):* merge passes replace each group of runs in place, keeping input order.
23. **Fixed. Two writer handles on one VFS without locking share the scratch file.**
    - *Where:* `database.ts:245`, `exec/spill.ts`.
    - *Effect:* the second handle truncates the shared `db-spill` file, and the first fails with "spill file: short
      read". This is not reachable with OPFS: exclusive handles make the second spill open fall back to no spilling.
   - *Fix (done):* scratch file names are registered per VFS. A second handle (or a worker whose exclusive OPFS open fails) takes `<db>-spill-2`, `-3`, … and the name is freed on close.
24. **Fixed. `Database.close()` never closes the memory pager.** Only cleanup is affected: memory is reclaimed by the
    garbage collector.
   - *Fix (done):* `close()` closes the memory pager.
25. **Fixed. The two-pager transaction facade has no compensation.**
    - *Where:* `database.ts:352–391`.
    - *Risk:* if the main pager commits and the auto-checkpoint after it throws, the memory pager never commits.
      This was not reproduced; it is an ordering hazard.
   - *Fix (done):* the automatic checkpoint after a WAL commit is best-effort (counted in `stats.failedCheckpoints`, retried at the next commit and on close). A committed transaction no longer surfaces as an error, and the memory store's commit always follows the main one.

## Refuted on verification

- **Re-run INSERTs keep a refreshed MV fresh.** Refuted: REFRESH bumps the schema version, so the INSERT recompiles
  with a new writer.
- **Mixed number and bigint rowids in one row group are missed.** Refuted: a bigint forces the generic chunk
  encoding without `numMax`, so lookups scan.
- **Bigint rowids break generated code ("Cannot mix BigInt").** Not reproducible: fused aggregates matched a row
  table both with and without codegen.

## Performance

Status: all eight items are addressed. Measured with `npx tsx bench/micro/m7-perf.ts` (Node, file database on
MemoryVfs, median of 5). Invariant tests are in `test/perf-invariants.test.ts`.

| Issue | Fix | Before | After |
|---|---|---|---|
| Every write statement to a columnar table runs `count()` over the delta and deletion trees | Exact running counts kept by the writer (dropped on rollback, recounted when missing) | 8000 single-row INSERTs: 354 ms | 309 ms (a row table takes 282–309 ms: the rest is the per-statement WAL commit) |
| UPDATE and DELETE of segment rows run `locateInSegments` with a linear rowid search | Binary search in row groups whose rowids ascend (normal after compaction; checked once per chunk) | UPDATE / DELETE 5k segment rows: 56.7 / 42.6 ms | 42.4 / 30.8 ms |
| Every columnar scan rebuilds the deleted-rowid `Set` and the per-row-group bitmaps | Set cached per table, keyed by commit counter, local deletion version and deletion root. Bitmaps cached per set; row groups whose rowid range holds no deletion are skipped | GROUP BY / selective filter with 5k deletions: 14.5 / 0.91 ms | 5.3 / 0.31 ms |
| `snapshotMem()` runs before every write statement | Already reduced in the S1 fixes: a shared empty snapshot when there are no memory objects | — | — |
| `rowBytes` computed for every sorted row | Sampled every 16th row | Sort 300k rows: 328 ms | 322 ms (the accounting was a small share) |
| `touchTable` loops over all tables on every DML writer | Loops over a per-schema-version list of materialized views only. (Marking a view stale still recompiles cached statements once per refresh cycle; left as is.) | 5000 INSERT + UPDATE with 20 tables: 62.7 ms | 62.4 ms (the loop was a small share) |
| `usesMemoryObjects` walks the AST per request; `morselQuery` cache-clears at 64 entries; merge statements compiled per run | Memoized per statement and schema version. The morsel cache is an LRU. Partial column types and the merge statement are compiled once per query text and schema; `smalt_partials()` reads the current rows at run time | 20000 checks with a TEMP table present: 25.2 ms | 0.04 ms |
| TEMP-table growth never triggers re-planning | Statements re-check row assumptions when the memory pager's commit counter moves too (`Database.changeStamp`) | Plan kept after a TEMP table grew 1→20000 rows | Re-planned |

## Cleanup

Status: done, except two items kept on purpose and two that are behavior changes (follow-up features). Behavior is
unchanged: all suites pass, and `bench/micro/m7-perf.ts` plus an interpreted GROUP BY benchmark show no regression.

- **Reuse:**
  - *AST helpers:* a new `sql/ast-util.ts` holds `exprKey`, `anyNode`, `and` and `andAll`.
    - `mv-match.ts` uses `conjuncts` from `expr.ts`, the shared `andAll` and `anyNode`, and the planner's
      `isAggregateCall`; its own copies are gone.
    - `flatten.ts` uses the shared `and` and `anyNode`, keeping its behavior of not entering nested SELECTs.
  - *Expression keys:* `exprKey` (morsels, MV matching) and the planner's `exprShapeKey` are now one canonical function
    with options (`foldNames`, `ignoreQualifiers`). **Kept:** `exprEquals` stays a separate, allocation-free
    comparator, because it is used on planner hot paths where building a key string would cost more.
  - *Walkers:* the deep walkers (`walk` in morsel, `contains` in mv-match, `anyNode` in flatten) are replaced by the
    shared `anyNode`.
  - *Metadata rows:* `writeMatviewMeta` and `writeColumnarMeta` share `upsertMetaRow`, which also closes its cursor on
    errors.
  - *Pragmas:* boolean parsing and setters use `pragmaBool()` and `setter()`.
  - *Varints:* the spill writer uses the B+tree module's `writeVarint` (same encoding).
- **Simplification:**
  - *Column stores:* a single `storeOf(t)` replaces the three ways of getting a table's `ColumnStore`, and one
    `liveRows(t)` is shared by the planner (through `PlannerEnv`) and `parallelSplit`.
  - *Unused fields removed:* `spilledRuns`, `spilledPartitions` and `ColumnScan.skipped`.
  - *Columnar scans:* the interpreted `ColumnScan` and the generated loops share `ColumnScanRun` (zone-map test,
    deleted flags, stored rowids per row group).
  - *Worker jobs:* reader jobs are a tagged union (`{ kind: 'query' } | { kind: 'partial' }`) instead of fake jobs with
    negative ids.
  - **Kept:** `HashAggregate.step` and `stepRecord` stay separate. Routing in-memory rows through the spill record
    format cost about 20% on an interpreted GROUP BY (34 → 41 ms over 300k rows), so `step` reads registers directly
    and a comment ties the two together. `record()` now shares `inputs()` with the spill path.
  - **Kept:** `MemView` still mirrors the refresh state of `MatViewInfo`. It has to outlive `TableSchema` objects,
    which are rebuilt on every schema reload. Folding the two together would touch every refresh path for little gain.
- **Altitude:**
  - *Columnar checks:* the hand-written `t.matview?.storage === 'columnar' || t.columnar` checks are now
    `isColumnar(t)`.
  - *Implicit rowid zone (-1):* kept, and the stated consequence does not occur. A materialized view's storage layout
    never declares an INTEGER PRIMARY KEY, so views have no rowid alias that could go unpruned.
  - **Follow-up features, not cleanup** (they change behavior):
    - MV rewrite inside subqueries, CTEs, views and INSERT … SELECT, by hooking it into `planSelect`;
    - passing PRAGMA settings (`work_mem`, `matview_rewrite`) to parallel readers.

## Suggested order of work

1. **S1 items 1–5**, which corrupt data or return wrong results silently. Each gets a regression test that
   reproduces it first.
2. **Morsel and MV merge correctness, items 3 and 7–12:**
   - tighten `analyzeMorsels` (non-mergeable aggregates, collation, `rowid` columns, HAVING resolution);
   - fix the `count` merge;
   - type the partial columns;
   - add a differential test that runs a large set of query shapes through both the normal path and morsels.
3. **Server scheduling, item 6:** the morsel-completion path needs to respect the queue and transaction ownership.
4. **TEMP-table isolation, items 13–17 and 19:** keep main and temp schema maps separate. That root cause underlies
   several items.
5. **S3 items 20–25, the performance items, then the cleanup.**
