# INSERT

`INSERT` adds rows to a table. `REPLACE` is short for `INSERT OR REPLACE`.

## Syntax

```text
[WITH [RECURSIVE] cte [, ...]]
{INSERT [OR conflict-action] | REPLACE} INTO [schema.]table [AS alias] [(column [, ...])]
  {VALUES (expr [, ...]) [, ...] | select | DEFAULT VALUES}
  [upsert-clause ...]
  [RETURNING result-column [, ...]]

conflict-action:
  ABORT | FAIL | IGNORE | REPLACE | ROLLBACK

upsert-clause:
  ON CONFLICT [(indexed-column [, ...])]
    DO NOTHING
  | DO UPDATE SET {column | (column [, ...])} = expr [, ...] [WHERE condition]
```

The examples use this table:

```sql
CREATE TABLE stock(
  id INTEGER PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  qty INTEGER NOT NULL DEFAULT 0 CHECK (qty >= 0)
);
```

## Values

Without a column list, each row must give a value for every column, in table order. With a column list, the other columns get their `DEFAULT` (or NULL). An `INTEGER PRIMARY KEY` column left out, or given NULL, gets the next rowid: one more than the largest in the table.

```sql
INSERT INTO stock VALUES (1, 'pen', 10);
INSERT INTO stock(sku) VALUES ('ink'), ('pad');
SELECT * FROM stock
```

| id | sku | qty |
| --- | --- | --- |
| 1 | pen | 10 |
| 2 | ink | 0 |
| 3 | pad | 0 |

