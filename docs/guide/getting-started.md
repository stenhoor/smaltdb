# Getting started

smaltdb is an embedded SQL database for web pages. The engine runs in a Web Worker, stores data in the Origin Private File System (OPFS), and speaks a SQL dialect based on SQLite. Your page talks to it through a small promise-based client.

## Install

```sh
npm install smaltdb
```

The package has three entry points:

| Import | File | Use it for |
|---|---|---|
| `smaltdb` | `dist/smaltdb.js` | The client: `open()` a database from a page or a worker. The engine runs in its own worker. |
| `smaltdb/engine` | `dist/engine.js` | The engine itself, synchronous and in-process: Node, tests, tools, or inside your own worker. See [the engine API](../reference/api/engine). |
| `smaltdb/worker` | `dist/smaltdb-worker.js` | The engine worker script, for setups that need its path (see [below](#loading-the-engine-worker)). |

Type declarations ship with the package. The engine needs Node 20 or later when you run it in Node.

## A first query

```ts
import { open } from 'smaltdb';

const db = await open('app'); // a database named "app", stored in OPFS
await db.exec('CREATE TABLE IF NOT EXISTS notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
await db.exec('INSERT INTO notes(body) VALUES (?)', ['Hello, smaltdb']);

const rows = await db.query('SELECT id, body FROM notes');
console.log(rows); // [{ id: 1, body: 'Hello, smaltdb' }]

await db.close();
```

`open()` starts the engine worker and opens (or creates) the database. Every call returns a promise, so the main thread never waits on the database. The same SQL runs in the engine directly:

```sql
CREATE TABLE notes(id INTEGER PRIMARY KEY, body TEXT NOT NULL);
INSERT INTO notes(body) VALUES ('Hello, smaltdb');
SELECT id, body FROM notes;
```

| id | body |
|---|---|
| 1 | Hello, smaltdb |

Next: the [quick start](./quick-start) builds a small data layer step by step.

## Loading the engine worker

The client starts the engine with this line, in `dist/smaltdb.js`:

```js
new Worker(new URL('./smaltdb-worker.js', import.meta.url), { type: 'module', name: 'smaltdb' });
```

So the worker is found next to the module that contains the client code. The files it needs are:

```
node_modules/smaltdb/dist/
  smaltdb.js           the client
  smaltdb-worker.js    the engine worker (a module worker)
  chunks/              code the worker loads on first use (the Parquet reader)
```

How this works with your build:

- **Vite.** Works without configuration. Vite recognises the `new Worker(new URL(…, import.meta.url))` pattern and emits the worker as an asset, in the dev server and in production builds (checked with Vite 8). A production build may warn that `node:fs/promises` "has been externalized for browser compatibility": that import is only used when the engine runs in Node, and the warning can be ignored.
- **No bundler.** If the page loads `dist/smaltdb.js` as an ES module from where the package files are served, the worker URL resolves to `dist/smaltdb-worker.js` next to it.
- **Other bundlers.** A bundler that understands the same pattern emits the worker the same way. If yours does not, or it moves the client code so the relative URL no longer points at the worker, copy `dist/smaltdb-worker.js` and the `dist/chunks/` folder to your site and pass the worker's URL with the `worker` option.

The `worker` option overrides where the engine worker comes from:

```ts
import { open } from 'smaltdb';

// A URL or string: the client starts `new Worker(url, { type: 'module' })`.
const db = await open('app', { worker: new URL('/smaltdb-worker.js', location.href) });
```

You can also pass a `Worker` you created yourself. Prefer a URL: with [multi-tab access](./databases#multi-tab-access), a tab that takes over the database later starts its engine worker from the option.

## Browser requirements

What each feature needs from the browser, from the client and worker code:

| Feature | Needs | Without it |
|---|---|---|
| The engine | Module workers (`new Worker(url, { type: 'module' })`) | smaltdb does not run. |
| Persistent storage (`storage: 'opfs'`, the default) | OPFS with `FileSystemSyncAccessHandle` in dedicated workers | `open()` fails with `SMALT_CANTOPEN`. Use `storage: 'memory'`, which needs no OPFS. |
| Sharing one database between tabs | Web Locks (`navigator.locks`) and `BroadcastChannel` | Each `open()` owns the file alone; a second tab that opens it fails with `SMALT_BUSY`. |
| Stopping a statement that is already running (`signal`) | A cross-origin isolated page (`crossOriginIsolated` and `SharedArrayBuffer`) | Aborting still removes queued requests and closes streams, but a running statement runs to the end. See [cancellation](./queries#cancellation). |
| Parallel reader workers | Multi-tab access, OPFS sync handles with `mode: 'readwrite-unsafe'`, and more than one CPU core | Reads run on the owning engine worker. |

A page is cross-origin isolated when it is served with these headers:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Storage, transactions and multi-tab access work without them.

The engine is designed for Chrome 108, Firefox 111 and Safari 17 and later ([ADR 0002](../adr/0002-second-round-decisions)). The project's browser test suite runs in Chromium by default. `readwrite-unsafe` handles, which parallel readers need, are a Chromium feature.

## Node and other in-process use

`smaltdb/engine` is the same engine without the worker and the client: a synchronous API that runs in the current thread.

```ts
import { Database } from 'smaltdb/engine';

const db = Database.openMemory();
db.exec('CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT)');
db.run('INSERT INTO t(b) VALUES (?)', ['x']);
console.log(db.query('SELECT a, b FROM t')); // { columns: ['a', 'b'], rows: [[1, 'x']] }
db.close();
```

Storage in Node:

- `Database.openMemory()` gives an in-memory database.
- `Database.open(new MemoryVfs(), 'app.db')` gives a file-format database whose files live in the `MemoryVfs` object, in process memory.
- `OpfsVfs` needs OPFS, which Node does not have: opening a file with it rejects with `SMALT_CANTOPEN`.
- smaltdb ships no VFS for the Node file system. To persist to disk, implement the `Vfs` interface (see [the engine API](../reference/api/engine#vfs)).

Reading Parquet files needs the optional `hyparquet` package in Node (`npm install hyparquet`), plus `hyparquet-compressors` for codecs other than Snappy. The browser worker in `dist/` already contains the Parquet reader. See [external data](./external-data).

## Next steps

- [Quick start](./quick-start): a short tutorial.
- [Databases](./databases): storage, options, durability, multi-tab access.
- [Queries](./queries): parameters, result shapes, streaming, values.
- [Client API reference](../reference/api/client).
