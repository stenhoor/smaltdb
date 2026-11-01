# ADR 0010: Analytics (M7): mixed storage, spilling

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
