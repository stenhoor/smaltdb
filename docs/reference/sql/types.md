# Data types

Every value in smaltdb has one of SQLite's five storage types. Every column has a declared type that decides which values it accepts: tables are STRICT by default, so a value that does not fit is converted losslessly or rejected. This is the main difference from SQLite, whose ordinary tables accept any value in any column.

## Storage types

| Type | Values | JavaScript |
| --- | --- | --- |
| NULL | the missing value | `null` |
| INTEGER | 64-bit signed integers | `number`, or `bigint` beyond ±(2<sup>53</sup>−1) |
| REAL | 64-bit IEEE floating point | `number` |
| TEXT | Unicode strings (UTF-8 in the file) | `string` |
| BLOB | bytes | `Uint8Array` |

`typeof(x)` returns the storage type of a value in lower case.

```sql
SELECT typeof(NULL) AS a, typeof(42) AS b, typeof(4.2) AS c, typeof('x') AS d, typeof(x'00') AS e
```

| a | b | c | d | e |
| --- | --- | --- | --- | --- |
| null | integer | real | text | blob |

How JavaScript values are bound and returned (row modes, `bigint`, `Date`) is described in [Queries](../../guide/queries).

## Declared types

A column's declared type maps to a column type with SQLite's affinity rules, checked in this order:

| Declared type contains | Column type | Examples |
| --- | --- | --- |
| `INT` | INTEGER | `INTEGER`, `INT`, `BIGINT`, `UNSIGNED BIG INT` |
| `CHAR`, `CLOB` or `TEXT` | TEXT | `TEXT`, `VARCHAR(255)`, `NVARCHAR(10)`, `CLOB` |
| `BLOB` | BLOB | `BLOB` |
| `REAL`, `FLOA` or `DOUB` | REAL | `REAL`, `FLOAT`, `DOUBLE PRECISION` |
| exactly `ANY`, or no type | ANY | `ANY`, (none) |
| anything else | NUMERIC | `NUMERIC`, `DECIMAL(10,2)`, `BOOLEAN`, `DATE`, `DATETIME` |

Lengths and precisions (`VARCHAR(10)`, `DECIMAL(10,2)`) are kept in the declared type but not enforced. `PRAGMA table_info` and `information_schema.columns.data_type` show the declared type as written (upper-cased), or `ANY` in `information_schema` when none was given.

## STRICT conversion

When a value is stored in a column (`INSERT`, `UPDATE`, upsert), it is converted to the column type only if no information is lost; otherwise the statement fails with `SMALT_CONSTRAINT_DATATYPE` and the message `cannot store <TYPE> value in <COLUMN TYPE> column <table>.<column>`. NULL fits every column (use `NOT NULL` to forbid it).

| Column type | Accepts | Converts | Rejects |
| --- | --- | --- | --- |
| INTEGER | INTEGER | a REAL with no fraction within the 64-bit range (`5.0` → 5); text that is an integer or an integral number, with optional spaces (`'5'`, `' 7 '`, `'5.0'`) | other REALs (`5.5`), other text, BLOBs |
| REAL | REAL | INTEGER (`3` → 3.0); numeric text (`'2.5'`) | other text, BLOBs |
| TEXT | TEXT | INTEGER and REAL to their text form (`12` → `'12'`, `1.0` → `'1.0'`) | BLOBs |
| BLOB | BLOB | — | everything else |
| NUMERIC | everything | numeric-looking text to INTEGER or REAL (`'12'` → 12, `'1.50'` → 1.5) | — |
| ANY | everything, unchanged | — | — |

```sql
CREATE TABLE t(i INTEGER, r REAL, s TEXT, b BLOB, n NUMERIC, a ANY);
INSERT INTO t VALUES ('5', 3, 12, x'01', '1.50', '1.50');
SELECT i, typeof(i) AS ti, r, typeof(r) AS tr, s, typeof(s) AS ts, n, typeof(n) AS tn, a, typeof(a) AS ta FROM t
```

| i | ti | r | tr | s | ts | n | tn | a | ta |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 5 | integer | 3 | real | 12 | text | 1.5 | real | 1.50 | text |

<!-- docs:error SMALT_CONSTRAINT_DATATYPE -->
```sql
INSERT INTO t(i) VALUES (5.5)
```

<!-- docs:error SMALT_CONSTRAINT_DATATYPE -->
```sql
INSERT INTO t(r) VALUES ('abc')
```

<!-- docs:error SMALT_CONSTRAINT_DATATYPE -->
```sql
INSERT INTO t(b) VALUES ('not bytes')
```

The messages are `cannot store REAL value in INTEGER column t.i`, `cannot store TEXT value in REAL column t.r` and `cannot store TEXT value in BLOB column t.b`.

`STRICT` after a table definition is accepted and changes nothing. SQLite's dynamic typing (`LOOSE` tables) is not supported. Compared with SQLite's own STRICT tables: SQLite allows only `INT`, `INTEGER`, `REAL`, `TEXT`, `BLOB` and `ANY` as column types there, while smaltdb accepts any type name and maps it as above (which is how NUMERIC columns arise).

Expressions are not checked: a `SELECT` can return any type in any column. Only stored values are converted. External tables convert by affinity without errors ([External tables](./external)).

## Integers

INTEGER values are exact 64-bit signed integers, from -9223372036854775808 to 9223372036854775807.

