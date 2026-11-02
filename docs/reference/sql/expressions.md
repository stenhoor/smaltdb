# Expressions

Expressions compute values in result columns, `WHERE`, `ORDER BY`, `SET`, `CHECK` and elsewhere. They follow SQLite's rules for types, NULL and comparisons. For the values themselves, see [Data types](./types); for functions, the [function reference](../functions/).

## Syntax

```text
expr:
    literal | column | table.column | schema.table.column | parameter
  | unary-op expr | expr binary-op expr
  | expr [NOT] {LIKE | GLOB} expr [ESCAPE expr]
  | expr [NOT] BETWEEN expr AND expr
  | expr [NOT] IN (expr [, ...]) | expr [NOT] IN (select) | expr [NOT] IN [schema.]table
  | expr IS [NOT] expr | expr IS [NOT] DISTINCT FROM expr
  | expr ISNULL | expr NOTNULL | expr NOT NULL
  | [NOT] EXISTS (select) | (select)
  | CASE [expr] WHEN expr THEN expr [...] [ELSE expr] END
  | CAST (expr AS type-name)
  | expr COLLATE collation
  | function(args) [FILTER (WHERE expr)] [OVER window]
  | (expr)
```

## Operator precedence

From tightest to loosest binding. Operators on one line have equal precedence and group left to right.

| Operators |
| --- |
| unary `-` `+` `~`, `COLLATE` |
| `\|\|` `->` `->>` |
| `*` `/` `%` |
| `+` `-` |
| `&` `\|` `<<` `>>` |
| `ESCAPE` |
| `<` `<=` `>` `>=` |
| `=` `==` `!=` `<>` `IS` `IS NOT` `IN` `LIKE` `GLOB` `MATCH` `REGEXP` `BETWEEN` `ISNULL` `NOTNULL` `NOT NULL` |
| `NOT` |
| `AND` |
| `OR` |

```sql
SELECT 1 + 2 * 3 AS a, (1 + 2) * 3 AS b, NOT 1 = 2 AS c, 1 = 1 AND 0 OR 1 AS d
```

| a | b | c | d |
| --- | --- | --- | --- |
| 7 | 9 | 1 | 1 |

## Arithmetic

| Operator | Meaning |
| --- | --- |
| `+` `-` `*` | add, subtract, multiply |
| `/` | divide; integer division when both operands are integers (truncates toward zero) |
| `%` | remainder; both operands are converted to integers first, as in SQLite |
| unary `-` `+` | negate, no-op |

- Division or remainder by zero gives NULL (no error).
- Integer arithmetic is exact 64-bit. A result outside the 64-bit range becomes a REAL, as in SQLite.
- Text and blobs used as numbers take their longest numeric prefix (`'3abc'` is 3, `'abc'` is 0).
- Any NULL operand gives NULL.

```sql
SELECT 7 / 2 AS a, 7.0 / 2 AS b, -7 / 2 AS c, 7 % 3 AS d, 5.5 % 2 AS e, 1 / 0 AS f, '3abc' * 2 AS g, typeof(9223372036854775807 + 1) AS h
```

| a | b | c | d | e | f | g | h |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 3 | 3.5 | -3 | 1 | 1 | NULL | 6 | real |

## Concatenation

`a || b` joins two values as text. Numbers are converted to text the way `CAST(… AS TEXT)` does (`1.0` stays `1.0`). NULL on either side gives NULL.

```sql
SELECT 'v' || 2 AS a, 'v' || 2.0 AS b, 'v' || NULL AS c
```

| a | b | c |
| --- | --- | --- |
| v2 | v2.0 | NULL |

The JSON operators `->` and `->>` are parsed but fail with `SMALT_UNSUPPORTED`.

## Bitwise operators

`&` (and), `|` (or), `<<` and `>>` (shifts, sign-extending), unary `~` (not), on 64-bit integers.

```sql
SELECT 6 & 3 AS a, 6 | 3 AS b, 1 << 4 AS c, -16 >> 2 AS d, ~0 AS e
```

| a | b | c | d | e |
| --- | --- | --- | --- | --- |
| 2 | 7 | 16 | -4 | -1 |

## Comparisons

`=` (also `==`), `!=` (also `<>`), `<`, `<=`, `>`, `>=` return 1, 0, or NULL when either side is NULL.

Values of different types compare in this order: NULL, then INTEGER and REAL (by numeric value), then TEXT (by collation), then BLOB (bytewise). Before comparing, SQLite's affinity rules apply: when one side is a column with INTEGER, REAL or NUMERIC type and the other is text, the text is converted to a number if it looks like one; when one side is a TEXT column and the other a number, the number is converted to text. Two plain literals of different types are not converted.

