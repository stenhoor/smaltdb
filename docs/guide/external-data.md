# External data

smaltdb can query data that lives outside the database (CSV, TSV, JSON, NDJSON and Parquet files, from a URL, an S3 bucket, Azure Blob Storage, a file the user picked, or a path in Node) with the same SQL as local tables. External data is read-only: smaltdb reads it, but never writes to it.

There are three ways to use it:

| Way | Use it for |
| --- | --- |
| `read_csv()`, `read_json()`, `read_parquet()` | Ad hoc queries: previews, one-off imports. Nothing is stored in the database. |
| `CREATE EXTERNAL TABLE` | A source you query regularly: its location, format and columns are stored under a name. |
| A materialized view over either | A local copy: fast repeat reads and offline use, refreshed when the source changes. |

Reference pages: [CREATE CONNECTION and CREATE EXTERNAL TABLE](../reference/sql/external), [table-valued functions](../reference/functions/table-valued), [plugins](./plugins), [error codes](../reference/api/errors).

The runnable examples on this page read small files from the documentation's `docs/examples/` folder, registered under their file names (`file:ext-products.csv` and so on).

## Plugins

External data is not built into the core engine. Three [plugins](./plugins) provide it:

| Plugin | Provides | Depends on |
| --- | --- | --- |
| `@smaltdb/io` | The CSV, TSV, JSON and NDJSON formats; `read_csv()` and `read_json()` | Nothing |
| `@smaltdb/external` | Where data is read from: registered files (`file:`), `http://` and `https://` URLs, S3 (`s3://`), Azure Blob Storage (`az://`, `azure://`) and local paths in Node. The connection types `http`, `s3` and `azure`. The helpers `registerFile`, `registerCredentials` and `setFetch` | Nothing |
| `@smaltdb/parquet` | The Parquet format; `read_parquet()` | `hyparquet`; optionally `hyparquet-compressors` |

A read needs a plugin for the format and a plugin for the source. `read_csv('file:prices.csv')` needs both `@smaltdb/io` and `@smaltdb/external`.

Install the ones you use:

```sh
npm install smaltdb @smaltdb/io @smaltdb/external
```

In the browser, the plugins run in the engine worker. Write a worker entry that serves the engine with them:

```ts
// db-worker.ts
import { serve } from 'smaltdb/worker-runtime';
import io from '@smaltdb/io';
import external from '@smaltdb/external';

serve({ plugins: [io, external] });
```

Open the database with that worker:

```ts
import { open } from 'smaltdb';

const db = await open('app', {
  worker: () => new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' }),
});
```

