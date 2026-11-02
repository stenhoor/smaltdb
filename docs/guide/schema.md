# Tables and schema

This guide shows how to design tables in smaltdb: choosing column types, keys and constraints, linking tables with foreign keys, changing tables later, and using temporary tables. Each topic links to the exact rules in the [SQL reference](../reference/sql/).

If you know SQLite, two differences matter most here: **tables are STRICT by default** (a value must fit its column's type), and **foreign keys are enforced by default**. The full list is in [Differences from SQLite](./sqlite-differences).

## A first table

```sql
CREATE TABLE project(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  budget REAL CHECK (budget >= 0),
  created TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO project(name, budget) VALUES ('Website', 1200), ('Mobile app', 5000.5);
SELECT id, name, budget FROM project
```

| id | name | budget |
| --- | --- | --- |
| 1 | Website | 1200 |
| 2 | Mobile app | 5000.5 |

- `id INTEGER PRIMARY KEY` is the row's key and is filled in automatically.
- `NOT NULL`, `UNIQUE` and `CHECK` reject bad rows with an error.
- `DEFAULT` fills a column the `INSERT` leaves out.

## Choosing column types

Declare every column with one of these types:

| Use | Declare | Stores |
| --- | --- | --- |
| whole numbers, counters, IDs, flags | `INTEGER` | 64-bit integers (JavaScript `number`, or `bigint` when large) |
| measurements, money in floating point | `REAL` | 64-bit floats |
| strings, dates | `TEXT` | Unicode text |
| bytes (images, hashes) | `BLOB` | `Uint8Array` |
| anything | `ANY` (or no type) | any value, unchanged |

Other type names work too, mapped by SQLite's rules: `VARCHAR(50)` is TEXT, `BIGINT` is INTEGER, `DOUBLE` is REAL. Names such as `NUMERIC`, `DECIMAL`, `BOOLEAN` and `DATE` give a NUMERIC column, which stores numbers and keeps any text that does not look like a number. Prefer the five types above; see [Data types](../reference/sql/types#declared-types) for the mapping.

Because tables are STRICT, a value is converted only when nothing is lost, and rejected otherwise:

```sql
INSERT INTO project(name, budget) VALUES ('Docs', '300');
SELECT budget, typeof(budget) AS type FROM project WHERE name = 'Docs'
```

| budget | type |
| --- | --- |
| 300 | real |

<!-- docs:error SMALT_CONSTRAINT_DATATYPE -->
```sql
INSERT INTO project(name, budget) VALUES ('Oops', 'a lot')
```

The error is `cannot store TEXT value in REAL column project.budget`. The rules for every type are in [STRICT conversion](../reference/sql/types#strict-conversion).

Some common cases:

- **Booleans**: use `INTEGER` with `CHECK (col IN (0, 1))`. `TRUE`/`FALSE` and JavaScript booleans are stored as 1 and 0.
- **Dates and times**: use `TEXT` with ISO 8601 values (`'2024-03-01'`, `'2024-03-01 14:30:00'`); they sort correctly and work with the [date functions](../reference/functions/datetime). Or use `INTEGER` for Unix timestamps.
- **Money**: there is no decimal type. Store cents in an `INTEGER` column to stay exact.
- **JSON**: store it in a `TEXT` column.

## Keys

Give most tables an `INTEGER PRIMARY KEY`. It is the row's internal ID (the rowid), so lookups by it are the fastest, and it needs no extra index. When you insert without it, it becomes one more than the largest key in the table.

Other primary keys work as well: `TEXT PRIMARY KEY`, or a composite `PRIMARY KEY (a, b)`. They are enforced with a unique index next to the rowid. Primary key columns can never be NULL.

```sql
CREATE TABLE membership(
  project_id INTEGER NOT NULL REFERENCES project(id),
  user_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (project_id, user_name)
);
INSERT INTO membership(project_id, user_name) VALUES (1, 'ann'), (1, 'bob'), (2, 'ann');
```

`AUTOINCREMENT` is allowed only on an `INTEGER PRIMARY KEY` and does not prevent reuse of a deleted largest key; see [CREATE TABLE](../reference/sql/create-table#primary-key).

## Constraints

| Constraint | Rejects |
| --- | --- |
| `NOT NULL` | NULL |
| `UNIQUE` | a second row with the same value (NULLs are allowed many times) |
| `CHECK (expr)` | rows for which `expr` is false |
| `PRIMARY KEY` | duplicates and NULL |
| `REFERENCES` | a value with no matching parent row |

Name constraints with `CONSTRAINT name` to get clearer errors and catalog entries:

```sql
CREATE TABLE task(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  estimate_h REAL,
  done INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT positive_estimate CHECK (estimate_h > 0),
  CONSTRAINT done_flag CHECK (done IN (0, 1))
);
INSERT INTO task(project_id, title, estimate_h) VALUES (1, 'Design', 8), (1, 'Build', 40), (2, 'Prototype', 16);
```

<!-- docs:error SMALT_CONSTRAINT_CHECK -->
```sql
INSERT INTO task(project_id, title, estimate_h) VALUES (1, 'Nothing', 0)
```

The error is `CHECK constraint failed: positive_estimate`. To insert-or-update instead of failing on a duplicate key, use [`ON CONFLICT … DO UPDATE`](../reference/sql/insert#upsert-on-conflict). To skip or replace duplicates by default, give the constraint an [`ON CONFLICT` clause](../reference/sql/create-table#on-conflict), such as `UNIQUE ON CONFLICT IGNORE`.

## Foreign keys

A foreign key makes a column point to a row in another table. smaltdb enforces foreign keys **by default** (SQLite needs `PRAGMA foreign_keys = ON`). A child row must point to an existing parent:

<!-- docs:error SMALT_CONSTRAINT_FOREIGNKEY -->
```sql
INSERT INTO task(project_id, title) VALUES (99, 'Orphan')
```

`membership.project_id` has a plain `REFERENCES` clause, so a project cannot be deleted while it has members:

<!-- docs:error SMALT_CONSTRAINT_FOREIGNKEY -->
```sql
DELETE FROM project WHERE id = 1
```

`task.project_id` has `ON DELETE CASCADE`, so once the members are gone, deleting the project deletes its tasks too:

```sql
DELETE FROM membership WHERE project_id = 1;
DELETE FROM project WHERE id = 1;
SELECT title FROM task
```

| title |
| --- |
| Prototype |

Choose what happens to child rows when a parent is deleted or its key changes:

| Clause | Effect on children |
| --- | --- |
| (none) or `ON DELETE NO ACTION` | the parent cannot be deleted while children exist |
| `ON DELETE CASCADE` | children are deleted too |
| `ON DELETE SET NULL` | the child column becomes NULL |
| `ON DELETE SET DEFAULT` | the child column gets its default |
| `ON DELETE RESTRICT` | like `NO ACTION`, checked immediately |

The same actions exist for `ON UPDATE`. Mark a constraint `DEFERRABLE INITIALLY DEFERRED` to check it only at `COMMIT`, for example when inserting rows that point at each other. Index the child column (`CREATE INDEX task_project ON task(project_id)`) so that deletes and updates of parents stay fast.

To load data whose order you cannot control, you can switch enforcement off for the connection (outside a transaction) and back on afterwards; rows written meanwhile are not checked:

```sql
PRAGMA foreign_keys = OFF;
INSERT INTO task(project_id, title) VALUES (7, 'Imported early');
PRAGMA foreign_keys = ON;
SELECT count(*) AS n FROM task WHERE project_id = 7
```

| n |
| --- |
| 1 |

Details: [Foreign keys](../reference/sql/create-table#foreign-keys), [PRAGMA foreign_keys](../reference/sql/pragmas#foreign-keys).

## Changing a table

`ALTER TABLE` can rename a table, rename a column, add a column, and drop a column. Renames also update indexes, views and other tables' foreign keys.

```sql
ALTER TABLE task ADD COLUMN priority INTEGER NOT NULL DEFAULT 2;
ALTER TABLE task RENAME COLUMN estimate_h TO estimate_hours;
SELECT title, estimate_hours, priority FROM task WHERE project_id = 2
```

| title | estimate_hours | priority |
| --- | --- | --- |
| Prototype | 16 | 2 |

An added column needs a constant default (or none), and cannot be `PRIMARY KEY` or `UNIQUE`. A column used by an index, a view or a constraint cannot be dropped until that object is removed. For any other change (a column's type, constraints), rebuild the table in a transaction:

```sql
BEGIN;
CREATE TABLE task_new(
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title TEXT NOT NULL COLLATE NOCASE,
  estimate_hours REAL,
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  priority INTEGER NOT NULL DEFAULT 2
);
INSERT INTO task_new SELECT id, project_id, title, estimate_hours, done, priority FROM task WHERE project_id IN (SELECT id FROM project);
DROP TABLE task;
ALTER TABLE task_new RENAME TO task;
COMMIT;
SELECT count(*) AS tasks FROM task
```

| tasks |
| --- |
| 1 |

The `WHERE` drops the task imported with foreign keys off, whose project does not exist.

See [ALTER TABLE](../reference/sql/alter-table) for all rules and errors.

## Temporary tables

`CREATE TEMP TABLE` makes a table that only this connection sees. It lives in memory, never in the database file, and disappears when the database is closed. Use it for scratch data: intermediate results, a list of IDs to join against, a staging area for an import.

```sql
CREATE TEMP TABLE selected(id INTEGER PRIMARY KEY);
INSERT INTO selected VALUES (2);
SELECT p.name FROM project p JOIN selected s ON s.id = p.id
```

| name |
| --- |
| Mobile app |

Temp tables can have indexes and constraints, roll back with transactions, and hide a regular table of the same name (`main.name` still reaches it). They cannot be altered, cannot be columnar, and are listed in `temp.sqlite_schema` rather than `sqlite_schema` (and not in `information_schema`). `CREATE TABLE temp.name` is the same as `CREATE TEMP TABLE name`. See [Temporary tables](../reference/sql/create-table#temporary-tables).

## Tables for analytics

For large tables that are mostly scanned and aggregated (events, logs, measurements), create the table with columnar storage:

```sql
CREATE TABLE page_view(id INTEGER PRIMARY KEY, path TEXT, ms REAL, at TEXT) WITH (storage = 'columnar');
```

Columnar tables make scans and aggregates several times faster, but they have no indexes, no `UNIQUE` constraints, no foreign keys and no `ALTER TABLE`. See [Analytics](./analytics) and [Columnar tables](../reference/sql/create-table#columnar-tables).

## Inspecting the schema

```sql
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns WHERE table_name = 'membership'
```

| table_name | column_name | data_type | is_nullable |
| --- | --- | --- | --- |
| membership | project_id | INTEGER | NO |
| membership | user_name | TEXT | NO |
| membership | role | TEXT | NO |

`PRAGMA table_info(t)`, `PRAGMA index_list(t)`, `PRAGMA foreign_key_list(t)`, `sqlite_schema` and the other [information_schema](../reference/sql/information-schema) views describe the rest. See [Introspection](./introspection).
