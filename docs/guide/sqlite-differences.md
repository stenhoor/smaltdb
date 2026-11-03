# Differences from SQLite

smaltdb's SQL is based on SQLite's: the same syntax, functions, NULL handling, comparison and affinity rules, and error messages wherever possible. This page lists every difference we know of. Each one was checked against the engine; the examples on this page run as part of the test suite.

The two that affect almost every application:

1. **Tables are STRICT by default.** Values must fit the column type.
2. **Foreign keys are enforced by default.**

## Types and values

### Tables are STRICT

Every table behaves like a SQLite `STRICT` table: a value is converted to the column's type only when nothing is lost, and otherwise rejected with `SMALT_CONSTRAINT_DATATYPE`. SQLite's ordinary tables store anything anywhere. SQLite-style dynamic typing (`LOOSE` tables) is not supported.

```sql
CREATE TABLE t(n INTEGER, s TEXT);
INSERT INTO t VALUES ('42', 7);
SELECT n, typeof(n) AS tn, s, typeof(s) AS ts FROM t
```

| n | tn | s | ts |
| --- | --- | --- | --- |
| 42 | integer | 7 | text |

<!-- docs:error SMALT_CONSTRAINT_DATATYPE -->
```sql
INSERT INTO t(n) VALUES ('forty-two')
```

Unlike SQLite's `STRICT` tables, any type name is allowed and mapped by SQLite's affinity rules (`VARCHAR(20)` is TEXT; `BOOLEAN`, `DATE`, `DECIMAL` are NUMERIC). See [Data types](../reference/sql/types).

### Integral REALs can become INTEGERs

JavaScript has one number type, so smaltdb tracks REAL-ness statically. Where it cannot, an integral REAL turns into an INTEGER: in an `ANY` or `NUMERIC` column, and in arithmetic on numeric text. This changes `typeof()`, integer division and text conversion. REAL columns are not affected.

```sql
CREATE TABLE r(a ANY);
INSERT INTO r VALUES (2.0);
SELECT typeof(a) AS t, a / 4 AS q, typeof('5.0' + 0) AS t2 FROM r
```

| t | q | t2 |
| --- | --- | --- |
| integer | 0 | integer |