In Node, pass the plugins to the in-process engine: `Database.openMemory({ plugins: [io, external] })`. See [Running statements over external data](#running-statements-over-external-data).

A statement that needs a missing plugin fails with `SMALT_PLUGIN_MISSING`, and the message names the plugin:

<!-- docs:skip -->
```sql
SELECT * FROM read_csv('file:prices.csv');
-- without @smaltdb/io:
--   read_csv('file:prices.csv'): the csv format needs the @smaltdb/io plugin (install it and add it to the engine's plugins)
-- with @smaltdb/io but without @smaltdb/external:
--   read_csv('file:prices.csv'): reading file:prices.csv needs the @smaltdb/external plugin (install it and add it to the engine's plugins)
```

## Reading files

A location starting with `file:` names a file the application has registered (see [Registering files](#registering-files)).

### CSV

```sql
SELECT * FROM read_csv('file:ext-products.csv');
```

| id | name | category | price | in_stock |
| --- | --- | --- | --- | --- |
| 1 | Kettle | kitchen | 24.5 | 12 |
| 2 | Toaster | kitchen | 39.9 | 0 |
| 3 | Desk lamp | office | 18 | 7 |
| 4 | Chair, swivel | office | 129 | 3 |
| 5 | Notebook | office | 2.75 | NULL |

The first line is the header. Column types are inferred from the values (see [Types](#types)), and an empty unquoted field is NULL.

Options are passed as named arguments with `=>`. This file has a comment line before the header, uses `;` as the delimiter and writes missing values as `NA`:

```text
# exported 2026-03-31
region;month;revenue
north;2026-01;1200
south;2026-01;NA
north;2026-02;1350
```

```sql
SELECT * FROM read_csv('file:ext-revenue.txt', skip => 1, delimiter => ';', null => 'NA');
```

| region | month | revenue |
| --- | --- | --- |
| north | 2026-01 | 1200 |
| south | 2026-01 | NULL |
| north | 2026-02 | 1350 |

### JSON and NDJSON

`read_json()` reads a JSON array of objects, or newline-delimited JSON (one object per line):

```sql
SELECT * FROM read_json('file:ext-orders.ndjson');
```

| order_id | product_id | qty | placed |
| --- | --- | --- | --- |
| 101 | 1 | 2 | 2026-03-01 |
| 102 | 3 | 1 | 2026-03-02 |
| 103 | 1 | 1 | 2026-03-02 |
| 104 | 4 | 4 | 2026-03-05 |

Each key becomes a column (keys are matched without regard to case; the first spelling seen names the column). A missing key is NULL, `true` and `false` become 1 and 0, and nested arrays and objects become JSON text:

```json
[
  {"store": "Leeds", "opened": 2019, "manager": "Priya", "tags": ["flagship", "north"]},
  {"store": "Bristol", "opened": 2021, "manager": null, "tags": []},
  {"store": "York", "opened": 2024.5, "manager": "Sam"}
]
```

```sql
SELECT store, opened, typeof(opened) AS type, manager, tags FROM read_json('file:ext-stores.json');
```

| store | opened | type | manager | tags |
| --- | --- | --- | --- | --- |
| Leeds | 2019 | real | Priya | ["flagship","north"] |
| Bristol | 2021 | real | NULL | [] |
| York | 2024.5 | real | Sam | NULL |

Because one `opened` value is a fraction, the whole column is REAL.

### Parquet

```sql
SELECT * FROM read_parquet('file:ext-sales.parquet');
```

| sold | region | product | units | price |
| --- | --- | --- | --- | --- |
| 2026-01-05 | north | apple | 12 | 0.5 |
| 2026-01-09 | south | pear | 4 | 0.75 |
| 2026-01-20 | north | pear | 7 | 0.75 |
| 2026-02-02 | west | apple | 9 | 0.5 |
| 2026-02-14 | south | apple | 15 | 0.45 |
| 2026-02-27 | north | plum | 3 | 1.2 |
| 2026-03-03 | west | plum | 6 | 1.1 |
| 2026-03-18 | south | pear | 8 | 0.8 |

Parquet needs the `@smaltdb/parquet` plugin; see [Parquet](#parquet) below.

### Using the results

The functions work wherever a table can appear: joins, subqueries, CTEs, views, and `INSERT … SELECT`:

```sql
SELECT p.name, o.qty
FROM read_csv('file:ext-products.csv') AS p
JOIN (SELECT product_id, sum(qty) AS qty
      FROM read_json('file:ext-orders.ndjson')
      GROUP BY product_id) AS o ON o.product_id = p.id
ORDER BY p.id;
```

| name | qty |
| --- | --- |
| Kettle | 3 |
| Desk lamp | 1 |
| Chair, swivel | 4 |

To copy external data into a table, create the table and insert into it (`CREATE TABLE … AS SELECT` is not supported):

```sql
CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price REAL);
INSERT INTO products SELECT id, name, price FROM read_csv('file:ext-products.csv');
SELECT count(*) AS n FROM products;
```

| n |
| --- |
| 5 |

For importing from JavaScript values or strings without registering a file, see also [Import and export](./import-export).

The function arguments must be constant: a literal, or an expression of literals such as `'file:' || 'ext-products.csv'`. A column of another table cannot name the file.

## Running statements over external data

The engine is synchronous, but fetching files is not. smaltdb therefore fetches every source a statement needs first (concurrently, each source once per statement), then runs the statement over the loaded rows.

- **With the worker client** (`smaltdb`), nothing changes: `db.query()`, `db.exec()`, `db.stream()` and prepared statements work as usual.
- **With the in-process engine** (`smaltdb/engine`, for example in Node or inside your own worker), use `queryAsync()`, `runAsync()` and `execAsync()`. The synchronous `query()`, `run()` and `exec()` fail with `SMALT_ASYNC_REQUIRED` for any statement that reads external data.

```ts
import { Database } from 'smaltdb/engine';
import io from '@smaltdb/io';
import external from '@smaltdb/external';
import { registerFile } from '@smaltdb/external/client';

const db = Database.openMemory({ plugins: [io, external] });
await registerFile(db, 'prices.csv', 'id,price\n1,9.5\n2,12\n');

const { rows } = await db.queryAsync("SELECT sum(price) AS total FROM read_csv('file:prices.csv')");
console.log(rows); // [[21.5]]
```

Statements that read external data always run on the engine worker that owns the database, never on [parallel readers](./analytics#parallel-readers). A cancelled request aborts its fetches and fails with `SMALT_INTERRUPT`.

## Registering files

In a browser, the engine cannot open the user's files by path. Register a file under a name with `registerFile(db, name, source)` from `@smaltdb/external/client`, then read it as `file:<name>`:

```ts
import { registerFile } from '@smaltdb/external/client';

const input = document.querySelector<HTMLInputElement>('#upload')!;

input.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (!file) return;
  await registerFile(db, 'upload.csv', file);
  const preview = await db.query("SELECT * FROM read_csv('file:upload.csv') LIMIT 20");
  console.table(preview);
});
```

`source` can be:

| Source | Notes |
| --- | --- |
| `File` or `Blob` | Read when a statement needs it. Parquet is read in slices, not loaded whole. |
| A file handle (any object with `getFile()`, such as a `FileSystemFileHandle`) | `getFile()` is called each time, so the latest contents are read. |
| `Uint8Array`, `ArrayBuffer` | The bytes. |
| `string` | The text. |
| `null` | Removes the registration. |

Registered files live in the engine worker's memory for as long as the database is open. They are not stored in the database file, and a reopened database needs them registered again. With multi-tab sharing, a tab's registrations are sent again to the new owner when ownership moves to another tab.

A registered name can contain slashes, and can be matched by [wildcards](#wildcards-and-partitions): `file:exports/*.csv`.

`registerFile` works the same with the in-process engine. In Node, `@smaltdb/external` also reads local paths, relative to the current directory:

<!-- docs:skip -->
```sql
SELECT * FROM read_csv('data/prices.csv');
```

In a browser, a location without a scheme is an error unless a [connection](#connections) supplies a base URL.

## Formats and reader options

The format comes from the `format` option, or else from the file extension. `read_csv()` defaults to CSV (TSV for `.tsv` files), `read_json()` to JSON and `read_parquet()` to Parquet.

| Extension | Format |
| --- | --- |
| `.csv`, `.txt` | CSV |
| `.tsv` | CSV with a tab delimiter |
| `.json`, `.ndjson`, `.jsonl` | JSON (an array or NDJSON, detected from the first character) |
| `.parquet`, `.pq` | Parquet |

Other extensions need the `format` option: `'csv'`, `'tsv'`, `'json'` (also `'ndjson'` or `'jsonl'`) or `'parquet'` (also `'pq'`). `txt` is an extension only, not a format name.

Reader options (named arguments of the functions, or `WITH (…)` options of an external table):

| Option | Default | Meaning |
| --- | --- | --- |
| `format` | from the extension | See above. |
| `header` | `true` | CSV: the first record names the columns. Without it, columns are `column1`, `column2`, … |
| `delimiter` | `,` (tab for TSV) | CSV: one character. |
| `quote` | `"` | CSV: one character. A doubled quote inside a quoted field is a literal quote. |
| `null` | none | CSV: text that is read as NULL, such as `'NA'`. Unquoted empty fields are NULL anyway; quoted ones are empty text. |
| `skip` | `0` | CSV: records to skip before the header. |
| `encoding` | `utf-8` | CSV and JSON: any encoding label `TextDecoder` accepts, such as `'latin1'`. |
| `hive_partitioning` | `true` for patterns | Read `key=value` directories as columns. See [Partitions](#partitions). |
| `connection` | none | The [connection](#connections) to read through. |

An unknown option is an error, so typos do not pass silently:

<!-- docs:error SMALT_EXTERNAL -->
```sql
SELECT * FROM read_csv('file:ext-products.csv', delim => ';');
```

## Types

Without declared columns, each column's type is inferred from all of its values:

| Source | Inference |
| --- | --- |
| CSV | `INTEGER` if every non-empty value is an integer, `REAL` if every value is a number, otherwise `TEXT`. Quoted values are always text. A column with no values at all is `TEXT`. |
| JSON | `INTEGER`, `REAL` or `TEXT` from the JSON values; integers and fractions mixed give `REAL`; any other mix gives `ANY`. |
| Parquet | From the file's schema; see [Parquet types](#parquet-types). |

```sql
SELECT name, typeof(id), typeof(price), typeof(in_stock)
FROM read_csv('file:ext-products.csv') WHERE id IN (1, 5);
```

| name | typeof(id) | typeof(price) | typeof(in_stock) |
| --- | --- | --- | --- |
| Kettle | integer | real | integer |
| Notebook | integer | real | null |

Repeated header names get a suffix (`a`, `a_2`), and empty ones are named `column1`, `column2`, … by position.

Declared columns (on an external table) convert values by SQLite's affinity rules instead: text that looks like a number becomes one in an `INTEGER`, `REAL` or `NUMERIC` column, and text in a `TEXT` column stays text. A value that does not convert is kept as it is, not rejected: declared types of external tables are conversions, not constraints.

## External tables

`CREATE EXTERNAL TABLE` stores a source under a name. Without a column list, the columns are inferred from the source when the table is created (for Parquet, from the file's footer) and stored with it, so later queries do not depend on the inference:

```sql
CREATE EXTERNAL TABLE ext_products WITH (location = 'file:ext-products.csv');
SELECT sql FROM sqlite_schema WHERE name = 'ext_products';
```

| sql |
| --- |
| CREATE EXTERNAL TABLE "ext_products" ("id" INTEGER, "name" TEXT, "category" TEXT, "price" REAL, "in_stock" INTEGER) WITH (location = 'file:ext-products.csv') |

Declare the columns to fix their names and types yourself:

```sql
CREATE EXTERNAL TABLE orders (order_id INTEGER, product_id INTEGER, qty INTEGER, placed TEXT)
  WITH (location = 'file:ext-orders.ndjson');

SELECT o.order_id, p.name, o.qty * p.price AS value
FROM orders o JOIN ext_products p ON p.id = o.product_id
ORDER BY o.order_id;
```

| order_id | name | value |
| --- | --- | --- |
| 101 | Kettle | 49 |
| 102 | Desk lamp | 18 |
| 103 | Kettle | 24.5 |
| 104 | Chair, swivel | 516 |

For CSV with a header, declared columns are matched to header fields by name when every declared name appears in the header, so you can declare only the columns you need, in any order. Otherwise they are matched by position, and the header must have as many fields as there are declared columns.

```sql
CREATE EXTERNAL TABLE price_list (price REAL, name TEXT) WITH (location = 'file:ext-products.csv');
SELECT * FROM price_list WHERE price > 30;
```

| price | name |
| --- | --- |
| 39.9 | Toaster |
| 129 | Chair, swivel |

What to know:

- **Re-read by every statement.** An external table has no stored rows and no indexes; each statement that reads it fetches the source again. For repeat reads, [cache it in a materialized view](#caching-in-a-materialized-view).
- **Read-only.** `INSERT`, `UPDATE` and `DELETE` fail with `table x may not be modified`, `CREATE INDEX` with `table x may not be indexed` and `ALTER TABLE` with `table x may not be altered` (`SMALT_ERROR`).
- **`PRAGMA table_info(x)`** and `pragma_table_info('x')` list its columns.
- **Columns cannot have constraints** (`PRIMARY KEY`, `NOT NULL`, …).
- **Creating without a column list reads the source**, so in the in-process engine it needs `execAsync()`.
- **Dropping** with `DROP EXTERNAL TABLE [IF EXISTS] name` removes only the catalog entry, never the source. `DROP TABLE` refuses an external table.
- **In the catalog**, `sqlite_schema` lists it with type `external`, `information_schema.tables` with table type `EXTERNAL`, and `information_schema.external_tables` shows its location, format, connection and options:

```sql
SELECT table_name, location, format, connection_name FROM information_schema.external_tables ORDER BY table_name;
```

| table_name | location | format | connection_name |
| --- | --- | --- | --- |
| ext_products | file:ext-products.csv | csv | NULL |
| orders | file:ext-orders.ndjson | json | NULL |
| price_list | file:ext-products.csv | csv | NULL |

`EXPLAIN QUERY PLAN` shows external sources as `SCAN EXTERNAL`:

```sql
EXPLAIN QUERY PLAN SELECT * FROM orders o JOIN ext_products p ON p.id = o.product_id;
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | HASH JOIN |
| 2 | 1 | 0 | SCAN EXTERNAL orders (file:ext-orders.ndjson) |
| 3 | 1 | 0 | SCAN EXTERNAL ext_products (file:ext-products.csv) |

## URLs

A location can be an `http://` or `https://` URL:

<!-- docs:skip -->
```sql
SELECT * FROM read_csv('https://data.example.com/v1/fx/rates.csv');
```

In a browser, the server must allow your origin with CORS headers. A network failure, including a CORS refusal, fails with `SMALT_EXTERNAL`, and the message mentions CORS. Check the browser's network panel for the cause. For `IF CHANGED` (below), the server should also expose the `ETag` or `Last-Modified` header. Parquet has further requirements; see [Parquet](#parquet).

Requests go through the global `fetch`. With the in-process engine, `setFetch(db, fn)` from `@smaltdb/external/client` replaces it for HTTP(S), S3 and Azure requests, for example to serve requests in tests; `null` restores `fetch`. A function cannot be sent to an engine worker, so this is for the in-process engine only.

```ts
import { Database } from 'smaltdb/engine';
import io from '@smaltdb/io';
import external from '@smaltdb/external';
import { setFetch } from '@smaltdb/external/client';

const db = Database.openMemory({ plugins: [io, external] });
await setFetch(db, async (url, init) => {
  console.log(init.method ?? 'GET', url);
  return fetch(url, init);
});
```

## Connections

A connection names an endpoint and, optionally, the credentials to use with it. Locations relative to a connection resolve against it:

<!-- docs:skip -->
```sql
CREATE CONNECTION rates_api WITH (url = 'https://data.example.com/v1/', credentials = 'rates-token');

CREATE EXTERNAL TABLE rates WITH (connection = 'rates_api', location = 'fx/rates.csv');
-- reads https://data.example.com/v1/fx/rates.csv

SELECT * FROM read_csv('fx/rates.csv', connection => 'rates_api');
```

Three types are supported:

| `type` | Options | Locations |
| --- | --- | --- |
| `'http'` (default) | `url`: the base URL | Relative paths, resolved against `url`; absolute URLs. |
| `'s3'` | `region` (default `us-east-1`), `bucket`, `endpoint` (for S3-compatible stores such as MinIO or Cloudflare R2), `url_style` (`'path'` or `'virtual'`; path-style by default when an `endpoint` is given, virtual-hosted otherwise) | Keys relative to `bucket`, or `s3://bucket/key`. |
| `'azure'` | `account` (required), `container`, `endpoint` (for emulators or other clouds; default `https://<account>.blob.core.windows.net`) | Paths relative to `container`, or `az://container/path`. |

Every type also takes `credentials`, the name of a provider the application registers (below). An unknown option is an error.

<!-- docs:skip -->
```sql
CREATE CONNECTION lake WITH (type = 's3', region = 'eu-west-1', bucket = 'analytics', credentials = 'lake-keys');
CREATE EXTERNAL TABLE events WITH (connection = 'lake', location = 'events/2026/*.parquet');

CREATE CONNECTION minio WITH (type = 's3', endpoint = 'http://localhost:9000', bucket = 'data', credentials = 'minio-keys');

CREATE CONNECTION exports WITH (type = 'azure', account = 'contoso', container = 'exports', credentials = 'contoso-sas');
SELECT * FROM read_csv('daily/rates.csv', connection => 'exports');
```

Connections contain no secrets, so they are safe to store in the database. `information_schema.connections` lists them:

```sql
CREATE CONNECTION lake WITH (type = 's3', region = 'eu-west-1', bucket = 'analytics', credentials = 'lake-keys');
SELECT connection_name, connection_type, url, credentials, options FROM information_schema.connections;
```

| connection_name | connection_type | url | credentials | options |
| --- | --- | --- | --- | --- |
| lake | s3 | NULL | lake-keys | {"region":"eu-west-1","bucket":"analytics"} |

`DROP CONNECTION [IF EXISTS] name` fails while an external table uses the connection.

## Credentials

Secrets never go into SQL or the database file. The application registers them at runtime with `registerCredentials(db, name, provider)` from `@smaltdb/external/client`, under the name that a connection's `credentials` option refers to. They live in the engine's memory until the database is closed. Pass `null` as the provider to remove them.

Every provider has an `endpoint`: credentials are only ever sent with requests to URLs that start with it. A connection that points elsewhere fails instead of leaking them, which protects you when a database file comes from someone else.

```ts
import { registerCredentials } from '@smaltdb/external/client';

declare const apiToken: string;

await registerCredentials(db, 'rates-token', {
  endpoint: 'https://data.example.com/',
  headers: { authorization: `Bearer ${apiToken}` },
});
```

A provider holds one of these:

| Field | Used for | Value |
| --- | --- | --- |
| `headers` | Any HTTP endpoint | Extra request headers, such as `authorization`. |
| `aws` | `s3` connections | `{ accessKeyId, secretAccessKey, sessionToken? }`. Requests are signed with AWS Signature Version 4 (in the engine, with WebCrypto). STS session tokens are supported. |
| `azure` | `azure` connections | `{ sasToken }`, `{ accountKey }` (requests are signed with Shared Key) or `{ bearerToken }` (Microsoft Entra ID). |
| `presign` | Any | A function `(url, method) => presigned URL`, called for each request. The returned URL is fetched instead, with no other authentication. |

`headers`, `aws` and `azure` can also be functions, called for each request. Use them for short-lived tokens or keys fetched from your backend. In the worker client, a provider with any function in it (including `presign`) stays in the tab that registered it, and the engine asks that tab for each request. The engine drops such credentials when that tab closes. A request fails with `SMALT_EXTERNAL` if the tab does not answer within 30 seconds. With the in-process engine, the functions are called directly.

```ts
import { registerCredentials } from '@smaltdb/external/client';

await registerCredentials(db, 'lake-keys', {
  endpoint: 'https://analytics.s3.eu-west-1.amazonaws.com/',
  aws: async () => {
    const res = await fetch('/api/s3-session');
    return (await res.json()) as { accessKeyId: string; secretAccessKey: string; sessionToken: string };
  },
});

await registerCredentials(db, 'contoso-sas', {
  endpoint: 'https://contoso.blob.core.windows.net/',
  azure: { sasToken: 'sv=2024-11-04&ss=b&sig=…' },
});

await registerCredentials(db, 'reports', {
  endpoint: 'https://reports.s3.amazonaws.com/',
  presign: async (url, method) => {
    const res = await fetch(`/api/presign?method=${method}&url=${encodeURIComponent(url)}`);
    return res.text();
  },
});
```

The endpoint is compared with the full request URL, so for S3 use the URL the bucket is reached at: `https://<bucket>.s3.<region>.amazonaws.com/` for virtual-hosted style, or the `endpoint` you configured for path style.

::: warning Anything in a browser is visible to its user
Keys registered in a page can be read by whoever uses that page. Give browsers short-lived, narrowly scoped credentials (STS session tokens, SAS tokens, presigned URLs) issued by your backend, never long-term keys.
:::

## Wildcards and partitions

A location can be a pattern that matches many files of the same layout:

| Pattern | Matches |
| --- | --- |
| `*` | Any characters within one directory level. |
| `**` | Any number of directory levels, including none. |
| `?` | One character. |
| `[abc]`, `[a-z]`, `[!abc]` | One character from a set, or not from it. |
| `{a,b}` | Either alternative. |

Patterns work for S3 and Azure (the bucket or container is listed), local paths in Node, and registered file names. They do not work for HTTP URLs, which cannot be listed.

Matching files are read concurrently and combined by column name, so files may order their columns differently. A file without one of the columns gives NULL for it. A pattern that matches nothing is an error.

### Partitions

Directories named `key=value` (Hive-style partitioning, as written by Spark, DuckDB, Athena and others) become columns. With these registered files:

```text
events/year=2025/month=12/a.csv
events/year=2026/month=01/a.csv
events/year=2026/month=02/a.csv
```

each containing `kind,n` rows, the pattern adds `year` and `month` columns:

<!-- docs:skip -->
```sql
CREATE EXTERNAL TABLE events WITH (location = 'file:events/**/*.csv');
SELECT sql FROM sqlite_schema WHERE name = 'events';
-- CREATE EXTERNAL TABLE "events" ("kind" TEXT, "n" INTEGER, "year" INTEGER, "month" INTEGER) WITH (location = 'file:events/**/*.csv')
```

Partition values are typed like CSV values (`month=02` is the integer 2), or by the declared type when you declare the column. The directory name `__HIVE_DEFAULT_PARTITION__` stands for NULL. `hive_partitioning => false` turns partition columns off for a pattern; `true` turns them on for a single file.

**Partition pruning.** For an external table, `WHERE` conditions that use only partition columns, constants and deterministic functions are checked against each file's path before anything is fetched. Files that cannot match are not read at all:

<!-- docs:skip -->
```sql
-- reads only events/year=2026/month=02/a.csv
SELECT kind, sum(n) FROM events WHERE year = 2026 AND month = 2 GROUP BY kind;

-- reads the two 2026 files
SELECT kind, sum(n) FROM events WHERE year >= 2026 GROUP BY kind;
```

Pruning applies to external tables, not to `read_csv()` and `read_json()` calls. It does not apply to a table on the right of a `LEFT JOIN`, to queries with `RIGHT` or `FULL` joins, or to conditions with parameters (`year = ?`).

## Parquet

Parquet is provided by the `@smaltdb/parquet` [plugin](./plugins), which reads files with [hyparquet](https://github.com/hyparam/hyparquet). Install it:

```sh
npm install @smaltdb/parquet
```

Add it to the plugins of your engine worker entry, next to `@smaltdb/external` for the source (see [Plugins](#plugins)):

```ts
// db-worker.ts
import { serve } from 'smaltdb/worker-runtime';
import external from '@smaltdb/external';
import parquet from '@smaltdb/parquet';

serve({ plugins: [external, parquet] });
```

In Node: `Database.openMemory({ plugins: [external, parquet] })`.

Snappy compression is built in. For gzip, zstd, brotli or LZ4-compressed files, also install the decompressors:

```sh
npm install hyparquet-compressors
```

Without the plugin, reading Parquet fails with `SMALT_PLUGIN_MISSING`, and the message names the plugin to install.

### Reading only what is needed

smaltdb does not download whole Parquet files. It reads:

1. the footer (starting with the last 16 KB of the file), which holds the schema and statistics;
2. only the column chunks of the columns the statement uses;
3. only the row groups whose statistics do not rule them out.

Remote files are read with HTTP `Range` requests, registered `File`s and `Blob`s with slices, and Node files with positioned reads. Files under 64 KB are read in one request.

Row groups are skipped using each column's minimum, maximum and NULL count, for `WHERE` conditions of the form `column op constant` (`=`, `<`, `<=`, `>`, `>=`), `BETWEEN` and `IN (…)` with constants. This works for `read_parquet()` calls and external tables alike, but not for a source on the right of a `LEFT JOIN` or with `RIGHT` or `FULL` joins. The answer is always the same as a full read.

```sql
CREATE EXTERNAL TABLE sales WITH (location = 'file:ext-sales.parquet');
SELECT region, sum(units) AS units FROM sales WHERE sold >= '2026-02-01' GROUP BY region ORDER BY region;
```

| region | units |
| --- | --- |
| north | 3 |
| south | 23 |
| west | 15 |

### Parquet types

| Parquet | SQL value |
| --- | --- |
| Integers (signed or unsigned), booleans | INTEGER (INT64 values beyond ±2^53 stay exact, as `bigint`) |
| Floats, doubles, decimals | REAL |
| Strings, enums, JSON, UUIDs | TEXT |
| Dates | TEXT, `YYYY-MM-DD` |
| Timestamps | TEXT, `YYYY-MM-DD HH:MM:SS[.fraction]` in UTC |
| Binary | BLOB |
| Lists, structs, maps | JSON text |

Dates and timestamps come out in the format SQLite's date functions use, so they compare and sort correctly as text and work with `date()`, `strftime()` and the rest:

```sql
SELECT sold, typeof(sold), strftime('%m', sold) AS month FROM sales LIMIT 2;
```

| sold | typeof(sold) | month |
| --- | --- | --- |
| 2026-01-05 | text | 01 |
| 2026-01-09 | text | 01 |

### CORS for remote Parquet

For HTTP, S3 and Azure locations, `@smaltdb/external` first learns the file's size with a range probe: a `GET` with `Range: bytes=0-0`. The total size comes from the `Content-Range` header of the `206` response (`bytes 0-0/<size>`). It does not use `Content-Length` from a `HEAD` request: hosts that compress responses, such as GitHub Pages, report the compressed size there, while ranges address the uncompressed bytes. Browsers send range requests with `Accept-Encoding: identity`, so range responses are not compressed.

Ranged reads from a browser need the server's CORS configuration to:

- allow the `Range` request header;
- expose the `Content-Range` response header, so the page can read the size from the probe;
- expose `ETag`, if you use `IF CHANGED`.

If the server ignores `Range` and answers the probe with `200`, that body is the whole file and is used as it is. If the probe's `206` has no readable total size (`Content-Range` is not exposed, or its total is `*`), the file is downloaded whole, without `Range`. If the reader then finds no Parquet footer where the size puts it, for example because the server reports the compressed size as the total, the file is downloaded whole and read again; other errors, such as a missing codec or a corrupt column chunk, are reported at once. Registered files and Node files have an exact size and are not read again.

How often such a file is downloaded depends on how it is read. A `read_parquet()` call reads the file twice per statement, once for its schema (the footer) and once for its rows, so it downloads it twice. An external table stores its columns when it is created, so a statement over it reads the file once. To download it once in all, [cache it in a materialized view](#caching-in-a-materialized-view).

For S3 and Azure, configure CORS on the bucket or storage account. Signed requests also send their own headers (for S3 with keys, `authorization`, `x-amz-date` and `x-amz-content-sha256`, plus `x-amz-security-token` with a session token), which must be allowed too.

## Caching in a materialized view

An external table is read again by every statement. To read it once and query a local copy, put a [materialized view](./views-and-materialized-views) over it:

```sql
CREATE MATERIALIZED VIEW products_local WITH (storage = 'columnar') AS
  SELECT * FROM ext_products;

SELECT category, count(*) AS n FROM products_local GROUP BY category ORDER BY category;
```

| category | n |
| --- | --- |
| kitchen | 2 |
| office | 3 |

The view is stored in the database, so it is also available offline. `REFRESH MATERIALIZED VIEW products_local` reads the source again.

### Refreshing only when the source changed

When a view over external data is refreshed, smaltdb records a validator for each source:

| Source | Validator |
| --- | --- |
| URL, S3 object, Azure blob | `ETag`, or else `Last-Modified` |
| Pattern | Every matching file's validator (for S3 and Azure, taken from the listing); if one file has none, the pattern counts as changed |
| Node file | Modification time and size |
| Registered `File` or file handle | `lastModified` and size |
| Registered `Blob`, bytes or text | None: it always counts as changed |

`REFRESH MATERIALIZED VIEW name IF CHANGED` asks each source for its current validator (a `HEAD` request, a listing or a file stat, not a download) and refreshes only if one differs:

```sql
REFRESH MATERIALIZED VIEW products_local IF CHANGED;
SELECT count(*) AS n FROM products_local;
```

| n |
| --- |
| 5 |

`IF CHANGED` is asynchronous: any call through the worker client runs it; in the in-process engine, use `execAsync()`, `runAsync()` or `queryAsync()`.

### Refreshing automatically

Two options let the engine worker refresh the view by itself, with `IF CHANGED`:

<!-- docs:skip -->
```sql
CREATE MATERIALIZED VIEW rates_local
  WITH (refresh_every = 300, refresh_on_reconnect = true) AS
  SELECT * FROM rates;
```

- `refresh_every = <seconds>`: when that long has passed since the last refresh or attempt;
- `refresh_on_reconnect = true`: when the browser comes back online.

`information_schema.materialized_views` shows the policy in `refresh_mode` and the last automatic refresh's error, such as a failed request while offline, in `last_refresh_error`. In the in-process engine nothing runs on a timer; run `REFRESH … IF CHANGED` yourself. See [Refresh policies](./views-and-materialized-views#refresh-policies).

Views over external data are never used by `PRAGMA matview_rewrite` to answer queries on the external table, because smaltdb cannot know when the source changes.

## Errors

| Code | Raised when |
| --- | --- |
| `SMALT_PLUGIN_MISSING` | The statement needs a [plugin](#plugins) the engine does not have. The message names it. |
| `SMALT_EXTERNAL` | A source cannot be fetched or parsed. The message names the source and the cause: the HTTP status, the CSV line, the JSON item, a missing registered file, an unknown option, or a network or CORS failure. |
| `SMALT_ASYNC_REQUIRED` | The in-process engine's synchronous API ran a statement that reads external data, or `REFRESH … IF CHANGED`. Use the `…Async` methods. |
| `SMALT_INTERRUPT` | The request was cancelled while fetching. |
| `SMALT_ERROR` | SQL-level mistakes, such as a connection that does not exist. |

<!-- docs:error SMALT_EXTERNAL -->
```sql
SELECT * FROM read_csv('file:ext-revenue.txt', delimiter => ';');
```

This fails with `read_csv('file:ext-revenue.txt'): CSV line 2: expected 1 fields but found 3`, because the comment line was taken as the header. See [Errors](./errors) for handling errors in general.

## See also

- [ADR 0011](../adr/0011-external-tables): the design of external data
- [Import and export](./import-export): loading data from JavaScript
- [Analytics](./analytics): columnar storage for the local copy