Values are converted to the column types as described in [Data types](./types#strict-conversion): `'5'` into an INTEGER column stores 5, `'abc'` fails.

Errors: `table stock has 3 columns but 1 values were supplied`, `table stock has no column named x` (`SMALT_ERROR`).

`DEFAULT` as a value inside `VALUES` (`VALUES (DEFAULT)`) is a syntax error, as in SQLite; leave the column out of the column list instead.

## DEFAULT VALUES

`DEFAULT VALUES` inserts one row in which every column gets its `DEFAULT` (or NULL), and the rowid is assigned as above. It takes no column list (`0 values for 1 columns`, `SMALT_ERROR`) and, as in SQLite, no upsert clause; `OR` conflict actions and `RETURNING` work.

```sql
CREATE TABLE tick(id INTEGER PRIMARY KEY, n INTEGER DEFAULT 0);
INSERT INTO tick DEFAULT VALUES;
INSERT INTO tick DEFAULT VALUES RETURNING *
```

| id | n |
| --- | --- |
| 2 | 0 |

Constraints still apply: `stock` has `sku TEXT NOT NULL` without a default.

<!-- docs:error SMALT_CONSTRAINT_NOTNULL -->
```sql
INSERT INTO stock DEFAULT VALUES
```

## INSERT … SELECT

Any query can be the source, as long as it returns as many columns as are inserted. A query that reads the target table is run to completion before the first row is written.

```sql
CREATE TABLE archive(id INTEGER PRIMARY KEY, sku TEXT, qty INTEGER);
INSERT INTO archive SELECT * FROM stock WHERE qty = 0;
SELECT * FROM archive
```

| id | sku | qty |
| --- | --- | --- |
| 2 | ink | 0 |
| 3 | pad | 0 |

### WITH

A `WITH` clause before `INSERT` works when the source is a `SELECT`. `WITH … INSERT … VALUES` fails with `SMALT_UNSUPPORTED`.

```sql
WITH more(sku) AS (VALUES ('cap'), ('nib'))
INSERT INTO stock(sku) SELECT sku FROM more;
SELECT id, sku FROM stock WHERE id > 3
```

| id | sku |
| --- | --- |
| 4 | cap |
| 5 | nib |

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
WITH x AS (SELECT 1) INSERT INTO stock(sku) VALUES ('clip')
```

## Conflict actions

`INSERT OR action` says what happens when a row violates a `PRIMARY KEY`, `UNIQUE`, `NOT NULL` or `CHECK` constraint.

| Action | Effect |
| --- | --- |
| `ABORT` (default) | the statement fails and its changes are undone; an enclosing transaction stays open |
| `FAIL` | same as `ABORT` (see below) |
| `ROLLBACK` | the statement fails and the enclosing transaction is rolled back; outside a transaction, same as `ABORT` |
| `IGNORE` | the conflicting row is skipped; the statement goes on |
| `REPLACE` | rows that conflict on a `PRIMARY KEY` or `UNIQUE` constraint are deleted first, then the row is inserted; a NULL for a `NOT NULL` column with a default gets the default; a `CHECK` failure is handled as `ABORT` |

Without an `OR` action, each constraint's own `ON CONFLICT` clause applies (see [CREATE TABLE](./create-table#on-conflict)), and `ABORT` where it has none. `CHECK` constraints have no clause of their own. The statement's action, when given, applies to every constraint.

After `OR ROLLBACK` fails, no transaction is open: a following `COMMIT` fails with `cannot commit - no transaction is active`.

```sql
CREATE TABLE tags(name TEXT UNIQUE);
INSERT INTO tags VALUES ('a');
BEGIN;
INSERT INTO tags VALUES ('b');
```

<!-- docs:error SMALT_CONSTRAINT_UNIQUE -->
```sql
INSERT OR ROLLBACK INTO tags VALUES ('a')
```

```sql
SELECT name FROM tags
```

| name |
| --- |
| a |

```sql
INSERT OR IGNORE INTO stock VALUES (1, 'pen', 99), (6, 'tape', 5);
REPLACE INTO stock VALUES (2, 'ink', 7);
SELECT * FROM stock WHERE id IN (1, 2, 6)
```

| id | sku | qty |
| --- | --- | --- |
| 1 | pen | 10 |
| 2 | ink | 7 |
| 6 | tape | 5 |

A `REPLACE` that deletes rows applies foreign-key actions to them, as in SQLite.

Difference from SQLite: `FAIL` (as `OR FAIL`, or a constraint's `ON CONFLICT FAIL`) behaves like `ABORT`: rows inserted by the statement before the failing one are undone too.

## Upsert (ON CONFLICT)

An upsert clause turns a uniqueness conflict into an update, or skips the row.

- The conflict target `(columns)` must match a `PRIMARY KEY` or `UNIQUE` constraint or a unique index on plain columns; otherwise the statement fails with `ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`. Without a target, `DO NOTHING` covers any uniqueness conflict; such a clause must be the last one.
- `DO UPDATE` needs a conflict target (`ON CONFLICT DO UPDATE requires a conflict target`). SQLite 3.35+ also allows it without one on the last clause.
- In `DO UPDATE`, `excluded.column` is the value that was to be inserted, and the plain column (or `alias.column`) is the existing row's value. The optional `WHERE` decides whether the existing row is updated; if not, the row is skipped.
- Several clauses are tried in order; the first whose target conflicts wins.

```sql
INSERT INTO stock(sku, qty) VALUES ('pen', 5)
  ON CONFLICT(sku) DO UPDATE SET qty = qty + excluded.qty
  RETURNING id, sku, qty
```

| id | sku | qty |
| --- | --- | --- |
| 1 | pen | 15 |

```sql
INSERT INTO stock AS s(sku, qty) VALUES ('ink', 1), ('glue', 4)
  ON CONFLICT(sku) DO UPDATE SET qty = s.qty + excluded.qty WHERE excluded.qty > 1
  RETURNING sku, qty
```

| sku | qty |
| --- | --- |
| glue | 4 |

The `ink` row was skipped, because its `WHERE` was false.

```sql
INSERT INTO stock(id, sku) VALUES (1, 'new') ON CONFLICT DO NOTHING;
SELECT sku FROM stock WHERE id = 1
```

| sku |
| --- |
| pen |

Not supported: a conflict target with a `WHERE` clause (`ON CONFLICT (col) WHERE …`, for partial indexes) fails with `SMALT_UNSUPPORTED`, and so does a row-value assignment (`SET (a, b) = (SELECT …)`; with a parenthesized list of values it is a syntax error).

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
INSERT INTO stock(sku) VALUES ('pen') ON CONFLICT(sku) WHERE qty > 0 DO NOTHING
```

## RETURNING

`RETURNING` makes the statement return one row per inserted (or upserted) row: `*`, columns or any expression of the new row, with aliases. Aggregate functions are not allowed in it (`misuse of aggregate function`).

```sql
INSERT INTO stock(sku, qty) VALUES ('clip', 3) RETURNING id, upper(sku) AS sku, qty * 2 AS doubled
```

| id | sku | doubled |
| --- | --- | --- |
| 8 | CLIP | 6 |

## Constraint errors

A violated constraint fails the statement with one of these codes (the message is SQLite's):

| Code | Example message |
| --- | --- |
| `SMALT_CONSTRAINT_PRIMARYKEY` | `UNIQUE constraint failed: stock.id` |
| `SMALT_CONSTRAINT_UNIQUE` | `UNIQUE constraint failed: stock.sku` |
| `SMALT_CONSTRAINT_NOTNULL` | `NOT NULL constraint failed: stock.sku` |
| `SMALT_CONSTRAINT_CHECK` | `CHECK constraint failed: qty >= 0` |
| `SMALT_CONSTRAINT_FOREIGNKEY` | `FOREIGN KEY constraint failed` |
| `SMALT_CONSTRAINT_DATATYPE` | `cannot store TEXT value in INTEGER column stock.qty` |

<!-- docs:error SMALT_CONSTRAINT_CHECK -->
```sql
INSERT INTO stock(sku, qty) VALUES ('bad', -1)
```

See [Errors](../api/errors) for all codes.
