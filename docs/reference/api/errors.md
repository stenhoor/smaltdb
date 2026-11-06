# Error codes

Every error smaltdb raises carries a `code`. In the client it is a [`SmaltdbError`](https://stenhoor.github.io/smaltql/reference/api/client#smaltdberror); in the engine it is a [`SmaltError`](./engine#errors) or a subclass. Codes are strings that start with `SMALT_`. Where SQLite has a matching result code, the name follows it (`SQLITE_BUSY` → `SMALT_BUSY`).

The [errors guide](https://stenhoor.github.io/smaltql/guide/errors) shows how to handle them. This page lists every code the engine and client raise, what causes it, and what to do.

Besides `code` and `message`, an error carries what it is about as fields, so a language or an application can word
it for its users ([ADR 0016](../../adr/0016-plan-api-for-every-language.md), section 10):

| Field | |
|---|---|
| `origin` | The `origin` of the [plan node](../engine/plans#expressions) it arose in, the innermost one that has an origin, as the language that built the plan gave it (a SQL text span, a call site) |
| `constraint` | For a constraint failure: `notNull`, `unique`, `primaryKey`, `check`, `foreignKey` or `datatype` |
| `table` | The table the constraint is on |
| `columns` | The columns it covers (none for an index on expressions; a foreign key counted across a statement names none) |
| `constraintName` | The constraint's name, or its index's |

| Code | Meaning | Retry? |
|---|---|---|
| [`SMALT_ERROR`](#smalt-error) | General SQL error: unknown table or column, misuse of a statement, bad data in an import | No |
| [`SMALT_SYNTAX`](#smalt-syntax) | The SQL does not parse | No |
| [`SMALT_UNSUPPORTED`](#smalt-unsupported) | Valid SQL that smaltdb does not support | No |
| [`SMALT_CONSTRAINT_NOTNULL`](#smalt-constraint-notnull) | NULL in a `NOT NULL` column | No |
| [`SMALT_CONSTRAINT_UNIQUE`](#smalt-constraint-unique) | Duplicate value for a `UNIQUE` constraint or index | No |
| [`SMALT_CONSTRAINT_PRIMARYKEY`](#smalt-constraint-primarykey) | Duplicate primary key | No |
| [`SMALT_CONSTRAINT_CHECK`](#smalt-constraint-check) | A `CHECK` constraint failed | No |
| [`SMALT_CONSTRAINT_FOREIGNKEY`](#smalt-constraint-foreignkey) | A foreign key constraint failed | No |
| [`SMALT_CONSTRAINT_DATATYPE`](#smalt-constraint-datatype) | A value cannot be stored in the column's type | No |
| [`SMALT_MISMATCH`](#smalt-mismatch) | A value of the wrong kind where a specific kind is required | No |
| [`SMALT_RANGE`](#smalt-range) | Wrong number of parameters, or a missing parameter | No |
| [`SMALT_TOOBIG`](#smalt-toobig) | An index key is too large | No |
| [`SMALT_FULL`](#smalt-full) | No more rowids | No |
| [`SMALT_BUSY`](#smalt-busy) | The database is in use in a way that blocks the request | After the blocker ends |
| [`SMALT_INTERRUPT`](#smalt-interrupt) | The request was cancelled | Your choice |
| [`SMALT_RETRY`](#smalt-retry) | The tab that owned the database changed | Yes |
| [`SMALT_MISUSE`](#smalt-misuse) | The API was used incorrectly (closed database, finalized statement) | No |
| [`SMALT_PLUGIN_MISSING`](#smalt-plugin-missing) | A feature needs a plugin the engine does not have | After installing it |
| [`SMALT_EXTERNAL`](#smalt-external) | Reading external data failed | Often |
| [`SMALT_ASYNC_REQUIRED`](#smalt-async-required) | A synchronous engine call needs external data | Use the async method |
| [`SMALT_PLAN`](#smalt-plan) | A plan given to the engine is not valid | No |
| [`SMALT_CANTOPEN`](#smalt-cantopen) | A database file cannot be opened | No |
| [`SMALT_NOTADB`](#smalt-notadb) | The file is not a smaltdb database | No |
| [`SMALT_FORMAT`](#smalt-format) | The file has an unsupported format version | No |
| [`SMALT_CORRUPT`](#smalt-corrupt) | The database file is damaged | No |
| [`SMALT_READONLY`](#smalt-readonly) | A write on a read-only snapshot | No |
| [`SMALT_WORKER`](#smalt-worker) | The engine worker failed | Reopen |
| [`SMALT_INTERNAL`](#smalt-internal) | An unexpected error inside the engine | No |

Unless noted, a statement that fails changes nothing: it is rolled back on its own, and an open transaction stays open.

## SMALT_ERROR

The general error for SQL that refers to things that do not exist or uses them wrongly. The message says what is wrong. Common causes:

- an unknown table, column, function, view, index, savepoint or connection;
- an object that already exists (`CREATE TABLE` without `IF NOT EXISTS`);
- transaction control out of place: `BEGIN` inside a transaction, `COMMIT` or `ROLLBACK` without one;
- a `db.transaction()` callback that ran `ROLLBACK` itself (`the transaction was rolled back inside the transaction callback`);
- a query that is valid syntax but not valid SQL (an aggregate in `GROUP BY`, a compound `SELECT` whose sides have different column counts, an ambiguous column name);
- an integer overflow in arithmetic or `sum()`;
- bad import data: malformed CSV or JSON, a JSON item that is not an object or array (or does not match the first item's kind), a wrong field count, an unknown column name.

**Remedy:** fix the SQL or the data.

<!-- docs:error SMALT_ERROR -->
```sql
SELECT * FROM no_such_table;
```

## SMALT_SYNTAX

The SQL does not parse. The message gives the token and position: `SELEC 1` fails with `near "SELEC": syntax error (line 1, column 1)`. `query()` and `prepare()` accept one statement only; a second statement is reported as a syntax error. (`exec()` with parameters reports it as `SMALT_MISUSE`.)

**Remedy:** fix the SQL. See the [SQL reference](https://stenhoor.github.io/smaltql/reference/sql/).

## SMALT_UNSUPPORTED

The SQL is valid in SQLite, or reserved for a future version, but smaltdb does not support it. Examples: `WITHOUT ROWID` tables, generated columns, `CREATE TABLE … AS SELECT`, some `PRAGMA`s, `UPDATE … ORDER BY/LIMIT`, indexes on columnar tables. The message names the feature.

**Remedy:** rewrite the statement without the feature. See [differences from SQLite](https://stenhoor.github.io/smaltql/guide/sqlite-differences).

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
CREATE TABLE w(a INTEGER PRIMARY KEY) WITHOUT ROWID;
```

## SMALT_CONSTRAINT_NOTNULL

An `INSERT` or `UPDATE` would store NULL in a `NOT NULL` column. Message: `NOT NULL constraint failed: table.column`.

**Remedy:** provide a value, or give the column a `DEFAULT`.

<!-- docs:error SMALT_CONSTRAINT_NOTNULL -->
```sql
CREATE TABLE users(id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, age INTEGER CHECK (age >= 0));
INSERT INTO users(email) VALUES (NULL);
```

## SMALT_CONSTRAINT_UNIQUE

An `INSERT` or `UPDATE` would create a second row with the same value in a `UNIQUE` column or unique index. Message: `UNIQUE constraint failed: table.column`.

**Remedy:** use a different value, or turn the insert into an upsert (`ON CONFLICT … DO UPDATE` or `DO NOTHING`, see [INSERT](https://stenhoor.github.io/smaltql/reference/sql/insert)).

<!-- docs:error SMALT_CONSTRAINT_UNIQUE -->
```sql
INSERT INTO users(email) VALUES ('a@example.com'), ('a@example.com');
```

## SMALT_CONSTRAINT_PRIMARYKEY

A row with the same primary key exists already. The message has the same form as for `UNIQUE`: `UNIQUE constraint failed: table.column`.

**Remedy:** as for `SMALT_CONSTRAINT_UNIQUE`.

<!-- docs:error SMALT_CONSTRAINT_PRIMARYKEY -->
```sql
INSERT INTO users(id, email) VALUES (1, 'b@example.com'), (1, 'c@example.com');
```

## SMALT_CONSTRAINT_CHECK

A `CHECK` constraint is false for the new row. Message: `CHECK constraint failed: <constraint>`.

**Remedy:** fix the data.

<!-- docs:error SMALT_CONSTRAINT_CHECK -->
```sql
INSERT INTO users(email, age) VALUES ('d@example.com', -1);
```

## SMALT_CONSTRAINT_FOREIGNKEY

A row refers to a parent row that does not exist, or a parent row that is still referenced would be deleted or changed. Message: `FOREIGN KEY constraint failed`. For deferred foreign keys, the error comes from `COMMIT`, and the transaction stays open so you can fix the data.

**Remedy:** insert the parent first, delete children first, or use an `ON DELETE` action. See [tables and schema](https://stenhoor.github.io/smaltql/guide/schema).

<!-- docs:error SMALT_CONSTRAINT_FOREIGNKEY -->
```sql
CREATE TABLE orders(id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id));
INSERT INTO orders(user_id) VALUES (999);
```

## SMALT_CONSTRAINT_DATATYPE

A value cannot be converted to the column's declared type. Tables are strictly typed, so `'abc'` cannot go into an `INTEGER` column. Message: `cannot store TEXT value in INTEGER column table.column`.

**Remedy:** convert the value first (`CAST`, or in JavaScript), or declare the column `ANY`. See [data types](https://stenhoor.github.io/smaltql/reference/sql/types).

<!-- docs:error SMALT_CONSTRAINT_DATATYPE -->
```sql
INSERT INTO users(email, age) VALUES ('e@example.com', 'abc');
```

## SMALT_MISMATCH

A value of the wrong kind where one kind is required. Message: `datatype mismatch`, or more specific. Causes:

- `LIMIT` or `OFFSET` that is NULL or not an integer;
- a rowid (`INTEGER PRIMARY KEY`) value that is not an integer;
- a parameter of an unsupported JavaScript type, such as a `Date` or an `ArrayBuffer` (`unsupported parameter type`);
- a materialized view whose query produced a value that does not fit a view column.

**Remedy:** pass a value of the right type. See [values](https://stenhoor.github.io/smaltql/guide/queries#values).

<!-- docs:error SMALT_MISMATCH -->
```sql
SELECT 1 LIMIT NULL;
```

## SMALT_RANGE

The parameters do not match the statement:

- an array with the wrong number of values (`statement expects 2 parameter(s), got 1`);
- no parameters for a statement that has placeholders (`statement expects 1 parameter(s)`);
- an object without a key for a named parameter (`missing value for parameter :id`);
- an object for a statement that has `?` or `?NNN` placeholders (`statement has positional parameters (? or ?NNN): bind them with an array, not an object`);
- a `bigint` outside the 64-bit INTEGER range (`parameter ?1: integer 9223372036854775808 is out of range (INTEGER values are 64-bit signed)`).

Also raised by the CSV import when `delimiter` or `quote` is not a single character.

**Remedy:** pass one value per placeholder, within range. See [parameters](https://stenhoor.github.io/smaltql/guide/queries#parameters).

<!-- docs:error SMALT_RANGE -->
```sql
SELECT ?;
```

## SMALT_TOOBIG

A value is too large to be stored in an index: index keys must fit within a page. Message: `index key too large for index <name>`. The limit depends on the page size.

**Remedy:** do not index long text or blobs. Index a prefix or a hash instead, for example an [index on an expression](https://stenhoor.github.io/smaltql/reference/sql/create-index), or open the database with a larger `pageSize`.

<!-- docs:error SMALT_TOOBIG -->
```sql
CREATE TABLE docs(body TEXT);
CREATE INDEX docs_body ON docs(body);
INSERT INTO docs VALUES (hex(zeroblob(10000)));
```

## SMALT_FULL

A new row needs a rowid, the largest rowid in the table is already the largest 64-bit integer, and no free one was found: as in SQLite, 100 random candidates were all taken, or the table is `AUTOINCREMENT` (which never picks random rowids). Message: `database or disk is full (rowid space exhausted)`.

**Remedy:** do not store values near 2^63 − 1 in an `INTEGER PRIMARY KEY`; use a separate column for them.

<!-- docs:error SMALT_FULL -->
```sql
CREATE TABLE seq(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);
INSERT INTO seq VALUES (9223372036854775807, 'max');
INSERT INTO seq(v) VALUES ('next');
```

## SMALT_BUSY

The request cannot run now because of something else holding the database:

| Message | Cause | Remedy |
|---|---|---|
| `cannot modify the database while a query cursor is open; finish or close it first` | A write from a tab that has an open [stream](https://stenhoor.github.io/smaltql/guide/queries#streaming) on the owning engine worker. In the engine, a write while a `RowCursor` is open. | Finish or close the stream (or cursor), then write. |
| `cannot lock <name>.db: …` | Another engine worker has the OPFS file open: another tab or `open()` call, with multi-tab access off or unavailable. | Close the other database, or use [multi-tab access](https://stenhoor.github.io/smaltql/guide/databases#multi-tab-access). |
| `cannot checkpoint inside a transaction` | Engine `checkpoint()` called inside a transaction. | Call it after `COMMIT`. |

## SMALT_INTERRUPT

The request was cancelled through its `AbortSignal` (message `interrupted`), or the fetch of external data it was waiting for was aborted. A statement that was interrupted while running has been rolled back. See [cancellation](https://stenhoor.github.io/smaltql/guide/queries#cancellation).

**Remedy:** none needed. Run the request again if you still want its result.

## SMALT_RETRY

Client only, with [multi-tab access](https://stenhoor.github.io/smaltql/guide/databases#multi-tab-access). The tab whose engine worker owned the database closed, and another took over:

- requests that were in flight are lost (message `the tab that owned the database closed; retry`);
- a `PreparedStatement` prepared before the change cannot be used (message `the tab that owned the database changed; prepare the statement again`).

An open transaction of this tab is gone too.

**Remedy:** retry the request, or prepare the statement again. A write that was in flight may have committed before the owner closed: make retried writes safe to repeat. See [retrying](https://stenhoor.github.io/smaltql/guide/errors#retrying).

## SMALT_MISUSE

The API was used in a way that cannot work:

| Message | Cause |
|---|---|
| `database is closed` | A call on a closed `Database` (client or engine). |
| `statement is finalized` | A call on a `PreparedStatement` after `finalize()`. |
| `parameters can only be bound with a single statement` | `exec` (client or engine) or engine `execAsync` with parameters and several statements. |
| `the transaction has ended: use tx only while the transaction callback runs` | A method of a `db.transaction()` handle (`tx`) called after its callback finished. |
| `the statement was prepared on another Database` | `tx.statement(stmt)` with a statement of another `Database`. |
| `invalid page size …` | A `pageSize` that is not a power of two from 512 to 65536. |
| `plugin … needs plugin API version …; this engine implements version 1` | A plugin written for another version of the [plugin interface](./plugins). |
| `plugin … is installed twice` | The same plugin listed twice in `plugins`. |
| `plugin …: format 'csv' is already defined` (or table function, source prefix, connection type, method) | Two plugins register the same name. |
| `plugin … has no method …` | `callPlugin` with a method the plugin does not have. |
| `serve() was already called in this worker` | A second `serve()` call in an engine worker entry. |

Low-level engine classes (pager, b-tree, VFS) raise it for invalid calls as well.

**Remedy:** fix the calling code.

## SMALT_PLUGIN_MISSING

A statement or a plugin call needs a [plugin](https://stenhoor.github.io/smaltql/guide/plugins) the engine does not have. The message names smaltdb's plugin for the feature when there is one:

- a format: `read_parquet('file:x.parquet'): the parquet format needs the @smaltdb/parquet plugin (install it and add it to the engine's plugins)`;
- a source: `read_csv('file:x.csv'): reading file:x.csv needs the @smaltdb/external plugin (…)`, or `reading the path 'data/x.csv'` for a local path;
- a connection type, in `CREATE CONNECTION` or when a statement reads through the connection: `connection c: an s3 connection needs the @smaltdb/external plugin (…)`;
- a plugin helper: `importCSV(): import and export needs the @smaltdb/io plugin (…)`, `registerFile(): registering files and credentials needs the @smaltdb/external plugin (…)`;
- a format no plugin is known for: `read_csv('file:x.dat'): no installed plugin provides the 'xml' format (installed: csv, json, jsonl, ndjson, tsv)`.

It is raised when a statement is planned or run, or when a plugin method is called, never when a database is opened. External tables and connections created with a plugin stay in the catalog without it.

**Remedy:** install the plugin and add it to the engine: `serve({ plugins: [...] })` in the engine worker entry, with `worker: () => new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' })` in `open()`, or `Database.openMemory({ plugins })` / `Database.open(…, { plugins })` with `smaltdb/engine`. See [plugins](https://stenhoor.github.io/smaltql/guide/plugins).

## SMALT_EXTERNAL

Reading [external data](https://stenhoor.github.io/smaltql/guide/external-data) failed. Plugins raise it: a format or source plugin that throws a plain `Error` is reported as `SMALT_EXTERNAL` (see [Writing plugins](./plugins#errors)). The message starts with the source (`read_csv('file:x.csv'): …`, a URL, an external table) and says why: no file registered under that name, an HTTP error, a network failure, a file that does not parse, a missing optional package (`this file uses a codec that needs the hyparquet-compressors package`), or credentials that could not be obtained (a credentials callback that failed, did not answer within 30 seconds, or whose tab closed).

**Remedy:** depends on the cause. Network and HTTP errors are often temporary and can be retried.

<!-- docs:error SMALT_EXTERNAL -->
```sql
SELECT * FROM read_csv('file:not-registered.csv');
```

## SMALT_ASYNC_REQUIRED

Engine only. A synchronous call (`query`, `run`, `exec`, `Statement.run` …) was given a statement that reads external data, which must be fetched first, or `REFRESH MATERIALIZED VIEW … IF CHANGED`, which checks its sources first. The client never raises it: the engine worker uses the async path.

**Remedy:** use `queryAsync`, `runAsync` or `execAsync`. See the [engine API](./engine#external-data).

## SMALT_CANTOPEN

A file cannot be opened: OPFS refused to open or create it, OPFS sync access handles do not exist where the engine runs (engine `OpfsVfs` in Node, on a page's main thread, or in a browser without OPFS), or a file that must exist does not (engine `MemoryVfs.open` with `create: false`, a parallel reader opening a database that was never written).

**Remedy:** check that OPFS is available and the storage quota is not exhausted.

## SMALT_NOTADB

The file exists but does not start with the smaltdb file header. smaltdb does not read SQLite database files.

**Remedy:** open a different name, or delete the file.

## SMALT_PLAN

A statement given as plan data ([`preparePlan`, `queryPlan`](./engine#plans)) is not a valid plan: an unknown operation or function, a column position its input does not have, a table that does not exist, a wrong number of arguments, parameters beyond the limit, or a plan nested deeper than 1000 levels. The message gives the path to the part that is wrong, such as `invalid plan at plan.input.pred.args[1]: …`. A plan with a newer format version than the engine reads is refused the same way.

**Remedy:** fix the plan. Plans built by a language are valid; this error points at a bug in the code that built the plan.

## SMALT_FORMAT

The file was written by a version of smaltdb with a different major format version, which this version cannot read. Message: `unsupported format version N.x (engine supports M.x)`.

**Remedy:** open it with a matching smaltdb version and export the data.

## SMALT_CORRUPT

The database file is damaged: a page checksum does not match, a page or record has an impossible layout, or an index points at a row that does not exist. Page checksums are checked on every read from storage, so damage is reported when it is read, not ignored.

**Remedy:** restore from a backup or export what can still be read. `PRAGMA integrity_check` lists problems it can find.

## SMALT_READONLY

A write reached a read-only snapshot (`attempt to write a read-only snapshot`). Only parallel reader workers open read-only snapshots, and they are only given read-only queries, so applications should not see this code.

## SMALT_WORKER

Client only. The engine worker raised an error event: it failed to load (a wrong `worker` URL, a script that is not the smaltdb worker, a blocked module worker) or crashed. All pending requests reject with this code.

**Remedy:** check the browser console and the [worker setup](https://stenhoor.github.io/smaltql/guide/getting-started#loading-the-engine-worker). Open the database again.

## SMALT_INTERNAL

The engine worker caught an error that is not a smaltdb error, such as a `TypeError` from a bug or a browser API failure, or a plain `Error` thrown by a plugin method. The message is the original error's message (or its name when the message is empty).

**Remedy:** report it, with the message and the SQL, at the project's issue tracker.
