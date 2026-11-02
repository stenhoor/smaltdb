# CREATE INDEX

`CREATE INDEX` builds a B+tree index on a table's columns or expressions, so queries that filter, join or sort on them can avoid a full scan. For choosing indexes and reading plans, see [Indexes and performance](../../guide/indexes-and-performance).

## Syntax

```text
CREATE [UNIQUE] INDEX [IF NOT EXISTS] [schema.]name
  ON table (indexed-column [, ...])
  [WHERE condition]

indexed-column:
  {column | expr} [COLLATE collation] [ASC | DESC]
```

| Part | Meaning |
| --- | --- |
| `UNIQUE` | no two rows may have equal non-NULL keys (NULLs never collide) |
| `IF NOT EXISTS` | do nothing if an object of that name exists |
| `column` | a column of the table, compared with its collation unless `COLLATE` is given |
| `expr` | an expression index; see below |
| `ASC` / `DESC` | the order of the key in the index |
| `WHERE` | a partial index: only rows for which the condition is true are indexed |

The index is filled from the existing rows when it is created. Index names share one namespace with tables and views.

```sql
CREATE TABLE person(id INTEGER PRIMARY KEY, email TEXT, city TEXT, born TEXT, active INTEGER);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n LIMIT 1000)
INSERT INTO person SELECT i, 'user' || i || '@Example.com', 'city' || (i % 50), '19' || (50 + i % 50) || '-01-01', i % 2 FROM n;
CREATE INDEX person_city_born ON person(city, born DESC);
EXPLAIN QUERY PLAN SELECT * FROM person WHERE city = 'city7' AND born > '1980'
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SEARCH person USING INDEX person_city_born (=?) |

## Unique indexes

A unique index enforces uniqueness like a `UNIQUE` constraint. If existing rows already collide, `CREATE UNIQUE INDEX` fails. A violation fails the statement with `SMALT_CONSTRAINT_UNIQUE` and the message `UNIQUE constraint failed: index 'name'` (for expression indexes) or `UNIQUE constraint failed: table.column`.

## Expression indexes

An indexed column can be any expression over the table's columns. The planner uses it for query terms that contain the same expression (table qualifiers are ignored).

```sql
CREATE UNIQUE INDEX person_email_lower ON person(lower(email));
EXPLAIN QUERY PLAN SELECT * FROM person WHERE lower(email) = 'user5@example.com'
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SEARCH person USING INDEX person_email_lower (=?) |

<!-- docs:error SMALT_CONSTRAINT_UNIQUE -->
```sql
INSERT INTO person(email) VALUES ('USER5@example.com')
```

As in SQLite, the expressions must be deterministic and cannot contain subqueries or parameters:

| Expression | Error |
| --- | --- |
| `random()`, `changes()`, `CURRENT_TIMESTAMP`, … | `non-deterministic functions prohibited in index expressions` |
| `(SELECT …)` | `subqueries prohibited in index expressions` |
| a parameter (`?`) | `parameters prohibited in index expressions` |

The date and time functions are allowed, in expressions and in the `WHERE` clause, as long as they do not read the clock or the time zone. When one does, for a row being indexed (a time value of `'now'`, `'subsec'` or none at all, or the `'localtime'` or `'utc'` modifier), the statement fails with `non-deterministic use of date() in an index` (naming the function), as in SQLite. See [Date and time functions](../functions/datetime#indexes-and-check-constraints).

## Partial indexes

A `WHERE` clause indexes only the rows that satisfy it. A query can use a partial index only when its own `WHERE` contains every condition of the index's `WHERE` (as `AND`ed terms).

```sql
CREATE INDEX person_active_city ON person(city) WHERE active = 1;
EXPLAIN QUERY PLAN SELECT * FROM person WHERE city = 'city3' AND active = 1
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 1 | 0 | 0 | SEARCH person USING INDEX person_active_city (=?) |

Without `active = 1` in the query, the partial index is not a candidate and the planner uses `person_city_born`.

`USING COVERING INDEX` in a plan means the index alone answers the query (for example `SELECT id … WHERE city = ?`, since `id` is the rowid stored in every index entry).

## Restrictions

- Views cannot be indexed (`views may not be indexed`); [materialized views](./views) with row storage can.
- Columnar tables and columnar materialized views cannot be indexed: their zone maps prune scans instead (`SMALT_UNSUPPORTED` for tables, `SMALT_ERROR` for views).
- External tables have no indexes.
- An index key must fit in about a quarter of a page (about 2 KB with the default 8 KiB pages); a longer value fails with `SMALT_TOOBIG` (`index key too large for index name`). SQLite allows larger keys.
- `INCLUDE (columns)` (covering columns) is parsed but not supported (`SMALT_UNSUPPORTED`).

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
CREATE INDEX person_city_incl ON person(city) INCLUDE (email)
```

Indexes on TEMP tables live in memory with the table. A schema qualifier names the index's schema, which must be its table's, as in SQLite: `CREATE INDEX temp.i ON t(x)` needs a TEMP table `t` (`cannot create a TEMP index on non-TEMP table "t"`), and `CREATE INDEX main.i ON t(x)` a main one (`no such table: main.t`). Index statistics come from [`ANALYZE`](./explain#analyze). To remove an index, use [`DROP INDEX`](./drop#drop-index); to list them, [`PRAGMA index_list`](./pragmas#index-list) or [`information_schema.statistics`](./information-schema#statistics).
