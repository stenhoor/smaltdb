# Scalar functions

General-purpose scalar functions: NULL handling, conditionals, type inspection, blobs, and information about the last statement. Text functions are on [String functions](./string), numeric ones on [Math functions](./math), and date and time functions on [Date and time functions](./datetime).

Function names are case-insensitive. Calling a function with the wrong number of arguments fails with `SMALT_ERROR` (`wrong number of arguments to function f()`), and an unknown name fails with `no such function: f`. Both errors are raised when the statement is prepared, not when a row is processed.

Some SQL constructs look like functions but are part of the expression grammar. They are documented with the other expressions:

| Construct | Where |
| --- | --- |
| `CAST(x AS type)` | [Expressions](../sql/expressions) |
| `CASE … END` | [Expressions](../sql/expressions) |
| `CURRENT_DATE`, `CURRENT_TIME`, `CURRENT_TIMESTAMP` | [Date and time functions](./datetime#current_date) |

## NULL handling and conditionals

### coalesce {#coalesce}

```
coalesce(X, Y, …)
```

Returns the first argument that is not NULL, or NULL when all of them are NULL. It takes at least two arguments.

```sql
SELECT coalesce(NULL, NULL, 'third', 'fourth') AS a, coalesce(NULL, NULL) AS b;
```

| a | b |
| --- | --- |
| third | NULL |

### ifnull {#ifnull}

```
ifnull(X, Y)
```

The two-argument form of `coalesce`: `X` if it is not NULL, otherwise `Y`.

```sql
SELECT ifnull(NULL, 'fallback') AS a, ifnull(0, 'fallback') AS b;
```

| a | b |
| --- | --- |
| fallback | 0 |

### iif {#iif}

```
iif(COND, X, Y)
iif(COND, X)
iif(COND1, X1, COND2, X2, …, [ELSE])
if(…)
```

Returns `X` when `COND` is true and `Y` otherwise. `COND` is true when it is a non-zero number; text and blobs are converted to a number first (`'abc'` counts as 0), and NULL counts as false. It is the same as `CASE WHEN COND THEN X ELSE Y END`, and only the chosen argument is evaluated.

With two arguments, the result is NULL when `COND` is false. With more, the arguments are condition/value pairs tried in order, and an odd last argument is the value when no condition is true (NULL without one). `if` is another name for `iif` (both as in SQLite 3.48 and later). Fewer than two arguments fail with `wrong number of arguments to function iif()`.

```sql
SELECT iif(5 > 3, 'yes', 'no') AS a, iif(NULL, 'yes', 'no') AS b, iif('0.5', 'yes', 'no') AS c;
```

| a | b | c |
| --- | --- | --- |
| yes | no | yes |

```sql
SELECT iif(0, 'yes') AS a, iif(0, 'one', 1, 'two') AS b, if(0, 'one', 0, 'two', 'other') AS c;
```

| a | b | c |
| --- | --- | --- |
| NULL | two | other |

<!-- docs:error SMALT_ERROR -->
```sql
SELECT iif(1);
```

### nullif {#nullif}

```
nullif(X, Y)
```

Returns NULL when `X` and `Y` are equal, otherwise `X`. The comparison uses the collation of `X` (for example `COLLATE NOCASE`). If either argument is NULL, the result is `X`.

```sql
SELECT nullif(10, 10) AS a, nullif(10, 20) AS b, nullif('a', 'A') AS c, nullif('a' COLLATE NOCASE, 'A') AS d;
```

| a | b | c | d |
| --- | --- | --- | --- |
| NULL | 10 | a | NULL |

A common use is avoiding division by zero:

```sql
SELECT 100 / nullif(0, 0) AS ratio;
```

| ratio |
| --- |
| NULL |

## Type inspection

### typeof {#typeof}

```
typeof(X)
```

Returns the storage class of `X` as lower-case text: `'null'`, `'integer'`, `'real'`, `'text'` or `'blob'`.

```sql
SELECT typeof(1) AS a, typeof(1.5) AS b, typeof('x') AS c, typeof(x'00') AS d, typeof(NULL) AS e;
```

| a | b | c | d | e |
| --- | --- | --- | --- | --- |
| integer | real | text | blob | null |

::: warning Differs from SQLite
A REAL with no fractional part (and magnitude below 2^53) that reaches `typeof` through an untyped expression, or from an `ANY` or `NUMERIC` column, can report `'integer'`. For example `typeof(max(1, 2.0))` is `'integer'` in smaltdb and `'real'` in SQLite. A REAL literal such as `2.0` and values from a `REAL` column report `'real'`. See [Types](../sql/types).
:::

```sql
SELECT typeof(2.0) AS literal, typeof(max(1, 2.0)) AS computed;
```

| literal | computed |
| --- | --- |
| real | integer |

## Scalar min and max

### min {#min}

```
min(X, Y, …)
```

With two or more arguments, `min` is a scalar function that returns the smallest argument. It returns NULL if any argument is NULL. Values of different types compare in SQLite's order: NULL, then numbers, then text, then blobs. Text compares with the collation of the first argument.

With one argument, `min` is the [aggregate function](./aggregate#min).

```sql
SELECT min(3, 1, 2) AS a, min(2.5, 3) AS b, min(1, 'a') AS c, min(1, NULL) AS d;
```

| a | b | c | d |
| --- | --- | --- | --- |
| 1 | 2.5 | 1 | NULL |

### max {#max}

```
max(X, Y, …)
```

With two or more arguments, returns the largest argument, or NULL if any argument is NULL. Ordering and collation work as for scalar `min`. With one argument, `max` is the [aggregate function](./aggregate#max).

```sql
SELECT max(3, 1, 2) AS a, max('a', 'B') AS b, max('a' COLLATE NOCASE, 'B') AS c, max(1, x'00') AS d;
```

| a | b | c | d |
| --- | --- | --- | --- |
| 3 | a | B | x'00' |

`'a'` is larger than `'B'` in the default `BINARY` collation (it compares UTF-8 bytes); with `NOCASE` it is not.

## Blobs

### randomblob {#randomblob}

```
randomblob(N)
```

Returns a blob of `N` cryptographically random bytes (from `crypto.getRandomValues`). If `N` is less than 1 or NULL, the result is a 1-byte blob.

```sql
SELECT length(randomblob(16)) AS a, length(randomblob(0)) AS b, typeof(randomblob(4)) AS c;
```

| a | b | c |
| --- | --- | --- |
| 16 | 1 | blob |

A common use is generating random identifiers:

```sql
SELECT length(hex(randomblob(16))) AS hex_digits;
```

| hex_digits |
| --- |
| 32 |

### zeroblob {#zeroblob}

```
zeroblob(N)
```

Returns a blob of `N` zero bytes. A negative `N` or NULL gives an empty blob.

```sql
SELECT zeroblob(3) AS a, length(zeroblob(-1)) AS b;
```

| a | b |
| --- | --- |
| x'000000' | 0 |

## Planner hints

### likely {#likely}

```
likely(X)
```

Returns `X` unchanged. In SQLite it tells the query planner that `X` is usually true; smaltdb accepts it for compatibility and ignores the hint.

### unlikely {#unlikely}

```
unlikely(X)
```

Returns `X` unchanged (SQLite's hint that `X` is usually false; ignored).

### likelihood {#likelihood}

```
likelihood(X, P)
```

Returns `X` unchanged (SQLite's hint that `X` is true with probability `P`; ignored). `P` must be a REAL literal from 0.0 to 1.0, such as `0.9` or `1.0`; anything else, including an integer literal like `1`, fails with `second argument to likelihood() must be a constant between 0.0 and 1.0`, as in SQLite.

```sql
SELECT likely(5) AS a, unlikely('b') AS b, likelihood(7, 0.9) AS c;
```

| a | b | c |
| --- | --- | --- |
| 5 | b | 7 |

<!-- docs:error SMALT_ERROR -->
```sql
SELECT likelihood(7, 2);
```

## Last statement and version

### last_insert_rowid {#last_insert_rowid}

```
last_insert_rowid()
```

Returns the rowid of the most recent successful `INSERT` on this database connection, or 0 if there has been none.

### changes {#changes}

```
changes()
```

Returns the number of rows inserted, updated or deleted by the most recent completed `INSERT`, `UPDATE` or `DELETE` statement on this connection.

### total_changes {#total_changes}

```
total_changes()
```

Returns the number of rows inserted, updated or deleted by all `INSERT`, `UPDATE` and `DELETE` statements since the connection was opened.

```sql
CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT);
INSERT INTO note(body) VALUES ('a'), ('b'), ('c');
UPDATE note SET body = upper(body) WHERE id > 1;
SELECT last_insert_rowid() AS last_id, changes() AS changed, total_changes() AS total;
```

| last_id | changed | total |
| --- | --- | --- |
| 3 | 2 | 5 |

From JavaScript, `exec()` and a prepared statement's `run()` return `changes` and `lastInsertRowid` too; see [Queries](../../guide/queries).

### smaltdb_version {#smaltdb_version}

```
smaltdb_version()
```

Returns the version of the smaltdb package as text, such as `'0.9.0'` (the `version` in its `package.json`). smaltdb has no `sqlite_version()` function.

```sql
SELECT smaltdb_version() GLOB '[0-9]*.[0-9]*.[0-9]*' AS is_version;
```

| is_version |
| --- |
| 1 |
