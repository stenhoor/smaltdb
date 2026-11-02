# CREATE TABLE

`CREATE TABLE` creates a table. Tables are STRICT by default: every column has a storage type that its values must fit (see [Data types](./types)). For a task-oriented introduction, see [Tables and schema](../../guide/schema).

## Syntax

```text
CREATE [TEMP | TEMPORARY] TABLE [IF NOT EXISTS] [schema.]name (
  column-def [, column-def ...]
  [, table-constraint ...]
) [table-option [, table-option ...]]

column-def:
  name [type-name] [column-constraint ...]

type-name:
  word [word ...] [(number [, number])]

column-constraint:
  [CONSTRAINT name]
  { PRIMARY KEY [ASC | DESC] [conflict-clause] [AUTOINCREMENT]
  | NOT NULL [conflict-clause]
  | NULL
  | UNIQUE [conflict-clause]
  | CHECK (expr)
  | DEFAULT {literal | signed-number | (expr) | CURRENT_DATE | CURRENT_TIME | CURRENT_TIMESTAMP | identifier}
  | COLLATE collation
  | REFERENCES foreign-table [(column [, ...])] [fk-action ...] [deferrable] }

table-constraint:
  [CONSTRAINT name]
  { PRIMARY KEY (column [COLLATE c] [ASC | DESC] [, ...] [AUTOINCREMENT]) [conflict-clause]
  | UNIQUE (column [COLLATE c] [ASC | DESC] [, ...]) [conflict-clause]
  | CHECK (expr) [conflict-clause]
  | FOREIGN KEY (column [, ...]) REFERENCES foreign-table [(column [, ...])] [fk-action ...] [deferrable] }

fk-action:
  ON {DELETE | UPDATE} {SET NULL | SET DEFAULT | CASCADE | RESTRICT | NO ACTION}
  | MATCH name

deferrable:
  [NOT] DEFERRABLE [INITIALLY {DEFERRED | IMMEDIATE}]

conflict-clause:
  ON CONFLICT {ROLLBACK | ABORT | FAIL | IGNORE | REPLACE}

table-option:
  STRICT | WITH (storage = 'row' | 'columnar') | LOOSE | WITHOUT ROWID
```

```sql
CREATE TABLE author(
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE COLLATE NOCASE
);
CREATE TABLE book(
  id INTEGER PRIMARY KEY,
  author_id INTEGER NOT NULL REFERENCES author(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  pages INTEGER CHECK (pages > 0),
  added TEXT DEFAULT CURRENT_DATE
);
SELECT name, type, "notnull", pk FROM pragma_table_info('book')
```

| name | type | notnull | pk |
| --- | --- | --- | --- |
| id | INTEGER | 0 | 1 |
| author_id | INTEGER | 1 | 0 |
| title | TEXT | 1 | 0 |
| pages | INTEGER | 0 | 0 |
| added | TEXT | 0 | 0 |