```sql
CREATE TABLE cmp(n INTEGER, t TEXT);
INSERT INTO cmp VALUES (10, '10');
SELECT n = '10' AS num_col, t = 10 AS text_col, 10 = '10' AS literals, 1 = 1.0 AS int_real, 'Z' < 'a' AS binary_text FROM cmp
```

| num_col | text_col | literals | int_real | binary_text |
| --- | --- | --- | --- | --- |
| 1 | 1 | 0 | 1 | 1 |

### IS, IS NOT, IS DISTINCT FROM

`a IS b` is like `=` but treats NULLs as equal and never returns NULL. `IS NOT` is its negation. `IS NOT DISTINCT FROM` and `IS DISTINCT FROM` are the standard spellings of `IS` and `IS NOT`. `x ISNULL`, `x NOTNULL` and `x NOT NULL` are short for `x IS NULL` and `x IS NOT NULL`.

```sql
SELECT NULL = NULL AS eq, NULL IS NULL AS is_, 1 IS NOT NULL AS is_not, 1 IS DISTINCT FROM NULL AS distinct_, 5 NOTNULL AS notnull_
```

| eq | is_ | is_not | distinct_ | notnull_ |
| --- | --- | --- | --- | --- |
| NULL | 1 | 1 | 1 | 1 |

## Logical operators

`AND`, `OR` and `NOT` use three-valued logic: NULL means unknown. Any non-zero number is true; text is converted to a number (`'abc'` is false).

| a | b | a AND b | a OR b |
| --- | --- | --- | --- |
| 1 | NULL | NULL | 1 |
| 0 | NULL | 0 | NULL |

```sql
SELECT 1 AND NULL AS a, 0 AND NULL AS b, 1 OR NULL AS c, NOT NULL AS d
```

| a | b | c | d |
| --- | --- | --- | --- |
| NULL | 0 | 1 | NULL |

## LIKE and GLOB

```text
expr [NOT] LIKE pattern [ESCAPE char]
expr [NOT] GLOB pattern
```

| | `LIKE` | `GLOB` |
| --- | --- | --- |
| any sequence | `%` | `*` |
| one character | `_` | `?` |
| character class | — | `[abc]`, `[a-z]`, `[^a-z]` |
| case | ASCII letters ignore case (`'é'` does not match `'É'`) | case-sensitive |
| escape | `ESCAPE 'c'` makes the next character literal | use a class, e.g. `[*]` |

```sql
SELECT 'Hello' LIKE 'h%' AS a, 'Hello' GLOB 'h*' AS b, 'Hello' GLOB 'H?llo' AS c, '50%' LIKE '50\%' ESCAPE '\' AS d, 'Bx' GLOB '[A-C]*' AS e
```

| a | b | c | d | e |
| --- | --- | --- | --- | --- |
| 1 | 0 | 1 | 1 | 1 |

`MATCH` and `REGEXP` are parsed, but no functions implement them, so they fail with `no such function: regexp` (`SMALT_ERROR`), as in SQLite without extensions.

## BETWEEN

`x BETWEEN low AND high` is `x >= low AND x <= high`, with `x` evaluated once. `NOT BETWEEN` negates it.

```sql
SELECT 5 BETWEEN 1 AND 10 AS a, 'm' BETWEEN 'a' AND 'k' AS b, NULL BETWEEN 1 AND 2 AS c
```

| a | b | c |
| --- | --- | --- |
| 1 | 0 | NULL |

## IN

```text
x [NOT] IN (value, ...)
x [NOT] IN (select)
x [NOT] IN table        -- SQLite shorthand for x IN (SELECT * FROM table)
```

`IN` is true when `x` equals a value in the list or a row of the one-column subquery. When there is no match and the list contains a NULL, the result is NULL (so `NOT IN` with a NULL in the list is never true). An empty list `()` is allowed and gives false.

```sql
SELECT 2 IN (1, 2) AS a, 3 IN (1, 2) AS b, 3 IN (1, NULL) AS c, 3 NOT IN (1, NULL) AS d, 1 IN () AS e, 2 IN (VALUES (1), (2)) AS f
```

| a | b | c | d | e | f |
| --- | --- | --- | --- | --- | --- |
| 1 | 0 | NULL | NULL | 0 | 1 |

## Subqueries

A subquery in parentheses is a scalar value: the first column of its first row, or NULL when it returns no rows. It must return one column (`sub-select returns 2 columns - expected 1`). `EXISTS (select)` is 1 if the subquery returns any row. Subqueries can refer to columns of the outer query (correlated subqueries).

```sql
CREATE TABLE emp(name TEXT, dept TEXT, salary INTEGER);
INSERT INTO emp VALUES ('Ann', 'eng', 100), ('Bob', 'eng', 80), ('Cid', 'ops', 70);
SELECT name,
  salary - (SELECT avg(salary) FROM emp i WHERE i.dept = o.dept) AS vs_dept,
  EXISTS (SELECT 1 FROM emp i WHERE i.dept = o.dept AND i.salary > o.salary) AS has_higher
FROM emp o
ORDER BY name
```

