# Views

A view is a named query. A materialized view stores the query's result as rows and is refreshed explicitly. For when to use which, refresh strategies and query rewriting, see [Views and materialized views](../../guide/views-and-materialized-views).

## CREATE VIEW

```text
CREATE [TEMP | TEMPORARY] VIEW [IF NOT EXISTS] [schema.]name [(column [, ...])] AS select
```

A view is read like a table. Its query runs every time the view is used. The column list, if given, renames the query's columns and must match their number (otherwise reading the view fails with `expected 2 columns for 'v' but got 1`).

```sql
CREATE TABLE sale(day TEXT, product TEXT, amount REAL);
INSERT INTO sale VALUES
  ('2024-01-01', 'pen', 10), ('2024-01-01', 'ink', 5), ('2024-01-02', 'pen', 7);
CREATE VIEW daily(day, total) AS SELECT day, sum(amount) FROM sale GROUP BY day;
SELECT * FROM daily ORDER BY day
```

| day | total |
| --- | --- |
| 2024-01-01 | 15 |
| 2024-01-02 | 7 |

- As in SQLite, the query is resolved when the view is used, not when it is created: a view may name a table created later, and a view whose table was dropped fails when read (`no such table`).
- Views are read-only: `INSERT`, `UPDATE` and `DELETE` fail with `cannot modify v because it is a view`, and views cannot be indexed or altered.
- Simple views (a plain projection, filter or join over tables: no aggregates, `GROUP BY`, `DISTINCT`, window functions, `ORDER BY`, `LIMIT`, compound, `WITH` or subquery expressions) are merged into the query that uses them, so their tables use indexes as if written out directly.
- A `TEMP` view exists only for this connection and shadows a main view of the same name. A view that reads a TEMP table or view becomes TEMP automatically; asking for it in `main` (`CREATE VIEW main.v …`) fails. `CREATE VIEW temp.v` is the same as `CREATE TEMP VIEW v`; `CREATE TEMP VIEW main.v` fails with `temporary table name must be unqualified`. `temp.v` and `main.v` read that schema's view.

## DROP VIEW

```text
DROP VIEW [IF EXISTS] [schema.]name
```

See [DROP](./drop).

## CREATE MATERIALIZED VIEW

```text
CREATE MATERIALIZED VIEW [IF NOT EXISTS] [main.]name [(column [, ...])]
  [WITH (option = value [, ...])]
  AS select
  [WITH DATA | WITH NO DATA]
```

The query runs once when the view is created (unless `WITH NO DATA`), and its rows are stored like a table's. Reading the view reads the stored rows, which stay as they are until the next [`REFRESH`](#refresh-materialized-view).

```sql
CREATE MATERIALIZED VIEW product_totals AS
  SELECT product, sum(amount) AS total, count(*) AS n FROM sale GROUP BY product;
SELECT * FROM product_totals ORDER BY product
```

| product | total | n |
| --- | --- | --- |
| ink | 5 | 1 |
| pen | 17 | 2 |

### Options

| Option | Values | Default | Meaning |
| --- | --- | --- | --- |
| `storage` | `'row'`, `'columnar'` | `'row'` | row storage, or columnar segments with zone maps (faster scans and aggregates, no indexes) |
| `location` | `'file'`, `'memory'` | `'file'` | `'memory'` keeps the rows and indexes in memory and only the definition in the file; see below |
| `refresh` | `'manual'` | `'manual'` | other values fail with `SMALT_UNSUPPORTED` |
| `refresh_every` | seconds (> 0) | none | the engine worker runs `REFRESH … IF CHANGED` when this long has passed since the last refresh |
| `refresh_on_reconnect` | `true` / `false` | `false` | the engine worker runs `REFRESH … IF CHANGED` when the browser comes back online |

Unknown options fail with `unknown materialized view option: x`.

- `location = 'memory'`: in a file (OPFS) database, the view's rows are not written to the file. They are recomputed when the database is opened. In an in-memory database the option changes nothing (`information_schema.materialized_views.location` shows `file`).
- `refresh_every` and `refresh_on_reconnect` are run by the engine worker that the `smaltdb` client uses. The refreshes queue like any other request. With the in-process engine (`smaltdb/engine`), nothing runs them: run `REFRESH … IF CHANGED` yourself. The policy and the last automatic refresh's error are shown in [`information_schema.materialized_views`](./information-schema#materialized-views) (`refresh_mode`, `last_refresh_error`).

```sql
CREATE MATERIALIZED VIEW daily_cache
  WITH (storage = 'columnar', refresh_every = 300, refresh_on_reconnect = true)
  AS SELECT day, sum(amount) AS total FROM sale GROUP BY day;
SELECT table_name, storage, refresh_mode FROM information_schema.materialized_views ORDER BY table_name
```

