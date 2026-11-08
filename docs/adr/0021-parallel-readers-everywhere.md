# ADR 0021: Parallel readers everywhere (M9)

- **Status:** accepted with #171; step 1 in #172; step 2 in progress
- **Date:** 2026-11-08
- **Builds on:** [ADR 0009](0009-concurrency.md) section 7 (parallel readers on Chromium) and
  [WORKER_MODEL.md](../WORKER_MODEL.md) section 3 (the parallel mode)

## Context

Parallel readers exist only on Chromium (ADR 0009, section 7). Each reader worker opens the database and WAL files
itself, with OPFS `readwrite-unsafe` sync access handles, and keeps its own page cache. Before each query it catches
up with the WAL (`Wal.refresh`), so it reads a snapshot while the owner keeps writing, and the owner holds checkpoints
back while any reader is busy.

Firefox and Safari have sync access handles but not `readwrite-unsafe`. A handle there locks the file, so only the
owner can open the database, and every query runs on the owner. A page that is cross-origin isolated still has
`SharedArrayBuffer` and `Atomics.wait` in workers on all three browsers, which is what M9 builds on.

**What a reader needs from the files.** A reader opens two of the owner's files and reads them; it never writes them.
- **The database file:** pages, and the header (change counter, page count).
- **The WAL:** its header (salts, checkpoint sequence) and the frames committed since the reader last looked.
- It also writes a spill file of its own (`<name>.db-spill-r<n>`), which no other worker opens. An exclusive handle is
  fine for that on every browser.

Every one of those reads goes through `VfsFile` (`read`, `size`), which is synchronous. So a reader does not need a
handle of its own if something can answer those calls synchronously.

**Who can answer them.** Only the owner holds the handles. JavaScript in the owner runs one thing at a time, so it can
answer a reader:
- **when it is idle,** in its event loop (a message wakes it);
- **while it runs a statement,** at points the engine already stops at: the pager calls the interrupt check every
  256 page fetches (ADR 0009, section 4), and the server yields between requests and between result batches about
  every 8 ms.

The owner never waits on a reader, so a reader waiting on the owner cannot deadlock.

**Where readers matter.** The server routes a query to a reader only when other requests are waiting behind it
(ADR 0009): when the owner is busy. A reader that needs the owner for every page it reads would wait for exactly that
busy owner. Readers pay off when most of their reads are answered without the owner: from a cache.

## Decisions

1. **Parallel readers wherever the page is cross-origin isolated.** The conditions become: OPFS, a cross-origin
   isolated page (`SharedArrayBuffer` and `Atomics.wait`) and more than one core. `readwrite-unsafe` is no longer
   needed. Where it exists (Chromium), readers keep opening the files themselves until step 4 shows which way is
   faster.

2. **Step 1: readers read the owner's files through the owner.** A reader's database and WAL files become proxy
   files (`vfs/proxy.ts`). Each reader has a channel: a small `SharedArrayBuffer` with a request slot and a data
   buffer.
   - **Asking:** the reader writes the request (file, offset, length, or `size`), sets the slot's state, posts a
     message to wake the owner, and waits on the state with `Atomics.wait`. Reads larger than the data buffer
     (1 MiB) are split.
   - **Answering:** the owner reads with its own handle into the data buffer, sets the result, and notifies. It
     answers when the wake-up message arrives, and from the interrupt check while its own statements run. Requests
     are answered in turn, one channel at a time.
   - **Everything else stays.** The reader's snapshot refresh, cache invalidation, WAL scanning and the owner's
     checkpoint gate work as in ADR 0009. They read through `VfsFile` and do not know where the bytes come from.
   - **One owner without the leader lock.** The owner keeps its exclusive handles. Unlike shared handles, these keep
     the file lock, so proxied readers do not need the multi-tab leader lock.
   - **Off by default until step 2.** Measured in step 1 ([research](../research/m9-parallel-readers.md)): warm, they
     run 8 concurrent queries 1.4–1.6× faster than the owner alone, and a large aggregate 3.5× faster. But the first
     burst of concurrent queries is 2× slower, because every reader reads the same pages through the owner, one
     request at a time. So step 1 ships them behind a worker setting, `defineWorker({ parallelReaders: 'proxy' })`,
     and step 2 turns them on.
   - **Testing:** the browser test runs the client test a second time with proxy readers, on every browser (on
     Chromium, where readers otherwise open the files themselves, too).

