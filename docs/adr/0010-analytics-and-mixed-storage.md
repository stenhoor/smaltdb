# ADR 0010: Analytics (M7): mixed storage, spilling, columnar tables, morsels

- **Status:** accepted (M7 in progress; sections are added as parts land)
- **Date:** 2026-11-01

## Context

M5 added materialized views and columnar segments, and M6 added parallel readers. Before M7 the gaps were:

- every object of a file database lived in the file;
- every sort and hash aggregate had to fit in the worker's JS heap.

M7 adds the analytics pieces: objects placed in memory inside an OPFS database, spilling to OPFS, columnar base
tables, morsel parallelism and MV matching.

## Decisions

### 1. A second page store for memory-resident objects (M7.1)

- **The memory store.** A file database gets a second pager that lives only in memory (`Pager.openMemory`).
  - *Routing:* root page numbers at or above `MEM_BASE` (2^30) belong to that pager. `Database.tree()` and
    `freshTree()` route by root, so B-trees, cursors, the planner and codegen see no difference.
  - *Transactions:* a facade drives statement, savepoint and transaction boundaries on both pagers together.
  - *Failure behavior:* the memory store has no WAL, no checksums and no crash recovery. If the worker dies, its
    contents could not be recovered anyway.
- **`CREATE TEMP TABLE`** (and its indexes) lives entirely in the memory store.
  - It writes no catalog rows, so it is invisible to other connections and gone on reopen.
  - It shadows a main table of the same name, as in SQLite.
- **`CREATE MATERIALIZED VIEW … WITH (location = 'memory')`** splits the view between the file and memory.
  - *File:* the catalog row holds only the definition. Its root page is the marker `MEM_BASE`.
  - *Memory:* the rows, index trees and refresh state live in the memory store.
  - *On open:* the owner rebuilds such views. Parallel readers do not.
  - *On refresh:* no database pages are written, and the schema cookie does not change.
  - *Storage:* row and columnar layouts both work. `information_schema.materialized_views.location` reports the
    placement.
- **Rollback.** Temp DDL, temp writes and memory refreshes are undone with the transaction, a savepoint or a
  failing statement. The pages roll back with the memory pager. The name-to-root maps (`tempTables`, `memViews`)
  are snapshotted at BEGIN and at each savepoint and statement, and restored with them.
- **Parallel readers stay on the owner for these objects.** Readers are separate connections and cannot see memory
  objects. A statement that touches one goes to the owner, as does every PRAGMA, since settings belong to the
  owner's connection. Readers never run such a statement.

### 2. Spilling sorts and hash aggregates (M7.2)

- **One scratch area per database handle.** The scratch file is `<db>-spill`; parallel readers use
  `<db>-spill-r<n>`.
  - *Opening:* OPFS opens files asynchronously, so the file is opened with the database. If it cannot be opened,
    nothing spills.
  - *Use:* spilling operators append blocks of whole rows to it. When the last operator using it closes, it is
    truncated to empty.
  - *Lifetime:* nothing in it outlives a statement, so it needs no journal, checksums or recovery.
  - *Row format:* a tag byte and a payload per value, with no row header.
  - *Interruption:* reading or writing a block calls the interrupt check, so spilled work is cancellable like page
    fetches.
- **`work_mem`** is the limit on an operator's estimated heap bytes.
  - *Default:* 256 MiB. `0` turns spilling off.
  - *Settings:* the `workMem` open option or `PRAGMA work_mem`. `PRAGMA spill_bytes` reports the scratch bytes
    written since open.
  - *Sizing:* the estimate is deliberately rough (row arrays, strings at 2 bytes per character, a fixed size per
    group and aggregate). The default sits well above common queries: a 64 MiB default made a 300k-group GROUP BY
    spill.
- **Sort** becomes an external merge sort.
  - *Runs:* each memory-full of rows is sorted and written as a run.
  - *Merge:* a heap merges the runs and the final in-memory batch lazily as rows are read. Ties go to the earlier
    run, so the sort stays stable.
  - *Many runs:* past 64 runs, merge passes first combine runs.
  - *Top-N:* a top-N sort writes only its first N rows per run.
