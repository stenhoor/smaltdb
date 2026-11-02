# Engine API

`smaltdb/engine` is the database engine without the worker and the client. It runs in the current thread and its core API is **synchronous**: `query()` returns rows, not a promise. Use it in Node (tests, scripts, tools), or inside a worker you manage yourself. In a web page, use the [client](./client) instead: it keeps the engine off the main thread.

```ts
import { Database } from 'smaltdb/engine';

const db = Database.openMemory();
db.exec('CREATE TABLE t(a INTEGER PRIMARY KEY, b TEXT)');
const r = db.run('INSERT INTO t(b) VALUES (?)', ['x']); // { changes: 1, lastInsertRowid: 1 }
const { columns, rows } = db.query('SELECT a, b FROM t'); // ['a', 'b'], [[1, 'x']]
db.close();
```

The SQL, the values, the parameters and the errors are the same as in the client. Results differ: the engine returns `{ columns, rows }` with rows as value arrays.

## Exports

| Export | Description |
|---|---|
| [`Database`](#database) | A database connection |
| [`Statement`](#statement), [`RowCursor`](#rowcursor) | Prepared statements and their result cursors |
| [`importCSV`, `importJSON`, `exportCSV`, `exportJSON`, `exportCSVAsync`, `exportJSONAsync`](#import-and-export) | Import and export functions |
| [`MemoryVfs`, `OpfsVfs`, `Vfs`, `VfsFile`, `OpenOptions`](#vfs) | Storage back ends |
| [`SmaltError`, `CorruptionError`, `MisuseError`, `SqlSyntaxError`](#errors) | Error classes |
| [`parse`, `parseOne`](#parsing) | The SQL parser |
| [`detectCapabilities`, `Capabilities`](#detectcapabilities) | Browser feature detection |
| Types: `RunResult`, `QueryResult`, `BindParams`, `DatabaseOptions`, `SqlValue`, `CsvImportOptions`, `JsonImportOptions`, `CsvExportOptions`, `JsonExportOptions`, `CredentialProvider`, `FetchFn`, `FileSource` | Described below |
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
| `sharedHandles` | `boolean` | `false` | Open OPFS files with `readwrite-unsafe` handles so other workers can open them too. You must then make sure only one connection writes. |

### Running SQL

| Method | Description |
|---|---|
| `exec(sql: string, params?: BindParams): void` | Run one or more statements, discarding rows. With `params`, `sql` must be one statement (else `SMALT_MISUSE`). |
| `query(sql: string, params?: BindParams): QueryResult` | Run one statement and return `{ columns, rows }`. |
| `run(sql: string, params?: BindParams): RunResult` | Run one statement for effect and return `{ changes, lastInsertRowid }`. |
| `prepare(sql: string): Statement` | Compile one statement. See [Statement](#statement). |
| `changes(): number` | Rows changed by the most recent `INSERT`, `UPDATE` or `DELETE`. |
| `totalChanges(): number` | Rows changed since the database was opened. |
| `lastInsertRowid(): number \| bigint` | Rowid of the most recent successful `INSERT`. |
| `inTransaction: boolean` | Whether a transaction is open (getter). |
| `checkpoint(): void` | Copy the write-ahead log into the database file now. Also happens automatically and on close. Throws `SMALT_BUSY` inside a transaction. |
| `close(): void` | Close the database and its files. Further calls throw `SMALT_MISUSE`. Calling it again does nothing. |

`query` and `run` keep compiled statements in a cache keyed by the SQL text (see `statementCacheSize`); `exec` compiles each time.

`BindParams` is `readonly (SqlValue | boolean | undefined)[] | Readonly<Record<string, SqlValue | boolean>>`, the same as the client's [`Params`](./client#params). `QueryResult` is `{ columns: string[]; rows: SqlValue[][] }`.

Engine calls are synchronous: a long query blocks the thread until it finishes. There is no `signal`. A host can install an interrupt check with `setInterruptCheck(fn)`, which the engine calls every few hundred page reads; `fn` stops the statement by throwing a `SmaltError` with code `SMALT_INTERRUPT`, and must reset its own trigger before it throws.

### External data

Statements that read [external data](../../guide/external-data) (`read_csv`, `read_json`, `read_parquet`, external tables, materialized views over them) need their sources fetched first, which is asynchronous. The synchronous methods throw `SMALT_ASYNC_REQUIRED` for them; use the async variants, which work for any statement:

| Method | Description |
|---|---|
| `queryAsync(sql, params?, options?: { signal?: AbortSignal }): Promise<QueryResult>` | `query` that fetches external sources first. |
| `runAsync(sql, params?, options?): Promise<RunResult>` | `run` that fetches external sources first. |
| `execAsync(sql, params?, options?): Promise<void>` | `exec` that fetches external sources first, statement by statement. Also needed for `REFRESH MATERIALIZED VIEW … IF CHANGED`. |
| `registerFile(name: string, file: FileSource \| null): void` | Make `file` readable as `file:<name>`. `FileSource` is `Blob \| Uint8Array \| ArrayBuffer \| string \| { getFile(): Promise<Blob> }`; a string is the file's text. `null` removes it. |
| `registerCredentials(name: string, provider: CredentialProvider \| null): void` | Credentials a connection names. `CredentialProvider` has the fields of the client's [`CredentialsProvider`](./client#credentialsprovider); functions are called in this thread. |
| `setFetch(fetchFn: FetchFn \| null): void` | Replace the transport for HTTP(S) and object store requests (default: the global `fetch`). |

`signal` aborts the fetches; the call then rejects with `SMALT_INTERRUPT`.

```ts
import { Database } from 'smaltdb/engine';

const db = Database.openMemory();
db.registerFile('prices.csv', 'id,price\n1,9.5\n2,12\n');
const { rows } = await db.queryAsync("SELECT id, price FROM read_csv('file:prices.csv') WHERE price > ?", [10]);
console.log(rows); // [[2, 12]]
```

`FetchFn` is `(url, { method?, headers, signal? }) => Promise<{ ok, status, statusText, headers: { get(name) }, arrayBuffer() }>`, a subset of `fetch`. Replace it to route requests through your own transport or to serve them in tests.

## Statement

A compiled statement, from `db.prepare()`. It compiles again by itself after schema changes.

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

The same operations as the client's [import and export methods](./client#importcsv), as functions. They take text (decode bytes yourself) and run synchronously.

| Function | Description |
|---|---|
| `importCSV(db, table, text, options?: CsvImportOptions): { rows: number }` | Insert CSV records. |
| `importJSON(db, table, text, options?: JsonImportOptions): { rows: number }` | Insert a JSON array or NDJSON. |
| `exportCSV(db, sql, params?, options?: CsvExportOptions): string` | Query result as CSV. |
| `exportJSON(db, sql, params?, options?: JsonExportOptions): string` | Query result as JSON or NDJSON. |
| `exportCSVAsync(db, sql, params?, options?, signal?): Promise<string>` | `exportCSV` for queries over external data. |
| `exportJSONAsync(db, sql, params?, options?, signal?): Promise<string>` | `exportJSON` for queries over external data. |

The options and output rules are in [import and export](../../guide/import-export).

```ts
import { Database, importCSV, exportCSV } from 'smaltdb/engine';

const db = Database.openMemory();
importCSV(db, 'people', 'name,age\nAnn,31\n', { create: true });
console.log(exportCSV(db, 'SELECT name, age FROM people')); // 'name,age\nAnn,31\n'
```

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

## Errors

Engine methods throw `SmaltError` (or a subclass) with the same `code` and `message` the client's [`SmaltdbError`](./client#smaltdberror) carries. The codes are listed in [error codes](./errors).

| Class | Code |
|---|---|
| `SmaltError` | Any; the base class. |
| `SqlSyntaxError` | `SMALT_SYNTAX`. Also has `line` and `column` (1-based), `position` (0-based offset into the SQL) and `reason` (the message without the location). |
| `MisuseError` | `SMALT_MISUSE` |
| `CorruptionError` | `SMALT_CORRUPT` |

Other codes are thrown as plain `SmaltError` objects (or an internal subclass): check `code`, not the class. `OpfsVfs` used where OPFS sync access handles do not exist (Node, a page's main thread) throws `SMALT_CANTOPEN`. Other errors from the host pass through unchanged.

```ts
import { Database, SmaltError, SqlSyntaxError } from 'smaltdb/engine';

const db = Database.openMemory();
try {
  db.exec('SELECT 1; SELEC 2');
} catch (e) {
  if (e instanceof SqlSyntaxError) console.log(e.line, e.column, e.reason); // 1 11 'near "SELEC": syntax error'
  else if (e instanceof SmaltError) console.log(e.code);
}
```

## Parsing

`parse(sql: string)` splits a script into statements and parses each one, throwing `SqlSyntaxError` on the first error. Each result has `text` (the statement's source, without the `;`) and `paramCount`, among other fields. `parseOne(sql)` parses exactly one statement. The rest of the parse tree is internal and may change.

```ts
import { parse } from 'smaltdb/engine';

console.log(parse('SELECT 1; SELECT ?2').map((s) => [s.text, s.paramCount])); // [['SELECT 1', 0], ['SELECT ?2', 2]]
```

## detectCapabilities

`detectCapabilities(): Capabilities` reports which optional browser features exist in the current context: `syncAccessHandle`, `readwriteUnsafe`, `crossOriginIsolated`, `sharedArrayBuffer`, `atomicsWait`, `webLocks`, `sharedWorker`, `broadcastChannel`, `cspEval` (all booleans) and `hardwareConcurrency`. The engine worker uses it to decide whether to start parallel readers. Call it in a dedicated worker to see what OPFS supports there.

## Low-level storage

`Pager`, `Frame`, `BTree`, `BTreeCursor`, `KeyEncoder`, `encodeKey`, `decodeKey`, `Collation` and `crc32c` are the storage layer under `Database`: page cache, B+trees, the index key encoding and the page checksum. They are exported for tests and tools and are not needed to use the database. See [STORAGE_FORMAT](../../STORAGE_FORMAT) for how they work.