3. **Step 2: a shared block cache** (`vfs/shared-cache.ts`). A `SharedArrayBuffer` of 64 KiB file blocks that the
   owner and every reader can read.
   - **Keyed by where the bytes are, not by page number:** (file, block, generation). Only bytes that cannot change
     while cached go in: whole blocks of the database file, and whole blocks of the WAL below its last commit (the
     log only grows until a checkpoint). Any write to the database file and any truncation (checkpoints, which wait
     for idle readers) move the generation on, so earlier entries stop matching and eviction reclaims them.
   - **Filled by the owner:** with the blocks it reads from the database file for its own queries, and with the
     blocks it sends readers.
   - **Used by readers:** a proxy file copies whole blocks from the cache and asks the owner only on a miss. A miss
     right after the previous run reads ahead (twice as long each time, up to 1 MiB), and the owner answers from the
     cache when another reader has just filled the blocks asked for: readers scanning the same table at once
     otherwise all miss on the same blocks. Each reader keeps the last part block it got (the end of the log, never
     cached) until its next snapshot.
   - **Concurrency:** only the owner writes entries, so there are no locks. Each slot has a sequence number that is
     odd while it is written (a seqlock); a reader checks it before and after copying. Sets of 8 ways, clock
     replacement, readers marking what they hit.
   - **Size:** twice the owner's page cache (32 MiB by default) for now; step 4 chooses.
   - **On by default** where readers cannot open the files themselves, once a cold burst of concurrent queries
     measures no slower than on the owner alone.

4. **Step 3, if step 2's measurements call for it: a shared WAL index.** Before each query a reader reads the frames
   committed since its last query to find which pages changed (`Wal.scan`). The owner already knows. It can publish,
   per commit, the pages and frame offsets in a `SharedArrayBuffer` (as SQLite's wal-index does), and readers read
   that instead of the frames. Only if refreshing turns out to cost readers more than it saves.

5. **Step 4: measure, then route.** The browser test's concurrent-query timings on all three browsers, against the
   owner alone, and on Chromium against readers with their own handles. Then:
   - **Routing:** whether readers should take queries in more cases, now that the cost of a hand-off is known per
     browser.
   - **Chromium:** keep shared handles, or use the shared cache there too.
   - **Defaults:** the shared cache's size.

## Steps

One PR each, with its measurements in the PR and in `docs/research/`.

1. Proxy files and the owner's answering, behind `parallelReaders: 'proxy'`. Tests: the channel protocol in Node (a
   reader over a proxied in-memory database, answered in the same thread), and the browser test with proxy readers
   on every browser.
2. The shared page cache, and proxy readers on by default.
3. The shared WAL index, if needed.
4. Measurements on the three browsers, routing and defaults. WORKER_MODEL.md and ARCHITECTURE.md describe what was
   built.

## Consequences

- Concurrent read-only queries run in parallel on every browser that supports OPFS, when the page is cross-origin
  isolated. Without isolation, nothing changes: reads run on the owner.
- A reader's cache miss costs a round trip to the owner until step 2, and waits while the owner is in a stretch of
  work with no page fetches (a commit's flush, a large sort in memory). Step 2 exists to make those misses rare, and
  proxy readers stay off by default until it does.
- With step 2, memory for cached pages is shared rather than copied per reader.
- The engine gains a cross-worker protocol on shared memory. Its tests run in Node with the owner's side called
  directly, and in the browsers for real.
