# FAQ

## General

### What is smaltdb?

smaltdb is an SQL database for web applications, written in TypeScript. It runs in a Web Worker, so queries don't
block the page. It stores data in the browser's Origin Private File System (OPFS), and its SQL dialect is based on
SQLite. See [Getting started](./getting-started).

### Is it SQLite compiled to WebAssembly?

No. smaltdb is its own engine: its parser, planner, B-trees, write-ahead log and storage format are all written in
TypeScript. It follows SQLite's SQL syntax and semantics, and is tested against SQLite with differential tests. Where
it behaves differently, [Differences from SQLite](./sqlite-differences) lists the differences.

### Can I open an existing SQLite database file?

No. smaltdb has its own file format, and opening a file that isn't a smaltdb database fails with `SMALT_NOTADB`. To
move data across, export it from SQLite as CSV or JSON and [import it](./import-export).

### Is it ready for production?

The current version is 0.9.0. The on-disk format may still change before 1.0, so a later version might not open a
database written by this one. Keep a way to rebuild or re-import your data, for example
[exportJSON](./import-export) or a server copy.

### How big is it?

These are the minified sizes, with the gzipped size in brackets:

| File | What it is | Size |
|---|---|---|
| `smaltdb.js` | the client you import | 12 KB (4 KB) |
| `smaltdb-worker.js` | the engine, in its worker | 471 KB (150 KB) |

Optional features that depend on other packages are [plugins](./plugins) and are not included. For example, the
Parquet plugin adds hyparquet and, if you install it, hyparquet-compressors to your worker bundle.

## Storage

### Where is my data stored?

With the default `storage: 'opfs'`, the data is stored in the Origin Private File System, in a folder named
`smaltdb`. A database named `app` is stored in these files:
- `app.db`, the database;
- `app.db-wal`, its write-ahead log;
- `app.db-spill`, a scratch file for large sorts and aggregates.

OPFS is private to your origin. Users can't see these files in their file system, and other sites can't read them.

### Will the browser delete my data?

It can. Browsers may evict an origin's storage when the device is short of space, unless the origin has persistent
storage. Ask for it with the standard browser API:

```ts
const persisted = await navigator.storage.persist();
```

To see how much space your origin has, call `navigator.storage.estimate()`.

### Can I keep a database in memory only?

Yes. Use `open(name, { storage: 'memory' })` or `open(':memory:')`. The database is discarded when it's closed. See
[Databases](./databases).

### Does it work in Node.js?

Yes. Use `smaltdb/engine`, which runs the engine in your own process with a synchronous API. Node has no OPFS, so
in Node a database lives in memory (`Database.openMemory()`). You can also supply your own storage by implementing
the exported `Vfs` interface. See [Engine API](../reference/api/engine).

## Using it

### Why do I get "cannot store TEXT value in INTEGER column"?

Tables are `STRICT` by default. A value must fit the declared type of its column, and is converted only when that
can be done without loss. For example, the text `'5'` becomes the integer 5, but `'abc'` is rejected. See
[Data types](../reference/sql/types).

### Why does my insert fail with a foreign key error when SQLite accepted it?

smaltdb enforces foreign keys by default, while SQLite enforces them only after `PRAGMA foreign_keys = ON`. To turn
enforcement off, run `PRAGMA foreign_keys = OFF` outside a transaction.

### Are JSON functions, math functions, triggers or full-text search available?

Not yet. `json_*` functions, math functions such as `sqrt` and `pow`, `CREATE TRIGGER`, virtual tables (so no
full-text search) and `ATTACH` aren't supported. The
[function list](../reference/functions/) shows exactly what is available.

### Can several tabs use the same database?

Yes. One tab's engine worker owns the file, and the other tabs send their requests to it. When that tab closes,
another takes over. See [Databases](./databases) and [Transactions](./transactions).

### Do I need cross-origin isolation (COOP/COEP headers)?

No, everything works without it. It changes one thing: cancelling a statement that is already running.
- With cross-origin isolation, a cancelled statement that is already running in this tab's engine worker is
  interrupted and rolled back.
- Without it, a statement that is already running finishes first, and only queued requests and open streams stop at
  once.

See [Queries](./queries).

### Why does my query fail with `SMALT_ASYNC_REQUIRED`?

The statement reads external data, such as `read_csv`, an external table or a URL, which has to be fetched first.
The browser client handles this for you. With `smaltdb/engine`, use `queryAsync`, `runAsync` or `execAsync` for these
statements. See [External data](./external-data).

### How do I back up a database?

Export the tables you need with `exportJSON` or `exportCSV`, and load them back with `importJSON` or `importCSV`. See
[Import and export](./import-export).

### How do I see why a query is slow?

Run `EXPLAIN QUERY PLAN` to see which indexes the planner uses, and `EXPLAIN ANALYZE` to see the actual row counts
and time spent in each operator. See [Indexes and performance](./indexes-and-performance).

### How do I report a bug?

Open an issue at [github.com/stenhoor/smaltdb/issues](https://github.com/stenhoor/smaltdb/issues). Include the SQL,
the error code and message, and your browser.
