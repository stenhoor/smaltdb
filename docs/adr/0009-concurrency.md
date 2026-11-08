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

7. **Parallel reader workers (Chromium).** These are used only where OPFS `readwrite-unsafe` handles exist, there is
   more than one core, and the multi-tab leader lock guarantees one owner. Shared handles give up the file lock, and
   the leader lock replaces it.
   - *Readers:* the owner opens its files with shared handles and starts up to three reader workers. Each opens the
     same files read-only (`Database.openReader`).
   - *Snapshots:* before each query, a reader catches up with the WAL incrementally (`Wal.refresh`). It invalidates
     only the pages that later commits changed. After a checkpoint, the database header's change counter tells it
     whether the file changed. A query therefore sees exactly the commits that existed when it started, while the
     owner keeps writing (snapshot isolation for those reads; readers never block writers).
   - *Checkpoints:* the owner holds them back while any reader query runs; skipping one is always safe.
   - *Routing:* a read-only query outside any transaction goes to an idle reader when other requests are waiting
     behind it. A query that arrives alone runs on the owner, because the hand-off and snapshot refresh cost more
     than they save: in testing, routing every query to readers took prepared lookups from 65 to 713 µs. The server
     starts processing on a fresh task, so requests that arrived together are all queued before the first is routed.
   - *Results:* readers answer the client directly over a `MessagePort`, or the BroadcastChannel for other tabs.
     Credits and cancels are forwarded to them, and they share the interrupt flag.
   - *Other browsers:* there are no parallel readers. M9 brings them ([ADR 0021](0021-parallel-readers-everywhere.md)).

## Found on the way: text decoding contended across Chromium workers

Four concurrent text-heavy queries in four Chromium workers took 5.6× as long as one, and each was 4× slower than in
Node. The cause was `TextDecoder.decode`, called once per TEXT value: it is a costly host call in browsers and
contended across workers. ASCII values up to 64 bytes are now built in JS, 8 characters per `String.fromCharCode`
call (3× faster than `TextDecoder` in a Chromium worker). Four concurrent queries now take about as long as one.
Node keeps its fast native decoder above 24 bytes. This speeds up text decoding in browsers generally, not only for
readers.

## Consequences

- Several tabs can use one database safely. Long results can be streamed and cancelled; running statements can be
  interrupted.
- Transactions between tabs are serialized: a long transaction in one tab blocks the other tabs' statements.
- On Chromium, concurrent read-only queries run in parallel on snapshots and do not block writers. In the browser
  test, eight concurrent analytic queries took 65–88 ms against 116 ms serial (three readers plus the owner, after
  warm-up). Elsewhere, reads run on the owner.
