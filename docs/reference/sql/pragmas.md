# PRAGMA

`PRAGMA` reads or changes engine settings and inspects the schema. smaltdb implements the pragmas on this page; any other name fails with `SMALT_UNSUPPORTED` (`PRAGMA cache_size is not supported yet`).

## Syntax

```text
PRAGMA [schema.]name
PRAGMA [schema.]name = value
PRAGMA [schema.]name(value)
```

The value is a number, a string, or a bare word (`ON`, `wal`, a table name). The schema prefix (`main.`) is accepted and ignored. Names are matched without regard to case.

**Boolean settings** are on for `1`, `on`, `true` or `yes` (any case), and off for anything else.

## Scope

| Kind | Pragmas | Scope |
| --- | --- | --- |
| Settings | `foreign_keys`, `work_mem`, `matview_rewrite`, `parallel_aggregates` | the open database handle: not stored in the file, back to the default when the database is opened again |
| Database facts | `page_size`, `page_count`, `freelist_count`, `schema_version`, `journal_mode`, `spill_bytes` | read-only; describe the database file (or the handle, for `spill_bytes`) |
| Actions | `integrity_check`, `wal_checkpoint`, `compact` | run when the statement runs |
| Schema | `table_info`, `table_xinfo`, `index_list`, `index_info`, `index_xinfo`, `foreign_key_list` | read-only |

With the `smaltdb` client, all tabs that share a database talk to one engine, so they share its settings. Parallel reader workers use the owner's `work_mem` and `matview_rewrite`.

Giving a value to a read-only pragma does nothing: `PRAGMA page_size = 4096` returns the current page size. The page size of a new database and the journal mode are chosen when the database is opened (see [Databases](../../guide/databases)).

## Settings

### foreign_keys

```text
PRAGMA foreign_keys
PRAGMA foreign_keys = ON | OFF
```

Whether foreign-key constraints are enforced. **Default: 1 (on)**; SQLite's default is off. Turning it off skips all checks and actions until it is turned on again; rows written meanwhile are not checked later. Inside a transaction the setting cannot change: the statement succeeds and does nothing, as in SQLite.

```sql
PRAGMA foreign_keys
```

| foreign_keys |
| --- |
| 1 |

```sql
PRAGMA foreign_keys = OFF;
PRAGMA foreign_keys
```

| foreign_keys |
| --- |
| 0 |

```sql
PRAGMA foreign_keys = ON;
BEGIN;
PRAGMA foreign_keys = OFF;
PRAGMA foreign_keys
```

| foreign_keys |
| --- |
| 1 |

```sql
COMMIT
```

### work_mem

```text
PRAGMA work_mem
PRAGMA work_mem = bytes
```

How many bytes (estimated) a sort or hash aggregate may hold in memory before it spills to the scratch file `<database>-spill`. **Default: 268435456 (256 MiB)**, or the engine's `workMem` open option. `0` means never spill. A negative or non-integer value fails with `work_mem must be a non-negative number of bytes`. In-memory databases never spill. See [Analytics](../../guide/analytics).

```sql
PRAGMA work_mem = 67108864;
PRAGMA work_mem
```

| work_mem |
| --- |
| 67108864 |

### matview_rewrite

```text
PRAGMA matview_rewrite
PRAGMA matview_rewrite = ON | OFF
```

When on, a `SELECT` that a fresh [materialized view](./views) provably answers is read from the view instead of the base tables. **Default: 0 (off).** Views over external data or TEMP objects are never used. See [Views and materialized views](../../guide/views-and-materialized-views).

```sql
PRAGMA matview_rewrite = on;
PRAGMA matview_rewrite
```

| matview_rewrite |
| --- |
| 1 |

### parallel_aggregates

```text
PRAGMA parallel_aggregates
PRAGMA parallel_aggregates = ON | OFF
```

Whether an aggregate query over a large table (200,000 rows or more) may be split across the client's parallel reader workers. **Default: 1 (on).** It has no effect without parallel readers, for example with the in-process engine.

