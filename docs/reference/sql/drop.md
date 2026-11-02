# DROP

`DROP` removes a table, index, view, materialized view, external table or connection.

## Syntax

```text
DROP TABLE [IF EXISTS] [schema.]name
DROP INDEX [IF EXISTS] [schema.]name
DROP VIEW [IF EXISTS] [schema.]name
DROP MATERIALIZED VIEW [IF EXISTS] [schema.]name
DROP EXTERNAL TABLE [IF EXISTS] name
DROP CONNECTION [IF EXISTS] name
```

Without `IF EXISTS`, dropping something that does not exist fails with `SMALT_ERROR` (`no such table: x`, `no such index: x`, `no such view: x`, `no such materialized view: x`, `no such external table: x`, `no such connection: x`). With it, nothing happens.

The statement must match the kind of object: `DROP TABLE` on a view fails with `use DROP VIEW to delete view v`, and likewise for the other kinds.

```sql
CREATE TABLE t(a INTEGER);
CREATE VIEW v AS SELECT a FROM t;
DROP TABLE IF EXISTS nothing_here;
```

<!-- docs:error SMALT_ERROR -->
```sql
DROP TABLE v
```

## DROP TABLE

Removes the table, its rows and its indexes. Views that read it are kept, and fail when used (`no such table`), as in SQLite.

If other tables have foreign keys that reference it and enforcement is on, its rows are deleted first, applying their `ON DELETE` actions; the drop fails if that violates a constraint (as in SQLite).

When a TEMP table shadows a main table of the same name, `DROP TABLE name` drops the TEMP table and `DROP TABLE main.name` the main one.

```sql
DROP TABLE t;
SELECT name FROM sqlite_schema
```

| name |
| --- |
| v |

<!-- docs:error SMALT_ERROR -->
```sql
SELECT * FROM v
```

## DROP INDEX

Removes an index created with [CREATE INDEX](./create-index). The indexes behind `PRIMARY KEY` and `UNIQUE` constraints (`smalt_autoindex_…`) cannot be dropped: `index associated with UNIQUE or PRIMARY KEY constraint cannot be dropped`.

## DROP VIEW, DROP MATERIALIZED VIEW

`DROP VIEW` removes a view (a TEMP view first, if one has the name). `DROP MATERIALIZED VIEW` removes a materialized view with its stored rows and indexes. See [Views](./views).

## DROP EXTERNAL TABLE, DROP CONNECTION

`DROP EXTERNAL TABLE` removes the catalog entry only; it never touches the source file. `DROP CONNECTION` fails while an external table uses the connection: `connection c is used by external table x`. See [External tables](./external).

## Not supported

`DROP TRIGGER` fails with `SMALT_UNSUPPORTED` (there are no triggers).

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
DROP TRIGGER IF EXISTS audit
```