The statement text is stored in the catalog as written ([`sqlite_schema`](./information-schema#sqlite-schema)).

## Names and options

| Clause | Meaning |
| --- | --- |
| `IF NOT EXISTS` | do nothing if an object of that name exists (no error) |
| `TEMP` / `TEMPORARY` | a [temporary table](#temporary-tables) |
| `main.name` | the same as `name` |

A table name must be new among tables, views, materialized views, external tables and indexes (`table book already exists`, `SMALT_ERROR`). Names starting with `smalt_` or `sqlite_` are reserved. A table needs at least one column, and column names must be unique (`duplicate column name: x`).

## Column types

The declared type is any sequence of words with an optional `(n)` or `(n, m)`. It is kept as written (upper-cased) and mapped to a storage type with SQLite's affinity rules:

| Declared type contains | Storage type |
| --- | --- |
| `INT` | INTEGER |
| `CHAR`, `CLOB` or `TEXT` | TEXT |
| `BLOB` | BLOB |
| `REAL`, `FLOA` or `DOUB` | REAL |
| exactly `ANY`, or no type | ANY |
| anything else (`NUMERIC`, `DECIMAL(10,2)`, `BOOLEAN`, `DATE`, …) | NUMERIC |

The rules are checked in this order, so `CHARINT` is INTEGER. Lengths such as `VARCHAR(10)` are not enforced. [Data types](./types) describes what each storage type accepts.

## Constraints

### PRIMARY KEY

A table has at most one primary key (`table "t" has more than one primary key`). Primary key columns are always NOT NULL (in SQLite only for `INTEGER PRIMARY KEY` and STRICT tables).

A column declared exactly `INTEGER PRIMARY KEY` (the type name `INTEGER`, a single column, not `DESC`) is the table's rowid: it takes no extra storage, lookups by it are the fastest, and when an insert leaves it NULL it gets one more than the largest rowid in the table. Any other primary key (`INT PRIMARY KEY`, `TEXT PRIMARY KEY`, several columns) is a unique index next to a separate rowid, as in SQLite.

```sql
CREATE TABLE k1(id INTEGER PRIMARY KEY, v TEXT);
CREATE TABLE k2(id INT PRIMARY KEY, v TEXT);
INSERT INTO k1(v) VALUES ('a');
INSERT INTO k2 VALUES (7, 'a');
SELECT (SELECT rowid FROM k1) AS k1_rowid, (SELECT rowid FROM k2) AS k2_rowid
```

| k1_rowid | k2_rowid |
| --- | --- |
| 1 | 1 |

`AUTOINCREMENT` is allowed only on an `INTEGER PRIMARY KEY` (`AUTOINCREMENT is only allowed on an INTEGER PRIMARY KEY`), as in SQLite. It does not stop reuse: a deleted largest rowid can be used again (SQLite never reuses one with `AUTOINCREMENT`).

When the largest rowid is 9223372036854775807, a row inserted without one gets a random unused rowid between 1 and 2^62, as in SQLite. After 100 candidates that are all taken, or at once in an `AUTOINCREMENT` table, the insert fails with `SMALT_FULL`.

### NOT NULL, UNIQUE, CHECK

`NOT NULL` rejects NULL. `UNIQUE` allows any number of NULLs, as in SQLite; it compares with the column's collation (or the one given in a table constraint). `CHECK (expr)` rejects a row when the expression is false (NULL passes). As in SQLite, a `CHECK` expression may not contain a subquery (`subqueries prohibited in CHECK constraints`) or a parameter, and a `DEFAULT` may not contain a subquery, a column or a parameter (`default value of column [x] is not constant`); functions such as `random()` are allowed.

```sql
CREATE TABLE account(
  id INTEGER PRIMARY KEY,
  handle TEXT NOT NULL,
  balance INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT handle_lower UNIQUE (handle COLLATE NOCASE),
  CONSTRAINT no_overdraft CHECK (balance >= 0)
);
INSERT INTO account(handle) VALUES ('Ann');
```

<!-- docs:error SMALT_CONSTRAINT_UNIQUE -->
```sql
INSERT INTO account(handle) VALUES ('ann')
```

<!-- docs:error SMALT_CONSTRAINT_CHECK -->
```sql
INSERT INTO account(handle, balance) VALUES ('bob', -5)
```

The error message names the constraint when it has a name (`CHECK constraint failed: no_overdraft`) and shows the expression otherwise.

### ON CONFLICT {#on-conflict}

An `ON CONFLICT` clause on a `PRIMARY KEY`, `UNIQUE` or `NOT NULL` constraint sets what an `INSERT` or `UPDATE` without its own [`OR` action](./insert#conflict-actions) does when a row violates that constraint: `ABORT` (the default), `FAIL`, `ROLLBACK`, `IGNORE` or `REPLACE`, with the meanings listed there. A statement's `OR` action overrides it, and an upsert's `ON CONFLICT … DO` clause takes precedence for its target. On a table `CHECK` constraint the clause is accepted and ignored, as in SQLite.

```sql
CREATE TABLE visit(page TEXT UNIQUE ON CONFLICT IGNORE, hits INTEGER NOT NULL ON CONFLICT REPLACE DEFAULT 0);
INSERT INTO visit VALUES ('home', 5), ('home', 9), ('about', NULL);
SELECT * FROM visit ORDER BY page
```

| page | hits |
| --- | --- |
| about | 0 |
| home | 5 |

As in SQLite:

- When a row violates several constraints, the first one checked decides: the rowid (`INTEGER PRIMARY KEY`) first, then the other `PRIMARY KEY` and `UNIQUE` constraints and unique indexes, the most recently created first, with those whose action is `REPLACE` last. An `INTEGER PRIMARY KEY … ON CONFLICT REPLACE` is checked after all of them.
- For `NOT NULL ON CONFLICT REPLACE`, a NULL gets the column's default; without a default, it fails as `ABORT`. If a column has several `NOT NULL` clauses, the last one counts.
- Identical `UNIQUE` / `PRIMARY KEY` constraints share one action; two different ones fail with `conflicting ON CONFLICT clauses specified`.

The clauses are part of the stored `CREATE TABLE` text, so they apply after the database is reopened. `FAIL` behaves like `ABORT` (see [INSERT](./insert#conflict-actions)).

### DEFAULT

A column's default is used when an `INSERT` leaves the column out.

| Default | Example | Value |
| --- | --- | --- |
| literal | `DEFAULT 'n/a'`, `DEFAULT -5`, `DEFAULT NULL` | the literal |
| identifier | `DEFAULT active` | the text `'active'` |
| `CURRENT_DATE`, `CURRENT_TIME`, `CURRENT_TIMESTAMP` | `DEFAULT CURRENT_TIMESTAMP` | the time of the insert (UTC text) |
| `(expr)` | `DEFAULT (lower('X'))` | evaluated for each insert; it cannot refer to columns (the insert fails with `no such column`) |

```sql
CREATE TABLE note(id INTEGER PRIMARY KEY, status TEXT DEFAULT draft, prio INTEGER DEFAULT (2 * 3), body TEXT);
INSERT INTO note(body) VALUES ('hi');
SELECT status, prio FROM note
```

| status | prio |
| --- | --- |
| draft | 6 |

### COLLATE

`COLLATE BINARY` (default), `NOCASE` or `RTRIM` sets the column's collation, used by comparisons, sorting, `UNIQUE` and indexes. See [collations](./types#collations).

### Foreign keys

`REFERENCES parent(col)` on a column, or `FOREIGN KEY (cols) REFERENCES parent(cols)` as a table constraint, makes every non-NULL child value match a row of the parent. Without a parent column list, the parent's primary key is used. The parent columns must be its `PRIMARY KEY` or covered by a `UNIQUE` constraint or index; otherwise writes fail with `foreign key mismatch - "child" referencing "parent"`.

Foreign keys are **enforced by default** (SQLite's default is off). `PRAGMA foreign_keys = OFF` turns enforcement off for the connection; see [PRAGMA foreign_keys](./pragmas#foreign-keys).

| Action | On parent `DELETE` / `UPDATE` of the key |
| --- | --- |
| `NO ACTION` (default) | fail at the end of the statement if children still point to a missing parent |
| `RESTRICT` | fail immediately |
| `CASCADE` | delete the children / update their keys |
| `SET NULL` | set the child columns to NULL |
| `SET DEFAULT` | set the child columns to their defaults |

`DEFERRABLE INITIALLY DEFERRED` checks the constraint at `COMMIT` instead of at the end of each statement. Every other form (`NOT DEFERRABLE`, `DEFERRABLE INITIALLY IMMEDIATE`, none) is immediate. `MATCH name` is accepted and ignored, as in SQLite.

```sql
INSERT INTO author VALUES (1, 'Ann', 'ann@example.com');
INSERT INTO book(author_id, title, pages) VALUES (1, 'Notes', 120);
DELETE FROM author WHERE id = 1;
SELECT count(*) AS books FROM book
```

| books |
| --- |
| 0 |

<!-- docs:error SMALT_CONSTRAINT_FOREIGNKEY -->
```sql
INSERT INTO book(author_id, title) VALUES (42, 'Orphan')
```

Columnar tables can neither have foreign keys nor be referenced by one. Foreign keys are listed by [`PRAGMA foreign_key_list`](./pragmas#foreign-key-list) and in [`information_schema.referential_constraints`](./information-schema#referential-constraints).

## Table options

| Option | Effect |
| --- | --- |
| `STRICT` | accepted; every table is already STRICT |
| `WITH (storage = 'row')` | row storage in a B+tree (the default) |
| `WITH (storage = 'columnar')` | columnar storage for analytics; see below |
| `LOOSE` | not supported (`SMALT_UNSUPPORTED`) |
| `WITHOUT ROWID` | not supported (`SMALT_UNSUPPORTED`) |

Options are separated by commas: `) STRICT, WITH (storage = 'row')`. `WITH` takes no other keys (`unknown table option: x`).

### Columnar tables

`WITH (storage = 'columnar')` stores the table as compressed column segments with zone maps, plus a row store for recent changes. Scans and aggregates over many rows are faster, point lookups slower. All DML works. These restrictions apply (each `SMALT_UNSUPPORTED`):

- no `UNIQUE` or `PRIMARY KEY` constraints other than `INTEGER PRIMARY KEY`;
- no foreign keys, in either direction;
- no indexes;
- no `ALTER TABLE`;
- no `TEMP` columnar tables.

```sql
CREATE TABLE events(id INTEGER PRIMARY KEY, kind TEXT, ms REAL) WITH (storage = 'columnar');
INSERT INTO events(kind, ms) VALUES ('load', 12.5), ('click', 0.5), ('load', 9.5);
SELECT kind, count(*) AS n, avg(ms) AS avg_ms FROM events GROUP BY kind ORDER BY kind
```

| kind | n | avg_ms |
| --- | --- | --- |
| click | 1 | 0.5 |
| load | 2 | 11 |

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
CREATE INDEX events_kind ON events(kind)
```

`PRAGMA compact(table)` rewrites a columnar table's segments; see [PRAGMA compact](./pragmas#compact) and [Analytics](../../guide/analytics).

## Temporary tables

`CREATE TEMP TABLE` makes a table that exists only for this connection, in memory (even in an OPFS database), and is gone when the database is closed. It may have indexes and constraints. A temp table shadows a main table of the same name; `main.name` still reaches the main one. Creating and filling it rolls back with the transaction.

```sql
CREATE TABLE scratch(v TEXT);
INSERT INTO scratch VALUES ('main');
CREATE TEMP TABLE scratch(v TEXT);
INSERT INTO scratch VALUES ('temp');
SELECT (SELECT v FROM scratch) AS plain, (SELECT v FROM main.scratch) AS main, (SELECT v FROM temp.scratch) AS temp
```

| plain | main | temp |
| --- | --- | --- |
| temp | main | temp |

Temp tables are listed in [`temp.sqlite_schema`](./information-schema#sqlite-schema), not in `sqlite_schema` or `information_schema`. They cannot be altered (`ALTER TABLE is not supported for TEMP table`), and cannot be columnar. A view that reads a temp table is itself temporary, and a materialized view cannot read one.

`CREATE TABLE temp.name (…)` also makes a temp table, and `CREATE TABLE main.name (…)` a main one. As in SQLite, `CREATE TEMP TABLE main.name` fails with `temporary table name must be unqualified`, and any other qualifier with `unknown database x` (`SMALT_ERROR`).

```sql
CREATE TABLE temp.notes(v TEXT);
SELECT type, name FROM temp.sqlite_schema
```

| type | name |
| --- | --- |
| table | scratch |
| table | notes |

## Not supported

| Form | Result |
| --- | --- |
| `CREATE TABLE … AS SELECT …` | `SMALT_UNSUPPORTED` |
| generated columns (`GENERATED ALWAYS AS (…)`, `AS (…) STORED`) | `SMALT_UNSUPPORTED` |
| `WITHOUT ROWID` | `SMALT_UNSUPPORTED` |
| `LOOSE` (dynamic typing) | `SMALT_UNSUPPORTED` |
| expressions in `PRIMARY KEY` / `UNIQUE` table constraints | `SMALT_UNSUPPORTED` (use a [unique expression index](./create-index)) |

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
CREATE TABLE copy AS SELECT * FROM book
```

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
CREATE TABLE area(w REAL, h REAL, a REAL GENERATED ALWAYS AS (w * h))
```

To copy a query's result into a new table, create the table, then `INSERT INTO … SELECT`.
