# Math functions

Numeric functions: [`abs`](#abs), [`round`](#round), [`sign`](#sign), [`random`](#random), and SQLite's math functions:

| Group | Functions |
| --- | --- |
| Rounding | [`ceil`, `ceiling`, `floor`, `trunc`](#ceil) |
| Powers and roots | [`sqrt`](#sqrt), [`pow`, `power`](#pow), [`exp`](#exp) |
| Logarithms | [`ln`, `log`, `log10`, `log2`](#ln) |
| Remainder | [`mod`](#mod) |
| Angles | [`pi`, `degrees`, `radians`](#pi) |
| Trigonometry | [`sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `atan2`](#sin) |
| Hyperbolic | [`sinh`, `cosh`, `tanh`, `asinh`, `acosh`, `atanh`](#sinh) |

Arithmetic (`+ - * / %`) and the bitwise operators are documented in [Expressions](../sql/expressions); [`min` and `max`](./scalar#min) with several arguments are on the scalar page.

## Arguments and results of the math functions {#math-arguments}

The math functions (all of the table above) follow SQLite, which builds them into its official releases:
- **Arguments** are used when they are numbers: INTEGER, REAL, or text that is a number, with optional spaces around it (`'16'`, `' 2.25 '`). Other text, blobs and NULL give NULL.
- **Results** are REAL, except that [`ceil`, `floor` and `trunc`](#ceil) return an INTEGER argument unchanged.
- **Undefined results are NULL:** the square root of a negative number, the logarithm of zero or a negative number, `acos(2)`, `mod(x, 0)`.
- **Overflow gives infinity**, which is a REAL and turns into the text `Inf` (`-Inf`), as in SQLite.

```sql
SELECT sqrt('16') AS a, sqrt(' 2.25 ') AS b, sqrt('x') AS c, sqrt(x'34') AS d, sqrt(NULL) AS e;
```

| a | b | c | d | e |
| --- | --- | --- | --- | --- |
| 4 | 1.5 | NULL | NULL | NULL |

```sql
SELECT exp(1000) > 1e308 AS a, typeof(exp(1000)) AS b, CAST(exp(1000) AS TEXT) AS c;
```

| a | b | c |
| --- | --- | --- |
| 1 | real | Inf |

**Accuracy.** `sqrt`, `ceil`, `floor`, `trunc`, `mod`, `degrees` and `radians` are exact. The other functions come from JavaScript's `Math` (`tanh` and `log10` from ports of the C library's): in V8 (Chrome, Edge, Node) they are within one unit in the last place of SQLite's results, and most match to the last bit. JavaScript does not fix the last bit, so another browser's engine can differ there; round results you compare or display. See [Differences from SQLite](../../guide/sqlite-differences#math-functions).

**Speed.** On numeric columns, the math functions are compiled into the query like arithmetic, in row and columnar tables and in aggregates, so `sum(sqrt(x))` costs about the same as `sum(x * x)`.

## ceil, ceiling, floor, trunc {#ceil}

```
ceil(X)
ceiling(X)
floor(X)
trunc(X)
```

`X` rounded up (`ceil`, `ceiling`), down (`floor`) or toward zero (`trunc`). An INTEGER is returned unchanged; a REAL gives a REAL. For rounding to a number of decimal places, use [`round`](#round).

```sql
SELECT ceil(2.1) AS a, floor(-2.1) AS b, trunc(-2.7) AS c, ceil(5) AS d, typeof(ceil(5)) AS e, typeof(ceil(2.1)) AS f;
```

| a | b | c | d | e | f |
| --- | --- | --- | --- | --- | --- |
| 3 | -3 | -2 | 5 | integer | real |

## sqrt {#sqrt}

```
sqrt(X)
```

The square root of `X`. NULL for a negative `X`.

```sql
SELECT sqrt(16) AS a, sqrt(2) AS b, sqrt(-1) AS c, typeof(sqrt(16)) AS d;
```

| a | b | c | d |
| --- | --- | --- | --- |
| 4 | 1.4142135623730951 | NULL | real |

## pow, power {#pow}

```
pow(X, Y)
power(X, Y)
```

`X` raised to the power `Y`. NULL when the result is not a real number, such as a negative number to a fractional power.

```sql
SELECT pow(2, 10) AS a, power(9, 0.5) AS b, pow(-8, 1.0 / 3) AS c, pow(2, -2) AS d;
```

| a | b | c | d |
| --- | --- | --- | --- |
| 1024 | 3 | NULL | 0.25 |

## exp {#exp}

```
exp(X)
```

*e* raised to the power `X`.

## ln, log, log10, log2 {#ln}

```
ln(X)
log(X)
log10(X)
log2(X)
log(B, X)
```

The natural logarithm (`ln`), the base-10 logarithm (`log` with one argument, and `log10`), the base-2 logarithm (`log2`), and the logarithm of `X` to base `B`. NULL when `X` is zero or negative, and when `B` is 1 or less.

```sql
SELECT ln(1) AS a, exp(1) AS b, log(100) AS c, log10(1000) AS d, log2(8) AS e, log(2, 1024) AS f, ln(0) AS g;
```

| a | b | c | d | e | f | g |
| --- | --- | --- | --- | --- | --- | --- |
| 0 | 2.718281828459045 | 2 | 3 | 3 | 10 | NULL |

## mod {#mod}

```
mod(X, Y)
```

The remainder of `X` divided by `Y`, with the sign of `X`, as a REAL. Unlike the `%` operator, it keeps the fractional part (`mod(7.5, 2)` is 1.5, `7.5 % 2` is 1). NULL when `Y` is 0.

```sql
SELECT mod(7, 3) AS a, mod(-7, 3) AS b, mod(7.5, 2) AS c, mod(7, 0) AS d, typeof(mod(7, 3)) AS e, 7 % 3 AS f;
```

| a | b | c | d | e | f |
| --- | --- | --- | --- | --- | --- |
| 1 | -1 | 1.5 | NULL | real | 1 |

## pi, degrees, radians {#pi}

```
pi()
degrees(X)
radians(X)
```

π, and `X` converted from radians to degrees (`degrees`) or from degrees to radians (`radians`).

```sql
SELECT pi() AS a, degrees(pi()) AS b, radians(180) AS c;
```

| a | b | c |
| --- | --- | --- |
| 3.141592653589793 | 180 | 3.141592653589793 |

## sin, cos, tan, asin, acos, atan, atan2 {#sin}

```
sin(X)
cos(X)
tan(X)
asin(X)
acos(X)
atan(X)
atan2(Y, X)
```

The trigonometric functions and their inverses, in radians. `atan2(Y, X)` is the angle of the point (`X`, `Y`), from -π to π. `asin` and `acos` are NULL outside -1 to 1.

```sql
SELECT round(sin(pi() / 6), 10) AS a, cos(0) AS b, round(tan(pi() / 4), 10) AS c, degrees(asin(1)) AS d, degrees(atan2(1, 1)) AS e, acos(2) AS f;
```

| a | b | c | d | e | f |
| --- | --- | --- | --- | --- | --- |
| 0.5 | 1 | 1 | 90 | 45 | NULL |

## sinh, cosh, tanh, asinh, acosh, atanh {#sinh}

```
sinh(X)
cosh(X)
tanh(X)
asinh(X)
acosh(X)
atanh(X)
```

The hyperbolic functions and their inverses. `acosh` is NULL below 1, and `atanh` outside -1 to 1.

```sql
SELECT sinh(0) AS a, cosh(0) AS b, round(tanh(1), 6) AS c, asinh(0) AS d, acosh(1) AS e, atanh(2) AS f;
```

| a | b | c | d | e | f |
| --- | --- | --- | --- | --- | --- |
| 0 | 1 | 0.761594 | 0 | 0 | NULL |

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

`-1`, `0` or `1` for a negative, zero or positive number. Text that is a number, with optional spaces around it (`'3'`, `' -2.5 '`, `'1e3'`), counts as that number; other text, blobs and NULL give NULL.

```sql
SELECT sign(-2.5) AS a, sign(0) AS b, sign(42) AS c, sign(NULL) AS d;
```

| a | b | c | d |
| --- | --- | --- | --- |
| -1 | 0 | 1 | NULL |

```sql
SELECT sign('3') AS a, sign(' -2.5 ') AS b, sign('3x') AS c, sign(x'01') AS d;
```

| a | b | c | d |
| --- | --- | --- | --- |
| 1 | -1 | NULL | NULL |

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
