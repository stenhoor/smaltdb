# SQL Dialect

> Status: design notes. The baseline is **SQLite 3.4x syntax and semantics**. The current reference is the
> [SQL reference](reference/sql/index.md). Since ADR 0012, external sources and formats (§5a) come from plugins.

## 1. Statements (initial scope)

| Category | Statements |
|---|---|
| Query | `SELECT` (joins: inner/left/right/full/cross, `USING`, `NATURAL`), `WITH [RECURSIVE]`, compound `UNION [ALL]`/`INTERSECT`/`EXCEPT`, `ORDER BY … NULLS FIRST/LAST`, `LIMIT/OFFSET`, window functions, `FILTER` clause, `VALUES` |
| DML | `INSERT` (incl. `INSERT … SELECT`, `ON CONFLICT … DO UPDATE/NOTHING`, `RETURNING`), `UPDATE … FROM`, `DELETE`, `REPLACE` |
| DDL | `CREATE/DROP TABLE` (incl. `WITHOUT ROWID`, `STRICT`, generated columns, `CHECK`, `FOREIGN KEY`), `ALTER TABLE` (rename, add/drop/rename column), `CREATE/DROP INDEX` (partial, expression), `CREATE/DROP VIEW`, `CREATE/DROP MATERIALIZED VIEW`, `REFRESH MATERIALIZED VIEW`. *(Triggers: post-v1)* |
| Transactions | `BEGIN [DEFERRED/IMMEDIATE/EXCLUSIVE]`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE` |
| Utility | `EXPLAIN [ANALYZE|QUERY PLAN]`, `ANALYZE`, `VACUUM`, `PRAGMA` (subset). *(`ATTACH`/`DETACH`: open question Q-10)* |

## 2. Type system (decided: ADR 0001)

SQLite uses dynamic typing with *type affinity*: any column can hold any value. That is flexible, but it blocks
efficient fixed-width columnar storage and vectorization.

**Decision:**
- Tables are `STRICT` by default (as in SQLite `STRICT` tables). Each column has a declared type that is enforced.
- Storage types: `INTEGER` (int64), `REAL` (float64), `TEXT` (UTF-8), `BLOB`, `BOOLEAN`, `ANY`.
  Optional extensions: `DATE`/`TIMESTAMP`, `DECIMAL`, `JSON`.
- `CREATE TABLE … LOOSE` (or a database-level pragma) enables SQLite-style affinity for compatibility. Such tables
  use a slower, tagged-value path.
- Integers surface in JS as `number` when they are within the safe range, and as `bigint` otherwise (configurable).

## 3. Functions

- Core scalar functions: SQLite's full core set (`abs`, `coalesce`, `ifnull`, `instr`, `length`, `lower`, `printf`/`format`, `replace`, `round`, `substr`, `trim`, `typeof`, …)
- Date/time: `date`, `time`, `datetime`, `julianday`, `unixepoch`, `strftime`, `timediff`, and `CURRENT_DATE` / `CURRENT_TIME` /
  `CURRENT_TIMESTAMP`, with SQLite 3.54 semantics (a port of SQLite's `date.c`, checked against the SQLite WASM build in
  `test/datetime.test.ts`). All time-value formats are supported (`YYYY-MM-DD[ |T]HH:MM[:SS[.SSS]]`, `HH:MM…` alone, `24:00`, time-zone
  suffixes `[+-]HH:MM` / `Z`, `'now'`, `'subsec'`, julian day or Unix numbers), as are all modifiers (`±NNN days|hours|minutes|seconds|months|years`,
  `±HH:MM[:SS[.SSS]]`, `±YYYY-MM-DD[ HH:MM[:SS[.SSS]]]`, `start of day|month|year`, `weekday [-]N`, `unixepoch`, `julianday`, `auto`,
  `localtime`, `utc`, `subsec`/`subsecond`, `ceiling`, `floor`) and all `strftime` codes (`%d %e %f %F %G %g %H %I %j %J %k %l %m %M %p %P
  %R %s %S %T %u %U %V %w %W %Y %%`). Invalid input gives NULL where SQLite does. `'localtime'` and `'utc'` use the host (browser) time zone.
- Math: SQLite math functions
- Aggregates: `count`, `sum`, `total`, `avg`, `min`, `max`, `group_concat`/`string_agg`
- Window functions: `row_number`, `rank`, `dense_rank`, `ntile`, `lag`, `lead`, `first_value`, `last_value`, `nth_value`, and aggregates over frames
- *Post-v1 extensions*: JSON (`json_*`, `->`, `->>`) and JS user-defined functions. The function registry must allow them to be added without engine changes.

## 4. information_schema

These are read-only views over the internal catalog and follow the SQL-standard / PostgreSQL shape:

| View | Notes |
|---|---|
| `information_schema.schemata` | `main`, `temp`, and attached databases |
| `information_schema.tables` | `table_type` ∈ `BASE TABLE`, `VIEW`, `MATERIALIZED VIEW`, `LOCAL TEMPORARY` |
| `information_schema.columns` | ordinal position, data type, nullability, default, generated expression |
| `information_schema.views` | view definition |
| `information_schema.table_constraints`, `key_column_usage`, `referential_constraints`, `check_constraints` | |
| `information_schema.routines`, `parameters` | built-in and user-defined functions |
| `information_schema.statistics` (non-standard, like MySQL) | indexes and index columns |
| `information_schema.materialized_views` (extension) | refresh mode (MANUAL or the automatic policy), last refresh time, staleness, last automatic refresh error |
| `information_schema.external_tables`, `connections` (extensions, M8) | location, format, connection and reader options of external tables; connection endpoints and the names of their credentials (never secrets) |

SQLite compatibility: `sqlite_schema` / `sqlite_master`, `pragma_table_info()`, `pragma_index_list()`, and the related table-valued pragma functions.

> **Implemented in M4** (`src/engine/catalog/information-schema.ts`): `schemata`, `tables`, `columns`, `views`, `table_constraints`,
> `key_column_usage`, `referential_constraints`, `check_constraints`, `routines` (built-in functions) and `statistics`.
> Constraints without a name get PostgreSQL-style names (`t_pkey`, `t_col_key`, `t_col_fkey`, `t_check1`). Internal tables
> (`smalt_*`) are not listed. Not yet: `parameters` (no per-function signatures), TEMP objects (TEMP tables are not listed). `materialized_views` (extension) arrived with M5.
> Table-valued pragmas: `pragma_table_info`, `pragma_table_xinfo`, `pragma_index_list`, `pragma_index_info`,
> `pragma_index_xinfo`, `pragma_foreign_key_list`; their arguments may reference earlier FROM sources
> (`FROM sqlite_schema m JOIN pragma_table_info(m.name)`), which plans them as lateral joins.

## 5. Materialized views

```sql
CREATE MATERIALIZED VIEW sales_by_day
  [WITH (refresh = 'manual')]   -- 'incremental' / 'on_commit' reserved for later