SQLite returns `real`, `0.5` and `real`. See [REAL](../reference/sql/types#real).

### Double-quoted strings

A double-quoted name that is not a column is an error. SQLite falls back to treating it as a string literal.

<!-- docs:error SMALT_ERROR -->
```sql
SELECT "hello"
```

## Tables and constraints

### Foreign keys are on

Foreign-key constraints are enforced unless you run `PRAGMA foreign_keys = OFF` (outside a transaction). In SQLite they are off until you turn them on. See [PRAGMA foreign_keys](../reference/sql/pragmas#foreign-keys).

```sql
PRAGMA foreign_keys
```

| foreign_keys |
| --- |
| 1 |

### Primary keys are never NULL

All `PRIMARY KEY` columns are NOT NULL. SQLite allows NULL in the primary key of an ordinary table unless it is an `INTEGER PRIMARY KEY`.

```sql
CREATE TABLE code(c TEXT PRIMARY KEY, label TEXT);
```

<!-- docs:error SMALT_CONSTRAINT_NOTNULL -->
```sql
INSERT INTO code VALUES (NULL, 'none')
```

### AUTOINCREMENT

`AUTOINCREMENT` is allowed only on an `INTEGER PRIMARY KEY`, as in SQLite, but it does not stop keys from being reused: after the row with the largest key is deleted, its key can be used again. SQLite never reuses keys with `AUTOINCREMENT`.

```sql
CREATE TABLE seq(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);
INSERT INTO seq(v) VALUES ('a'), ('b');
DELETE FROM seq WHERE id = 2;
INSERT INTO seq(v) VALUES ('c');
SELECT * FROM seq
```

| id | v |
| --- | --- |
| 1 | a |
| 2 | c |

When the largest rowid is already 9223372036854775807, a row inserted without a key gets a random free rowid, as in SQLite (`SMALT_FULL` with `AUTOINCREMENT`). In SQLite an `AUTOINCREMENT` table stays full even after that row is deleted; in smaltdb the next key is again one more than the largest left.

### OR FAIL

`INSERT OR FAIL` and `UPDATE OR FAIL`, and a constraint's `ON CONFLICT FAIL`, behave like `ABORT`: rows the statement changed before the failing one are undone too. In SQLite they are kept.

```sql
CREATE TABLE u(k TEXT UNIQUE);
INSERT INTO u VALUES ('x');
```

<!-- docs:error SMALT_CONSTRAINT_UNIQUE -->
```sql
INSERT OR FAIL INTO u VALUES ('y'), ('x')
```

```sql
SELECT count(*) AS n FROM u
```

| n |
| --- |
| 1 |

SQLite keeps `'y'` and returns 2.

### Constraint expressions

- `ALTER TABLE … ADD COLUMN` rejects a `NOT NULL` column without a default, and a non-constant default such as `CURRENT_TIMESTAMP`, even on an empty table. SQLite rejects them only when the table has rows.

### Temporary tables

- TEMP tables cannot be altered (`SMALT_UNSUPPORTED`).
- `temp.sqlite_schema` lists the `sql` of TEMP objects as written (`CREATE TEMP TABLE t(x)`); SQLite stores a normalised `CREATE TABLE t(x)`.

### Index keys

An index key must fit in about a quarter of a page (about 2 KB with the default 8 KiB pages); longer values fail with `SMALT_TOOBIG`. SQLite stores larger keys in overflow pages.

## Not supported

These are rejected. Statements the parser does not know fail with a syntax error (`SMALT_SYNTAX`); the others fail with `SMALT_UNSUPPORTED` unless noted.

| Feature | Result | Instead |
| --- | --- | --- |
| `CREATE TRIGGER`, `DROP TRIGGER` | syntax error, `SMALT_UNSUPPORTED` | application code |
| `ATTACH`, `DETACH` | syntax error | open several databases |
| `CREATE VIRTUAL TABLE` (FTS, R*Tree, …) | syntax error | |
| `VACUUM` | `SMALT_UNSUPPORTED` | freed pages are reused |
| `REINDEX` | syntax error | |
| `WITHOUT ROWID` tables | `SMALT_UNSUPPORTED` | a `PRIMARY KEY` on a rowid table |
| generated columns | `SMALT_UNSUPPORTED` | compute in queries or views |
| `CREATE TABLE … AS SELECT` | `SMALT_UNSUPPORTED` | `CREATE TABLE`, then `INSERT … SELECT` |
| `LOOSE` (dynamic typing) | `SMALT_UNSUPPORTED` | `ANY` columns |
| `WITH … INSERT … VALUES` | `SMALT_UNSUPPORTED` | `WITH … INSERT … SELECT` |
| `UPDATE` / `DELETE` with `ORDER BY` or `LIMIT` | `SMALT_UNSUPPORTED` | `WHERE rowid IN (SELECT rowid … LIMIT n)` |
| row values: `(a, b) = (1, 2)`, `SET (a, b) = …` | syntax error / `SMALT_UNSUPPORTED` | separate terms |
| upsert target with `WHERE` | `SMALT_UNSUPPORTED` | |
| `ON CONFLICT DO UPDATE` without a target | `SMALT_ERROR` | name the conflict columns |
| `ORDER BY` inside aggregate arguments | `SMALT_UNSUPPORTED` | aggregate an ordered subquery |
| `USING` / `NATURAL` with `RIGHT` or `FULL` joins | `SMALT_UNSUPPORTED` | `ON` |
| `LEFT JOIN` whose right side is a parenthesized join | `SMALT_UNSUPPORTED` | a subquery |
| JSON functions and the `->`, `->>` operators | `no such function` / `SMALT_UNSUPPORTED` | parse in JavaScript |
| application-defined functions and collations | no API | |
| `EXPLAIN` of statements other than `SELECT` | `SMALT_UNSUPPORTED` | |
| `EXPLAIN` bytecode listing | plain `EXPLAIN` returns the query plan | |
| most `PRAGMA`s (`user_version`, `cache_size`, `busy_timeout`, `synchronous`, …) | `SMALT_UNSUPPORTED` | [open options](./databases) |

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
CREATE TABLE copy AS SELECT * FROM seq
```

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
DELETE FROM seq WHERE id > 0 LIMIT 1
```

```sql
DELETE FROM seq WHERE rowid IN (SELECT rowid FROM seq ORDER BY id LIMIT 1);
SELECT id FROM seq
```

| id |
| --- |
| 2 |

The supported `PRAGMA`s are listed in [PRAGMA](../reference/sql/pragmas).

## Math functions

The math functions (`sqrt`, `pow`, `ln`, `sin`, …) follow SQLite, with these differences:
- **The last bit.** smaltdb computes them with JavaScript's `Math`, and SQLite with the C library it was built with.
  In V8 (Chrome, Edge, Node) every function is within one unit in the last place of SQLite's official WASM build, and
  `sqrt`, `ceil`, `floor`, `trunc`, `mod`, `log2`, `log10`, `tanh` and the inverse trigonometric functions match it to
  the bit. JavaScript leaves the last bit to the engine, so Firefox and Safari can differ there too.
- **`acosh` below -1.** smaltdb returns NULL for any `X` below 1, where acosh is not defined. SQLite's WASM build
  returns a wrong number for some arguments of -2 or less; builds on other C libraries return NULL.
- **`ceil`, `floor` and `trunc` of text or an `ANY` value** can give an INTEGER where SQLite gives the same value as a
  REAL (`ceil('2.5')` is 3 rather than 3.0); see [Integral REALs can become INTEGERs](#integral-reals-can-become-integers).

## Queries

- `RIGHT JOIN` and `FULL JOIN` work (SQLite has them since 3.39), except with `USING` or `NATURAL`.
- In `GROUP BY` or `DISTINCT` over `NOCASE` or `RTRIM` text, values that compare equal form one group; smaltdb shows the spelling of the first row it scanned, which can differ from SQLite's choice.
- A failing constant subexpression in a part of an expression that is not needed is not evaluated: `SELECT a AND abs(-9223372036854775808) FROM t` gives 0 for rows where `a` is 0. SQLite evaluates such constants once before the first row, so it fails (except in `CASE`, `iif`, `coalesce` and similar, where both skip it, and next to a literal `0` or `1` as in `x AND 0`).
- `char()` of a surrogate code point (U+D800–U+DFFF) gives U+FFFD; SQLite emits invalid UTF-8.
- `'now'`, `CURRENT_TIMESTAMP` and friends are read once per statement, so every row of a statement sees the same time (SQLite guarantees this only within one step).
- Plain `EXPLAIN` returns the same rows as `EXPLAIN QUERY PLAN`, and the plan texts differ from SQLite's in places. `EXPLAIN ANALYZE` is an addition.

## Additions

smaltdb also has things SQLite does not:

- [`information_schema`](../reference/sql/information-schema) views;
- [materialized views](../reference/sql/views) (`CREATE / REFRESH / DROP MATERIALIZED VIEW`);
- [external tables and connections](../reference/sql/external), and the `read_csv`, `read_json`, `read_parquet` table functions, through [plugins](./plugins);
- [columnar tables](../reference/sql/create-table#columnar-tables) (`WITH (storage = 'columnar')`);
- the [statistical aggregates](../reference/functions/aggregate#statistics) `var_samp`, `variance`, `var_pop`, `stddev_samp`, `stddev`, `stddev_pop`, `covar_samp`, `covar_pop`, `corr`, `skewness`, `skewness_pop`, `kurtosis` and `kurtosis_pop` (SQLite has `median` and the `percentile` functions, which smaltdb has too, with the same results);
- `EXPLAIN ANALYZE`, and the pragmas `work_mem`, `matview_rewrite`, `parallel_aggregates`, `spill_bytes` and `compact`.
