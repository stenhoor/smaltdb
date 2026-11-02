# ALTER TABLE

`ALTER TABLE` renames a table, or adds, renames or drops a column. It works like SQLite's.

## Syntax

```text
ALTER TABLE [main.]table
  { RENAME TO new-name
  | RENAME [COLUMN] column TO new-name
  | ADD [COLUMN] column-def
  | DROP [COLUMN] column }
```

The examples use these objects:

```sql
CREATE TABLE customer(id INTEGER PRIMARY KEY, name TEXT, mail TEXT UNIQUE);
CREATE TABLE purchase(id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES customer(id), note TEXT);
CREATE INDEX customer_name ON customer(name);
CREATE VIEW customer_names AS SELECT id, name FROM customer;
INSERT INTO customer VALUES (1, 'Ann', 'ann@example.com');
```

## RENAME TO

Renames the table. References to it in other tables' `REFERENCES` clauses, in indexes and in views are rewritten; the new name is written in double quotes. The new name must not be in use (`there is already another table or index with this name: x`).

```sql
ALTER TABLE customer RENAME TO client;
SELECT sql FROM sqlite_schema WHERE name = 'purchase'
```

| sql |
| --- |
| CREATE TABLE purchase(id INTEGER PRIMARY KEY, customer_id INTEGER REFERENCES "client"(id), note TEXT) |

## RENAME COLUMN

Renames a column, and every reference to it in the table's own definition, its indexes, other tables' foreign keys and views. Only references that resolve to the altered table's column are changed.

```sql
ALTER TABLE client RENAME COLUMN name TO full_name;
SELECT name, sql FROM sqlite_schema WHERE name IN ('customer_name', 'customer_names')
```

| name | sql |
| --- | --- |
| customer_name | CREATE INDEX customer_name ON "client"(full_name) |
| customer_names | CREATE VIEW customer_names AS SELECT id, full_name FROM "client" |

Errors: `no such column: "x"`, or `error in table t after rename: duplicate column name: y` when the new name exists.

## ADD COLUMN

Adds a column at the end. Existing rows are not rewritten: they read the new column's default.

```sql
ALTER TABLE client ADD COLUMN tier INTEGER NOT NULL DEFAULT 1;
SELECT id, full_name, tier FROM client
```

| id | full_name | tier |
| --- | --- | --- |
| 1 | Ann | 1 |

These restrictions apply (each `SMALT_ERROR`):

| Column definition | Error |
| --- | --- |
| `PRIMARY KEY` | `Cannot add a PRIMARY KEY column` |
| `UNIQUE` | `Cannot add a UNIQUE column` |
| a default that is not a constant (`(expr)`, `CURRENT_TIMESTAMP`) | `Cannot add a column with non-constant default` |
| `NOT NULL` without a non-NULL default | `Cannot add a NOT NULL column with default value NULL` |
| `REFERENCES` with a non-NULL default, while foreign keys are on and the table has rows | `Cannot add a REFERENCES column with non-NULL default value` |
| a subquery in `CHECK` | `error in table t after add column: subqueries prohibited in CHECK constraints` |

SQLite applies the `NOT NULL` and non-constant default rules only when the table has rows; smaltdb applies them to empty tables too. Generated columns fail with `SMALT_UNSUPPORTED`.

<!-- docs:error SMALT_ERROR -->
```sql
ALTER TABLE client ADD COLUMN joined TEXT DEFAULT CURRENT_TIMESTAMP
```

## DROP COLUMN

Removes a column and rewrites every row without it.

```sql
ALTER TABLE purchase DROP COLUMN note;
SELECT name FROM pragma_table_info('purchase')
```

| name |
| --- |
| id |
| customer_id |

It fails (`SMALT_ERROR`) for:

- a `PRIMARY KEY` column (`cannot drop PRIMARY KEY column: "id"`);
- a column with a `UNIQUE` constraint (`cannot drop UNIQUE column: "mail"`);
- the only column of a table;
- a column that an index, a `CHECK` constraint, a table-level `FOREIGN KEY`, or a view still uses. The message names the object: `error in index customer_name after drop column: no such column: full_name`.

A column with its own `REFERENCES` clause can be dropped; the foreign key goes with it.

<!-- docs:error SMALT_ERROR -->
```sql
ALTER TABLE client DROP COLUMN full_name
```

## Restrictions

`ALTER TABLE` fails for:

| Target | Error |
| --- | --- |
| a view | `view v may not be altered`, `Cannot add a column to a view` |
| a materialized view | `materialized view m may not be altered` |
| a TEMP table | `SMALT_UNSUPPORTED` |
| a columnar table | `SMALT_UNSUPPORTED` |
| `sqlite_schema` and internal `smalt_*` tables | `table sqlite_master may not be altered` |

Other changes (column types, constraints) need a new table: create it, copy the rows with `INSERT INTO … SELECT`, drop the old one and rename the new one, in one [transaction](./transactions).

`ALTER TABLE` drops the table's [`ANALYZE`](./explain#analyze) statistics; run `ANALYZE` again afterwards.