| table_name | storage | refresh_mode |
| --- | --- | --- |
| daily_cache | columnar | EVERY 300 SECONDS, ON RECONNECT |
| product_totals | row | MANUAL |

### WITH DATA and WITH NO DATA

`WITH DATA` (the default) fills the view at creation. `WITH NO DATA` creates it empty and unpopulated: reading it fails until it is refreshed, as in PostgreSQL.

```sql
CREATE MATERIALIZED VIEW later AS SELECT count(*) AS n FROM sale WITH NO DATA;
```

<!-- docs:error SMALT_ERROR -->
```sql
SELECT * FROM later
```

The message is `materialized view "later" has not been populated (use REFRESH MATERIALIZED VIEW)`.

### Column types

Each column's type comes from the query. A column copied from a table keeps its declared type and collation; a computed column gets the type of its expression (INTEGER, REAL, TEXT, BLOB) or ANY when that is not known. Column names must be unique: `select 1 AS a, 2 AS a` fails with `column "a" specified more than once (name it with AS)`.

A refresh that produces a value its column cannot hold fails with `SMALT_MISMATCH` and keeps the old rows; add a `CAST` to the view's query.

### Using a materialized view

- It is read-only: `INSERT`, `UPDATE`, `DELETE` and `ALTER TABLE` fail (`cannot change materialized view "m" (use REFRESH MATERIALIZED VIEW)`).
- With row storage it can have indexes, which every refresh rebuilds.
- It cannot be `TEMP` and cannot read TEMP tables or views.
- `sqlite_schema` lists it with type `matview`; `information_schema.tables` shows `MATERIALIZED VIEW`.
- `information_schema.materialized_views.is_fresh` is `NO` once a table it reads has changed since the last refresh.
- With [`PRAGMA matview_rewrite = 1`](./pragmas#matview-rewrite), queries can be answered from fresh materialized views automatically.

```sql
CREATE INDEX product_totals_total ON product_totals(total);
INSERT INTO sale VALUES ('2024-01-03', 'ink', 3);
SELECT table_name, is_fresh FROM information_schema.materialized_views WHERE table_name = 'product_totals'
```

| table_name | is_fresh |
| --- | --- |
| product_totals | NO |

## REFRESH MATERIALIZED VIEW

```text
REFRESH MATERIALIZED VIEW [CONCURRENTLY] [main.]name [CONCURRENTLY] [IF CHANGED] [WITH DATA | WITH NO DATA]
```

Runs the view's query again and replaces the stored rows. The new rows are built next to the old ones and swapped in, so readers never see a half-done refresh and a failed refresh leaves the old rows.

| Clause | Meaning |
| --- | --- |
| `CONCURRENTLY` | accepted (before or after the name); every refresh already swaps in new rows, so it changes nothing and, unlike PostgreSQL, needs no unique index. It cannot be combined with `WITH NO DATA`. |
| `IF CHANGED` | refresh only if something the view reads has changed; see below |
| `WITH NO DATA` | empty the view and mark it unpopulated |

```sql
REFRESH MATERIALIZED VIEW product_totals;
SELECT * FROM product_totals ORDER BY product
```

| product | total | n |
| --- | --- | --- |
| ink | 8 | 2 |
| pen | 17 | 2 |

### IF CHANGED

`REFRESH MATERIALIZED VIEW name IF CHANGED` refreshes only when:

- the view is unpopulated, or a local table it reads changed since its last refresh; or
- an [external](./external) source it read has changed. Each source's validator from the last refresh (an HTTP ETag or Last-Modified, a local file's modification time and size, a registered `File`'s `lastModified` and size) is checked with a HEAD request or a stat, not a download. A source without a validator, such as registered bytes or a `Blob`, always counts as changed.

`IF CHANGED` needs the asynchronous API: `execAsync`, `runAsync` or `queryAsync` in-process, or any call through the `smaltdb` client. With the synchronous engine API it fails with `SMALT_ASYNC_REQUIRED`.

```sql
REFRESH MATERIALIZED VIEW daily_cache IF CHANGED;
SELECT * FROM daily_cache ORDER BY day
```

| day | total |
| --- | --- |
| 2024-01-01 | 15 |
| 2024-01-02 | 7 |
| 2024-01-03 | 3 |

## DROP MATERIALIZED VIEW

```text
DROP MATERIALIZED VIEW [IF EXISTS] [main.]name
```

Removes the view, its rows and its indexes. `DROP VIEW` and `DROP TABLE` refuse a materialized view (`use DROP MATERIALIZED VIEW to delete materialized view m`).

```sql
DROP MATERIALIZED VIEW later;
SELECT count(*) AS n FROM information_schema.materialized_views
```

| n |
| --- |
| 2 |