AS SELECT day, sum(amount) AS total, count(*) AS n FROM sales GROUP BY day;

REFRESH MATERIALIZED VIEW sales_by_day [CONCURRENTLY];
```

> **Implemented in M5.** `CREATE MATERIALIZED VIEW [IF NOT EXISTS] name [(columns)] [WITH (storage = 'row' | 'columnar',
> refresh = 'manual')] AS select [WITH [NO] DATA]`, `REFRESH MATERIALIZED VIEW [CONCURRENTLY] name [WITH [NO] DATA]`,
> `DROP MATERIALIZED VIEW [IF EXISTS] name`.
> - Column types come from the query: a column copied from a table keeps its declared type (and collation); computed
>   values get their static type (INTEGER, REAL, TEXT, BLOB) or ANY. A refresh that produces a value its column cannot
>   hold exactly fails and leaves the old rows (add a CAST to the view).
> - Every refresh builds new trees and then swaps them in (copy-on-write). `CONCURRENTLY` therefore never blocks
>   readers and, unlike PostgreSQL, needs no unique index. The two forms differ only once concurrent readers arrive (M6).
> - `WITH NO DATA` leaves the view unpopulated; reading it is an error until it is refreshed (PostgreSQL behaviour).
> - The view is read-only (INSERT/UPDATE/DELETE/ALTER fail) and can have indexes, which every refresh rebuilds.
> - `storage = 'columnar'` stores the rows as columnar segments: 8,192-row groups of encoded column chunks with zone
>   maps (min/max/null count) that let scans skip row groups, and generated aggregate pipelines over the column
>   arrays. Columnar views cannot have indexes. See [ADR 0008](adr/0008-materialized-views-and-columnar-segments.md).
> - Catalog: `sqlite_schema` lists it with type `matview`; `information_schema.tables` reports `MATERIALIZED VIEW`, and
>   `information_schema.materialized_views` gives the definition, storage, population state and last refresh time.

- Stored as a regular table with a hidden catalog link to its definition. MVs can have indexes.
- **v1**: `manual` refresh, which is a full recompute.
- **Later**:
  - `incremental`: maintained by delta rules for select/project/inner-join/group-by with distributive and algebraic
    aggregates. Deltas are captured from the WAL or a change log.
  - `on_commit`: incremental maintenance runs inside the writing transaction.
- `REFRESH … CONCURRENTLY` builds a new copy and swaps it in, so readers are never blocked.
- The optimizer can optionally rewrite queries to use a fresh MV.

## 5a. External data (M8.1)

Data that lives elsewhere — files, URLs — queried with the same SQL as local tables
([ADR 0011](adr/0011-external-tables.md)). Read-only.

```sql
-- An endpoint; `credentials` names a provider the application registers at runtime (no secrets in SQL).
CREATE CONNECTION [IF NOT EXISTS] api WITH (url = 'https://data.example.com/v1', credentials = 'api-token');

