# Databases

A database is opened with `open()` and lives either in the Origin Private File System (OPFS) or in memory. This page covers opening and closing, the options, where the data is stored, durability, and sharing one database between tabs.

## Opening and closing

```ts
import { open } from 'smaltdb';

const db = await open('app');
// … queries …
await db.close();
```

`open(name, options?)` starts an engine worker, opens the database `name` (creating it if needed) and resolves to a `Database` once it is open. `close()` closes it:

- In the tab that owns the engine worker, `close()` closes the database files and terminates the worker.
- In a tab that shares another tab's worker (see [multi-tab access](#multi-tab-access)), `close()` only detaches.
- Calling `close()` again does nothing. Any other call on a closed `Database` rejects with `SMALT_MISUSE` ("database is closed").

Each `open()` call returns its own `Database` with its own worker, unless multi-tab sharing applies. Open a database once and share the object in your app.

## Options

| Option | Type | Default | Meaning |
|---|---|---|---|
| `storage` | `'opfs'` \| `'memory'` | `'opfs'` | Where the data lives. See [storage](#storage). |
| `durable` | `boolean` | `true` | Flush to storage on every commit. See [durability](#durability). |
| `pageSize` | `number` | `8192` | Page size in bytes for a **new** database: a power of two from 512 to 65536. Ignored when the database already exists. |
| `cacheMB` | `number` | `16` | Page cache budget in MiB for the engine worker. |
| `multiTab` | `boolean` | `true` for OPFS when Web Locks and `BroadcastChannel` exist | Share the database with other tabs of the same origin. See [multi-tab access](#multi-tab-access). |
| `worker` | `() => Worker` \| `URL` \| `string` \| `Worker` | `new URL('./smaltdb-worker.js', import.meta.url)` | Where the engine worker comes from: a function that starts it (for [plugins](./plugins)), a URL, or a `Worker`. See [loading the engine worker](./getting-started#loading-the-engine-worker). |

```ts
import { open } from 'smaltdb';

const db = await open('analytics', { pageSize: 16384, cacheMB: 64 });
```

The page size of an open database can be read with a pragma:

```sql
PRAGMA page_size;
```

| page_size |
|---|
| 8192 |

## Storage

### OPFS (default)

With `storage: 'opfs'` the database is a set of files in the origin's private file system, in a directory named `smaltdb`:

| File | Contents |
|---|---|
| `<name>.db` | The database. |
| `<name>.db-wal` | The write-ahead log: committed changes not yet copied into the database file. |
| `<name>.db-spill` | Scratch space for large sorts and aggregates (see [analytics](./analytics)). |
| `<name>.db-spill-r1`, `-r2`, … | Scratch files of [parallel readers](#parallel-readers), when they run. |

The data survives page reloads and browser restarts, within the browser's storage rules for the origin. The engine worker holds the files open with OPFS sync access handles, which lock them: only one engine worker can have a database open at a time. A second one fails with `SMALT_BUSY`, unless the tabs share the database (see below).

smaltdb has no call to delete a database. Close it, then remove its files with the OPFS API:

```ts
import { open } from 'smaltdb';

const db = await open('scratch');
await db.close();

const root = await navigator.storage.getDirectory();
const dir = await root.getDirectoryHandle('smaltdb');
for (const file of ['scratch.db', 'scratch.db-wal', 'scratch.db-spill']) {
  await dir.removeEntry(file).catch(() => undefined); // a file may not exist
}
```

### Memory

With `storage: 'memory'` (or the name `':memory:'`), the database lives in the engine worker's memory and is gone when it is closed or the page unloads. It needs no OPFS. Transactions, savepoints and rollback work as usual.

```ts
import { open } from 'smaltdb';

const scratch = await open('scratch', { storage: 'memory' });
```

Every in-memory `open()` creates a new, empty database, even with the same name. In-memory databases are never shared between tabs.

An in-memory database has no write-ahead log:

```sql
PRAGMA journal_mode;
```

| journal_mode |
|---|
| off |

An OPFS database reports `wal`.

## Durability

Commits on OPFS go through a write-ahead log: a transaction is either fully committed or not at all, also when the tab or browser is closed while it runs.

With `durable: true` (the default), each commit flushes the log to storage before the commit resolves. With `durable: false`, commits are written to the files but not flushed: they are faster, and the most recent commits can be lost if the browser or the operating system crashes before the data reaches storage.

```ts
import { open } from 'smaltdb';

const cache = await open('cache', { durable: false });
```

To check a database file for damage, run:

```sql
PRAGMA integrity_check;
```

| integrity_check |
|---|
| ok |

## Multi-tab access

A web app is often open in several tabs. With multi-tab access (the default for OPFS databases where Web Locks and `BroadcastChannel` exist), all tabs of the origin that open the same database name share it:

- One tab's engine worker owns the files. `db.isLeader` is `true` in that tab.
- Other tabs send their requests to the owner over a `BroadcastChannel` and get the results back. Their `db.isLeader` is `false`.
- When the owning tab closes (or calls `close()`), another tab that has the database open takes over: it starts its own engine worker and opens the files.

From your code's point of view, every tab has a normal `Database`. Some things to know:

- **Transactions belong to a tab.** While one tab's transaction is open, the other tabs' requests wait until it ends. If a tab closes with a transaction open, the transaction is rolled back. See [transactions](./transactions#multiple-tabs).
- **A change of owner fails requests in flight** with `SMALT_RETRY`. Requests sent to the old owner are lost with it. Retry them; see [errors](./errors#retrying).
- **Prepared statements belong to the owner** they were prepared on. After a change of owner, using one rejects with `SMALT_RETRY`; prepare it again.
- **Registered files and credentials** (`registerFile`, `registerCredentials` from the [`@smaltdb/external`](./plugins) plugin) live in the owning worker. Each tab registers its own again with a new owner automatically. Credentials whose provider has functions are answered by the tab that registered them, and are dropped when that tab closes.
- **Cancellation** of a statement that is already running works only in the owning tab (see [cancellation](./queries#cancellation)).

Turn sharing off with `multiTab: false`. Each `open()` then opens the files itself, and a second tab that opens the same database fails with `SMALT_BUSY` while the first has it open.

```ts
import { open } from 'smaltdb';

const db = await open('app', { multiTab: false });
```

### Parallel readers

In the owning tab, where OPFS supports shared sync access handles (`readwrite-unsafe`, currently Chromium) and the device has more than one CPU core, the engine worker starts up to three reader workers. When several read-only queries are waiting at once, outside any transaction, some run on readers, each on a snapshot of the latest commit. Readers do not block writes. Large aggregates may also be split across readers and merged (`PRAGMA parallel_aggregates`).

Nothing changes in the API. `db.stats` counts where queries ran, for diagnostics:

```ts
console.log(db.stats); // { readerQueries, ownerQueries, morselQueries }
```

Parallel readers need multi-tab access to be on: it is the multi-tab lock that guarantees a single owner.

## In-process databases

The engine also runs without a worker, synchronously, through `smaltdb/engine`: in Node, in tests, or inside a worker you write yourself. See [getting started](./getting-started#node-and-other-in-process-use) and the [engine API](../reference/api/engine).
