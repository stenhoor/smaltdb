# DELETE

`DELETE` removes rows from a table.

## Syntax

```text
[WITH [RECURSIVE] cte [, ...]]
DELETE FROM [schema.]table [AS alias] [INDEXED BY index | NOT INDEXED]
  [WHERE condition]
  [RETURNING result-column [, ...]]
```

Every row for which `WHERE` is true is deleted; without `WHERE`, every row. Foreign-key actions (`ON DELETE CASCADE`, `SET NULL`, …) run for each deleted row; see [CREATE TABLE](./create-table#foreign-keys).

```sql
CREATE TABLE task(id INTEGER PRIMARY KEY, title TEXT, done INTEGER);
INSERT INTO task VALUES (1, 'write', 1), (2, 'test', 0), (3, 'ship', 1);
DELETE FROM task WHERE done = 1 RETURNING id, title
```

| id | title |
| --- | --- |
| 1 | write |
| 3 | ship |

`RETURNING` returns the deleted rows' values. Aggregate functions are not allowed in it.

```sql
SELECT * FROM task
```

| id | title | done |
| --- | --- | --- |
| 2 | test | 0 |

A `DELETE` without `WHERE` or `RETURNING` empties the table in one step (unless foreign keys need to see each row) and reports the number of rows it held:

```sql
DELETE FROM task;
SELECT changes() AS deleted
```

| deleted |
| --- |
| 1 |

`WITH` can prefix `DELETE`:

```sql
INSERT INTO task VALUES (4, 'plan', 0), (5, 'demo', 1);
WITH finished AS (SELECT id FROM task WHERE done = 1)
DELETE FROM task WHERE id IN (SELECT id FROM finished) RETURNING title
```

| title |
| --- |
| demo |

## Not supported

`DELETE … ORDER BY … LIMIT …` and `DELETE … LIMIT …` fail with `SMALT_UNSUPPORTED`.

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
DELETE FROM task LIMIT 1
```

Deleting from a [view](./views), a materialized view, an [external table](./external) or a catalog table fails with `SMALT_ERROR`. To remove a table itself, use [DROP TABLE](./drop).
