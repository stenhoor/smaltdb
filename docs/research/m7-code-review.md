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

**Status: nothing fixed yet.** Each item below records how it was reproduced and the suggested direction. Severity:
**S1** corrupts data or returns wrong results silently; **S2** wrong results or errors in specific shapes; **S3**
lifecycle, robustness and edge cases; **P** performance; **C** cleanup.

## Confirmed defects

### S1: data corruption and silent wrong results

1. **A re-run INSERT on a columnar table reuses rowids after compaction.**
   - *Where:* `exec/columnar-table.ts:143` and `database.ts:2614`.
   - *Cause:* `ColumnarTableWriter` caches `segMax` (and its `ColumnStore`) forever. The INSERT program keeps one
     writer across executions (`writer ??= this.writerFor(table)`). Compaction (`appendDelta`) does not bump the
     schema version, and `resetStatement` is not overridden.
   - *Repro:* run `prepare('INSERT INTO c VALUES (?)')` 8200 times on an empty columnar table.
     `count(*) = 8200` but `count(DISTINCT rowid) = 8192`. An explicit INSERT of an id already in the segments is
     also accepted.
   - *After a rollback:* `dropColumnarCaches()` leaves the writer holding the old `ColumnStore` object.
   - *Fix:* override `resetStatement()` to clear `segMax` and re-fetch the store, or stop caching writers across
     executions for columnar tables.
2. **A failed `CREATE UNIQUE INDEX` on a TEMP table corrupts it.**
   - *Where:* `database.ts:1862`.
   - *Cause:* the index is registered (`table.indexes.push`, `this.indexes.set`) before `checkUniqueIndex`. For TEMP
     tables `dirtySchema` is false, and `memDirty` is set only after the check. When the check fails, the pages roll
     back but the phantom index stays.
   - *Repro:* `CREATE TEMP TABLE tt(x); INSERT INTO tt VALUES (1),(1); CREATE UNIQUE INDEX ui ON tt(x)` fails, as it
     should. Afterwards every `INSERT INTO tt` and `PRAGMA integrity_check` fails with "page 2 out of range", and
     `ui` is still listed. This also happens on `:memory:` databases, where `memBefore` is null.
   - *Fix:* set `memDirty` before any temp DDL changes state, and restore the memory snapshot for `:memory:`
     databases too, or register the index only after it is built.
3. **Morsel and MV merges accept aggregates they cannot merge.**
   - *Where:* `exec/morsel.ts:173`, also reached through `mv-match.ts` `rollUp`.
   - *Cause:* only bare-column arguments of non-mergeable aggregates are rejected.
     `group_concat`/`string_agg`/`json_group_*`/user aggregates over constants or GROUP BY keys are copied into the
     merge query and aggregated over partial rows.
   - *Repro:* `SELECT g, length(group_concat('x','')) FROM t GROUP BY g` (1000 rows) gives `[[0,500],[1,500]]`
     normally and `[[0,4],[1,4]]` through `queryMorsels`.
   - *Fix:* reject any aggregate call outside the mergeable set, wherever it appears.
4. **Materialized views stay "fresh" when they are not.**
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
   - *Fix:* make DROP, RENAME, CREATE or DROP VIEW and temp DDL mark dependents stale and clear cached
     dependencies. Scope CTE names to their own SELECT. Key dependencies by object identity or catalog rowid rather
     than name.
5. **`main.`-qualified statements reach a shadowing TEMP table.**
   - *Where:* `database.ts:2398` (`targetTable`) and `:2086` (DROP TABLE).
   - *Repro:* main `t` with 2 rows, then `CREATE TEMP TABLE t`, then `DROP TABLE main.t`. This destroys the temp
     table's trees but the main table's catalog row. Main `t` is gone, and `integrity_check` reports
     `2 in use + 0 free != 3 total` permanently.
   - *Also:* `INSERT INTO main.t` writes into the temp table.
   - *Fix:* resolve `main.`-qualified names against the persisted catalog only (keep main and temp maps separate).

