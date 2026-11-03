# Table-valued functions

A table-valued function is called in the `FROM` clause and returns rows, like a table. It can be joined, filtered and aliased like any table:

```
SELECT … FROM function(arguments) [[AS] alias] …
```

smaltdb has two kinds:

| Function | Returns |
| --- | --- |
| [`read_csv(LOCATION, …)`](#read_csv) | The rows of a CSV or TSV file |
| [`read_json(LOCATION, …)`](#read_json) | The rows of a JSON array or NDJSON file |
| [`read_parquet(LOCATION, …)`](#read_parquet) | The rows of a Parquet file |
| [`pragma_table_info(TABLE)`](#pragma_table_info) | The columns of a table |
| [`pragma_table_xinfo(TABLE)`](#pragma_table_xinfo) | `pragma_table_info` plus a `hidden` column |
| [`pragma_index_list(TABLE)`](#pragma_index_list) | The indexes of a table |
| [`pragma_index_info(INDEX)`](#pragma_index_info) | The key columns of an index |
| [`pragma_index_xinfo(INDEX)`](#pragma_index_xinfo) | All columns of an index, with sort order and collation |
| [`pragma_foreign_key_list(TABLE)`](#pragma_foreign_key_list) | The foreign keys of a table |

`generate_series`, `json_each` and `json_tree` are not available; calling them fails with `no such table-valued function`.

## Reading files: read_csv, read_json, read_parquet {#reading-files}

These functions read external data straight into a query, without creating a table. They come from [plugins](../../guide/plugins):

| Function | Plugin |
| --- | --- |
| `read_csv`, `read_json` | `@smaltdb/io` |
| `read_parquet` | `@smaltdb/parquet` |

The location also needs a source plugin: `@smaltdb/external` reads registered files (`file:`), URLs, S3, Azure and local paths in Node. Install the plugins in the engine worker entry (`serve({ plugins: [io, external, parquet] })`, started with `worker: () => new Worker(new URL('./db-worker.ts', import.meta.url), { type: 'module' })`), or in Node with `Database.openMemory({ plugins: [io, external, parquet] })`. Without the plugin a call needs, it fails with `SMALT_PLUGIN_MISSING`, and the message names the plugin.

This section lists their arguments; [External data](../../guide/external-data) explains locations, connections, credentials, caching and partitioned datasets in full, and [CREATE EXTERNAL TABLE](../sql/external) gives the same data a permanent name.

```
read_csv(LOCATION [, option => value, …])
read_json(LOCATION [, option => value, …])
read_parquet(LOCATION [, option => value, …])
```

- `LOCATION` is required and must be text. Options follow it as `name => value` pairs; there are no other positional arguments.
- All arguments must be constant expressions (literals, or expressions over literals such as `'file:' || 'a.csv'`). Column references and statement parameters are not allowed (`read_csv() arguments must be constants`).
- Because the data is fetched before the statement runs, a statement that uses these functions must be run asynchronously: through the `smaltdb` client (every call is asynchronous), or with `queryAsync` / `execAsync` on the in-process engine. A synchronous `query` fails with `SMALT_ASYNC_REQUIRED`. See [Engine API](../api/engine).
- Errors while fetching or parsing the data, and bad option values, fail with `SMALT_EXTERNAL`; the message starts with the call, e.g. `read_csv('file:a.csv'): …`. Bad arguments (a missing location, non-constant arguments, an unknown connection) fail with `SMALT_ERROR`.

### Locations {#locations}

| Location | Reads |
| --- | --- |
| `file:NAME` | A file registered with `registerFile(db, NAME, …)` from `@smaltdb/external/client` (a `Uint8Array`, `ArrayBuffer`, string, `Blob`/`File`, or a file handle). |
| `https://…`, `http://…` | A URL, fetched with `fetch` (the server must allow CORS in a browser). |
| `s3://bucket/key` | An object in S3 or an S3-compatible store, through an `s3` connection or the default endpoint. |
| `az://container/path` | A blob in Azure Blob Storage, through an `azure` connection. |
| a path such as `data/x.csv` | In Node.js, a local file. With a `connection` option, a path relative to the connection. |

A location may contain wildcards (`*`, `**`, `?`, `[…]`, `{a,b}`) when the source can be listed (registered files, local paths, S3, Azure; not plain HTTP). All matching files are read and their rows combined, matching columns by name.

```sql
SELECT * FROM read_csv('file:fn-part-*.csv') ORDER BY month;
```

| month | sales |
| --- | --- |
| 2024-01 | 100 |
| 2024-02 | 140 |

### Options {#options}

Option names are case-insensitive. An unknown option fails with `unknown option 'name'`, so typos are caught.

| Option | Applies to | Default | Meaning |
| --- | --- | --- | --- |
| `format` | all | from the function | `'csv'`, `'tsv'`, `'json'` (also `'ndjson'`, `'jsonl'`) or `'parquet'`. Overrides the function's own format, so `read_csv(…, format => 'json')` reads JSON. |
| `header` | CSV | true | Whether the first record holds the column names. False names the columns `column1`, `column2`, …. `1`/`0`, `true`/`false`, `'yes'`/`'no'`, `'on'`/`'off'` are accepted. |
| `delimiter` | CSV | `','` (`'\t'` for `.tsv` files and `format => 'tsv'`) | The field separator. One character. |
| `quote` | CSV | `'"'` | The quote character. One character. A quote inside a quoted field is written twice. |
| `null` | CSV | none | Unquoted text that reads as NULL, e.g. `'NA'` or `'\N'`. An unquoted empty field is always NULL. |
| `skip` | CSV | 0 | Number of records to skip before the header (e.g. a comment line). |
| `encoding` | CSV, JSON | `'utf-8'` | Text encoding, any label `TextDecoder` accepts (`'latin1'`, `'utf-16le'`, `'windows-1252'`, …). |
| `hive_partitioning` | all | true when the location has wildcards | Read `key=value` directory names in the path as extra columns. |
| `connection` | all | none | Name of a connection created with [CREATE CONNECTION](../sql/external); the location is resolved against it. |

The options accepted are those of every installed format. So with `@smaltdb/io` installed, CSV options given to `read_json` or `read_parquet` are accepted and ignored.

### read_csv {#read_csv}

```
read_csv(LOCATION [, header => …] [, delimiter => …] [, quote => …] [, null => …] [, skip => …] [, encoding => …] [, format => …] [, hive_partitioning => …] [, connection => …])
```

Reads CSV (RFC 4180: quoted fields may contain the delimiter, quotes and line breaks). A location ending in `.tsv` is read as tab-separated. Every record must have as many fields as the header.

Column types are inferred from all the values in the column: INTEGER if every non-empty value is an integer, REAL if every value is a number, otherwise TEXT. Header names are trimmed; an empty name becomes `columnN`, and a repeated name gets a suffix (`name_2`). An unquoted empty field is NULL; a quoted empty field (`""`) is the empty string.

```sql
SELECT * FROM read_csv('file:fn-cities.csv');
```

| name | country | population |
| --- | --- | --- |
| Oslo | NO | 709037 |
| Bergen | NO | 291940 |
| Lyon | FR | 522250 |

```sql
SELECT name, typeof(population) AS type FROM read_csv('file:fn-cities.csv') WHERE population > 500000 ORDER BY population DESC;
```

| name | type |
| --- | --- |
| Oslo | integer |
| Lyon | integer |

Without a header row, every record is data. Here the header line is read as data, so the third column contains text and is typed TEXT:

```sql
SELECT * FROM read_csv('file:fn-cities.csv', header => false) LIMIT 2;
```

| column1 | column2 | column3 |
| --- | --- | --- |
| name | country | population |
| Oslo | NO | 709037 |

A file with a comment line, `;` as the delimiter and `NA` for missing values (`fn-weather.csv`):

```
# exported 2024-05-01
city;temp;note
Oslo;12.5;NA
Lyon;NA;"warm; dry"
```

```sql
SELECT city, temp, note, typeof(temp) AS temp_type FROM read_csv('file:fn-weather.csv', skip => 1, delimiter => ';', null => 'NA');
```

| city | temp | note | temp_type |
| --- | --- | --- | --- |
| Oslo | 12.5 | NULL | real |
| Lyon | NULL | warm; dry | null |

Tab-separated and Latin-1 files:

```sql
SELECT * FROM read_csv('file:fn-cities.tsv');
```

| name | country | population |
| --- | --- | --- |
| Oslo | NO | 709037 |
| Lyon | FR | 522250 |

```sql
SELECT * FROM read_csv('file:fn-latin1.csv', encoding => 'latin1');
```

| name | city |
| --- | --- |
| José | Málaga |

<!-- docs:error SMALT_EXTERNAL -->
```sql
SELECT * FROM read_csv('file:fn-cities.csv', delim => ';');
```

### read_json {#read_json}

```
read_json(LOCATION [, encoding => …] [, format => …] [, hive_partitioning => …] [, connection => …])
```

Reads either a JSON array (the file starts with `[`) or NDJSON (one JSON value per line; blank lines are skipped). The items must be all objects or all arrays:

- **Objects**: each key becomes a column, in the order keys are first seen; keys match case-insensitively. A key missing from an object is NULL.
- **Arrays**: the columns are `column1`, `column2`, …, as many as the longest array.

Values convert as follows: numbers and strings stay as they are, `true`/`false` become 1/0, `null` is NULL, and nested objects and arrays become JSON text. A column is typed INTEGER, REAL or TEXT when all its values have that type (INTEGER and REAL mix to REAL), otherwise it has no type.

```sql
SELECT * FROM read_json('file:fn-cities.json');
```

| name | country | population | capital |
| --- | --- | --- | --- |
| Oslo | NO | 709037 | NULL |
| Lyon | FR | 522250 | 0 |

`fn-items.ndjson` holds one object per line:

```
{"id": 1, "tags": ["a", "b"], "price": 9.5}
{"id": 2, "tags": null, "price": 12}
```

```sql
SELECT id, tags, price, typeof(tags) AS tags_type FROM read_json('file:fn-items.ndjson');
```

| id | tags | price | tags_type |
| --- | --- | --- | --- |
| 1 | ["a","b"] | 9.5 | text |
| 2 | NULL | 12 | null |

smaltdb has no JSON functions (`json_extract`, `->>`, …), so nested values can only be handled as text.

### read_parquet {#read_parquet}

```
read_parquet(LOCATION [, hive_partitioning => …] [, connection => …])
```

Reads a Parquet file. Only the columns the query uses are fetched, and row groups whose statistics rule them out are skipped; for remote files this uses HTTP range requests. `read_parquet` is provided by the [`@smaltdb/parquet` plugin](../../guide/plugins) (plus `hyparquet-compressors` for codecs other than Snappy and uncompressed); without the plugin the call fails with `SMALT_PLUGIN_MISSING`: `the parquet format needs the @smaltdb/parquet plugin`.

| Parquet type | SQL value |
| --- | --- |
| BOOLEAN | INTEGER 0 or 1 |
| INT32, INT64 | INTEGER |
| FLOAT, DOUBLE, DECIMAL, FLOAT16 | REAL |
| STRING, ENUM, JSON, UUID | TEXT |
| DATE | TEXT `YYYY-MM-DD` |
| TIMESTAMP, INT96 | TEXT `YYYY-MM-DD HH:MM:SS` in UTC, with the fraction of a second when there is one |
| other binary | BLOB |
| lists, structs, maps | TEXT holding JSON |

<!-- docs:plugin @smaltdb/parquet -->
```sql
SELECT * FROM read_parquet('file:fn-cities.parquet');
```

| name | country | population | founded |
| --- | --- | --- | --- |
| Oslo | NO | 709037 | 1048-01-01 |
| Bergen | NO | 291940 | 1070-01-01 |
| Lyon | FR | 522250 | NULL |

The read functions combine with each other and with tables:

<!-- docs:plugin @smaltdb/parquet -->
```sql
SELECT c.name, c.population, p.founded
FROM read_csv('file:fn-cities.csv') AS c
JOIN read_parquet('file:fn-cities.parquet') AS p USING (name)
WHERE p.founded IS NOT NULL
ORDER BY c.name;
```

| name | population | founded |
| --- | --- | --- |
| Bergen | 291940 | 1070-01-01 |
| Oslo | 709037 | 1048-01-01 |

Reading from a URL or object store looks the same (not run here, since it needs the network):

<!-- docs:skip -->
```sql
SELECT count(*) FROM read_parquet('https://example.com/data/trips.parquet');
SELECT * FROM read_csv('s3://my-bucket/2024/*.csv', connection => 'lake');
```

## Schema functions: pragma_* {#pragma-functions}

These are the table-valued forms of the schema [pragmas](../sql/pragmas): `SELECT * FROM pragma_table_info('t')` returns the same rows as `PRAGMA table_info(t)`. Unlike the `PRAGMA` statement, they can be filtered, joined and used in subqueries. [information_schema](../sql/information-schema) has the same information in standard form.

- The argument is a table or index name as text. Unlike `PRAGMA table_info('nope')`, which fails, an unknown name gives no rows.
- The argument may come from another table in the same `FROM`, for example to list the columns of every table (see the example under [pragma_table_info](#pragma_table_info)).
- Only these six pragmas have a function form. A `main.` or `temp.` prefix (`main.pragma_table_info(…)`) is accepted and, as in SQLite, changes nothing. Functions such as `pragma_foreign_keys()`, and the forms without parentheses (`pragma_index_list WHERE arg = 't'`), are not supported.
- For an [external table](../sql/external), `pragma_table_info` lists its columns (declared or inferred; `notnull`, `dflt_value` and `pk` are 0 or NULL), and `pragma_index_list` and `pragma_foreign_key_list` give no rows.

The examples use this schema:

```sql
CREATE TABLE author(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, born INT DEFAULT 1900);
CREATE TABLE book(
  id INTEGER PRIMARY KEY,
  author_id INT REFERENCES author(id) ON DELETE CASCADE,
  title TEXT COLLATE NOCASE,
  year INT
);
CREATE INDEX book_year ON book(year DESC, title);
```

### pragma_table_info {#pragma_table_info}

```
pragma_table_info(TABLE)
```

One row per column of `TABLE`:

| Column | Meaning |
| --- | --- |
| `cid` | Position of the column, from 0. |
| `name` | Column name. |
| `type` | Declared type, as written (empty if none). |
| `notnull` | 1 if the column was declared `NOT NULL`. |
| `dflt_value` | The `DEFAULT` expression as SQL text, or NULL. |
| `pk` | Position in the primary key (from 1), or 0. |

```sql
SELECT * FROM pragma_table_info('author');
```

| cid | name | type | notnull | dflt_value | pk |
| --- | --- | --- | --- | --- | --- |
| 0 | id | INTEGER | 0 | NULL | 1 |
| 1 | name | TEXT | 1 | NULL | 0 |
| 2 | born | INT | 0 | 1900 | 0 |

Every column of every table:

```sql
SELECT m.name AS table_name, p.name AS column_name, p.type
FROM sqlite_schema AS m, pragma_table_info(m.name) AS p
WHERE m.type = 'table'
ORDER BY m.name, p.cid;
```

| table_name | column_name | type |
| --- | --- | --- |
| author | id | INTEGER |
| author | name | TEXT |
| author | born | INT |
| book | id | INTEGER |
| book | author_id | INT |
| book | title | TEXT |
| book | year | INT |

Unknown table:

```sql
SELECT count(*) AS n FROM pragma_table_info('no_such_table');
```

| n |
| --- |
| 0 |

### pragma_table_xinfo {#pragma_table_xinfo}

```
pragma_table_xinfo(TABLE)
```

The rows and columns of `pragma_table_info`, plus a seventh column, `hidden`, as in SQLite. SQLite uses it for hidden columns of virtual tables (1) and generated columns (2, 3); smaltdb has neither, so it is always 0.

```sql
SELECT name, hidden FROM pragma_table_xinfo('author');
```

| name | hidden |
| --- | --- |
| id | 0 |
| name | 0 |
| born | 0 |

### pragma_index_list {#pragma_index_list}

```
pragma_index_list(TABLE)
```

One row per index on `TABLE`:

| Column | Meaning |
| --- | --- |
| `seq` | Sequence number, from 0. |
| `name` | Index name. Indexes created for `UNIQUE` and `PRIMARY KEY` constraints are named `smalt_autoindex_<table>_<n>` (SQLite: `sqlite_autoindex_…`). |
| `unique` | 1 for a unique index. |
| `origin` | `c` for `CREATE INDEX`, `u` for a `UNIQUE` constraint, `pk` for a `PRIMARY KEY` constraint. |
| `partial` | 1 for a partial index (with `WHERE`). |

```sql
SELECT * FROM pragma_index_list('author');
```

| seq | name | unique | origin | partial |
| --- | --- | --- | --- | --- |
| 0 | smalt_autoindex_author_1 | 1 | u | 0 |

### pragma_index_info {#pragma_index_info}

```
pragma_index_info(INDEX)
```

One row per key column of the index:

| Column | Meaning |
| --- | --- |
| `seqno` | Position in the index key, from 0. |
| `cid` | Column position in the table (`-2` for an expression). |
| `name` | Column name (NULL for an expression). |

```sql
SELECT * FROM pragma_index_info('book_year');
```

| seqno | cid | name |
| --- | --- | --- |
| 0 | 3 | year |
| 1 | 2 | title |

### pragma_index_xinfo {#pragma_index_xinfo}

```
pragma_index_xinfo(INDEX)
```

Like `pragma_index_info`, with three more columns, and a final row for the rowid that every index entry also stores:

| Column | Meaning |
| --- | --- |
| `desc` | 1 if the column is sorted descending. |
| `coll` | Collation: `BINARY`, `NOCASE` or `RTRIM`. |
| `key` | 1 for key columns, 0 for the rowid row. |

```sql
SELECT * FROM pragma_index_xinfo('book_year');
```

| seqno | cid | name | desc | coll | key |
| --- | --- | --- | --- | --- | --- |
| 0 | 3 | year | 1 | BINARY | 1 |
| 1 | 2 | title | 0 | NOCASE | 1 |
| 2 | -1 | NULL | 0 | BINARY | 0 |

### pragma_foreign_key_list {#pragma_foreign_key_list}

```
pragma_foreign_key_list(TABLE)
```

One row per column of each foreign key of `TABLE`. As in SQLite, the last-declared foreign key comes first (`id` 0).

| Column | Meaning |
| --- | --- |
| `id` | Foreign key number. |
| `seq` | Column position within the key, from 0. |
| `table` | Parent table. |
| `from` | Column in `TABLE`. |
| `to` | Parent column, or NULL when the key references the parent's primary key implicitly. |
| `on_update`, `on_delete` | `NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL` or `SET DEFAULT`. |
| `match` | Always `NONE`. |

```sql
SELECT "table", "from", "to", on_delete FROM pragma_foreign_key_list('book');
```

| table | from | to | on_delete |
| --- | --- | --- | --- |
| author | author_id | id | CASCADE |