-- Columns declared, or inferred from the source when the table is created (and stored with it).
CREATE EXTERNAL TABLE [IF NOT EXISTS] prices [(id INTEGER, name TEXT, price REAL)]
  WITH (location = 'prices.csv', connection = 'api' [, format = 'csv', header = true, delimiter = ',', …]);

-- Ad hoc, without a catalog entry.
SELECT * FROM read_csv('https://example.com/rates.csv', delimiter => ';', null => 'NA');
SELECT * FROM read_json('file:upload', format => 'ndjson');

-- A local cache (offline, fast repeat reads); REFRESH re-reads the source.
CREATE MATERIALIZED VIEW prices_local
  WITH (storage = 'columnar', refresh_every = 300, refresh_on_reconnect = true)
AS SELECT * FROM prices;
REFRESH MATERIALIZED VIEW prices_local IF CHANGED;   -- only when a source changed

DROP EXTERNAL TABLE [IF EXISTS] prices;   -- catalog entry only: never touches the source
DROP CONNECTION [IF EXISTS] api;          -- fails while an external table uses it
```

- **Locations:** `http://` / `https://` URLs (relative to the connection's `url` when one is given); `s3://bucket/key`
  and `az://container/path` (M8.2), or a key relative to an s3 / azure connection's bucket or container; `file:<name>`
  for a file the application registered (`registerFile`: a browser `File`, `Blob` or file handle, or bytes/text); a local
  path in Node. Parquet comes in M8.3, remote databases in M8.5.
- **Connections** (M8.2): `type = 'http'` (`url`), `type = 's3'` (`region`, `bucket`, `endpoint` for S3-compatible stores
  such as MinIO or Cloudflare R2, `url_style = 'path' | 'virtual'`; path-style by default with an `endpoint`) and
  `type = 'azure'` (`account`, `container`, `endpoint` for emulators or sovereign clouds). Each may name `credentials`.
  `information_schema.connections` shows them (never secrets).
- **Credentials** are registered by the application, bound to an endpoint prefix: headers, AWS keys (requests are signed
  with Signature Version 4, including STS session tokens), Azure SAS tokens, account keys (Shared Key signing) or bearer
  tokens, or a presigned-URL issuer. Signing runs on WebCrypto in the engine; nothing is stored in SQL or the file.
- **Patterns** (M8.2): `*` (within a directory), `**` (any depth), `?`, `[a-z]`, `{a,b}` in S3 and Azure keys (listed
  with ListObjectsV2 / List Blobs), local paths in Node and registered file names, not in HTTP URLs. Matching files are
  read concurrently and merged by column name (a CSV header with the declared columns matches them by name, so files may
  order columns differently).