### S2: wrong results or errors in specific shapes

6. **The server's morsel path breaks request scheduling.**
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
7. **min/max merges ignore column collation.**
   - *Where:* `exec/morsel.ts:163`.
   - *Repro:* `ci TEXT COLLATE NOCASE` holding `'b','a','B','C'`. `SELECT min(ci), max(ci)` gives `['a','C']`
     normally and `['B','b']` through morsels. The MV roll-up has the same bug.
   - *Fix:* reject non-BINARY `min`/`max` arguments, or carry the collation into the merge.
8. **An MV roll-up `count` returns NULL instead of 0 when no view rows match.**
   - *Where:* `exec/mv-match.ts:151`.
   - *Cause:* an ungrouped query merges `count` as `sum` over the view's group rows, which are zero when nothing
     matches.
   - *Repro:* `SELECT count(*) FROM t WHERE g = 999` returns `[[null]]`. An empty base table gives the same.
   - *Fix:* merge `count` as `coalesce(sum(n), 0)`, or `total(n)` cast to integer.
9. **The morsel range filter binds to a user column named `rowid`.**
   - *Where:* `exec/morsel.ts:249`.
   - *Cause:* the filter uses a column reference named `rowid`, while `rowidBounds` splits by true B+tree rowids.
   - *Repro:* `CREATE TABLE t(rowid INT, v INT)` with user `rowid` values outside the true range.
     `sum(v), count(*)` gives `[[500500,1000]]` normally and `[[null,0]]` through morsels. The same happens with
     columnar tables and columnar views.
   - *Fix:* refuse morsels when a column is named `rowid`, `_rowid_` or `oid`, or filter on an internal rowid
     reference.
10. **The morsel merge loses REAL typing.**
    - *Where:* `database.ts:560`.
    - *Cause:* `smalt_partials` columns are typed `any`.
    - *Repro:* `x REAL` holding `2.0, 4.0, …`. `typeof(max(x))` and `min(x) || ''` give `real`/`2.0` normally and
      `integer`/`2` through morsels.
    - *Fix:* type the partial columns from the partial query's output types.
11. **A HAVING alias that matches a table column breaks morsel queries.**
    - *Where:* `exec/morsel.ts:171`.
    - *Repro:* `SELECT g, sum(a) AS a FROM t GROUP BY g HAVING a > 5` works normally but fails through morsels with
      "misuse of aggregate function sum()".
    - *Fix:* resolve HAVING names the way the planner does (table column first), or decline when an alias shadows
      a column.
12. **Rewriting a query to an MV breaks `t.*` and renames `SELECT *` columns.**
    - *Where:* `exec/mv-match.ts` `project`.
    - *Repros:*
      - `SELECT t.* FROM t` fails with "no such table: t": the star's qualifier is not normalized.
      - `SELECT * FROM t` against `CREATE MATERIALIZED VIEW mv(x, y) AS SELECT * FROM t` returns columns `x, y`
        instead of `a, b`.
13. **ALTER TABLE on a TEMP table does nothing, or rewrites the main table.**
    - *Where:* `database.ts:2146`.
    - *Repros:*
      - `ALTER TABLE tmp ADD COLUMN y DEFAULT 3` succeeds without effect.
      - With main `t` and TEMP `t(a,b)`, `ALTER TABLE t ADD COLUMN c` writes `a,b,c` into main `t`'s catalog row
        over records shaped `(a)`.
    - *Fix:* support ALTER for temp tables in memory, or reject it.
14. **Persistent views and MVs may read TEMP tables.**
    - *Where:* `database.ts:986` (`createMatview`) and `createView`.
    - *Repro:* `CREATE MATERIALIZED VIEW m AS SELECT x FROM tt` (`tt` is TEMP) persists this connection's private
      rows to the file, visible to readers and other tabs. After reopen, `REFRESH` fails with "no such table: tt".
    - *Fix:* reject persistent objects with temp dependencies (SQLite makes such views TEMP, or rejects them when
      `main` is explicit).
