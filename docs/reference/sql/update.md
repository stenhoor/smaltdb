# UPDATE

`UPDATE` changes rows of a table.

## Syntax

```text
[WITH [RECURSIVE] cte [, ...]]
UPDATE [OR conflict-action] [schema.]table [AS alias] [INDEXED BY index | NOT INDEXED]
  SET column = expr [, column = expr ...]
  [FROM from-item]
  [WHERE condition]
  [RETURNING result-column [, ...]]

conflict-action:
  ABORT | FAIL | IGNORE | REPLACE | ROLLBACK
```

Every row for which `WHERE` is true is changed; without `WHERE`, every row. The expressions on the right of `SET` see the row's old values, so `SET a = b, b = a` swaps two columns. New values are converted to the column types as for [INSERT](./insert) and checked against the table's constraints.

```sql
CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT UNIQUE, price REAL, stock INTEGER);
INSERT INTO item VALUES (1, 'pen', 1.5, 10), (2, 'ink', 4.0, 0), (3, 'pad', 2.25, 5);
UPDATE item SET price = price * 2, stock = stock - 1 WHERE stock > 0;
SELECT * FROM item
```

| id | name | price | stock |
| --- | --- | --- | --- |
| 1 | pen | 3 | 9 |
| 2 | ink | 4 | 0 |
| 3 | pad | 4.5 | 4 |

The number of changed rows is available from `changes()` and from the API's run result.

```sql
UPDATE item SET stock = 0 WHERE stock < 5;
SELECT changes() AS changed
```

| changed |
| --- |
| 2 |

## OR conflict-action

As for [INSERT](./insert#conflict-actions): `OR IGNORE` skips rows whose new values would violate a constraint, and `OR REPLACE` deletes the rows they would collide with. `OR ROLLBACK` also rolls back the enclosing transaction, and `OR FAIL` behaves like `OR ABORT`. Without an `OR` action, each constraint's own `ON CONFLICT` clause applies.

```sql
UPDATE OR IGNORE item SET name = 'pen' WHERE id = 2;
SELECT name FROM item WHERE id = 2
```

| name |
| --- |
| ink |

## FROM

`UPDATE … FROM` joins the target with other tables. In `SET` and `WHERE`, columns of both are visible. When several `FROM` rows match one target row, the first one found is used, as in SQLite (which one is not defined).

```sql
CREATE TABLE price_change(name TEXT, new_price REAL);
INSERT INTO price_change VALUES ('pen', 2.0), ('pad', 5.0);
UPDATE item AS i SET price = c.new_price FROM price_change c WHERE c.name = i.name
RETURNING i.name, i.price
```

<!-- docs:unordered -->
| name | price |
| --- | --- |
| pen | 2 |
| pad | 5 |

## WITH

```sql
WITH empty AS (SELECT id FROM item WHERE stock = 0)
UPDATE item SET stock = 100 WHERE id IN (SELECT id FROM empty)
RETURNING id
```

<!-- docs:unordered -->
| id |
| --- |
| 2 |
| 3 |

## RETURNING

`RETURNING` returns the new values of each changed row. Aggregate functions are not allowed in it.

```sql
UPDATE item SET stock = stock + 1 WHERE id = 1 RETURNING id, stock
```

| id | stock |
| --- | --- |
| 1 | 10 |

## INDEXED BY

`INDEXED BY` and `NOT INDEXED` are hints for finding the rows, as in [SELECT](./select#tables-subqueries-and-functions).

## Not supported

| Form | Result |
| --- | --- |
| `UPDATE … ORDER BY … LIMIT …` | `SMALT_UNSUPPORTED` |
| `SET (a, b) = (SELECT …)` | `SMALT_UNSUPPORTED`; `SET (a, b) = (1, 2)` is a syntax error |

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
UPDATE item SET stock = 0 ORDER BY id LIMIT 1
```

Updating a [view](./views), a materialized view, an [external table](./external) or a catalog table (`sqlite_schema`) fails with `SMALT_ERROR`.