- **Partitions** (M8.2): with a pattern, `key=value` directories (Hive style: `sales/year=2024/month=02/x.csv`) become
  columns, typed from their values (`__HIVE_DEFAULT_PARTITION__` is NULL); `hive_partitioning => false` turns this off,
  `true` turns it on for a single file. For external tables, WHERE conditions on partition columns with constants (`year =
  2024`, `month IN (1, 2)`, `year + month > 2030`, …) skip the files they exclude before anything is fetched. Not for
  a LEFT-joined table, with RIGHT / FULL joins, or for `read_csv` / `read_json` calls. `REFRESH … IF CHANGED` over a
  pattern compares the listing (each file's ETag or modification time).
- **Formats:** `csv`, `tsv`, `json` (an array of objects, or of arrays with declared columns), `ndjson`, `parquet`
  (M8.3); taken from `format` or the file extension. `read_parquet(location, …)` reads Parquet ad hoc.
- **Parquet** (M8.3) is the `@smaltdb/parquet` plugin (ADR 0012), which reads with
  [hyparquet](https://github.com/hyparam/hyparquet) (plus `hyparquet-compressors` for gzip, zstd, brotli and lz4;
  Snappy is built in). Without it, Parquet sources fail with `SMALT_PLUGIN_MISSING`.
  - *Reads only what the statement needs:* the footer (the first 16 KB from the end), then only the column chunks of
    the columns the statement uses, by HTTP Range requests (S3, Azure and HTTP), Blob slices or file reads; files under
    64 KB are read in one request. Columns that are not read are NULL to the scan.
  - *Row groups:* `column op constant` (`=`, `<`, `<=`, `>`, `>=`), `BETWEEN` and `IN (…)` in WHERE skip the row groups
    whose statistics (min, max, null count) rule them out, as zone maps do for columnar tables. Not for a LEFT-joined
    source or with RIGHT / FULL joins.
  - *Types:* integers (also unsigned; INT64 beyond 2^53 stay exact) and booleans are INTEGER, floats and decimals REAL,
    strings, enums, JSON and UUIDs TEXT, dates `YYYY-MM-DD` and timestamps `YYYY-MM-DD HH:MM:SS[.fraction]` (UTC) TEXT
    like SQLite's date functions produce, binary BLOB, and lists, structs and maps JSON text. An external table's
    columns come from the footer alone.
  - Browsers need CORS on the server that allows the `Range` header and exposes `Content-Length` (and `ETag` for
    `IF CHANGED`); without a usable size the file is read in one request.
- **Reader options:** `header` (default true), `delimiter`, `quote`, `null` (text read as NULL; unquoted empty fields are
  NULL anyway), `skip` (leading records), `encoding` (default utf-8). Unknown options are errors.
- **Types:** declared columns convert values by affinity (text that does not convert stays text). Inferred columns are
  INTEGER, REAL or TEXT for CSV (ANY when JSON values mix). Header names that repeat get a suffix (`a_2`); missing ones
  are `column1`, `column2`, …
- **Running:** a statement that reads external data is fetched first (all its sources concurrently, each once), then
  runs as usual. In-process this needs `queryAsync` / `runAsync` / `execAsync`; the synchronous API fails with
  `SMALT_ASYNC_REQUIRED`. The worker client is asynchronous anyway and needs nothing different. Such statements run on
  the owner, never on parallel readers.
- **Behaviour:** external tables work in joins, subqueries, views and `INSERT … SELECT`. They have no indexes and are
  re-read by every statement; for repeat reads, cache them in a materialized view. A view over external data is never
  used to answer queries implicitly (`matview_rewrite`), since the source can change without the database knowing.
  `read_csv` / `read_json` arguments must be constants.
- **Caches and freshness:** a materialized view over external data records each source's validator when it is
  refreshed: the ETag or Last-Modified of a URL, a local file's modification time and size, a registered `File`'s
  `lastModified` and size. `REFRESH MATERIALIZED VIEW name IF CHANGED` checks them (a HEAD request or a stat, not a
  download) and refreshes only if one changed. A source without a validator (a registered Blob or bytes) always counts
  as changed. For a view over local tables only, `IF CHANGED` refreshes when the view is stale. It needs the async API.
- **Refresh policies:** `WITH (refresh_every = <seconds>)` and `WITH (refresh_on_reconnect = true)` on a materialized
  view make the engine worker run `REFRESH … IF CHANGED` when the interval has passed since its last refresh, and when
  the browser comes back online. These refreshes queue like any request. `information_schema.materialized_views` shows
  the policy in `refresh_mode` (`EVERY 300 SECONDS`, `ON RECONNECT`) and the last automatic refresh's error in
  `last_refresh_error`. In-process (Node), run `REFRESH … IF CHANGED` yourself.
- **Errors:** `SMALT_EXTERNAL` names the source and the HTTP status, the CSV line or the JSON item; a network failure
  mentions CORS. A cancelled request aborts its fetches (`SMALT_INTERRUPT`).
- **Catalog:** `sqlite_schema` lists them with types `external` and `connection`; `information_schema.tables` reports
  `EXTERNAL`.

## 6. Known deviations from SQLite (proposed)

- Tables are STRICT by default (`LOOSE` opt-in).
- Identifiers: case-insensitive, as in SQLite. Double quotes are identifiers only; the SQLite double-quoted string-literal quirk is not supported.
- `RIGHT`/`FULL OUTER JOIN` are supported.
- Collations: `BINARY` (default), `NOCASE` (ASCII only), and `RTRIM`. No locale collations in v1.
- Additions: `CREATE MATERIALIZED VIEW`, `INCLUDE` columns on indexes, `information_schema`, and `WITH (…)` storage options.

## 7. Implementation status (M1)

**Works today** (verified against SQLite with differential tests):
- `SELECT` with `WHERE`, `[LEFT] JOIN ... ON/USING`, `NATURAL JOIN`, comma joins, `GROUP BY` / `HAVING`, aggregates
  (`count`, `sum`, `total`, `avg`, `min`, `max`, `group_concat`, `string_agg`, `DISTINCT`, `FILTER`), `DISTINCT`, `ORDER BY`
  (`ASC`/`DESC`, `NULLS FIRST/LAST`, ordinals, aliases), `LIMIT`/`OFFSET`, `UNION [ALL]` / `INTERSECT` / `EXCEPT`, `VALUES`,
  derived tables, non-recursive CTEs, scalar / `EXISTS` / `IN` subqueries (correlated or not), and SQLite's bare-column rule for min/max.
- Expressions: SQLite affinity and collation rules for comparisons, three-valued logic, int64-exact arithmetic with overflow to REAL,
  `CASE`, `CAST`, `LIKE` / `GLOB` / `ESCAPE`, `IN` lists, `BETWEEN`, `IS [NOT]`, `||`, bitwise operators, and about 45 scalar functions
  (string, numeric, `printf`/`format`, `typeof`, `quote`, `hex`, `coalesce`/`ifnull`/`iif`/`nullif`, `last_insert_rowid`, `changes`, …).
- `INSERT` (VALUES, SELECT, DEFAULT VALUES, column lists, `OR IGNORE` / `OR REPLACE`), `UPDATE` (two-pass, SQLite order),
  `DELETE` (with a truncate fast path).
- (M4) `RETURNING` on INSERT/UPDATE/DELETE (`*`, expressions, aliases; aggregates rejected like SQLite);
  upsert `ON CONFLICT [(cols)] DO NOTHING | DO UPDATE SET … [WHERE …]` with `excluded.*`, several clauses tried in order;
  `UPDATE … FROM` (joined sources; with several matching FROM rows the first one wins, as in SQLite); `WITH [RECURSIVE]`
  on INSERT … SELECT, UPDATE and DELETE.
- (M4) Foreign keys are enforced, with SQLite's semantics: immediate constraints are checked at the end of each
  statement (temporary violations inside a statement are fine), `DEFERRABLE INITIALLY DEFERRED` ones at COMMIT;
  `ON DELETE` / `ON UPDATE` `NO ACTION | RESTRICT | CASCADE | SET NULL | SET DEFAULT` (actions recurse; RESTRICT is
  checked when its turn comes, newest constraint first, like SQLite); composite and self-referencing keys; REPLACE
  conflicts and `DROP TABLE` of a parent apply them; "foreign key mismatch" errors for parent keys that are not
  PRIMARY KEY/UNIQUE. **Deviation:** enforcement is **on by default** (SQLite's default is off);
  `PRAGMA foreign_keys = OFF` turns it off (not inside a transaction, as in SQLite).
- (M4) `ALTER TABLE … RENAME TO | RENAME COLUMN | ADD COLUMN | DROP COLUMN`, like SQLite: renames rewrite the
  stored SQL of the table, its indexes, other tables' `REFERENCES` clauses and views (only references that resolve
  to the altered table/column change; quoting style is kept); every object is re-validated and the ALTER fails with
  SQLite's "error in view v after drop column: …" style messages; `ADD COLUMN` takes a constant default and existing
  rows read it without being rewritten; `DROP COLUMN` rewrites the rows.
- (M4) `RIGHT [OUTER] JOIN` and `FULL [OUTER] JOIN` (hash-matched on equality conditions, with any residual ON
  condition; WHERE conditions are not pushed below them, and FROM order is kept in queries that use them).
- (M4) Expression and partial indexes: `CREATE [UNIQUE] INDEX i ON t(lower(name), a + b DESC) [WHERE cond]`.
  Expressions must be deterministic and free of subqueries and parameters (SQLite's errors). The planner matches
  query terms against index expressions (table qualifiers ignored) and uses a partial index only when the query's
  WHERE contains every conjunct of the index's WHERE.
- (M4) Window functions: `row_number`, `rank`, `dense_rank`, `percent_rank`, `cume_dist`, `ntile`, `lag`, `lead`,
  `first_value`, `last_value`, `nth_value`, and every aggregate (with `FILTER`) over a window; `PARTITION BY`, `ORDER BY`,
  `ROWS` / `RANGE` / `GROUPS` frames with `UNBOUNDED` / `n PRECEDING|FOLLOWING` / `CURRENT ROW` bounds and `EXCLUDE`
  options; named windows (`WINDOW w AS (...)`, `OVER w`, `OVER (w ORDER BY ...)`); window functions over aggregates
  (`rank() OVER (ORDER BY count(*))`). Errors match SQLite's.
- (M4) `WITH RECURSIVE`, evaluated like SQLite: a queue seeded by the initial SELECT, one row per recursive step,
  `UNION` de-duplication, `ORDER BY` in the CTE as a priority queue (breadth/depth-first traversals), `LIMIT`/`OFFSET`,
  several recursive SELECTs.
- `CREATE` / `DROP TABLE` (`IF [NOT] EXISTS`, `INTEGER PRIMARY KEY` rowid alias, `PRIMARY KEY`, `UNIQUE`, `NOT NULL`, `DEFAULT`,
  `CHECK`, `COLLATE`), `CREATE [UNIQUE] INDEX` (multi-column, `ASC`/`DESC`, collations), and `DROP INDEX`.
- `CREATE [TEMP] VIEW [IF NOT EXISTS] name [(columns)] AS select` and `DROP VIEW [IF EXISTS]` (M4). TEMP views exist for
  the connection only and shadow main views of the same name.
- (M7) `CREATE TEMP|TEMPORARY TABLE`: lives in the connection's memory store (no pages written to the file, even in an
  OPFS database), shadows a main table of the same name, takes indexes, and is gone when the database closes. Temp DDL
  and writes roll back with the transaction. `CREATE MATERIALIZED VIEW … WITH (location = 'memory')` keeps an MV's rows
  and indexes in memory and its definition in the file; it is recomputed when the database opens (ADR 0010).
- (M7) `CREATE TABLE t(…) WITH (storage = 'columnar')`: a columnar table (column segments with zone maps, plus a
  row delta store and deletions; full DML). Analytics scans are several times faster; point lookups are slower.
  `PRAGMA compact(t)` rewrites its segments. No secondary indexes, UNIQUE constraints (other than INTEGER PRIMARY
  KEY), foreign keys or ALTER TABLE yet. `storage = 'row'` is the default.
- `x [NOT] IN table` / `x IN f(args)`: SQLite's shorthand for `x IN (SELECT * FROM …)`. As in SQLite, a view's body is
  resolved when the view is used, not when it is created, and views cannot be modified or indexed. Simple views and FROM
  subqueries (no aggregates, DISTINCT, LIMIT, ORDER BY, compound, window functions or subquery expressions) are flattened
  into the referencing query, so their tables join and use indexes like tables written out directly.
- `BEGIN` / `COMMIT` / `ROLLBACK`, `SAVEPOINT` / `RELEASE` / `ROLLBACK TO` (M2), with statement-level atomicity inside transactions.
- `EXPLAIN QUERY PLAN`, `EXPLAIN ANALYZE` (SELECT; estimated vs actual rows, loops and time per operator), and `ANALYZE [table]`
  (statistics in `smalt_stat`; M3); `PRAGMA table_info / index_list / index_info / page_size / page_count / freelist_count /
  schema_version / integrity_check / journal_mode / wal_checkpoint / work_mem / spill_bytes / compact / parallel_aggregates / matview_rewrite`. `PRAGMA matview_rewrite = 1` (per connection, off by default) answers queries from fresh materialized views when they provably can (ADR 0010, section 5); parallel readers use the connection's `work_mem` and `matview_rewrite` too; `PRAGMA work_mem = bytes`
  (default 256 MiB) is how much a sort or hash aggregate may hold before spilling to the scratch file `<db>-spill`;
  `spill_bytes` reports scratch bytes written since open (M7); `smalt_schema` (also `sqlite_schema` / `sqlite_master`).

**Type mapping (STRICT by default):** declared types map to storage types by SQLite's affinity rules. *INT* → INTEGER;
*CHAR*/*CLOB*/*TEXT* → TEXT; *BLOB* → BLOB; *REAL*/*FLOA*/*DOUB* → REAL; `ANY` or no type → ANY; anything else
(NUMERIC, DECIMAL, BOOLEAN, DATE, …) → NUMERIC, meaning ANY with numeric conversion of numeric-looking text. Values are converted
losslessly as SQLite STRICT tables do (`'5'` into an INTEGER column becomes 5), and anything else is rejected with
`cannot store TEXT value in INTEGER column t.c`.

**Not yet supported** (each gives a clear `SMALT_UNSUPPORTED` error): `USING` / `NATURAL` with `RIGHT` / `FULL` joins,
materialized views (M5), `ON CONFLICT` targets with WHERE, row-value assignments (`SET (a, b) = …`), `INCLUDE` columns, `WITHOUT ROWID`, `LOOSE` tables, generated columns, JSON
functions, and `VACUUM`. Plain `EXPLAIN` returns the `EXPLAIN QUERY PLAN` output (there is no bytecode to list).

**Known deviations:**
- Foreign keys are enforced by default (`PRAGMA foreign_keys` is 1); SQLite starts with 0.
- An integral REAL with magnitude below 2^53 stored in an `ANY`/`NUMERIC` column, or flowing through an untyped expression, reads back as
  INTEGER. This affects `typeof()`, text conversion and integer division (ADR 0003, decision 2). REALs outside ±2^53, such as int64-overflow
  results, are always treated as REAL, because smaltdb represents such integers as `bigint`.
- `AUTOINCREMENT` (only on an `INTEGER PRIMARY KEY`, as in SQLite) behaves like a plain `INTEGER PRIMARY KEY` (the max rowid + 1
  can be reused after deleting the largest row), except that once the largest rowid is 2^63 − 1 inserts fail with `SMALT_FULL`
  instead of picking random rowids.
- PRIMARY KEY columns are always NOT NULL.
- `FAIL` (`OR FAIL`, or a constraint's `ON CONFLICT FAIL`) behaves like `ABORT`. `OR ROLLBACK` and `ON CONFLICT ROLLBACK`
  roll back the enclosing transaction, and a constraint's `ON CONFLICT` action is its default resolution, as in SQLite.
- `char()` of a surrogate code point (U+D800–U+DFFF) gives U+FFFD; SQLite emits the invalid UTF-8 bytes.
- In `GROUP BY` / `DISTINCT` over NOCASE or RTRIM text, values that compare equal form one group, and which spelling is returned is unspecified.
  smaltdb returns the first row in scan order; SQLite returns the first in its own sort order, which can differ.
- Date/time: `'now'` (and `CURRENT_*`) is read once per statement execution, so every row of a query sees the same instant (SQLite
  guarantees this only within one `sqlite3_step()`). `unixepoch(…, 'subsec')` returns a REAL that reads back as INTEGER when it has no
  fractional part (the integral-REAL deviation above). Julian-day arithmetic is done in doubles, exact up to ±2^53 ms, so modifier chains whose
  intermediate values exceed that (e.g. `'+400000000000000 seconds', '-400000000000000 seconds'`) can be off by a few milliseconds where
  SQLite's int64 arithmetic is exact. As in SQLite, date functions may appear in index expressions and CHECK constraints,
  where reading the clock or time zone (`'now'`, `'localtime'`, `'utc'`, …) fails at run time.
- Index keys must fit in about a quarter of a page (≈2 KB with 8 KiB pages); SQLite allows larger keys via overflow pages.