15. **TEMP views are not treated as connection-local.**
    - *Where:* `database.ts:298` (`usesMemoryObjects`).
    - *Repro:* `CREATE TEMP VIEW tv AS SELECT * FROM t`, then `SELECT * FROM tv`. It can be routed to a parallel
      reader, which fails with "no such table: tv".
16. **ANALYZE includes TEMP tables.**
    - *Where:* `database.ts:1664`.
    - *Effect:* their statistics are written into `smalt_stat` in the file and survive reopen. A TEMP `t` shadowing
      main `t` overwrites main `t`'s statistics, with the wrong column count.
17. **A TEMP table hides the main table from information_schema.**
    - *Where:* `catalog/information-schema.ts:56` and `database.ts:587`.
    - *Repro:* with main `t` and TEMP `t`, `information_schema.tables` and `.columns` lose main `t` entirely.
18. **A columnar table wraps past the maximum rowid.**
    - *Where:* `exec/columnar-table.ts:146`.
    - *Cause:* there is no `I64_MAX` check, unlike `TableWriter.newRowid`.
    - *Repro:* with segments holding 9223372036854775807, an INSERT succeeds with rowid 2^63, which reads back as
      -9223372036854775808. A row table raises `SMALT_FULL`.
19. **TEMP and main indexes can share a name.**
    - *Where:* `database.ts` `createIndex` and `loadSchema`.
    - *Cause:* `checkNewName` checks only the persisted catalog, so a main index may reuse a TEMP index's name.
    - *Effect:* depending on whether the schema was reloaded, `DROP INDEX i` drops one of the two, and the other can
      then never be dropped.

### S3: lifecycle, robustness and edge cases

20. **Reopening a database with memory views leaves writes uncommitted in the main pager.**
    - *Where:* `database.ts:228`.
    - *Cause:* `rebuildMemoryViews` runs outside a transaction. `fillMatview` calls `touchTable`, which writes
      `smalt_matview` and bumps the cookie on the main pager when a file MV depends on a memory MV, but only the
      memory pager is committed.
    - *Effect:* after open, `pager.inTransaction` is true. The next failing write silently discards that metadata,
      the next successful write commits it, and `checkpoint()` throws while the WAL is non-empty.
    - *Ordering:* views rebuild in catalog order, so after DROP and re-CREATE of a base memory view, a memory view
      over it stays unpopulated after reopen.
21. **A re-opened fused GROUP BY can leak a spill hold.**
    - *Where:* `exec/operators.ts:2350`.
    - *Cause:* `FusedGroupAggregate.open` resets `delegated` without closing the fallback `HashAggregate`.
    - *Trigger:* a correlated derived table on the inner side of a nested loop, where one re-open spills and the
      next does not. Reproduced only with a non-deterministic filter (`random()`).
    - *Effect:* the `-spill` file is never truncated and keeps growing.
    - *Fix:* close the fallback first in `open()`.
22. **The multi-pass external sort is not stable.**
    - *Where:* `exec/operators.ts` (Sort merge passes).
    - *Cause:* with more than 64 runs, the merged run holding the earliest input is appended after later runs, so
      ties favor later input. The code comment claims stability.
    - *Fix:* replace the merged group at the front of `runs`, not the end.
23. **Two writer handles on one VFS without locking share the scratch file.**
    - *Where:* `database.ts:245`, `exec/spill.ts`.
    - *Effect:* the second handle truncates the shared `db-spill` file, and the first fails with "spill file: short
      read". This is not reachable with OPFS: exclusive handles make the second spill open fall back to no spilling.
24. **`Database.close()` never closes the memory pager.** Only cleanup is affected: memory is reclaimed by the
    garbage collector.
25. **The two-pager transaction facade has no compensation.**
    - *Where:* `database.ts:352–391`.
    - *Risk:* if the main pager commits and the auto-checkpoint after it throws, the memory pager never commits.
      This was not reproduced; it is an ordering hazard.

## Refuted on verification

