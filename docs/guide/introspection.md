# Introspection

smaltdb describes its own schema in three ways:

- **`information_schema`**: read-only views in the SQL-standard (and PostgreSQL) shape. Use them for portable queries and tools.
- **`sqlite_schema`**: the catalog table, as in SQLite, with the `CREATE` statement of every object.
- **Pragmas** (`PRAGMA table_info(t)`, or as table-valued functions such as `pragma_table_info('t')`), compatible with SQLite.

Reference: [information_schema](../reference/sql/information-schema), [PRAGMA](../reference/sql/pragmas), [table-valued functions](../reference/functions/table-valued).

## Sample schema

```sql
CREATE TABLE authors (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  email TEXT COLLATE NOCASE
);

CREATE TABLE books (
  id        INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES authors(id) ON DELETE CASCADE,
  title     TEXT NOT NULL,
  year      INTEGER CHECK (year > 1400),
  price     REAL DEFAULT 0
);

CREATE INDEX books_author_year ON books(author_id, year DESC);
CREATE INDEX books_cheap ON books(price) WHERE price < 10;
CREATE VIEW recent_books AS SELECT title, year FROM books WHERE year >= 2020;
```

## information_schema

| View | Contents |
| --- | --- |
| `schemata` | The schemas: `main` and `information_schema`. |
| `tables` | Tables, views, materialized views and external tables, with `table_type`. |
| `columns` | Columns of tables, views, materialized views and external tables. |
| `views` | View definitions. |
| `table_constraints` | `PRIMARY KEY`, `UNIQUE`, `FOREIGN KEY` and `CHECK` constraints. |
| `key_column_usage` | The columns of key and foreign-key constraints. |
| `referential_constraints` | Foreign keys: the referenced constraint and the `ON UPDATE` / `ON DELETE` actions. |
| `check_constraints` | The expression of each `CHECK` constraint. |
| `statistics` | Indexes and their columns (like MySQL's view of the same name). |
| `routines` | Built-in functions and aggregates. |
| `materialized_views` | smaltdb extension: storage, location, refresh mode, freshness and last refresh of each materialized view. |
| `external_tables` | smaltdb extension: location, format, connection and options of each external table. |
| `connections` | smaltdb extension: each connection's type, URL, credentials name and options (never secrets). |

Every view has the standard `table_catalog` and `table_schema` columns (always `main`), so queries written for PostgreSQL usually work unchanged. Internal tables (names starting with `smalt_`) and `TEMP` tables are not listed.

### Tables and views

```sql
SELECT table_name, table_type, is_insertable_into
FROM information_schema.tables
ORDER BY table_name;
```

| table_name | table_type | is_insertable_into |
| --- | --- | --- |
| authors | BASE TABLE | YES |
| books | BASE TABLE | YES |
| recent_books | VIEW | NO |

`table_type` is `BASE TABLE`, `VIEW`, `MATERIALIZED VIEW` or `EXTERNAL`.

### Columns

```sql
SELECT column_name, data_type, is_nullable, column_default, collation_name, is_identity
FROM information_schema.columns
WHERE table_name = 'books'
ORDER BY ordinal_position;
```

| column_name | data_type | is_nullable | column_default | collation_name | is_identity |
| --- | --- | --- | --- | --- | --- |
| id | INTEGER | NO | NULL | BINARY | YES |
| author_id | INTEGER | NO | NULL | BINARY | NO |
| title | TEXT | NO | NULL | BINARY | NO |
| year | INTEGER | YES | NULL | BINARY | NO |
| price | REAL | YES | 0 | BINARY | NO |

- `data_type` is the declared type, or `ANY` for a column declared without one.
- `column_default` is the default expression as written.
- `is_identity` is `YES` for the `INTEGER PRIMARY KEY` column, which is the rowid.
- A view's columns are listed too, with types worked out from its query:

```sql
SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'recent_books';
```

| column_name | data_type |
| --- | --- |
| title | TEXT |
| year | INTEGER |

### Constraints

Constraints without a name get PostgreSQL-style names: `<table>_pkey`, `<table>_<column>_key`, `<table>_<column>_fkey` and `<table>_check1`, `<table>_check2`, …

```sql
SELECT table_name, constraint_name, constraint_type
FROM information_schema.table_constraints
ORDER BY table_name, constraint_name;
```

| table_name | constraint_name | constraint_type |
| --- | --- | --- |
| authors | authors_name_key | UNIQUE |
| authors | authors_pkey | PRIMARY KEY |
| books | books_author_id_fkey | FOREIGN KEY |
| books | books_check1 | CHECK |
| books | books_pkey | PRIMARY KEY |

Foreign keys, with the key they reference and their actions:

```sql
SELECT k.table_name, k.column_name, r.unique_constraint_name, r.update_rule, r.delete_rule
FROM information_schema.referential_constraints r
JOIN information_schema.key_column_usage k ON k.constraint_name = r.constraint_name;
```

| table_name | column_name | unique_constraint_name | update_rule | delete_rule |
| --- | --- | --- | --- | --- |
| books | author_id | authors_pkey | NO ACTION | CASCADE |

```sql
SELECT constraint_name, check_clause FROM information_schema.check_constraints;
```

| constraint_name | check_clause |
| --- | --- |
| books_check1 | year > 1400 |

### Indexes

`information_schema.statistics` has one row per index column. `collation` is `A` (ascending) or `D` (descending), as in MySQL.

```sql
SELECT table_name, index_name, non_unique, seq_in_index, column_name, collation
FROM information_schema.statistics
ORDER BY table_name, index_name, seq_in_index;
```

| table_name | index_name | non_unique | seq_in_index | column_name | collation |
| --- | --- | --- | --- | --- | --- |
| authors | smalt_autoindex_authors_1 | 0 | 1 | name | A |
| books | books_author_year | 1 | 1 | author_id | A |
| books | books_author_year | 1 | 2 | year | D |
| books | books_cheap | 1 | 1 | price | A |

The `UNIQUE` constraint on `authors.name` is backed by an automatic index named `smalt_autoindex_<table>_<n>`. The `INTEGER PRIMARY KEY` needs no index, so it has none. For an expression index, `column_name` is NULL. Partial indexes are listed like others; use `pragma_index_list` (below) to tell them apart.

### Functions

`information_schema.routines` lists the built-in scalar functions (`routine_type = 'FUNCTION'`) and aggregates (`'AGGREGATE'`):

```sql
SELECT routine_name, routine_type, is_deterministic
FROM information_schema.routines
WHERE routine_name IN ('lower', 'random', 'sum', 'group_concat')
ORDER BY routine_name;
```

| routine_name | routine_type | is_deterministic |
| --- | --- | --- |
| group_concat | AGGREGATE | YES |
| lower | FUNCTION | YES |
| random | FUNCTION | NO |
| sum | AGGREGATE | YES |

Function signatures are not available: there is no `information_schema.parameters` view.

## sqlite_schema

`sqlite_schema` (also `sqlite_master` and `smalt_schema`) is the catalog, with one row per object:

| Column | Meaning |
| --- | --- |
| `type` | `table`, `index`, `view`, `matview` (materialized view), `external` (external table) or `connection`. |
| `name` | The object's name. |
| `tbl_name` | For an index, its table; otherwise the object's own name. |
| `rootpage` | The root page of its B-tree, or 0 for objects without stored rows. |
| `sql` | The `CREATE` statement, or NULL for automatic indexes. |

```sql
SELECT type, name, tbl_name FROM sqlite_schema ORDER BY type, name;
```

| type | name | tbl_name |
| --- | --- | --- |
| index | books_author_year | books |
| index | books_cheap | books |
| index | smalt_autoindex_authors_1 | authors |
| table | authors | authors |
| table | books | books |
| view | recent_books | recent_books |

The stored `sql` is the statement as you wrote it, so it is the easiest way to recreate an object:

```sql
SELECT sql FROM sqlite_schema WHERE name = 'books_cheap';
```

| sql |
| --- |
| CREATE INDEX books_cheap ON books(price) WHERE price < 10 |

Unlike `information_schema`, `sqlite_schema` also lists smaltdb's internal tables once they exist, such as `smalt_stat` (created by `ANALYZE`) and `smalt_matview` (created with the first materialized view). To hide them, filter on `NOT (type = 'table' AND name LIKE 'smalt\_%' ESCAPE '\')`; a plain filter on the name would also hide automatic indexes, whose names start with `smalt_autoindex_`. The catalog cannot be modified directly. `TEMP` objects are listed in `temp.sqlite_schema` (also `sqlite_temp_schema`, `sqlite_temp_master`), as in SQLite.

## Pragma functions

These pragmas return rows describing one table or index, as in SQLite. Each can be run as a statement (`PRAGMA table_info(books)`) or used as a table-valued function in a query (`pragma_table_info('books')`).

| Function | Argument | Columns |
| --- | --- | --- |
| `pragma_table_info` | table | `cid`, `name`, `type`, `notnull`, `dflt_value`, `pk` |
| `pragma_table_xinfo` | table | `table_info`'s columns and `hidden` (always 0: smaltdb has no hidden or generated columns) |
| `pragma_index_list` | table | `seq`, `name`, `unique`, `origin`, `partial` |
| `pragma_index_info` | index | `seqno`, `cid`, `name` |
| `pragma_index_xinfo` | index | `seqno`, `cid`, `name`, `desc`, `coll`, `key` |
| `pragma_foreign_key_list` | table | `id`, `seq`, `table`, `from`, `to`, `on_update`, `on_delete`, `match` |

```sql
SELECT * FROM pragma_table_info('books');
```

| cid | name | type | notnull | dflt_value | pk |
| --- | --- | --- | --- | --- | --- |
| 0 | id | INTEGER | 0 | NULL | 1 |
| 1 | author_id | INTEGER | 1 | NULL | 0 |
| 2 | title | TEXT | 1 | NULL | 0 |
| 3 | year | INTEGER | 0 | NULL | 0 |
| 4 | price | REAL | 0 | 0 | 0 |

`notnull` reflects an explicit `NOT NULL`; as in SQLite, the `INTEGER PRIMARY KEY` shows 0 although it can never be NULL. `pk` is the column's position in the primary key, or 0.

```sql
SELECT * FROM pragma_index_list('books');
```

| seq | name | unique | origin | partial |
| --- | --- | --- | --- | --- |
| 0 | books_author_year | 0 | c | 0 |
| 1 | books_cheap | 0 | c | 1 |

`origin` is `c` for an index made with `CREATE INDEX`, `u` for one made by a `UNIQUE` constraint and `pk` for one made by a `PRIMARY KEY` that is not the rowid.

```sql
SELECT * FROM pragma_index_xinfo('books_author_year');
```

| seqno | cid | name | desc | coll | key |
| --- | --- | --- | --- | --- | --- |
| 0 | 1 | author_id | 0 | BINARY | 1 |
| 1 | 3 | year | 1 | BINARY | 1 |
| 2 | -1 | NULL | 0 | BINARY | 0 |

The last row (`key` = 0, `cid` = -1) is the rowid that every index entry carries, as in SQLite. In `pragma_index_info`, an expression column has `cid` -2 and a NULL name.

```sql
SELECT "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list('books');
```

| table | from | to | on_update | on_delete |
| --- | --- | --- | --- | --- |
| authors | author_id | id | NO ACTION | CASCADE |

For a table that does not exist, the functions return no rows.

### Joining the catalog with pragma functions

The argument of a pragma function can refer to an earlier table in the `FROM` clause, so one query can describe every table:

```sql
SELECT m.name AS table_name, p.name AS column_name, p.type, p.pk
FROM sqlite_schema AS m
JOIN pragma_table_info(m.name) AS p
WHERE m.type = 'table'
ORDER BY m.name, p.cid;
```

| table_name | column_name | type | pk |
| --- | --- | --- | --- |
| authors | id | INTEGER | 1 |
| authors | name | TEXT | 0 |
| authors | email | TEXT | 0 |
| books | id | INTEGER | 1 |
| books | author_id | INTEGER | 0 |
| books | title | TEXT | 0 |
| books | year | INTEGER | 0 |
| books | price | REAL | 0 |

Every index with its columns:

```sql
SELECT l.name AS index_name, i.seqno, i.name AS column_name, l."unique", l.partial
FROM sqlite_schema AS m
JOIN pragma_index_list(m.name) AS l
JOIN pragma_index_info(l.name) AS i
WHERE m.type = 'table'
ORDER BY l.name, i.seqno;
```

| index_name | seqno | column_name | unique | partial |
| --- | --- | --- | --- | --- |
| books_author_year | 0 | author_id | 0 | 0 |
| books_author_year | 1 | year | 0 | 0 |
| books_cheap | 0 | price | 0 | 1 |
| smalt_autoindex_authors_1 | 0 | name | 1 | 0 |

## Database-level pragmas

| Pragma | Returns |
| --- | --- |
| `PRAGMA page_size` | Bytes per page (8192 unless the database was created with another `pageSize`). |
| `PRAGMA page_count` | Pages in the database file. |
| `PRAGMA freelist_count` | Pages that are allocated but unused. |
| `PRAGMA schema_version` | A counter that changes with every schema change. |
| `PRAGMA integrity_check` | `ok`, or one row per problem found. |
| `PRAGMA journal_mode` | `wal` for an OPFS database, `off` for an in-memory one. |
| `PRAGMA foreign_keys` | 1 when foreign keys are enforced (the default in smaltdb; SQLite's default is 0). |

These run as statements only; there is no `pragma_page_count()` function. The size of the database file is `page_count × page_size` bytes:

```sql
PRAGMA page_size;
```

| page_size |
| --- |
| 8192 |

```sql
PRAGMA integrity_check;
```

| integrity_check |
| --- |
| ok |

smaltdb has no per-table size statistics (there is no `dbstat`). To see how many rows each table has, query `count(*)` per table, which is answered from the B-tree without reading rows. Other pragmas, and those for performance and analytics (`work_mem`, `matview_rewrite`, …), are listed in the [PRAGMA reference](../reference/sql/pragmas).

## Materialized views, external tables and connections

The smaltdb extensions to `information_schema` are described with their features:

- `information_schema.materialized_views`: [Views and materialized views](./views-and-materialized-views#freshness)
- `information_schema.external_tables` and `information_schema.connections`: [External data](./external-data#external-tables)

## smaltdb_version()

`smaltdb_version()` returns the version of the smaltdb package as text, such as `'0.9.0'`:

```sql
SELECT typeof(smaltdb_version()) AS type;
```

| type |
| --- |
| text |

`sqlite_version()` does not exist.

## Differences from SQLite

- `information_schema` exists (SQLite has none).
- `sqlite_schema` has extra object types: `matview`, `external` and `connection`.
- `PRAGMA table_list`, `PRAGMA database_list` and most other SQLite pragmas are not supported and fail with `SMALT_UNSUPPORTED`.
- `TEMP` objects do not appear in `information_schema`.
