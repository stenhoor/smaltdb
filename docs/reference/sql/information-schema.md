# information_schema

The `information_schema` views describe the database's tables, columns, constraints, indexes, views and external data in the SQL-standard (PostgreSQL-like) shape. SQLite has none of them; smaltdb also offers SQLite's [`sqlite_schema`](#sqlite-schema) table and the schema [pragmas](./pragmas#schema-pragmas). For a task-oriented overview, see [Introspection](../../guide/introspection).

The views are read-only and computed when queried. Names are matched without regard to case (`INFORMATION_SCHEMA.TABLES` works). Every view lists objects of the `main` schema only:

- TEMP tables and TEMP views are not listed.
- Internal tables (`smalt_*`) are not listed.
- `table_catalog` and `table_schema` (and the other `*_catalog` / `*_schema` columns) are always `main`.

The examples use these objects:

```sql
CREATE TABLE customer(
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  tier INTEGER DEFAULT 1 CHECK (tier BETWEEN 1 AND 3)
);
CREATE TABLE orders(
  id INTEGER PRIMARY KEY,
  customer_id INTEGER NOT NULL,
  total REAL,
  CONSTRAINT orders_customer FOREIGN KEY (customer_id) REFERENCES customer(id) ON DELETE CASCADE
);
CREATE INDEX orders_by_customer ON orders(customer_id, total DESC);
CREATE VIEW big_orders AS SELECT id, total FROM orders WHERE total > 100;
CREATE MATERIALIZED VIEW order_totals AS SELECT customer_id, sum(total) AS spent FROM orders GROUP BY customer_id;
CREATE CONNECTION api WITH (url = 'https://example.com/data/', credentials = 'token');
CREATE EXTERNAL TABLE rates (currency TEXT, rate REAL) WITH (location = 'rates.csv', connection = 'api', header = true);
```

## schemata

| Column | Meaning |
| --- | --- |
| `catalog_name` | `main` |
| `schema_name` | `main` or `information_schema` |
| `schema_owner` | NULL |

```sql
SELECT * FROM information_schema.schemata
```

| catalog_name | schema_name | schema_owner |
| --- | --- | --- |
| main | main | NULL |
| main | information_schema | NULL |

## tables

One row per table, view, materialized view and external table.

| Column | Meaning |
| --- | --- |
| `table_catalog`, `table_schema` | `main` |
| `table_name` | name |
| `table_type` | `BASE TABLE`, `VIEW`, `MATERIALIZED VIEW` or `EXTERNAL` |
| `is_insertable_into` | `YES` for base tables, `NO` otherwise |

```sql
SELECT table_name, table_type, is_insertable_into FROM information_schema.tables
```

| table_name | table_type | is_insertable_into |
| --- | --- | --- |
| customer | BASE TABLE | YES |
| orders | BASE TABLE | YES |
| order_totals | MATERIALIZED VIEW | NO |
| big_orders | VIEW | NO |
| rates | EXTERNAL | NO |

## columns

One row per column of every table, view, materialized view and external table.

| Column | Meaning |
| --- | --- |
| `table_catalog`, `table_schema`, `table_name` | the owner |
| `column_name` | name |
| `ordinal_position` | position, from 1 |
| `column_default` | the default's source text, or NULL |
| `is_nullable` | `NO` for `NOT NULL` and primary key columns, else `YES` (always `YES` for views and external tables) |
| `data_type` | declared type as written (upper-cased); `ANY` when none |
| `collation_name` | `BINARY`, `NOCASE` or `RTRIM` for table columns; NULL for views and external tables |
| `is_identity` | `YES` for the `INTEGER PRIMARY KEY` (rowid) column |
| `is_generated` | always `NEVER` |

A view's columns are found by planning its query; a view that cannot be planned (for example, its table was dropped) has no rows here.

```sql
SELECT table_name, column_name, ordinal_position AS pos, column_default, is_nullable, data_type, collation_name, is_identity
FROM information_schema.columns WHERE table_name IN ('customer', 'big_orders')
```

| table_name | column_name | pos | column_default | is_nullable | data_type | collation_name | is_identity |
| --- | --- | --- | --- | --- | --- | --- | --- |
| customer | id | 1 | NULL | NO | INTEGER | BINARY | YES |
| customer | email | 2 | NULL | NO | TEXT | NOCASE | NO |
| customer | tier | 3 | 1 | YES | INTEGER | BINARY | NO |
| big_orders | id | 1 | NULL | YES | INTEGER | NULL | NO |
| big_orders | total | 2 | NULL | YES | REAL | NULL | NO |

## views

| Column | Meaning |
| --- | --- |
| `table_catalog`, `table_schema`, `table_name` | the view |
| `view_definition` | the `SELECT` text |
| `check_option` | `NONE` |
| `is_updatable`, `is_insertable_into` | `NO` |

```sql
SELECT table_name, view_definition FROM information_schema.views
```

| table_name | view_definition |
| --- | --- |
| big_orders | SELECT id, total FROM orders WHERE total > 100 |

## materialized_views

A smaltdb extension (PostgreSQL has `pg_matviews`).

| Column | Meaning |
| --- | --- |
| `table_catalog`, `table_schema`, `table_name` | the view |
| `view_definition` | the `SELECT` text |
| `storage` | `row` or `columnar` |
| `location` | `file`, or `memory` for `location = 'memory'` in a file database |
| `refresh_mode` | `MANUAL`, or the automatic policy: `EVERY n SECONDS`, `ON RECONNECT`, or both |
| `is_populated` | `NO` after `WITH NO DATA` until the first refresh |
| `last_refresh` | time of the last refresh (ISO 8601, UTC), or NULL |
| `is_fresh` | `YES` while no table the view reads has changed since the last refresh |
| `last_refresh_error` | the error of the last automatic refresh, or NULL |

```sql
SELECT table_name, view_definition, storage, location, refresh_mode, is_populated, is_fresh, last_refresh IS NOT NULL AS refreshed
FROM information_schema.materialized_views
```

| table_name | view_definition | storage | location | refresh_mode | is_populated | is_fresh | refreshed |
| --- | --- | --- | --- | --- | --- | --- | --- |
| order_totals | SELECT customer_id, sum(total) AS spent FROM orders GROUP BY customer_id | row | file | MANUAL | YES | YES | 1 |

## external_tables

A smaltdb extension.

| Column | Meaning |
| --- | --- |
| `table_catalog`, `table_schema`, `table_name` | the table |
| `location` | the `location` option |
| `format` | the `format` option as given (lower case), or else the format the file extension selects (`csv`, `tsv`, `json`, `parquet`); NULL when no installed [plugin](../../guide/plugins) reads that extension |
| `connection_name` | the connection, or NULL |
| `options` | the other options as a JSON object |

```sql
SELECT * FROM information_schema.external_tables
```

| table_catalog | table_schema | table_name | location | format | connection_name | options |
| --- | --- | --- | --- | --- | --- | --- |
| main | main | rates | rates.csv | csv | api | {"header":1} |

## connections

A smaltdb extension. Never shows secrets: `credentials` is only the name of a provider the application registers.

| Column | Meaning |
| --- | --- |
| `connection_name` | name |
| `connection_type` | `http`, `s3` or `azure`: the `type` option in lower case, with `https` shown as `http` (`http` when none) |
| `url` | the `url` option, or NULL |
| `credentials` | the `credentials` option, or NULL |
| `options` | the other options as a JSON object |

```sql
SELECT * FROM information_schema.connections
```

| connection_name | connection_type | url | credentials | options |
| --- | --- | --- | --- | --- |
| api | http | `https://example.com/data/` | token | {} |

## table_constraints

One row per `PRIMARY KEY`, `UNIQUE`, `FOREIGN KEY` and `CHECK` constraint. Constraints without a `CONSTRAINT name` get PostgreSQL-style names: `<table>_pkey`, `<table>_<columns>_key`, `<table>_<columns>_fkey`, `<table>_check<n>`.

| Column | Meaning |
| --- | --- |
| `constraint_catalog`, `constraint_schema`, `constraint_name` | the constraint |
| `table_catalog`, `table_schema`, `table_name` | its table |
| `constraint_type` | `PRIMARY KEY`, `UNIQUE`, `FOREIGN KEY` or `CHECK` |
| `is_deferrable` | `YES` for a foreign key declared `DEFERRABLE` (with or without `INITIALLY …`), else `NO` |
| `initially_deferred` | `YES` for `DEFERRABLE INITIALLY DEFERRED`, the only form checked at `COMMIT`; else `NO` |

```sql
SELECT constraint_name, table_name, constraint_type, is_deferrable FROM information_schema.table_constraints
```

| constraint_name | table_name | constraint_type | is_deferrable |
| --- | --- | --- | --- |
| customer_pkey | customer | PRIMARY KEY | NO |
| customer_email_key | customer | UNIQUE | NO |
| customer_check1 | customer | CHECK | NO |
| orders_pkey | orders | PRIMARY KEY | NO |
| orders_customer | orders | FOREIGN KEY | NO |

## key_column_usage

One row per column of each `PRIMARY KEY`, `UNIQUE` and `FOREIGN KEY` constraint.

| Column | Meaning |
| --- | --- |
| `constraint_catalog`, `constraint_schema`, `constraint_name` | the constraint |
| `table_catalog`, `table_schema`, `table_name` | its table |
| `column_name` | the column |
| `ordinal_position` | position in the constraint, from 1 |
| `position_in_unique_constraint` | for foreign keys, the position of the referenced column; NULL otherwise |

```sql
SELECT constraint_name, table_name, column_name, ordinal_position, position_in_unique_constraint
FROM information_schema.key_column_usage
```

| constraint_name | table_name | column_name | ordinal_position | position_in_unique_constraint |
| --- | --- | --- | --- | --- |
| customer_pkey | customer | id | 1 | NULL |
| customer_email_key | customer | email | 1 | NULL |
| orders_pkey | orders | id | 1 | NULL |
| orders_customer | orders | customer_id | 1 | 1 |

## referential_constraints

One row per foreign key.

| Column | Meaning |
| --- | --- |
| `constraint_catalog`, `constraint_schema`, `constraint_name` | the foreign key |
| `unique_constraint_catalog`, `unique_constraint_schema`, `unique_constraint_name` | the parent's primary key or unique constraint it references (NULL if none matches) |
| `match_option` | `NONE` |
| `update_rule`, `delete_rule` | `NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL` or `SET DEFAULT` |

```sql
SELECT constraint_name, unique_constraint_name, match_option, update_rule, delete_rule FROM information_schema.referential_constraints
```

| constraint_name | unique_constraint_name | match_option | update_rule | delete_rule |
| --- | --- | --- | --- | --- |
| orders_customer | customer_pkey | NONE | NO ACTION | CASCADE |

## check_constraints

| Column | Meaning |
| --- | --- |
| `constraint_catalog`, `constraint_schema`, `constraint_name` | the constraint |
| `check_clause` | the expression's source text |

```sql
SELECT constraint_name, check_clause FROM information_schema.check_constraints
```

| constraint_name | check_clause |
| --- | --- |
| customer_check1 | tier BETWEEN 1 AND 3 |

## statistics

Indexes and their columns, one row per indexed column (a non-standard view, as in MySQL). Includes the indexes behind `PRIMARY KEY` and `UNIQUE` constraints (but not the rowid).

| Column | Meaning |
| --- | --- |
| `table_catalog`, `table_schema`, `table_name` | the table |
| `non_unique` | 0 for a unique index, 1 otherwise |
| `index_name` | the index |
| `seq_in_index` | position in the index, from 1 |
| `column_name` | the column, or NULL for an expression |
| `collation` | `A` (ascending) or `D` (descending) |
| `index_type` | `BTREE` |

```sql
SELECT table_name, non_unique, index_name, seq_in_index, column_name, collation FROM information_schema.statistics
```

| table_name | non_unique | index_name | seq_in_index | column_name | collation |
| --- | --- | --- | --- | --- | --- |
| customer | 0 | smalt_autoindex_customer_1 | 1 | email | A |
| orders | 1 | orders_by_customer | 1 | customer_id | A |
| orders | 1 | orders_by_customer | 2 | total | D |

## routines

The built-in scalar and aggregate functions. Window-only functions (`row_number`, `lag`, …) and table-valued functions (`read_csv`, …) are not listed.

| Column | Meaning |
| --- | --- |
| `specific_name`, `routine_name` | function name |
| `routine_catalog`, `routine_schema` | `main` |
| `routine_type` | `FUNCTION` or `AGGREGATE` |
| `is_deterministic` | `NO` for functions such as `random()` and `changes()`, else `YES` |
| `routine_body` | `EXTERNAL` |

```sql
SELECT routine_name, routine_type, is_deterministic FROM information_schema.routines WHERE routine_name IN ('abs', 'count', 'random')
```

| routine_name | routine_type | is_deterministic |
| --- | --- | --- |
| abs | FUNCTION | YES |
| count | AGGREGATE | YES |
| random | FUNCTION | NO |

The standard `parameters` view does not exist.

## sqlite_schema

`sqlite_schema` (also `sqlite_master` and `smalt_schema`) is the catalog table, with SQLite's columns. It cannot be modified directly.

| Column | Meaning |
| --- | --- |
| `type` | the kind of object; see below |
| `name` | object name |
| `tbl_name` | the table an index belongs to; for other objects, the name itself |
| `rootpage` | first page of the object's B+tree; 0 for views, external tables and connections |
| `sql` | the `CREATE` statement as written; NULL for constraint indexes |

| `type` | Object |
| --- | --- |
| `table` | a table, including internal `smalt_*` tables (statistics, materialized view metadata) |
| `index` | an index, including `smalt_autoindex_*` constraint indexes |
| `view` | a view |
| `matview` | a materialized view (smaltdb) |
| `external` | an external table (smaltdb) |
| `connection` | a connection (smaltdb) |

```sql
SELECT type, name, tbl_name, rootpage > 0 AS has_pages, sql IS NOT NULL AS has_sql
FROM sqlite_schema WHERE name NOT LIKE 'smalt\_%' ESCAPE '\' OR type = 'index'
```

| type | name | tbl_name | has_pages | has_sql |
| --- | --- | --- | --- | --- |
| table | customer | customer | 1 | 1 |
| index | smalt_autoindex_customer_1 | customer | 1 | 0 |
| table | orders | orders | 1 | 1 |
| index | orders_by_customer | orders | 1 | 1 |
| view | big_orders | big_orders | 0 | 1 |
| matview | order_totals | order_totals | 1 | 1 |
| connection | api | api | 0 | 1 |
| external | rates | rates | 0 | 1 |

For an external table created without a column list, `sql` is a rewritten statement that includes the inferred columns.

TEMP objects are not in `sqlite_schema`. As in SQLite, `temp.sqlite_schema` (also `temp.sqlite_master`, `sqlite_temp_schema` and `sqlite_temp_master`) lists them, with the same columns, in creation order: TEMP tables, their indexes and TEMP views. Their `rootpage` is the page in the in-memory store that holds TEMP objects, and their `sql` is the statement as written.