- Arithmetic is exact; a result outside the range becomes a REAL, as in SQLite.
- Values within ±(2<sup>53</sup>−1) (`Number.MAX_SAFE_INTEGER`) reach JavaScript as `number`, larger ones as `bigint`. Parameters can be either; a `bigint` within the safe range is stored like the same `number`.
- An `INTEGER PRIMARY KEY` column is the rowid (see [CREATE TABLE](./create-table#primary-key)).

```sql
SELECT 9007199254740993 AS big, 9223372036854775807 + 1 AS overflow, typeof(9223372036854775807 + 1) AS t
```

| big | overflow | t |
| --- | --- | --- |
| 9007199254740993 | 9223372036854776000 | real |

(In JavaScript, `big` is the `bigint` `9007199254740993n`.)

## REAL

REAL values are 64-bit floats. Division by zero gives NULL, not infinity. `CAST(real AS TEXT)` and `||` write a REAL with a decimal point (`1.0`) as SQLite does.

JavaScript has one number type, so an integral float such as `2.0` and the integer `2` look alike. smaltdb keeps them apart where it knows the type statically (REAL columns, REAL literals, `CAST … AS REAL`, results of REAL arithmetic), and `typeof()`, integer division and text conversion behave as in SQLite there. Where the type is only known at run time, an integral REAL can turn into an INTEGER:

- An integral REAL stored in an `ANY` or `NUMERIC` column reads back as INTEGER.
- Arithmetic on numeric text yields INTEGER when the result is integral (`'5.0' + 0`).

```sql
CREATE TABLE r(x REAL, a ANY);
INSERT INTO r VALUES (2.0, 2.0);
SELECT typeof(x) AS tx, x / 4 AS x4, typeof(a) AS ta, a / 4 AS a4, typeof('5.0' + 0) AS t5 FROM r
```

| tx | x4 | ta | a4 | t5 |
| --- | --- | --- | --- | --- |
| real | 0.5 | integer | 0 | integer |

SQLite returns `real`, `0.5` and `real` for the last three. Store floats in REAL columns to keep them REAL.

## Text

Text is Unicode, stored as UTF-8. `length()` counts characters. Comparisons use the column's [collation](#collations); the default `BINARY` compares by code point (so `'Z' < 'a'` and `'z' < 'é'`).

## Booleans

There is no boolean storage type. `TRUE` and `FALSE` are the integers 1 and 0; comparisons return 1, 0 or NULL; JavaScript `true` and `false` are bound as 1 and 0. A column declared `BOOLEAN` has NUMERIC type, so it stores 1 and 0 but also keeps text such as `'yes'` as text. Add a `CHECK` to restrict it.

```sql
CREATE TABLE flag(on_ BOOLEAN CHECK (on_ IN (0, 1)));
INSERT INTO flag VALUES (TRUE), (1 > 2);
SELECT on_, typeof(on_) AS t FROM flag
```

| on_ | t |
| --- | --- |
| 1 | integer |
| 0 | integer |

## Dates and times

There is no date type. Store dates as TEXT in ISO 8601 form (`'2024-03-01'`, `'2024-03-01 14:30:00'`), which sorts correctly and is what the [date and time functions](../functions/datetime) read and write, or as INTEGER Unix time or REAL Julian day numbers. Declare the column `TEXT`: a `DATE` column has NUMERIC type, which would turn a value such as `'2024'` into the integer 2024.

```sql
CREATE TABLE ev(d TEXT, n DATE);
INSERT INTO ev VALUES ('2024-03-01', '2024');
SELECT d, typeof(d) AS td, n, typeof(n) AS tn, date(d, '+1 month') AS next FROM ev
```

| d | td | n | tn | next |
| --- | --- | --- | --- | --- |
| 2024-03-01 | text | 2024 | integer | 2024-04-01 |

JavaScript `Date` objects are not accepted as parameters; pass `date.toISOString()` or a number.

## BLOBs

BLOB literals are written `x'0A1B'`. From JavaScript, pass a `Uint8Array` (other typed arrays and `DataView`s are bound as their bytes). Results return `Uint8Array`. A BLOB column accepts only BLOBs; `CAST(text AS BLOB)` gives the text's UTF-8 bytes.

## NULL

NULL means "no value". Most operators and functions return NULL when an operand is NULL; `IS`, `IS NOT`, `coalesce()` and `ifnull()` are the usual ways to handle it. `UNIQUE` columns allow many NULLs, `GROUP BY`, `DISTINCT` and compound queries treat NULLs as equal, and NULLs sort first in ascending order. See [Expressions](./expressions#logical-operators) for three-valued logic.

## Collations

A collation decides how text is compared and sorted.

| Collation | Comparison |
| --- | --- |
| `BINARY` (default) | by Unicode code point (UTF-8 byte order) |
| `NOCASE` | ASCII letters `A`–`Z` fold to lower case; other characters compare as `BINARY` |
| `RTRIM` | trailing spaces are ignored |

A collation is set on a column (`name TEXT COLLATE NOCASE`), on an index column, in a `UNIQUE`/`PRIMARY KEY` table constraint, or on an expression (`ORDER BY name COLLATE NOCASE`). Locale-aware collations are not available, and applications cannot define their own.

```sql
CREATE TABLE w(word TEXT COLLATE NOCASE);
INSERT INTO w VALUES ('b'), ('B'), ('a'), ('É');
SELECT word FROM w ORDER BY word, word COLLATE BINARY
```

| word |
| --- |
| a |
| B |
| b |
| É |

In `GROUP BY` and `DISTINCT` over a `NOCASE` or `RTRIM` column, values that compare equal form one group; which spelling the group shows is not specified (smaltdb returns the first in scan order, SQLite may return another).
