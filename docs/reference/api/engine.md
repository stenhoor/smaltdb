# Engine API

`smaltdb/engine` is the database engine without the worker and the client. It runs in the current thread and its core API is **synchronous**: `query()` returns rows, not a promise. Use it in Node (tests, scripts, tools), or inside a worker you manage yourself. In a web page, use the [client](https://stenhoor.github.io/smaltql/reference/api/client) instead: it keeps the engine off the main thread.

```ts
import { Database } from 'smaltdb/engine';
import '@smaltworks/smaltql/register';

const db = Database.openMemory();
db.exec('CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT)');
const r = db.run('INSERT INTO t(b) VALUES (?)', ['x']); // { changes: 1, lastInsertRowid: 1 }
const { columns, rows } = db.query('SELECT a, b FROM t'); // ['a', 'b'], [[1, 'x']]
db.close();
```

The engine carries no language: the text methods (`exec`, `query`, `run`, `prepare`) run SQL from [smaltql](https://stenhoor.github.io/smaltql/), registered with `import '@smaltworks/smaltql/register'`, and without it they fail with `SMALT_MISUSE`. Statements given as [plans](../engine/) need no language. The SQL, the values, the parameters and the errors are the same as in the client. Results differ: the engine returns `{ columns, rows }` with rows as value arrays.

## Exports

| Export | Description |
|---|---|
| [`Database`](#database) | A database connection |
| [`Statement`](#statement), [`PlanStatement`](#plans), [`PreparedStatement`](#statement), [`RowCursor`](#rowcursor) | Prepared statements and their result cursors |
| [`plan`](#plans), `PlanStatementInput`, `PlanColumn` | The plan format: types, builders, validator and codec (experimental) |
| [`MemoryVfs`, `OpfsVfs`, `Vfs`, `VfsFile`, `OpenOptions`](#vfs) | Storage back ends |
| [`SmaltError`, `CorruptionError`, `MisuseError`, `SqlSyntaxError`](#errors) | Error classes |
| [`registerLanguage`, `SmaltLanguage`, `LanguageStatement`, `ObjectReference`](#languages) | The language interface (experimental) |
| [`detectCapabilities`, `Capabilities`](#detectcapabilities) | Browser feature detection |
| [`PLUGIN_API_VERSION`, `SmaltPlugin`, `PluginHost`, `FormatReader`, …](#plugins) | The plugin interface, version 1. See [Writing plugins](./plugins). |
| Types: `RunResult`, `QueryResult`, `BindParams`, `DatabaseOptions`, `SqlValue` | Described below |
| `Pager`, `Frame`, `BTree`, `BTreeCursor`, `KeyEncoder`, `encodeKey`, `decodeKey`, `Collation`, `crc32c`, and their types | [Low-level storage](#low-level-storage) |

## Database

### Opening

| Method | Description |
|---|---|
| `Database.openMemory(options?: DatabaseOptions): Database` | A new in-memory database: no files, no write-ahead log. Gone when closed. |
| `Database.open(vfs: Vfs, path: string, options?: DatabaseOptions): Promise<Database>` | Open or create the database file `path` in `vfs`, with its write-ahead log `<path>-wal` and scratch file `<path>-spill`. `path` `':memory:'` is the same as `openMemory`. |
| `Database.openFile(file: VfsFile, options?: DatabaseOptions, walFile?: VfsFile): Database` | Open from files you have already opened. Pass `walFile` for write-ahead logging; without it, writes go to the file in place. |

```ts
import { Database, MemoryVfs } from 'smaltdb/engine';
import '@smaltworks/smaltql/register';

const vfs = new MemoryVfs();
const db = await Database.open(vfs, 'app.db');
db.exec("CREATE TABLE t(a); INSERT INTO t VALUES ('kept')");
db.close();

const again = await Database.open(vfs, 'app.db'); // same files, same data
console.log(again.query('SELECT a FROM t').rows); // [['kept']]
```

### DatabaseOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `pageSize` | `number` | `8192` | Page size for a new database: a power of two from 512 to 65536. Ignored for an existing file. |
| `cacheSizeBytes` | `number` | 16 MiB | Page cache budget. |
| `syncOnCommit` | `boolean` | `true` | Flush on every commit (the client's `durable`). |
| `journalMode` | `'wal'` \| `'off'` | `'wal'` | `'off'` writes pages in place: commits are then not atomic if the process stops halfway. |
| `workMem` | `number` | 256 MiB | Bytes a sort or hash aggregate may use before it spills to the scratch file; `0` never spills. `PRAGMA work_mem` changes it at run time. |
| `spillPath` | `string` \| `false` | `<path>-spill` | The scratch file, or `false` for none (operators then stay in memory). In-memory databases never spill. |
| `statementCacheSize` | `number` | `64` | Compiled statements kept by `run` and `query`, by SQL text. |
| `verifyChecksums` | `boolean` | `true` | Check page checksums on every read from storage. |
| `walAutoCheckpointBytes` | `number` | 4 MiB | Copy the write-ahead log into the database file once it reaches this size. |
| `readAheadBytes` | `number` | 64 KiB | On a cache miss, read this aligned extent around the page in one call (`0` disables). |
| `plugins` | `readonly SmaltPlugin[]` | none | [Plugins](https://stenhoor.github.io/smaltql/guide/plugins) to install, e.g. `[io, external]` from `@smaltdb/io` and `@smaltdb/external`. |
| `sharedHandles` | `boolean` | `false` | Open OPFS files with `readwrite-unsafe` handles so other workers can open them too. You must then make sure only one connection writes. |

### Running SQL

| Method | Description |
|---|---|
| `exec(sql: string, params?: BindParams): void` | Run one or more statements, discarding rows. With `params`, `sql` must be one statement (else `SMALT_MISUSE`). |
| `query(sql: string, params?: BindParams, options?: { temporal?: TemporalForm }): QueryResult` | Run one statement and return `{ columns, rows }`. `temporal` picks how dates and times come back. |
| `run(sql: string, params?: BindParams): RunResult` | Run one statement for effect and return `{ changes, lastInsertRowid }`. |
| `prepare(sql: string): Statement` | Compile one statement. See [Statement](#statement). |
| `changes(): number` | Rows changed by the most recent `INSERT`, `UPDATE` or `DELETE`. |
| `totalChanges(): number` | Rows changed since the database was opened. |
| `lastInsertRowid(): number \| bigint` | Rowid of the most recent successful `INSERT`. |
| `inTransaction: boolean` | Whether a transaction is open (getter). |
| `checkpoint(): void` | Copy the write-ahead log into the database file now. Also happens automatically and on close. Throws `SMALT_BUSY` inside a transaction. |
| `close(): void` | Close the database and its files. Further calls throw `SMALT_MISUSE`. Calling it again does nothing. |

`query` and `run` keep compiled statements in a cache keyed by the SQL text (see `statementCacheSize`); `exec` compiles each time.

`BindParams` is `readonly (SqlValue | boolean | undefined)[] | Readonly<Record<string, SqlValue | boolean>>`, the same as the client's [`Params`](https://stenhoor.github.io/smaltql/reference/api/client#params). `QueryResult` is `{ columns: string[]; rows: SqlValue[][] }`.

Engine calls are synchronous: a long query blocks the thread until it finishes. There is no `signal`. A host can install an interrupt check with `setInterruptCheck(fn)`, which the engine calls every few hundred page reads; `fn` stops the statement by throwing a `SmaltError` with code `SMALT_INTERRUPT`, and must reset its own trigger before it throws.

### External data

Statements that read [external data](https://stenhoor.github.io/smaltql/guide/external-data) (`read_csv`, `read_json`, `read_parquet`, external tables, materialized views over them) need their sources fetched first, which is asynchronous. The synchronous methods throw `SMALT_ASYNC_REQUIRED` for them; use the async variants, which work for any statement:

| Method | Description |
|---|---|
| `queryAsync(sql, params?, options?: { signal?: AbortSignal }): Promise<QueryResult>` | `query` that fetches external sources first. |
| `runAsync(sql, params?, options?): Promise<RunResult>` | `run` that fetches external sources first. |
| `execAsync(sql, params?, options?): Promise<void>` | `exec` that fetches external sources first, statement by statement. |

The three async methods also run `REFRESH MATERIALIZED VIEW … IF CHANGED`, which checks the view's sources before it refreshes; the synchronous ones fail with `SMALT_ASYNC_REQUIRED` for it.

`signal` aborts the fetches; the call then rejects with `SMALT_INTERRUPT`.

Formats and sources come from [plugins](https://stenhoor.github.io/smaltql/guide/plugins): `@smaltdb/io` (CSV, TSV, JSON), `@smaltdb/parquet` (Parquet) and `@smaltdb/external` (registered files, URLs, S3, Azure and local paths). Without them, these statements fail with `SMALT_PLUGIN_MISSING`. Files are registered with `registerFile(db, name, file)` from `@smaltdb/external/client`, which takes the engine `Database` as it takes the client's:

```ts
import { Database } from 'smaltdb/engine';
import io from '@smaltdb/io';
import external from '@smaltdb/external';
import { registerFile } from '@smaltdb/external/client';

const db = Database.openMemory({ plugins: [io, external] });
await registerFile(db, 'prices.csv', 'id,price\n1,9.5\n2,12\n');
const { rows } = await db.queryAsync("SELECT id, price FROM read_csv('file:prices.csv') WHERE price > ?", [10]);
console.log(rows); // [[2, 12]]
```

`registerCredentials(db, name, provider)` and `setFetch(db, fn)` from `@smaltdb/external/client` work the same way; with the in-process engine, functions in a credentials provider are called in this thread. See the [client's plugin helpers](https://stenhoor.github.io/smaltql/reference/api/client#plugin-helpers).

## Plans

A statement can also be given as plan data instead of SQL: the engine's own description of a query or write, which every language builds and which the engine plans and runs. The plan format is **experimental** (`plan.PLAN_FORMAT_VERSION` is `0`). [The engine section](../engine/) describes it in full: [the plan format](../engine/plans), [running plans](../engine/running) and [schema definitions](../engine/schema).

| Method | Description |
|---|---|
| `preparePlan(stmt: PlanStatementInput): PlanStatement` | Compile a statement given as plan data. A `PlanStatement` has the same members as a [`Statement`](#statement), but no `sql`. |
| `queryPlan(stmt: PlanStatementInput, params?: SqlValue[], options?: { temporal?: TemporalForm }): QueryResult` | Run a statement given as plan data and return `{ columns, rows }`. `temporal` picks how dates and times come back ([in results](../engine/running#through-the-client)). Compiled plans are cached by their canonical form (see `statementCacheSize`). |
| `queryPlanAsync(stmt, params?, options?: { signal?: AbortSignal; temporal?: TemporalForm }): Promise<QueryResult>` | `queryPlan` for a plan that reads [external data](#external-data). |

The `plan` namespace holds the format's types, builders, the validator (`validatePlan`) and the codec (`planToJSON`, `planFromJSON`, `encodePlan`, `decodePlan`). `smaltdb/plan` exports the same without the validator. An invalid plan fails with [`SMALT_PLAN`](./errors#smalt-plan).

## Statement

A compiled statement, from `db.prepare()`. It compiles again by itself after schema changes. `Statement` and [`PlanStatement`](#plans) are both `PreparedStatement`s.

| Member | Description |
|---|---|
| `run(params?: BindParams): RunResult` | Run for effect. A query is run to the end and its rows discarded. |
| `all(params?: BindParams): SqlValue[][]` | Run and return every row. |
| `cursor(params?: BindParams): RowCursor` | Run and return a cursor over the rows. |
| `columns: string[]` | Result column names (getter). |
| `columnTypes: StaticType[]` | Static result types: `'int'`, `'real'`, `'num'`, `'text'`, `'blob'`, `'null'` or `'any'` (getter). |
| `readonly: boolean` | Whether the statement only reads (getter). |
| `paramCount: number` | Number of parameter slots (getter). |
| `sql: string` | The statement's text. |

```ts
import { Database } from 'smaltdb/engine';
import '@smaltworks/smaltql/register';

const db = Database.openMemory();
db.exec('CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT)');
const insert = db.prepare('INSERT INTO t(b) VALUES (?)');
for (const b of ['x', 'y', 'z']) insert.run([b]);

const select = db.prepare('SELECT a, b FROM t WHERE a > :min');
console.log(select.columns, select.columnTypes); // ['a', 'b'] ['int', 'text']
console.log(select.all({ min: 1 })); // [[2, 'y'], [3, 'z']]
```

Statements in the engine need no finalizing: drop the reference.

## RowCursor

Returned by `Statement.cursor()`. It reads rows on demand.

| Member | Description |
|---|---|
| `next(): SqlValue[] \| null` | The next row, or `null` at the end. |
| `nextBatch(max: number, cols: SqlValue[][]): number` | Append up to `max` rows to `cols`, one array per column; returns the number of rows (0 at the end). |
| `close(): void` | Release the cursor. Done automatically at the end. |
| `columns: string[]` | Column names. |

While a cursor over table data is open, writes on the same database throw `SMALT_BUSY`. Read to the end or call `close()` first.

```ts
import { Database } from 'smaltdb/engine';
import '@smaltworks/smaltql/register';

const db = Database.openMemory();
db.exec('CREATE TABLE t(a); INSERT INTO t VALUES (1), (2), (3)');
const cursor = db.prepare('SELECT a FROM t').cursor();
try {
  for (let row = cursor.next(); row !== null; row = cursor.next()) {
    if (row[0] === 2) break;
  }
} finally {
  cursor.close();
}
db.exec('DELETE FROM t'); // fine: the cursor is closed
```

## Import and export

Import and export come from the `@smaltdb/io` plugin. Its helpers in `@smaltdb/io/client` take an engine `Database` as they take the client's, and return promises:

```ts
import { Database } from 'smaltdb/engine';
import io from '@smaltdb/io';
import { importCSV, exportCSV } from '@smaltdb/io/client';

const db = Database.openMemory({ plugins: [io] });
await importCSV(db, 'people', 'name,age\nAnn,31\n', { create: true });
console.log(await exportCSV(db, 'SELECT name, age FROM people')); // 'name,age\nAnn,31\n'
```

Import and export need no language: import writes through plans, and export takes a plan statement in place of the SQL query (`exportCSV(db, { kind: 'query', plan, columns })`). Exports over external data fetch their sources first. The options and output rules are in [import and export](https://stenhoor.github.io/smaltql/guide/import-export).

## VFS

A VFS (virtual file system) gives the engine its files. Opening a file is asynchronous; reads and writes on an open file are synchronous.

| Class | Description |
|---|---|
| `MemoryVfs` | Files in a `Map` in memory. Files stay as long as the `MemoryVfs` object, so a database can be closed and opened again from it. For tests and Node. |
| `OpfsVfs` | Files in OPFS, under the directory `smaltdb` (option `rootDir`). Works only in a dedicated worker, where OPFS sync access handles exist; elsewhere `open` rejects with `SMALT_CANTOPEN`. `OpfsVfs.isSupported()` checks for them. This is what the engine worker uses. |

smaltdb ships no VFS for the Node file system. To store files somewhere else, implement the interfaces:

```ts
import type { Vfs, VfsFile, OpenOptions } from 'smaltdb/engine';

// Vfs:     name; open(path, options?: OpenOptions): Promise<VfsFile>; delete(path); exists(path)
// VfsFile: path; read(dst, offset): number; write(src, offset): number; size(); truncate(size); flush(); close()
export type { Vfs, VfsFile, OpenOptions };
```

| `VfsFile` method | Contract |
|---|---|
| `read(dst: Uint8Array, offset: number): number` | Read into `dst` from byte `offset`; return the bytes read (fewer at the end of the file). |
| `write(src: Uint8Array, offset: number): number` | Write `src` at `offset`, extending the file if needed; return the bytes written. |
| `size(): number` | The file's size in bytes. |
| `truncate(size: number): void` | Set the file's size. |
| `flush(): void` | Make previous writes durable. |
| `close(): void` | Close the file. |

`OpenOptions` has `create` (default `true`: create a missing file) and `shared` (OPFS only: open with a `readwrite-unsafe` handle).

## Plugins

`DatabaseOptions.plugins` installs [plugins](https://stenhoor.github.io/smaltql/guide/plugins) into this engine instance. In the browser, plugins
are installed in the engine worker with `serve({ plugins })` from `smaltdb/worker-runtime`.

<!-- docs:plugin @smaltdb/parquet -->
```ts
// db-worker.ts
import { serve } from 'smaltdb/worker-runtime';
import io from '@smaltdb/io';
import external from '@smaltdb/external';
import parquet from '@smaltdb/parquet';

serve({ plugins: [io, external, parquet] });
```

| Member or export | Description |
|---|---|
| `serve(options?: { plugins?: readonly SmaltPlugin[]; languages?: readonly SmaltLanguage[]; parallelReaders?: 'auto' \| 'proxy' \| 'off' })` (`smaltdb/worker-runtime`) | Makes the current dedicated worker an engine worker, with these plugins installed and these languages registered in it and in its parallel readers. Call it once, at the top level of the worker script; a second call fails with `SMALT_MISUSE`. `parallelReaders`: `'auto'` (the default) starts parallel reader workers where they can open the database files themselves (OPFS `readwrite-unsafe` handles, in Chromium); `'proxy'` starts them in any cross-origin isolated page, reading the files through the engine worker, with a block cache they share ([ADR 0021](../../adr/0021-parallel-readers-everywhere.md); not the default yet, as a burst of queries on fresh readers is slower than on the engine worker alone); `'off'` runs every query in the engine worker. |
| `defineWorker(options?)` (`smaltdb/worker-runtime`) | The same as `serve`, under the name a language's worker entry uses (see [Languages](#languages)). |
| `db.plugins: readonly { name: string; version: string }[]` | The plugins installed in this engine (getter). |
| `db.callPlugin(plugin: string, method: string, args: unknown[], options?: { session?: string; signal?: AbortSignal }): Promise<unknown>` | Call a plugin method. Plugin helpers such as `importCSV(db, …)` call it. `session` names the calling client session (default `'local'`); the worker server sets it. See [Writing plugins](./plugins#calling-plugin-methods). |
| `PLUGIN_API_VERSION` | The plugin interface version this engine implements (`1`). |
| `SmaltPlugin`, `PluginHost`, `PluginMethod`, `MethodContext`, `ConnectionTypeSpec`, `FormatReader`, `FormatRequest`, `FormatResult`, `FormatColumn`, `RandomAccessFile`, `SourceHandler`, `SourceTarget`, `SourceContext`, `OpenedFile`, `ListedFile`, `AskError`, `Zone` | Types for writing plugins. See [Writing plugins](./plugins). |

Opening fails with `SMALT_MISUSE` when a plugin was written for another `apiVersion`, when the same plugin is listed
twice, or when two plugins register the same format name or alias, table function, source prefix, source for plain
paths, or connection type or alias.

The plugin interface is API version 1. It is not stable yet: it will be declared stable before the 0.9.0 release.

## Languages

A language turns its source text into plans; the engine never reads its syntax. `registerLanguage(language)` makes a language available, by its name, to every database in the same engine, and a worker entry registers languages with `defineWorker({ languages, plugins })` from `smaltdb/worker-runtime`. A language reaches the engine only through `smaltdb/language`. See [writing a language](../engine/languages).

## Errors

Engine methods throw `SmaltError` (or a subclass) with the same `code` and `message` the client's [`SmaltdbError`](https://stenhoor.github.io/smaltql/reference/api/client#smaltdberror) carries. The codes are listed in [error codes](./errors).

| Class | Code |
|---|---|
| `SmaltError` | Any; the base class. |
| `SqlSyntaxError` (from `@smaltworks/smaltql`) | `SMALT_SYNTAX`. Also has `line` and `column` (1-based), `position` (0-based offset into the SQL) and `reason` (the message without the location). |
| `MisuseError` | `SMALT_MISUSE` |
| `CorruptionError` | `SMALT_CORRUPT` |

Other codes are thrown as plain `SmaltError` objects (or an internal subclass): check `code`, not the class. `OpfsVfs` used where OPFS sync access handles do not exist (Node, a page's main thread) throws `SMALT_CANTOPEN`. Other errors from the host pass through unchanged.

Errors from [plugins](./plugins#errors), such as `@smaltdb/io`'s import errors from `callPlugin` or the `@smaltdb/io/client` helpers, are not `SmaltError`s: a plugin cannot create one. They carry a `code` that starts with `SMALT_` all the same, so check `e.code`; `e instanceof SmaltError` is false for them.

```ts
import { Database, SmaltError } from 'smaltdb/engine';
import { SqlSyntaxError } from '@smaltworks/smaltql';
import '@smaltworks/smaltql/register';

const db = Database.openMemory();
try {
  db.exec('SELECT 1; SELEC 2');
} catch (e) {
  if (e instanceof SqlSyntaxError) console.log(e.line, e.column, e.reason); // 1 11 'near "SELEC": syntax error'
  else if (e instanceof SmaltError) console.log(e.code);
}
```

## Parsing

The SQL parser is smaltql's: `parse`, `parseOne` and `SqlSyntaxError` are exported from `@smaltworks/smaltql`.

## detectCapabilities

`detectCapabilities(): Capabilities` reports which optional browser features exist in the current context: `syncAccessHandle`, `readwriteUnsafe`, `crossOriginIsolated`, `sharedArrayBuffer`, `atomicsWait`, `webLocks`, `sharedWorker`, `broadcastChannel`, `cspEval` (all booleans) and `hardwareConcurrency`. The engine worker uses it to decide whether to start parallel readers. Call it in a dedicated worker to see what OPFS supports there.

## Low-level storage

`Pager`, `Frame`, `BTree`, `BTreeCursor`, `KeyEncoder`, `encodeKey`, `decodeKey`, `Collation` and `crc32c` are the storage layer under `Database`: page cache, B+trees, the index key encoding and the page checksum. They are exported for tests and tools and are not needed to use the database. See [STORAGE_FORMAT](../../STORAGE_FORMAT) for how they work.
