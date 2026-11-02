# External tables

An external table is a catalog entry for data that lives outside the database: a CSV, JSON or Parquet file in the browser, on a web server, in S3 or Azure Blob Storage, or on disk in Node. Queries read it like a table; the database never writes to it. A connection names an endpoint and the credentials for it.

This page is the syntax reference. For a walk-through, registering files and credentials, patterns, partitions and caching, see [External data](../../guide/external-data). To read a file once without a catalog entry, use [`read_csv`, `read_json` and `read_parquet`](../functions/table-valued).

## CREATE CONNECTION

```text
CREATE CONNECTION [IF NOT EXISTS] name WITH (option = value [, ...])
```

A connection is stored in the database file. It holds no secrets: `credentials` names a provider that the application registers at runtime with `registerCredentials` (see the [client API](../api/client)), and that provider's material is only sent to URLs that start with its `endpoint`.

Options by `type`:

| Option | `http` (default) | `s3` | `azure` | Meaning |
| --- | --- | --- | --- | --- |
| `type` | ✓ | ✓ | ✓ | `'http'` (also `'https'`, the same type), `'s3'` or `'azure'`, in any case; other values fail (`type 'ftp' is not supported`) |
| `url` | ✓ | | | base URL; relative locations resolve against it |
| `region` | | ✓ | | AWS region (default `us-east-1`) |
| `bucket` | | ✓ | | bucket for relative locations |
| `endpoint` | | ✓ | ✓ | S3-compatible endpoint (MinIO, R2, …) or Azure endpoint (emulator, sovereign cloud) |
| `url_style` | | ✓ | | `'path'` or `'virtual'`; default path-style when `endpoint` is given, virtual-hosted otherwise |
| `account` | | | ✓ (required) | storage account name |
| `container` | | | ✓ | container for relative locations |
| `credentials` | ✓ | ✓ | ✓ | name of a registered credentials provider |

Without `endpoint`, S3 requests go to `https://<bucket>.s3.<region>.amazonaws.com` and Azure requests to `https://<account>.blob.core.windows.net`.

```sql
CREATE CONNECTION web WITH (url = 'https://data.example.com/v1/', credentials = 'api-token');
CREATE CONNECTION lake WITH (type = 's3', region = 'eu-west-1', bucket = 'analytics', credentials = 'aws');
CREATE CONNECTION minio WITH (type = 's3', endpoint = 'http://localhost:9000', bucket = 'test');
CREATE CONNECTION blobs WITH (type = 'azure', account = 'mystore', container = 'exports', credentials = 'az');
SELECT connection_name, connection_type, url, credentials, options FROM information_schema.connections
```

| connection_name | connection_type | url | credentials | options |
| --- | --- | --- | --- | --- |
| web | http | `https://data.example.com/v1/` | api-token | {} |
| lake | s3 | NULL | aws | {"region":"eu-west-1","bucket":"analytics"} |
| minio | s3 | NULL | NULL | `{"endpoint":"http://localhost:9000","bucket":"test"}` |
| blobs | azure | NULL | az | {"account":"mystore","container":"exports"} |

Creating a connection does not contact the endpoint. Errors (`SMALT_ERROR`):

| Problem | Message |
| --- | --- |
| unknown type | `connection c: type 'ftp' is not supported (http, s3, azure)` |
| option not valid for the type | `connection c: unknown option 'url' for type s3 (type, region, bucket, endpoint, url_style, credentials)` |
| `url` or `endpoint` not http(s) | `connection c: url must be an http(s) URL` |
| azure without `account` | `connection c: an azure connection needs account (the storage account name)` |
| bad `url_style` | `connection c: url_style must be 'path' or 'virtual'` |
| name in use | `connection c already exists` |

<!-- docs:error SMALT_ERROR -->
```sql
CREATE CONNECTION bad WITH (type = 's3', url = 'https://example.com')
```

Connections have their own namespace (a connection and a table may share a name). `sqlite_schema` lists them with type `connection`.

## DROP CONNECTION

```text
DROP CONNECTION [IF EXISTS] name
```

Fails while an external table uses the connection: `connection lake is used by external table x`.

## CREATE EXTERNAL TABLE

```text
CREATE EXTERNAL TABLE [IF NOT EXISTS] [main.]name [(column [type] [, ...])]
  WITH (location = 'where', option = value [, ...])
```