- **Hash aggregate** becomes grace hash.
  - *Overflow:* when the groups outgrow `work_mem`, groups already in memory keep accumulating. Rows with new keys
    are written to 16 hash partitions as records of group keys, per-aggregate FILTER flags and evaluated arguments,
    and bare columns.
  - *Partitions:* after the in-memory groups are returned, each partition is aggregated on its own, with the same
    step logic replaying the records. A partition that is still too big is partitioned again with a differently
    salted hash, up to 6 levels.
  - *Order:* all rows of one group go to the same place in input order, so order-sensitive aggregates such as
    `group_concat`, `DISTINCT` aggregates and bare columns behave as in memory.
- **Fused GROUP BY loops** (codegen) count group memory in their `newGroup` helper.
  - *Overflow:* past the limit they throw a restart signal. The loop's `finally` releases the page.
  - *Restart:* the operator reruns the query through the equivalent spilling hash aggregate. The planner builds that
    aggregate next to every fused one.
  - *Cost:* the restart repeats the scan once. This is acceptable because it only happens for results that would
    not fit anyway.

### 3. Columnar base tables (M7.3)

`CREATE TABLE t(…) WITH (storage = 'columnar')` keeps a table's rows in three B+trees.

- **Delta store**: the table's ordinary root, in row format. Every INSERT lands here, so constraints, conflict
  handling (`OR REPLACE`/`IGNORE`), RETURNING and triggers of the write path need no columnar variant.
- **Segments**: a column store in the ADR 0008 format. It holds the table's columns plus a final rowid column
  (rowids are not dense once rows move), in 8192-row groups with zone maps.
- **Deletion tree**: rowids of segment rows that were deleted, or that an UPDATE moved back into the delta store
  (keys only).

The segment and deletion roots are kept in `smalt_columnar(name, seg_root, del_root)`. The CREATE text itself says
the table is columnar.

**Reading.**
- *Scans:* a scan reads the delta store, then the segments minus deleted rowids (`ColumnarTableScan`). Results come
  back in no particular rowid order.
- *Zone maps:* comparisons with constants, including on the rowid or INTEGER PRIMARY KEY, become zone-map tests.
- *Fused loops:* fused aggregate and GROUP BY loops are generated once per source, a leaf loop for the delta store
  and a row-group loop for the segments. Both step the same aggregate states or groups. The row-group loop reads
  stored rowids and skips rows flagged in a per-row-group deleted bitmap.
- *Deletions:* deleted rowids are read when a scan opens. Compaction keeps that set small.

**Writing** (`ColumnarTableWriter`).
- *Lookups:* reads, existence checks and conflict checks look in the delta store, then the segments. A zone-map
  search runs only for rowids at or below the segments' maximum, so INSERTs with new rowids never search.
- *Segment rows:* a DELETE of a segment row records its rowid. An UPDATE records the rowid and writes the new version
  to the delta store.
- *Order safety:* UPDATE and DELETE collect target rowids before changing anything, so the order of the two sources
  cannot revisit a row.

**Compaction** runs at the end of a write statement, inside the statement's journal or autocommit transaction, so a
failure rolls it back.
- *Append:* once the delta store holds 8192 rows, whole row groups of delta rows, oldest rowids first, are appended
  as new row groups with B+tree inserts at the tree's right edge. The rest stay in the delta store.
- *Rows held back:* delta rows whose rowid is also in the deletion tree (updated segment rows, reused rowids) stay
  behind, because the deletion entry would hide them.
- *Rewrite:* when deletions exceed a quarter of the segment rows, when too few rows could move, on
  `PRAGMA compact(t)`, or on `DELETE FROM t` without WHERE, the segments are rewritten into a new tree. The delta
  store and deletion tree are emptied.
- *Readers:* a new segment root bumps the schema cookie, so readers reload.
- *Caches:* decoded-chunk caches survive commits, because segments never change in place. They are dropped on
  rollback, since the keys of rolled-back row groups get reused.

**Not supported yet:** secondary indexes, UNIQUE constraints other than INTEGER PRIMARY KEY, foreign keys to or
from columnar tables, ALTER TABLE, TEMP columnar tables and ANALYZE statistics. Each fails with a clear error.

### 4. Morsel parallelism on reader workers (M7.4)

Partial aggregates are computed over rowid ranges on parallel reader workers and merged on the owner. This works
in Chromium, where shared OPFS handles allow parallel readers (ADR 0009).