```sql
PRAGMA parallel_aggregates
```

| parallel_aggregates |
| --- |
| 1 |

## Database facts

### page_size, page_count, freelist_count

The page size in bytes (default 8192 for a new database), the number of pages in the database, and how many of them are free for reuse. The file size is about `page_size × page_count`.

```sql
PRAGMA page_size
```

| page_size |
| --- |
| 8192 |

### schema_version

A counter that changes whenever the stored schema changes (tables, indexes, views created, altered or dropped).

### journal_mode

`wal` for a file database opened with a write-ahead log (the default), `off` for one opened without, and for in-memory databases. It cannot be changed with `PRAGMA`.

```sql
PRAGMA journal_mode
```

| journal_mode |
| --- |
| off |

### spill_bytes

Bytes written to the scratch (spill) file since the database was opened. Useful to see whether `work_mem` is too small.

```sql
PRAGMA spill_bytes
```

| spill_bytes |
| --- |
| 0 |

## Actions

### integrity_check

Walks every B+tree (catalog, tables, indexes, columnar segments) and checks that pages are consistent, that each full index has as many entries as its table has rows, and that every page is either in use or free. Returns one row `ok`, or one row per problem.

```sql
PRAGMA integrity_check
```

| integrity_check |
| --- |
| ok |

### wal_checkpoint

Copies the committed pages from the write-ahead log into the database file. Checkpoints also run automatically once the log grows past a threshold (4 MiB by default). Returns one row:

| Column | Meaning |
| --- | --- |
| `busy` | 1 if the checkpoint could not run because a transaction is open (then `log` and `checkpointed` are -1) |
| `log` | frames in the log before the checkpoint |
| `checkpointed` | frames copied |

```sql
PRAGMA wal_checkpoint
```

| busy | log | checkpointed |
| --- | --- | --- |
| 0 | 0 | 0 |

In an in-memory database there is no log, so both counts are 0.

### compact

```text
PRAGMA compact(table)
```

