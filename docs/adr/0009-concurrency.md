# ADR 0009: Concurrency (M6): request server, cancellation, streaming, multi-tab

- **Status:** accepted
- **Date:** 2026-11-01

## Context

Before M6 each `open()` started its own engine worker. That worker ran requests strictly one after another and
returned whole results. A second tab opening the same OPFS database failed, because sync access handles are
exclusive. Nothing could be cancelled.

## Decisions

1. **One request server per engine worker** (`EngineServer`, `src/engine/server.ts`), independent of the transport, so
   it is unit-tested in Node.
   - *Sessions:* requests carry a session, either the tab that owns the worker or another tab.
   - *Queue:* requests wait in a queue. The server yields to the event loop between requests and between result
     batches, roughly every 8 ms of work, so credits, cancels and other tabs' requests get through.
2. **Transactions belong to a session.** There is one connection, so while a session's transaction is open, other
   sessions' requests (reads included) wait. Otherwise they would see or join uncommitted changes. This replaces the
   MVCC snapshots in the original design for now. Readers and writers of different tabs are serialized, not
   concurrent.
3. **Streams with credits.**
   - *Credits:* a query may carry a credit, the number of batches to send before pausing. The client grants more
     credit as it consumes batches.
   - *Open cursors:* a paused stream keeps its read cursor open. Writes from other sessions wait until it ends.
   - *Own writes:* a write from the stream's own session fails with `SMALT_BUSY` instead, because waiting would
     deadlock.
   - *Whole results:* results without a credit are sent in one go, as before.
4. **Cancellation.**
   - *Queued or streaming:* `cancel` removes a queued request or closes a stream.
   - *Running statements:* these are stopped through an interrupt flag, an Int32 slot in a `SharedArrayBuffer` shared
     between the owning tab and its worker (cross-origin isolated pages only). The engine checks it every 256 page
     fetches (`Database.setInterruptCheck`); the check clears the flag and throws `SMALT_INTERRUPT`, and the statement
     rolls back like any error.
   - *Without isolation:* a running statement stops at its next result batch.
   - *Other tabs:* they cannot share memory with the worker, so their running statements are not interrupted.
5. **Interrupt safety.** An exception can now occur at any page fetch. A test interrupts every kind of statement at
   each of its interrupt points in turn and checks that nothing stays pinned, the data is unchanged, and the
   integrity check passes. To make that hold:
   - statement roots are opened inside try/finally;
   - operators that consume a child in `open()` (sort, hash aggregate, hash join, materialize, window, outer join,
     recursive CTE) close it in `close()`;
   - cursors forget a released leaf before fetching the next one;
   - fused scans fetch before releasing;
   - bulk loaders can abort;
   - a failed write releases any remaining pins before rolling back. No cursor can legitimately hold one then, because
     writes never run while read cursors are open.
6. **Multi-tab** (the default for OPFS when Web Locks and BroadcastChannel exist).
   - *Election:* the tab that wins `navigator.locks` `smaltdb:<db>:leader` (with `ifAvailable`) starts the engine
     worker.
   - *Other tabs:* they queue a waiting request for that lock and send their requests to the leader's engine worker
     over the BroadcastChannel `smaltdb:<db>`. The worker listens on that channel itself.
   - *Dead tabs:* every tab holds `smaltdb:<db>:client:<session>` for its lifetime. When the worker is granted that
     lock, the tab is gone, and the worker drops its work, closes its streams and rolls back its transaction.
   - *Failover:* when the owner closes, the next waiting tab starts a worker and reopens the file; WAL recovery restores
     the committed state. Requests sent to the old owner fail with `SMALT_RETRY`. Prepared statements carry the owner
     epoch, so an id from an old owner cannot address a different statement.
   - *Copies:* BroadcastChannel copies messages (no transfers), so other tabs pay one copy per batch.

## Not in this ADR

**Parallel reader workers** (the "parallel" mode of WORKER_MODEL §3) are not built. Two approaches are open:
- **Per-reader file handles (`readwrite-unsafe`).** Each reader opens the database and WAL files itself and runs
  read-only queries on a WAL snapshot, while the owner holds checkpoints back. This mostly reuses the engine, but
  `readwrite-unsafe` is Chromium-only today.
- **Shared buffer pool.** The pool lives in `SharedArrayBuffer`, with page reads proxied to the file owner. It works in
  any cross-origin isolated browser, but needs a shared page cache with atomics, and stalls when the owner is busy.

## Consequences

- Several tabs can use one database safely. Long results can be streamed and cancelled; running statements can be
  interrupted.
- Concurrency between tabs is serialization, not parallelism: a long transaction in one tab blocks the others.