| Option | Meaning |
| --- | --- |
| `location` | required: where the data is; see [Locations](#locations) |
| `connection` | name of a connection; relative locations resolve against it, and its credentials are used |
| `format` | `'csv'`, `'tsv'`, `'json'`, `'ndjson'` or `'parquet'` (`'jsonl'` and `'pq'` also work); default: from the file extension |
| [reader options](#reader-options) | `header`, `delimiter`, `quote`, `null`, `skip`, `encoding`, `hive_partitioning` |

Unknown options fail with `SMALT_EXTERNAL` (`x: unknown option 'foo'`), so typos are caught.

**Columns.** Declared columns take a name and an optional type, and no constraints (`columns cannot have constraints`). Without a column list, the source is read when the table is created (Parquet: only its footer) and the inferred columns are stored with the table, so creating it needs the asynchronous API, as any read does (see [Running statements](#running-statements)).

```sql
CREATE EXTERNAL TABLE products WITH (location = 'file:sql-products.csv');
SELECT * FROM products
```

| id | name | price | added |
| --- | --- | --- | --- |
| 1 | Pen | 1.5 | 2024-01-10 |
| 2 | Notebook | 4.25 | 2024-02-01 |
| 3 | Stapler | NA | 2024-02-15 |

```sql
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'products'
```

| column_name | data_type |
| --- | --- |
| id | INTEGER |
| name | TEXT |
| price | TEXT |
| added | TEXT |

`price` is TEXT because of the `NA`. With `null` set, it is REAL; with declared columns, values convert by affinity:

```sql
CREATE EXTERNAL TABLE products_typed (id INTEGER, name TEXT, price REAL, added TEXT)
  WITH (location = 'file:sql-products.csv', null = 'NA');
SELECT name, price, typeof(price) AS t FROM products_typed
```

| name | price | t |
| --- | --- | --- |
| Pen | 1.5 | real |
| Notebook | 4.25 | real |
| Stapler | NULL | null |

Option names may be keywords, so `null = 'NA'` and `"null" = 'NA'` are the same option. The definition stored for a table with inferred columns quotes such names (`"null" = 'NA'`).

**Types.** Declared types work like [column affinity](./types#declared-types): INTEGER and REAL columns turn numeric-looking text into numbers, TEXT columns keep text. Text that does not convert stays text (no error), so a declared type is a conversion, not a guarantee. Inferred CSV columns are INTEGER, REAL or TEXT; inferred JSON columns are INTEGER, REAL, TEXT, or ANY when the values mix.

**Header names.** CSV columns are named by the header; an empty or repeated name gets a suffix (`a_2`), and files without a header (`header = false`) have `column1`, `column2`, …. When declared columns are all found in the header, they are matched by name (so files may order columns differently); otherwise by position, and then the number of fields must match: `the header has 4 fields but 2 columns are declared`.

### Locations

| Location | Source |
| --- | --- |
| `file:<name>` | a file the application registered with `registerFile(name, …)`: a `File`, `Blob`, file handle, bytes or text |
| `https://…`, `http://…` | a URL (in browsers, the server must allow CORS) |
| a relative path or key | resolved against the connection: its `url` (http), its `bucket` (s3) or its `container` (azure) |
| `s3://bucket/key` | an S3 object; needs no connection, or an `s3` connection |
| `az://container/path` (also `azure://`) | an Azure blob; needs an `azure` connection (it names the account) |
| a local path | a file on disk, in Node only; in a browser it fails (`register the file (registerFile) and use file:<name>`) |

Other schemes fail when the table is read: `unsupported location 'ftp://…' (http(s), s3://, az://, file:<name>, or a path in Node)`.

**Patterns.** In S3 and Azure keys, local paths and registered file names, `*` (within a directory), `**` (any depth), `?`, `[a-z]` and `{a,b}` select several files, which are read concurrently and merged by column name. HTTP URLs cannot be listed, so they take no patterns.

**Partitions.** With a pattern, `key=value` directories in the path (`sales/year=2024/month=02/part.csv`) become columns, typed from their values (`__HIVE_DEFAULT_PARTITION__` is NULL). `hive_partitioning = false` turns this off; `true` turns it on for a single file. `WHERE` conditions that compare partition columns with constants skip the files they exclude before anything is fetched.

<!-- docs:skip -->
```sql
CREATE EXTERNAL TABLE sales WITH (location = 's3://analytics/sales/**/*.parquet', connection = 'lake');
SELECT year, sum(amount) FROM sales WHERE year >= 2024 GROUP BY year;
```

### Formats

| Format | Extensions | Notes |
| --- | --- | --- |
| `csv` | `.csv`, `.txt` | RFC 4180 quoting; `delimiter`, `quote`, `header`, `null`, `skip` apply |
| `tsv` | `.tsv` | CSV with a tab delimiter |
| `json` | `.json` | an array of objects (keys become columns, matched without regard to case), or of arrays (`column1`, …) |
| `ndjson` | `.ndjson`, `.jsonl` | one JSON value per line |
| `parquet` | `.parquet`, `.pq` | needs the optional `hyparquet` package; reads only the columns and row groups a statement needs |

A location without a known extension needs `format` (`cannot tell the format of 'x': add format = 'csv', 'json' or 'parquet'`). JSON and NDJSON are told apart by the content, so either `format` reads both. In JSON, `true`/`false` become 1/0, and nested arrays and objects become JSON text.

```sql
CREATE EXTERNAL TABLE events WITH (location = 'file:sql-events.json');
SELECT id, tags, ok, note FROM events
```

| id | tags | ok | note |
| --- | --- | --- | --- |
| 1 | ["a","b"] | 1 | NULL |
| 2 | [] | 0 | late |

For Parquet types and how much is fetched, see [External data](../../guide/external-data).

### Reader options

| Option | Formats | Default | Meaning |
| --- | --- | --- | --- |
| `header` | CSV | `true` | the first record (after `skip`) holds the column names |
| `delimiter` | CSV | `','` (tab for `tsv`) | one character |
| `quote` | CSV | `'"'` | one character |
| `null` | CSV | none | an unquoted field with this text is NULL (empty unquoted fields are always NULL) |
| `skip` | CSV | `0` | records to skip before the header |
| `encoding` | CSV, JSON | `'utf-8'` | any encoding name the platform's `TextDecoder` knows (`'latin1'`, `'utf-16le'`, …) |
| `hive_partitioning` | all | `true` for patterns | read `key=value` path segments as columns |

Boolean options take `true`/`false`, `1`/`0`, or the text `'true'`, `'yes'`, `'on'`, `'1'`.

```sql
CREATE EXTERNAL TABLE cities WITH (location = 'file:sql-semicolon.csv', delimiter = ';');
CREATE EXTERNAL TABLE counts WITH (location = 'file:sql-skip.csv', skip = 1);
SELECT (SELECT city FROM cities WHERE id = 2) AS city, (SELECT count(*) FROM counts WHERE qty IS NULL) AS missing
```

| city | missing |
| --- | --- |
| Bergen; Norway | 1 |

### Using external tables

- They are read-only and have no indexes. Every statement that uses one reads the source again; to read it once, cache it in a [materialized view](./views) and refresh it with `REFRESH … IF CHANGED`.
- They work in joins, subqueries, views and `INSERT … SELECT`.
- `information_schema.tables` shows them as `EXTERNAL`, [`information_schema.external_tables`](./information-schema#external-tables) lists their location, format, connection and options, and `sqlite_schema` lists them with type `external`.
- [`PRAGMA matview_rewrite`](./pragmas#matview-rewrite) never answers queries from a materialized view over external data.

```sql
CREATE TABLE product_copy(id INTEGER PRIMARY KEY, name TEXT, price REAL);
INSERT INTO product_copy SELECT id, name, price FROM products_typed;
SELECT count(*) AS n FROM product_copy
```

| n |
| --- |
| 3 |

### Running statements

A statement that reads external data fetches its sources first (all at once), then runs. In-process (`smaltdb/engine`) this needs `queryAsync`, `runAsync` or `execAsync`; the synchronous methods fail with `SMALT_ASYNC_REQUIRED`. Through the `smaltdb` client everything is asynchronous anyway. Fetch and parse failures raise `SMALT_EXTERNAL`, naming the source and the HTTP status, CSV line or JSON item.

## DROP EXTERNAL TABLE

```text
DROP EXTERNAL TABLE [IF EXISTS] name
```

Removes the catalog entry only; the source is never touched. `DROP TABLE` refuses an external table (`use DROP EXTERNAL TABLE to delete external table x`).

```sql
DROP EXTERNAL TABLE cities;
SELECT count(*) AS n FROM information_schema.external_tables
```

| n |
| --- |
| 4 |
