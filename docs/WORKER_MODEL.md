# Worker & Concurrency Model

> Status: §2 (multi-tab), §5 (messaging, backpressure, cancellation) and the basic mode of §3 are **implemented in M6**
> ([ADR 0009](adr/0009-concurrency.md)): `src/engine/server.ts`, `src/engine/worker.ts`, `src/client/index.ts`.
> Parallel readers (§3) are built differently from the plan below. On Chromium, reader workers open the files with
> OPFS `readwrite-unsafe` handles and read WAL snapshots, with no shared buffer pool (ADR 0009). The shared-buffer-pool
> design below is M9, for the other browsers. Transactions of different tabs are serialized.

## 1. Constraints that shape the design

1. `FileSystemSyncAccessHandle` is only available in **dedicated workers**.
2. A sync access handle normally holds an **exclusive lock** on the file. `readwrite-unsafe` mode lifts this,
   but not every browser supports it.
3. Workers share memory only through `SharedArrayBuffer`, which needs `Cross-Origin-Opener-Policy: same-origin` and
   `Cross-Origin-Embedder-Policy: require-corp` (or `credentialless`).
4. Several tabs of the same app may want the same database at the same time.

## 2. Topology

```
 Tab A (leader)                       Tab B
 ┌──────────────┐                     ┌──────────────┐
 │ client API   │                     │ client API   │
 └──────┬───────┘                     └──────┬───────┘
        │ MessagePort                         │ MessagePort (brokered via
        ▼                                     │ BroadcastChannel/SharedWorker)
 ┌──────────────────────┐ ◄───────────────────┘
 │ Engine worker        │  owns OPFS handles, WAL, buffer pool
 │  ├─ writer executor  │
 │  └─ coordinator      │──► Reader worker 1 ┐ share the buffer pool via
 └──────────────────────┘──► Reader worker 2 ┘ SharedArrayBuffer  [Q-4]
```

- **Leader election**: `navigator.locks.request('smaltdb:<db>', …)`. The tab that holds the lock spawns the engine worker.
  When that tab closes, the lock is released, another tab takes over, and it replays the WAL during recovery.
- **Brokering**: clients in other tabs get a `MessagePort` to the engine. The broker is a tiny `SharedWorker`
  where available (it just passes ports along), with `BroadcastChannel` as the fallback.
- **Single-tab mode**: if only one tab is ever expected, the election step is skipped.

### Capability detection

At startup the engine records a capability set: `syncAccessHandle`, `readwriteUnsafe`, `crossOriginIsolated`,
`webLocks`, `sharedWorker`, and `cspEval`. The minimum supported browsers are Chrome 108, Firefox 111, and Safari 17,
and they need only the baseline. Faster paths for newer browsers plug in behind these flags (ADR 0002).

## 3. Concurrency inside the engine

| Mode | Requirements | Behaviour |
|---|---|---|
| **Basic** (always available) | none | One engine worker. Statements are scheduled cooperatively: long reads are split into slices of N batches, so short queries interleave. MVCC snapshots keep reads consistent while writes proceed. |
| **Parallel** | `crossOriginIsolated === true` | The engine worker coordinates a pool of reader workers sized to `navigator.hardwareConcurrency - 1`. The buffer pool, WAL index, and catalog snapshot live in `SharedArrayBuffer`s. Page reads that miss the cache are proxied to the I/O owner through `Atomics.wait`/`notify`. Morsel-driven intra-query and inter-query parallelism. |

## 4. Transactions and isolation

- **Snapshot isolation** for readers via the WAL (each reader pins a WAL frame mark).
- **Single writer** at a time. `BEGIN IMMEDIATE` acquires the write lock; `DEFERRED` upgrades it on the first write.
  Write-write conflicts cannot happen, so there is no write-skew beyond what SI normally allows.
  Serializable isolation is out of scope (ADR 0002).
- Long-running readers can block checkpointing past their snapshot. The engine reports this through `PRAGMA wal_status`.

## 5. Messaging protocol

- Request: `{id, op: 'prepare'|'exec'|'step'|'close'|..., sql?, params?, options}`.
- Plans (ADR 0014 section 4): `queryPlan` and `preparePlan` carry a statement as plan data, as JSON text (`plan`) with its format version (`planVersion`); a version the engine does not read is refused with `SMALT_PLAN`. Plan queries go to parallel readers as SQL queries do; prepared plans run on the owner.
- Response: a stream of `{id, kind: 'batch', columns, buffers}` followed by `{id, kind: 'done', stats}`.
  Buffers are transferred, not copied.
- Backpressure: the client acknowledges every K batches, and the engine pauses the cursor otherwise.
- Cancellation: `{id, op: 'cancel'}`. Executors check a cancellation flag between batches.
  In parallel mode it is a shared `Int32Array` flag.
