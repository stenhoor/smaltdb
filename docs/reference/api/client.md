# Client API

The `smaltdb` package is the client: it runs on the page (or in any worker), starts the engine in its own Web Worker, and talks to it with messages. Every call returns a promise.

```ts
import { open, SmaltdbError, type Database } from 'smaltdb';
```

The guide explains the concepts: [databases](../../guide/databases), [queries](../../guide/queries), [transactions](../../guide/transactions), [import and export](../../guide/import-export), [errors](../../guide/errors). For the in-process engine, see [`smaltdb/engine`](./engine).

## Exports

| Export | Kind | Description |
|---|---|---|
| [`open`](#open) | function | Open or create a database |
| [`Database`](#database) | class | An open database |
| [`PreparedStatement`](#preparedstatement) | class | A compiled statement |
| [`SmaltdbError`](#smaltdberror) | class | The error type of every failed call |
| [`OpenOptions`](#openoptions) | type | Options of `open` |
| [`Queryable`](#queryable) | type | `query` and `exec`: what `Database` and the `tx` handle share |
| [`Transaction`](#transaction-1), [`TransactionStatement`](#transactionstatement) | type | The `tx` handle of `transaction`, and a prepared statement used through it |
| [`QueryOptions`](#queryoptions), [`StreamOptions`](#streamoptions) | type | Options of queries and streams |
| [`RowMode`](#rowmode) | type | `'object' \| 'array' \| 'columnar'` |
| [`RunResult`](#runresult) | type | Result of `exec` and `run` |
| [`ArrayResult`](#arrayresult), [`ColumnarResult`](#columnarresult) | type | Results in `'array'` and `'columnar'` row mode |
| [`SqlValue`](#sqlvalue), [`Params`](#params) | type | Values and parameters |
| [`ImportSource`](#importsource) | type | Input of `importCSV` / `importJSON` |
| [`CsvImportOptions`](#csvimportoptions), [`JsonImportOptions`](#jsonimportoptions), [`CsvExportOptions`](#csvexportoptions), [`JsonExportOptions`](#jsonexportoptions) | type | Import and export options |
| [`CredentialsProvider`](#credentialsprovider) | type | Credentials for `registerCredentials` |

## open

`open(name: string, options?: OpenOptions): Promise<Database>`

Starts an engine worker (or, with multi-tab access, joins the tab that owns the database) and opens the database `name`, creating it if it does not exist. Resolves when the database is open.

```ts
import { open } from 'smaltdb';

const db = await open('app');
const temp = await open('temp', { storage: 'memory' });
```

`name` identifies the database within the origin. For OPFS storage the files are `smaltdb/<name>.db` and siblings; see [storage](../../guide/databases#storage). The name `':memory:'` always opens an in-memory database.

Rejects with `SMALT_BUSY` if another engine worker holds the OPFS file without sharing it, and with `SMALT_WORKER` if the worker cannot be started.

### OpenOptions

| Option | Type | Default | Description |
|---|---|---|---|
| `storage` | `'opfs'` \| `'memory'` | `'opfs'` | `'opfs'` persists in the Origin Private File System; `'memory'` is discarded on close. |
| `pageSize` | `number` | `8192` | Page size in bytes for a new database (a power of two, 512 to 65536). Ignored for an existing one. |
| `cacheMB` | `number` | `16` | Page cache budget in MiB. |
| `durable` | `boolean` | `true` | Flush to storage on every commit. With `false`, recent commits can be lost in a crash. |
| `worker` | `() => Worker` \| `URL` \| `string` \| `Worker` | `new URL('./smaltdb-worker.js', import.meta.url)` | Where the engine worker comes from: a function that starts it (use this for a worker entry with [plugins](../../guide/plugins)), a script URL (started as a module worker) or a `Worker`. See [loading the engine worker](../../guide/getting-started#loading-the-engine-worker). |
| `multiTab` | `boolean` | `true` for OPFS when `navigator.locks` and `BroadcastChannel` exist | Share the database with other tabs of the origin. Never applies to in-memory databases. See [multi-tab access](../../guide/databases#multi-tab-access). |

## Database

An open database, returned by `open()`. It implements [`Queryable`](#queryable).

### query

`db.query<T, M>(sql: string, params?: Params, options?: QueryOptions & { rowMode?: M }): Promise<…>`

Runs one statement and resolves to all its rows. The result type depends on `rowMode`:

| `rowMode` | Resolves to |
|---|---|
| `'object'` or omitted | `T[]`, where `T` defaults to `Record<string, SqlValue>` |
| `'array'` | [`ArrayResult`](#arrayresult) |
| `'columnar'` | [`ColumnarResult`](#columnarresult) |

```ts
const people = await db.query<{ name: string; age: number }>('SELECT name, age FROM people WHERE age >= ?', [18]);
const table = await db.query('SELECT name, age FROM people', undefined, { rowMode: 'array' });
const cols = await db.query('SELECT age FROM people', undefined, { rowMode: 'columnar' });
```

`T` is not checked at run time. A statement without rows (an `INSERT` without `RETURNING`) runs and resolves to `[]`. Several statements in `sql` reject with `SMALT_SYNTAX`. While a [`transaction`](#transaction) of this `Database` runs, the call waits until it ends.

### exec

`db.exec(sql: string, params?: Params, options?: { signal?: AbortSignal }): Promise<RunResult>`

Runs statements for their effect. With `params`, `sql` must be a single statement. Without `params`, `sql` may be a script of statements separated by `;`, run in order, each committing on its own unless the script has `BEGIN … COMMIT`.

```ts
await db.exec('CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY, v TEXT)');
const { changes } = await db.exec('UPDATE kv SET v = ? WHERE k = ?', ['on', 'theme']);
```

Resolves to a [`RunResult`](#runresult). For a script, `changes` is that of the script's last `INSERT`, `UPDATE` or `DELETE`, or `0` if it has none; for a single statement other than those (a `SELECT`, DDL), it is `0`. With `params` and several statements, rejects with `SMALT_MISUSE`. `exec` calls on one `Database` run in call order and wait for a running [`transaction`](#transaction).

### stream

`db.stream<T, M>(sql: string, params?: Params, options?: StreamOptions & { rowMode?: M }): AsyncIterableIterator<…>`

Runs one statement and returns an async iterator over batches of rows. Each batch has the shape `query` would return for its `rowMode` (`T[]`, `ArrayResult` or `ColumnarResult`), with at most `batchSize` rows.

```ts
let total = 0;
for await (const batch of db.stream<{ amount: number }>('SELECT amount FROM payments', undefined, { batchSize: 1000 })) {
  for (const row of batch) total += row.amount;
}
```

The engine sends at most `highWaterMark` batches ahead and then waits for the loop. Leaving the loop early closes the result. While a stream is open on the owning engine worker, writes from this tab reject with `SMALT_BUSY`; see [streaming](../../guide/queries#streaming). Called while a [`transaction`](#transaction) of this `Database` runs, the stream starts when the transaction has ended; to stream inside the transaction, use `tx.stream`.

### prepare

`db.prepare(sql: string): Promise<PreparedStatement>`

Compiles one statement in the engine and resolves to a [`PreparedStatement`](#preparedstatement). Rejects with the statement's error (syntax, unknown table or column) at once.

```ts
const byId = await db.prepare('SELECT * FROM people WHERE id = ?');
const [person] = await byId.query([42]);
await byId.finalize();
```

### transaction

`db.transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>`

Runs `fn` in a transaction: `BEGIN`, then `fn(tx)`, then `COMMIT` when the promise `fn` returns resolves, or `ROLLBACK` when it rejects (the error is passed on). Resolves to `fn`'s result.

```ts
const id = await db.transaction(async (tx) => {
  const r = await tx.exec('INSERT INTO orders(customer) VALUES (?)', ['ann']);
  await tx.exec('INSERT INTO order_lines(order_id, item) VALUES (?, ?)', [r.lastInsertRowid, 'tea']);
  return r.lastInsertRowid;
});
```

Run statements through `tx` (a [`Transaction`](#transaction-1)). While `fn` runs, every other call on the same `Database` and its prepared statements (`query`, `exec`, `stream`, `prepare`, `transaction`, the import and export methods, `close`, and `query`, `stream` and `run` of a `PreparedStatement`) waits for the transaction to end, so awaiting one inside `fn` never finishes. Rejects with `SMALT_ERROR` if a transaction opened with SQL `BEGIN` is already open.

If `fn` ends the transaction itself through `tx`: after a `COMMIT`, the promise resolves to `fn`'s result; after a `ROLLBACK`, it rejects with `SMALT_ERROR` ("the transaction was rolled back inside the transaction callback"). See [transactions](../../guide/transactions).

### importCSV

`db.importCSV(table: string, source: ImportSource, options?: CsvImportOptions): Promise<{ rows: number }>`

Inserts the CSV records of `source` into `table`, in one transaction (or in a savepoint of the open SQL transaction). Resolves to the number of rows inserted. Rejects, with nothing inserted and no table created, if any row fails. See [CsvImportOptions](#csvimportoptions) and [importCSV](../../guide/import-export#importcsv).

```ts
const { rows } = await db.importCSV('people', 'name,age\nAnn,31\nBob,27\n');
```

### importJSON

`db.importJSON(table: string, source: ImportSource, options?: JsonImportOptions): Promise<{ rows: number }>`

Inserts a JSON array of objects or arrays, or NDJSON, into `table`, like `importCSV`. See [JsonImportOptions](#jsonimportoptions) and [importJSON](../../guide/import-export#importjson).

```ts
await db.importJSON('people', '[{"name": "Cy", "age": 40}]');
```

### exportCSV

`db.exportCSV(sql: string, params?: Params, options?: CsvExportOptions): Promise<string>`

Runs a query and resolves to its result as CSV text. See [CsvExportOptions](#csvexportoptions) and [exportCSV](../../guide/import-export#exportcsv).

```ts
const csv = await db.exportCSV('SELECT name, age FROM people ORDER BY name');
```

### exportJSON

`db.exportJSON(sql: string, params?: Params, options?: JsonExportOptions): Promise<string>`

Runs a query and resolves to its result as a JSON array of objects, or NDJSON with `{ format: 'ndjson' }`. See [exportJSON](../../guide/import-export#exportjson).

```ts
const ndjson = await db.exportJSON('SELECT * FROM people', undefined, { format: 'ndjson' });
```

### registerFile

`db.registerFile(name: string, file: Blob | Uint8Array | ArrayBuffer | string | { getFile(): Promise<Blob> } | null): Promise<void>`

Makes `file` readable from SQL as `file:<name>`, in `read_csv('file:<name>')`, `read_json`, `read_parquet` and external tables. `file` may be a `File` or `Blob`, a File System Access file handle, bytes, or text. `null` removes the registration. Nothing is copied into the database; the registration lives in the engine worker's memory until the database is closed. With multi-tab access, the client registers its files again with a new owner tab. See [external data](../../guide/external-data).

```ts
await db.registerFile('prices.csv', new Blob(['id,price\n1,9.5\n']));
const rows = await db.query("SELECT * FROM read_csv('file:prices.csv')");
```

### registerCredentials

`db.registerCredentials(name: string, provider: CredentialsProvider | null): Promise<void>`

Registers credentials that connections refer to by name (`CREATE CONNECTION c WITH (…, credentials = '<name>')`). They are used only for requests to URLs that start with `provider.endpoint`, live in the engine worker's memory, and are never stored in SQL or the database file. `null` removes them. Parts given as functions stay in this tab: the engine asks this tab for each request. See [CredentialsProvider](#credentialsprovider) and [external data](../../guide/external-data).

```ts
await db.registerCredentials('api', {
  endpoint: 'https://data.example.com/',
  headers: async () => ({ authorization: `Bearer ${await getToken()}` }),
});
declare function getToken(): Promise<string>;
```

### close

`db.close(): Promise<void>`

Closes the database. In the tab that owns the engine worker, it closes the files and terminates the worker; in other tabs it detaches. Waits for a running transaction and earlier `exec` calls. Calling it again does nothing; other calls on a closed database reject with `SMALT_MISUSE`.

### isLeader

`db.isLeader: boolean`

Whether this tab's engine worker owns the database. Always `true` without multi-tab access. With it, `false` in tabs that send their requests to another tab, until they take over.

### stats

`db.stats: { readerQueries: number; ownerQueries: number; morselQueries: number }`

Counts of queries answered by [parallel reader](../../guide/databases#parallel-readers) workers, by the owning engine worker, and by merging partial aggregates computed on readers. For diagnostics.

### Other members

`epoch` and the methods marked `@internal` in the type declarations (`attachWorker`, `attachShared`, `request`, `cancel`, `withLock`, `afterTransaction`, `rawQuery`, `rawExec`, `openStream`, `replayRegistrations`) are used by the client itself and are not part of the API.

## PreparedStatement

A statement compiled by [`db.prepare()`](#prepare). It belongs to the engine worker that prepared it.

| Member | Signature | Description |
|---|---|---|
| `columns` | `string[]` (read-only) | Result column names; `[]` for statements without rows. |
| `paramCount` | `number` (read-only) | Number of parameter slots. |
| `query` | `query<T, M>(params?: Params, options?: QueryOptions & { rowMode?: M }): Promise<…>` | Run and resolve to the rows, as [`db.query`](#query). |
| `stream` | `stream<T, M>(params?: Params, options?: StreamOptions & { rowMode?: M }): AsyncIterableIterator<…>` | Run and stream the rows, as [`db.stream`](#stream). |
| `run` | `run(params?: Params, options?: { signal?: AbortSignal }): Promise<RunResult>` | Run for effect, as [`db.exec`](#exec). |
| `finalize` | `finalize(): Promise<void>` | Free the statement. Later calls reject with `SMALT_MISUSE`. |

```ts
const insert = await db.prepare('INSERT INTO log(level, msg) VALUES (:level, :msg)');
for (const msg of ['started', 'ready']) await insert.run({ level: 'info', msg });
await insert.finalize();
```

While a [`transaction`](#transaction) of the `Database` runs, `query`, `stream` and `run` wait for it to end, like the `Database` methods; `run` also runs in call order with `exec`. Inside the transaction, use [`tx.statement(stmt)`](#transactionstatement). The members `db`, `rawQuery`, `rawStream` and `rawRun` are internal. With multi-tab access, a statement prepared before the owning tab changed rejects with `SMALT_RETRY` (`finalize` resolves without doing anything); prepare it again.

## SmaltdbError

`class SmaltdbError extends Error { readonly code: string }`

The error every failed call rejects with. `code` is one of the [error codes](./errors); `name` is `'SmaltdbError'`.

```ts
import { SmaltdbError } from 'smaltdb';

try {
  await db.exec('INSERT INTO kv(k, v) VALUES (?, ?)', ['theme', 'dark']);
} catch (e) {
  if (e instanceof SmaltdbError && e.code === 'SMALT_CONSTRAINT_PRIMARYKEY') {
    await db.exec('UPDATE kv SET v = ? WHERE k = ?', ['dark', 'theme']);
  } else throw e;
}
```

## Types

### Queryable

```ts
import type { Queryable } from 'smaltdb';

async function countRows(q: Queryable, table: 'people' | 'orders'): Promise<number> {
  const [row] = await q.query<{ n: number }>(`SELECT count(*) AS n FROM ${table}`);
  return row.n;
}
```

`query` and `exec`, with the same signatures as on `Database`. `Database` and the [`Transaction`](#transaction-1) handle implement it, so functions that take a `Queryable` work inside and outside transactions.

### Transaction

The `tx` argument of [`transaction`](#transaction). Everything run through it is part of the transaction. It works only while the callback runs: afterwards, its methods (and those of statements from `statement`) reject with `SMALT_MISUSE`.

| Member | Signature | Description |
|---|---|---|
| `query` | as [`db.query`](#query) | Run a query in the transaction. |
| `exec` | as [`db.exec`](#exec) | Run statements in the transaction. |
| `stream` | as [`db.stream`](#stream) | Stream a query's result in the transaction. |
| `statement` | `statement(stmt: PreparedStatement): TransactionStatement` | Use a statement prepared on this `Database` in the transaction. Throws `SMALT_MISUSE` for a statement of another `Database`. |

```ts
const insert = await db.prepare('INSERT INTO log(level, msg) VALUES (?, ?)');
await db.transaction(async (tx) => {
  const ins = tx.statement(insert);
  await ins.run(['info', 'one']);
  await ins.run(['info', 'two']);
});
```

### TransactionStatement

A prepared statement used through [`tx.statement()`](#transaction-1): `columns`, `paramCount`, and `query`, `stream` and `run` with the signatures of [`PreparedStatement`](#preparedstatement), running in the transaction. It has no `finalize`: finalize the `PreparedStatement` itself.

### QueryOptions

| Field | Type | Default | Description |
|---|---|---|---|
| `rowMode` | [`RowMode`](#rowmode) | `'object'` | Shape of the rows. |
| `batchSize` | `number` | `4096` | Rows per batch sent from the engine worker. |
| `signal` | `AbortSignal` | | Cancels the call. See [cancellation](../../guide/queries#cancellation). |

### StreamOptions

`QueryOptions` plus:

| Field | Type | Default | Description |
|---|---|---|---|
| `highWaterMark` | `number` | `4` | Batches the engine may send ahead of the consumer (at least 1). |

### RowMode

`type RowMode = 'object' | 'array' | 'columnar'`

### RunResult

| Field | Type | Description |
|---|---|---|
| `changes` | `number` | Rows changed by the `INSERT`, `UPDATE` or `DELETE`; `0` for other statements. |
| `lastInsertRowid` | `number` \| `bigint` | The rowid of the most recent successful `INSERT` on the engine's connection. |

### ArrayResult

`interface ArrayResult extends Array<SqlValue[]> { columns: string[] }`

Rows as value arrays, with the column names in `columns`.

### ColumnarResult

| Field | Type | Description |
|---|---|---|
| `columns` | `string[]` | Column names. |
| `length` | `number` | Number of rows. |
| `data` | `Record<string, Float64Array \| SqlValue[]>` | One entry per column name: a `Float64Array` when every value is a number (no NULL), else an array of values. |

### SqlValue

`type SqlValue = null | number | bigint | string | Uint8Array`

A SQL value in JavaScript: NULL, INTEGER (`number`, or `bigint` outside ±(2^53 − 1)), REAL, TEXT and BLOB. See [values](../../guide/queries#values).

### Params

`type Params = readonly (SqlValue | boolean | undefined)[] | Readonly<Record<string, SqlValue | boolean>>`

Positional values for `?` / `?NNN`, or an object for `:name`, `@name` and `$name`. `true` and `false` bind as `1` and `0`, `undefined` in an array as NULL, and `NaN` as NULL. A `bigint` outside the 64-bit INTEGER range, and an object for a statement with `?` or `?NNN` placeholders, reject with `SMALT_RANGE`. See [parameters](../../guide/queries#parameters).

### ImportSource

`type ImportSource = string | Uint8Array | ArrayBuffer | Blob`

Text, UTF-8 bytes, or a `Blob` / `File`.

### CsvImportOptions

| Field | Type | Default | Description |
|---|---|---|---|
| `header` | `boolean` | `true` | The first record names the columns. Without it, fields map to the table's columns in order. |
| `columns` | `string[]` | | Target columns, overriding the header. |
| `delimiter` | `string` | `','` | Single-character field separator. |
| `quote` | `string` | `'"'` | Single-character quote. |
| `emptyAsNull` | `boolean` | `true` | Unquoted empty fields become NULL; quoted `""` is always an empty string. |
| `create` | `boolean` | `false` | Create a missing table, inferring `INTEGER`, `REAL` or `TEXT` per column. If the import fails, the table is removed again. |

### JsonImportOptions

| Field | Type | Default | Description |
|---|---|---|---|
| `columns` | `string[]` | the table's columns | Target columns for arrays of arrays. |
| `create` | `boolean` | `false` | Create a missing table, inferring column types from the values. If the import fails, the table is removed again. |

### CsvExportOptions

| Field | Type | Default | Description |
|---|---|---|---|
| `header` | `boolean` | `true` | Write a header line. |
| `delimiter` | `string` | `','` | Field separator. |
| `nullString` | `string` | `''` | Text for NULL. |
| `crlf` | `boolean` | `false` | CRLF line endings instead of LF. |

### JsonExportOptions

| Field | Type | Default | Description |
|---|---|---|---|
| `format` | `'array'` \| `'ndjson'` | `'array'` | One JSON array of objects, or one object per line. |

### CredentialsProvider

| Field | Type | Description |
|---|---|---|
| `endpoint` | `string` | Credentials are used only for request URLs that start with this string. |
| `headers` | `Record<string, string>` or `(url: string) => Record<string, string> \| Promise<…>` | Extra request headers, such as `authorization`. |
| `aws` | `{ accessKeyId, secretAccessKey, sessionToken? }` or a function returning it (or a promise of it) | Keys to sign requests on `s3` connections (Signature Version 4). |
| `azure` | `{ sasToken }` \| `{ accountKey }` \| `{ bearerToken }`, or a function returning one | Authentication for `azure` connections. |
| `presign` | `(url: string, method: 'GET' \| 'HEAD') => string \| Promise<string>` | Returns a presigned URL to fetch instead of `url`. |

When any part is a function, the parts stay in this tab and the engine worker asks for the credentials of each request; a request fails with `SMALT_EXTERNAL` if no answer comes within 30 seconds, or when the tab closes. See [external data](../../guide/external-data).
