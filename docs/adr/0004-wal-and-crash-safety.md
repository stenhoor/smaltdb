# ADR 0004: Write-ahead log, checkpoints, savepoints, and read-ahead

- **Status:** accepted
- **Date:** 2026-10-31

## Context

Before M2, commits wrote pages in place and then the header. That is durable but not atomic: a crash
mid-commit could corrupt the database, and the crash tests demonstrate this. Fair benchmarking against crash-safe SQLite
required atomic commits.

## Decisions

1. **Physical page WAL** in `<db>-wal` (format in docs/STORAGE_FORMAT.md §6). A commit appends every changed page
   plus the header page as frames, the last marked as the commit frame, in **one write call followed by one flush**.
   The main file is written only by checkpoints.
2. **Integrity**: random salts per log generation, plus a cumulative CRC-32C chained across frames. Recovery accepts frames only
   while the salts match and the chain verifies, and only up to the last commit frame. Torn, partial, or stale frames are
   therefore ignored.
3. **Checkpoint** when the WAL exceeds 4 MiB (configurable), on close, or via `PRAGMA wal_checkpoint`. It copies the latest
   version of each page to the main file, using cached clean pages when possible, reading the WAL in 1 MiB chunks, and
   writing coalesced runs. It then flushes the main file, and only then truncates the WAL. A crash at any point replays
   idempotently.
4. **Single connection**: there are no concurrent readers yet, so the WAL index is an in-memory map rebuilt by recovery.
   Snapshot readers and group commit across connections arrive with multi-tab support in M6.
5. **Savepoints**: the pager keeps a stack of undo levels (page images on first modification plus "fresh" pages).
   Statements and SQL `SAVEPOINT`s share this mechanism. Releasing a level merges it into its parent, and `ROLLBACK TO`
   restores levels top-down.
6. **Read-ahead**: each OPFS read call costs about 200 µs in our measurements, almost regardless of size. A cache miss
   therefore reads the aligned 64 KiB extent containing the page. Neighbours become low-priority cache entries whose
   checksums are verified lazily on first use. This cut cold point lookups from about 380 ms to about 100 ms and cold scans from about 430 ms to
   about 140 ms (Chromium, 100k rows).
7. `journalMode: 'off'` keeps the old in-place mode. It is not crash-atomic, and is retained only for comparisons and tests.

## Verification

`test/crash.test.ts` records every write, truncate, and flush across both files. It rebuilds storage at every crash point
in three models: the prefix of operations, a torn last write, and loss of unflushed writes. Each image is reopened and must pass
`PRAGMA integrity_check` and equal a committed state: the last returned commit, or the in-flight one. More than 3,500
crash states were checked across 6 seeds, all passing. A control test shows the no-WAL mode does corrupt.

## Consequences

- Durable small commits are about 4× faster than SQLite's fastest crash-safe mode, because each commit is one write plus one flush.
- Bulk loads pay for writing pages twice (WAL, then checkpoint), roughly +40% versus in-place writes.
- Known limitation, unrelated to the WAL: index keys must fit in a quarter of a page (about 2 KB with 8 KiB pages). SQLite spills
  large index keys to overflow pages. This is tracked for M4.