- **Re-run INSERTs keep a refreshed MV fresh.** Refuted: REFRESH bumps the schema version, so the INSERT recompiles
  with a new writer.
- **Mixed number and bigint rowids in one row group are missed.** Refuted: a bigint forces the generic chunk
  encoding without `numMax`, so lookups scan.
- **Bigint rowids break generated code ("Cannot mix BigInt").** Not reproducible: fused aggregates matched a row
  table both with and without codegen.

## Performance

| Issue | Where | Suggested direction |
|---|---|---|
| Every write statement to a columnar table runs `count()` over the delta and deletion trees, which is O(n²) over an 8192-row batch of single-row inserts | `database.ts:1470` | Keep running counters in the writer, or check `estimateCount()` first |
| UPDATE and DELETE of segment rows run `locateInSegments`: zone checks plus a linear rowid search per row | `columnar-table.ts:84` | Have the scan pass (row group, row) or the row itself; build a lazy rowid map per writer |
| Every columnar scan rebuilds the deleted-rowid `Set`, and the deleted bitmaps per row group | `database.ts:814`, `operators.ts:682`, `planner.ts:1000` | Cache by deletion version; skip row groups whose rowid zone holds no deletions |
| `snapshotMem()` runs before every write statement on file databases | `database.ts:932` | Snapshot lazily the first time a statement sets `memDirty` |
| `rowBytes` is computed for every sorted row, even under a 256 MiB limit that rarely triggers | `operators.ts` Sort | Sample every Nth row |
| `touchTable` loops over all tables on every DML writer; marking a view stale recompiles every cached statement | `database.ts:1645` | Keep a reverse map from base table to dependent fresh MVs; track freshness outside the schema version |
| `usesMemoryObjects` walks the AST per request; `morselQuery` cache-clears at 64 entries; partial and merge statements are compiled per morsel | `database.ts:298`, `:1236`, `:1334` | Memoize per statement; use an LRU; cache compiled partial and merge programs |
| TEMP-table growth never triggers re-planning: `statsDrifted` watches only the main pager's change counter | `database.ts:3251` | Also watch the memory pager's change counter |

## Cleanup

- **Reuse:**
  - `mv-match.ts` re-implements helpers that already exist:
    - `conjuncts` (exported from `expr.ts`);
    - `andAll` (`flatten.ts` `and`);
    - the aggregate and subquery predicates (`planner.ts`).
  - There are three notions of structural expression equality: `exprKey`, `exprShapeKey` and `exprEquals`. Use one.
  - Three deep AST walkers exist (`walk`, `contains`, `flatten.ts` `anyNode`).
  - `writeColumnarMeta` duplicates `writeMatviewMeta`: one "upsert a row by name" helper would serve both, and the
    matview version does not close its cursor on errors.
  - Pragma boolean parsing and setter literals are written out three or four times.
  - There is a third varint codec in `spill.ts`.
- **Simplification:**
  - `HashAggregate.step` and `stepRecord` are near-duplicates.
  - `MemView` duplicates the `MatViewInfo` state fields.
  - There are three ways to get a table's `ColumnStore`.
  - Unused statistics fields remain (`spilledRuns`, `spilledPartitions`, `ColumnScan.skipped`).
  - The interpreted `ColumnScan` and the codegen helpers duplicate zone, deletion and rowid handling.
  - The worker encodes morsel tasks as fake jobs with negative ids.
- **Altitude:**
  - About ten hand-written `t.matview?.storage === 'columnar' || t.columnar` checks: use one `isColumnar(t)`
    predicate and one `liveRows(t)`.
  - Columnar views use an implicit rowid zone column (-1). As a result, INTEGER PRIMARY KEY range filters on
    columnar views are never pruned.
  - MV rewrite applies only to top-level SELECT and EXPLAIN, not to subqueries, CTEs, views or INSERT … SELECT.
    Hooking it into `planSelect` would cover all of them.
  - PRAGMA settings (`work_mem`, `matview_rewrite`) are not passed to parallel readers.

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