**Eligible queries** (`exec/morsel.ts`): a single SELECT over one file table (row table, columnar table or columnar
view).
- *Aggregates:* only those that merge exactly: `count`, `sum`, `total`, `min`/`max` with one argument, and `avg`.
  They may use `FILTER`, but not `DISTINCT` or `ORDER BY` inside the call.
- *Shape:* no joins, subqueries, window functions, `DISTINCT` or compound selects.
- *Columns:* GROUP BY keys must be plain BINARY-collated expressions, so partial groups meet by value. Output
  columns may refer only to keys, aggregates and output aliases.
- *Size:* at least 200k rows.

The analysis rewrites the AST twice.
- *Partial query:* the keys plus each aggregate's inputs, over `WHERE (original) AND rowid >= lo AND rowid < hi`.
  `avg` becomes `total` and `count`.
- *Merge query:* runs over a table-valued `smalt_partials()` source. `count` merges with `sum`, `avg` with
  `total(s) / sum(n)`, and the others with themselves. HAVING, ORDER BY, LIMIT and OFFSET apply there.
- *Column names:* output names are carried over as aliases, so results look exactly as without parallelism.

**Pruning.** Rowid ranges prune B+tree scans by key range, columnar tables by their rowid zone maps, and columnar
views by an implicit rowid zone (row-group base + count).

**The server** (`EngineServer.toMorsels`) splits a query across all idle readers, when there are at least two.
- *Consistent snapshot:* until every partial is back, the owner holds a placeholder read cursor. Writes wait, as for
  an open stream, so every morsel sees the same commit.
- *Merge:* the owner merges the partials and streams the result. The `columns` message carries `morsels: n`, and the
  client counts these in `stats.morselQueries`.
- *Failures and cancellation:* a failed reader makes the owner answer the query itself. A cancel drops the partial
  rows.
- *Switch:* `PRAGMA parallel_aggregates = 0` turns morsels off.

## Consequences

- An OPFS database can hold memory-only state (scratch tables, fast dashboards' MVs) without writing pages. Readers
  see none of it.
- **Spill costs measured** (Node, 1M-row table, MemoryVfs as the scratch file):

  | Query | In memory | Spilled | Limit | Scratch written |
  |---|---|---|---|---|
  | `ORDER BY` over 1M rows | 1500 ms | 1443 ms | 16 MiB | ~100 MB |
  | `GROUP BY` with 300k groups | 456 ms | 739 ms | 8 MiB | |

  Spilled sorts run at the same speed: smaller sorts are friendlier to the cache, which pays for the I/O.
- **Not counted towards `work_mem`:** state that grows inside an aggregate, such as `group_concat` strings and
  `json_group_array`.
- **Not spilling yet:** window partitions, hash joins and DISTINCT. Hash-join build sides are usually the smaller
  input; these are follow-ups.
- **Columnar tables against a row table** (Node, 1M rows of 5 columns, MemoryVfs):

  | Operation | Row table | Columnar |
  |---|---|---|
  | `sum`/`avg`/`count` | 84.6 ms | 13.7 ms |
  | `GROUP BY` (100 groups) | 90.7 ms | 13.9 ms |
  | Filtered aggregate | 72.3 ms | 2.2 ms |
  | Text `GROUP BY` | 123.6 ms | 17.2 ms |
  | rowid range | 1.8 ms | 0.76 ms |
  | Point lookup | 0.02 ms | 1.24 ms |
  | 1M-row INSERT | 2.9 s | 4.2 s |
  | UPDATE of 10k rows | 404 ms | 743 ms |
  | `GROUP BY` after DML | 98 ms | 37 ms |

  - *Point lookups:* slower, as expected, because they scan zone maps rather than descend a tree.
  - *INSERT:* rows are written twice, to the delta store and then to the segments. A direct bulk-load path is a
    follow-up.
  - *GROUP BY after DML:* the deleted bitmaps are recomputed on every scan.
  - *Row-table UPDATE:* the 404 ms figure includes a pager fix found while measuring. Before it, UPDATE took 3.2 s:
    with nearly every frame dirty, each cache miss swept the whole clock.
- **Morsels in Chromium**: a 600k-row `GROUP BY` takes 37 ms as morsels on 3 readers and 184 ms on the owner alone.
  The query is the same; parallel aggregates are turned off with the pragma for the owner run. The speedup is more
  than 3× because each reader caches only its third of the table, while the whole table exceeds the owner's 16 MiB
  page cache. With a warm cache that fits the table, expect roughly the reader count.