Rewrites a [columnar table](./create-table#columnar-tables): rows waiting in its row store are moved into column segments and deleted rows are dropped. Other tables fail with `PRAGMA compact needs a columnar table, not t`. See [Analytics](../../guide/analytics).

```sql
CREATE TABLE metric(id INTEGER PRIMARY KEY, v REAL) WITH (storage = 'columnar');
INSERT INTO metric(v) VALUES (1.5), (2.5);
DELETE FROM metric WHERE id = 1;
PRAGMA compact(metric);
SELECT * FROM metric
```

| id | v |
| --- | --- |
| 2 | 2.5 |

## Schema pragmas

Each of these also exists as a table-valued function named `pragma_<name>(arg)`, which can be filtered and joined like a table (see [table-valued functions](../functions/table-valued)). For an unknown table, the `PRAGMA` form fails with `no such table: x`, while the function form returns no rows.

```sql
CREATE TABLE parent(id INTEGER PRIMARY KEY, code TEXT NOT NULL DEFAULT 'x' COLLATE NOCASE, UNIQUE(code));
CREATE TABLE child(
  id INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES parent(id) ON DELETE CASCADE,
  qty REAL
);
CREATE INDEX child_qty ON child(qty DESC, abs(qty)) WHERE qty > 0;
```

### table_info

`PRAGMA table_info(table)`: one row per column.

| Column | Meaning |
| --- | --- |
| `cid` | column position, from 0 |
| `name` | column name |
| `type` | declared type as written (upper-cased), `''` when none |
| `notnull` | 1 if declared `NOT NULL` |
| `dflt_value` | the default's source text, or NULL |
| `pk` | position in the primary key (from 1), or 0 |

```sql
PRAGMA table_info(parent)
```

| cid | name | type | notnull | dflt_value | pk |
| --- | --- | --- | --- | --- | --- |
| 0 | id | INTEGER | 0 | NULL | 1 |
| 1 | code | TEXT | 1 | 'x' | 0 |

As in SQLite, `notnull` is 0 for an `INTEGER PRIMARY KEY` that was not declared `NOT NULL`, although it can never be NULL.

### table_xinfo

The columns and rows of `table_info`, plus `hidden`, as in SQLite. It is always 0: smaltdb has no hidden or generated columns (SQLite's 1, 2 and 3).

```sql
PRAGMA table_xinfo(parent)
```

| cid | name | type | notnull | dflt_value | pk | hidden |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | id | INTEGER | 0 | NULL | 1 | 0 |
| 1 | code | TEXT | 1 | 'x' | 0 | 0 |

For an [external table](./external), `table_info` and `table_xinfo` list its columns, and `index_list` and `foreign_key_list` give no rows.

### index_list

`PRAGMA index_list(table)`: one row per index of the table.

| Column | Meaning |
| --- | --- |
| `seq` | position, from 0 |
| `name` | index name; constraint indexes are named `smalt_autoindex_<table>_<n>` |
| `unique` | 1 for a unique index |
| `origin` | `c` (CREATE INDEX), `u` (UNIQUE constraint) or `pk` (PRIMARY KEY constraint) |
| `partial` | 1 for a partial index |

```sql
PRAGMA index_list(child)
```

| seq | name | unique | origin | partial |
| --- | --- | --- | --- | --- |
| 0 | child_qty | 0 | c | 1 |

### index_info

`PRAGMA index_info(index)`: one row per key column. `cid` is -2 and `name` NULL for an expression. An unknown index gives no rows.

| Column | Meaning |
| --- | --- |
| `seqno` | position in the index, from 0 |
| `cid` | table column position, or -2 for an expression |
| `name` | column name, or NULL |

```sql
PRAGMA index_info(child_qty)
```

| seqno | cid | name |
| --- | --- | --- |
| 0 | 2 | qty |
| 1 | -2 | NULL |

### index_xinfo

Like `index_info`, plus a final row for the rowid (`cid` -1) and these columns:

| Column | Meaning |
| --- | --- |
| `desc` | 1 for a descending key |
| `coll` | collation: `BINARY`, `NOCASE` or `RTRIM` |
| `key` | 1 for a key column, 0 for the rowid row |

```sql
SELECT * FROM pragma_index_xinfo('smalt_autoindex_parent_1')
```

| seqno | cid | name | desc | coll | key |
| --- | --- | --- | --- | --- | --- |
| 0 | 1 | code | 0 | NOCASE | 1 |
| 1 | -1 | NULL | 0 | BINARY | 0 |

### foreign_key_list

`PRAGMA foreign_key_list(table)`: one row per column of each foreign key, the last-declared key first (as in SQLite).

| Column | Meaning |
| --- | --- |
| `id` | foreign key number |
| `seq` | column position within the key |
| `table` | parent table |
| `from` | child column |
| `to` | parent column, or NULL when the parent's primary key is implied |
| `on_update`, `on_delete` | `NO ACTION`, `RESTRICT`, `CASCADE`, `SET NULL` or `SET DEFAULT` |
| `match` | always `NONE` |

```sql
PRAGMA foreign_key_list(child)
```

| id | seq | table | from | to | on_update | on_delete | match |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 0 | parent | parent_id | id | NO ACTION | CASCADE | NONE |

## Not supported

Pragmas not listed here are not implemented, including `user_version`, `application_id`, `cache_size`, `busy_timeout`, `synchronous`, `temp_store`, `recursive_triggers`, `defer_foreign_keys`, `foreign_key_check`, `quick_check`, `optimize`, `auto_vacuum`, `encoding`, `collation_list`, `function_list` and `table_list`. Several have open options instead (page size, cache size, durability, journal mode); see the [engine API](../api/engine) and the [client API](../api/client).

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
PRAGMA user_version
```
