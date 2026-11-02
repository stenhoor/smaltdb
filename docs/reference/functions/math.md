# Math functions

smaltdb has four numeric functions: [`abs`](#abs), [`round`](#round), [`sign`](#sign) and [`random`](#random). Arithmetic (`+ - * / %`) and the bitwise operators are documented in [Expressions](../sql/expressions); [`min` and `max`](./scalar#min) with several arguments are on the scalar page.

::: warning Not available
SQLite's optional math functions are **not** implemented: `acos`, `acosh`, `asin`, `asinh`, `atan`, `atan2`, `atanh`, `ceil`, `ceiling`, `cos`, `cosh`, `degrees`, `exp`, `floor`, `ln`, `log`, `log10`, `log2`, `mod`, `pi`, `pow`, `power`, `radians`, `sin`, `sinh`, `sqrt`, `tan`, `tanh` and `trunc`. Calling one fails with `no such function`.
:::

<!-- docs:error SMALT_ERROR -->
```sql
SELECT sqrt(16);
```

Some can be written with what is available:

| Instead of | Write |
| --- | --- |
| `mod(a, b)` | `a % b` |
| `trunc(x)` | `CAST(x AS INTEGER)` (rounds toward zero) |
| `floor(x)` | `CAST(x AS INTEGER) - (x < CAST(x AS INTEGER))` |
| `ceil(x)` | `CAST(x AS INTEGER) + (x > CAST(x AS INTEGER))` |
| `pow(x, 2)` | `x * x` |

```sql
SELECT 7 % 3 AS mod, CAST(-2.7 AS INTEGER) AS trunc, CAST(-2.7 AS INTEGER) - (-2.7 < CAST(-2.7 AS INTEGER)) AS floor, CAST(2.3 AS INTEGER) + (2.3 > CAST(2.3 AS INTEGER)) AS ceil;
```

| mod | trunc | floor | ceil |
| --- | --- | --- | --- |
| 1 | -2 | -3 | 3 |

## abs {#abs}

```
abs(X)
```

The absolute value of `X`. Integers stay integers and REALs stay REAL. Text and blobs are converted to a number first (text that is not a number gives 0). NULL gives NULL. `abs(-9223372036854775808)` fails with `integer overflow`, because the result does not fit in a 64-bit integer.

```sql
SELECT abs(-5) AS a, abs(-2.5) AS b, abs('-3') AS c, abs('x') AS d, abs(NULL) AS e;
```

| a | b | c | d | e |
| --- | --- | --- | --- | --- |
| 5 | 2.5 | 3 | 0 | NULL |

<!-- docs:error SMALT_ERROR -->
```sql
SELECT abs(-9223372036854775808);
```

## round {#round}

```
round(X)
round(X, DIGITS)
```

`X` rounded to `DIGITS` digits after the decimal point (default 0). Halves round away from zero. `DIGITS` is clamped to the range 0–30, so a negative value means 0. The result is always REAL. Text is converted to a number first. If `X` or `DIGITS` is NULL, the result is NULL.

```sql
SELECT round(2.5) AS a, round(-2.5) AS b, round(1.2345, 2) AS c, round('3.7') AS d, round(1234.5, -2) AS e, typeof(round(3)) AS f;
```

| a | b | c | d | e | f |
| --- | --- | --- | --- | --- | --- |
| 3 | -3 | 1.23 | 4 | 1235 | real |

Rounding works on the binary value, so a number such as 2.675 (stored as 2.67499999…) rounds down, as in SQLite:

```sql
SELECT round(2.675, 2) AS r;
```

| r |
| --- |
| 2.67 |

## sign {#sign}

```
sign(X)
```

`-1`, `0` or `1` for a negative, zero or positive number. NULL, text and blobs give NULL.

```sql
SELECT sign(-2.5) AS a, sign(0) AS b, sign(42) AS c, sign(NULL) AS d;
```

| a | b | c | d |
| --- | --- | --- | --- |
| -1 | 0 | 1 | NULL |

::: warning Differs from SQLite
SQLite converts numeric text, so `sign('3')` is 1 there. In smaltdb any text argument gives NULL.
:::

```sql
SELECT sign('3') AS s;
```

| s |
| --- |
| NULL |

## random {#random}

```
random()
```

A pseudo-random 64-bit signed integer, between -9223372036854775808 and 9223372036854775807, from `crypto.getRandomValues`. Each call returns a new value.

```sql
SELECT typeof(random()) AS t, random() BETWEEN -9223372036854775808 AND 9223372036854775807 AS in_range;
```

| t | in_range |
| --- | --- |
| integer | 1 |

Values outside the JavaScript safe-integer range come back to JavaScript as `bigint` (see [Queries](../../guide/queries)). For a random number in a range, take the remainder:

```sql
SELECT abs(random() % 6) + 1 BETWEEN 1 AND 6 AS die_roll_ok;
```

| die_roll_ok |
| --- |
| 1 |

For random bytes, use [`randomblob`](./scalar#randomblob).