| name | vs_dept | has_higher |
| --- | --- | --- |
| Ann | 10 | 0 |
| Bob | -10 | 1 |
| Cid | 0 | 0 |

## CASE

```text
CASE WHEN condition THEN result [WHEN ...] [ELSE result] END
CASE base WHEN value THEN result [WHEN ...] [ELSE result] END
```

The first `WHEN` that is true (or equal to `base`) gives the result; without a match the result is `ELSE`, or NULL. In the second form, a NULL `base` matches nothing, not even `WHEN NULL`.

```sql
SELECT name, CASE WHEN salary >= 90 THEN 'high' WHEN salary >= 75 THEN 'mid' ELSE 'low' END AS band,
  CASE dept WHEN 'eng' THEN 'Engineering' ELSE 'Other' END AS dept_name
FROM emp ORDER BY name
```

| name | band | dept_name |
| --- | --- | --- |
| Ann | high | Engineering |
| Bob | mid | Engineering |
| Cid | low | Other |

## CAST

`CAST(expr AS type-name)` converts a value to the affinity of the type name, using the same rules as [column types](./types#declared-types): a name containing `INT` is INTEGER, `CHAR`/`CLOB`/`TEXT` is TEXT, `BLOB` is BLOB, `REAL`/`FLOA`/`DOUB` is REAL, and anything else (including `NUMERIC`, `DECIMAL`, `BOOLEAN`, `DATE` and `ANY`) is NUMERIC.

| To | From text | From REAL | From BLOB |
| --- | --- | --- | --- |
| INTEGER | longest numeric prefix, truncated (`'12abc'` → 12, `'abc'` → 0) | truncates toward zero; clamps to the 64-bit range | the bytes read as text, then converted like text |
| REAL | longest numeric prefix | unchanged | like text |
| TEXT | unchanged | as SQLite's `printf('%!.17g', x)`: 17 significant digits, fewer when the 17-digit form ends in a run of zeros or nines and the shorter one reads back the same number (`0.1`, not `0.10000000000000001`); always with a decimal point or exponent; the exponent form for exponents below -4 or above 16 (`1.0`, `1000000000000000.0`, `1.0e+17`) | the bytes as UTF-8 |
| BLOB | the UTF-8 bytes | the text form's bytes | unchanged |
| NUMERIC | the numeric prefix, as INTEGER when it is integral | unchanged | like text |

NULL stays NULL.

```sql
SELECT CAST('12abc' AS INTEGER) AS a, CAST(-3.9 AS INTEGER) AS b, CAST(1.0 AS TEXT) AS c, CAST('é' AS BLOB) AS d, CAST(x'414243' AS TEXT) AS e, CAST('12.50' AS DECIMAL) AS f
```

| a | b | c | d | e | f |
| --- | --- | --- | --- | --- | --- |
| 12 | -3 | 1.0 | x'c3a9' | ABC | 12.5 |

Unlike storing into a column, `CAST` never fails.

## COLLATE

`expr COLLATE name` sets the collation used when the expression is compared or sorted: `BINARY` (default; bytewise), `NOCASE` (ASCII case folded) or `RTRIM` (trailing spaces ignored). An unknown name fails with `no such collation sequence: X`. When the two sides of a comparison have different collations, an explicit `COLLATE` wins, then the left operand's column collation, as in SQLite. See [collations](./types#collations).

```sql
SELECT 'abc' = 'ABC' AS plain, 'abc' = 'ABC' COLLATE NOCASE AS nocase, 'x  ' = 'x' COLLATE RTRIM AS rtrim
```

| plain | nocase | rtrim |
| --- | --- | --- |
| 0 | 1 | 1 |

## Parameters and special values

Parameters (`?`, `?NNN`, `:name`, `@name`, `$name`) are described in the [lexical structure](./#parameters). `CURRENT_DATE`, `CURRENT_TIME` and `CURRENT_TIMESTAMP` give the current UTC date (`YYYY-MM-DD`), time (`HH:MM:SS`) and both (`YYYY-MM-DD HH:MM:SS`); the current time is read once per statement, so every row sees the same value.

## Not supported

| Expression | Result |
| --- | --- |
| row values: `(a, b) = (1, 2)`, `(a, b) IN (…)` | syntax error: `row values are not supported` |
| `->`, `->>` | `SMALT_UNSUPPORTED` |
| `MATCH`, `REGEXP` | `no such function` |
| `RAISE(…)` (triggers only in SQLite) | syntax error |

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
SELECT '{"a": 1}' -> '$.a'
```
