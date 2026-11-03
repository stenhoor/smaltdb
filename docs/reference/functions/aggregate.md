# Aggregate functions

An aggregate function computes one value from many rows: from each group of a `GROUP BY` query, or from all rows when there is no `GROUP BY`. Every aggregate function can also be used as a [window function](./window#aggregate-functions-as-window-functions) with an `OVER` clause.

| Function | Result |
| --- | --- |
| [`count(*)`, `count(X)`](#count) | Number of rows, or of non-NULL values |
| [`sum(X)`](#sum) | Sum; NULL for no values |
| [`total(X)`](#total) | Sum as REAL; 0 for no values |
| [`avg(X)`](#avg) | Average |
| [`min(X)`](#min), [`max(X)`](#max) | Smallest or largest value |
| [`group_concat(X [, SEP])`](#group_concat) | Values joined into text |
| [`string_agg(X, SEP)`](#string_agg) | Same as `group_concat(X, SEP)` |
| [`var_samp(X)`, `variance(X)`, `var_pop(X)`](#variance) | Sample or population variance |
| [`stddev_samp(X)`, `stddev(X)`, `stddev_pop(X)`](#variance) | Sample or population standard deviation |
| [`covar_samp(Y, X)`, `covar_pop(Y, X)`](#covariance) | Sample or population covariance |
| [`corr(Y, X)`](#covariance) | Correlation coefficient |
| [`skewness(X)`, `skewness_pop(X)`](#skewness) | Skewness |
| [`kurtosis(X)`, `kurtosis_pop(X)`](#skewness) | Excess kurtosis |
| [`median(X)`](#median) | Median |
| [`percentile(X, P)`, `percentile_cont(X, F)`, `percentile_disc(X, F)`](#median) | Percentile, interpolated or an actual value |

The examples on this page use this table:

```sql
CREATE TABLE sale(region TEXT, product TEXT, qty INT, price REAL);
INSERT INTO sale VALUES
  ('north', 'apple',  3, 0.5),
  ('north', 'pear',   2, 0.75),
  ('north', 'apple',  1, 0.5),
  ('south', 'apple',  4, 0.5),
  ('south', 'plum',   NULL, 1.25);
```

## Syntax

```
name(*)                                -- count only
name([DISTINCT] X [, Y]) [FILTER (WHERE condition)]
```

- **NULL**: every aggregate except `count(*)` ignores rows where `X` is NULL.
- **Empty input**: with no rows (or only NULLs), `count` returns 0, `total` returns 0, and the others return NULL.
- **`DISTINCT`**: removes duplicate values of `X` before aggregating. It is only allowed with exactly one argument, so `group_concat(DISTINCT X)` works but `group_concat(DISTINCT X, ';')` and `string_agg(DISTINCT X, ';')` fail with `DISTINCT aggregates must have exactly one argument`, as in SQLite.
- **`FILTER (WHERE …)`**: only rows for which the condition is true are fed to the aggregate. `FILTER` is only valid with aggregate functions.
- **`ORDER BY` inside the call** (`group_concat(x, ',' ORDER BY y)`, SQLite 3.44+) is **not supported**: it fails with `SMALT_UNSUPPORTED`. To control the order of `group_concat`, aggregate over an ordered subquery (see [group_concat](#group_concat)).
- An aggregate cannot be used in `WHERE`; filter groups with `HAVING`. See [SELECT](../sql/select).

```sql
SELECT count(*) AS rows, count(qty) AS with_qty, count(DISTINCT product) AS products,
       sum(qty) FILTER (WHERE product = 'apple') AS apples
FROM sale;
```

| rows | with_qty | products | apples |
| --- | --- | --- | --- |
| 5 | 4 | 3 | 8 |

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
SELECT group_concat(product, ',' ORDER BY product) FROM sale;
```

<!-- docs:error SMALT_ERROR -->
```sql
SELECT string_agg(DISTINCT product, ';') FROM sale;
```

### Bare columns with min and max

As in SQLite, when a query has exactly one `min()` or `max()` aggregate, other columns that are not aggregated or grouped take their values from the row that holds the minimum or maximum:

```sql
SELECT product, max(qty) AS most FROM sale;
```

| product | most |
| --- | --- |
| apple | 4 |

## count {#count}

```
count(*)
count(X)
count(DISTINCT X)
```

`count(*)` is the number of rows. `count(X)` is the number of rows where `X` is not NULL. `count(DISTINCT X)` is the number of distinct non-NULL values. The result is an integer, and 0 for no rows.

```sql
SELECT region, count(*) AS n, count(qty) AS with_qty FROM sale GROUP BY region ORDER BY region;
```

| region | n | with_qty |
| --- | --- | --- |
| north | 3 | 3 |
| south | 2 | 1 |

## sum {#sum}

```
sum(X)
sum(DISTINCT X)
```

The sum of the non-NULL values of `X`, or NULL when there are none. If every value is an integer, the sum is an exact 64-bit integer and fails with `integer overflow` if it does not fit. If any value is a REAL, the result is a REAL, computed with compensated (Kahan–Babuška–Neumaier) summation as in SQLite 3.43 and later. Text and blobs are converted to numbers (non-numeric text counts as 0).

```sql
SELECT sum(qty) AS units, sum(qty * price) AS revenue, sum(0.1) AS tenths FROM sale;
```

| units | revenue | tenths |
| --- | --- | --- |
| 10 | 5.5 | 0.5 |

```sql
SELECT sum(qty) AS none FROM sale WHERE region = 'east';
```

| none |
| --- |
| NULL |

<!-- docs:error SMALT_ERROR -->
```sql
SELECT sum(x) FROM (SELECT 9223372036854775807 AS x UNION ALL SELECT 1);
```

## total {#total}

```
total(X)
total(DISTINCT X)
```

Like `sum`, but returns 0 instead of NULL when there are no values, and never fails on integer overflow (it switches to REAL arithmetic instead).

```sql
SELECT total(qty) AS none FROM sale WHERE region = 'east';
```

| none |
| --- |
| 0 |

```sql
SELECT total(x) AS t FROM (SELECT 9223372036854775807 AS x UNION ALL SELECT 1);
```

| t |
| --- |
| 9223372036854776000 |

::: warning Differs from SQLite
SQLite's `total()` always returns a REAL. In smaltdb a whole-number result, such as `total(qty)` = 10 over integers, can come back as an INTEGER (`typeof` gives `'integer'`, and JavaScript receives `10` either way). The same applies to `sum` and `avg` over REAL values that add up to a whole number. See [Types](../sql/types).
:::

## avg {#avg}

```
avg(X)
avg(DISTINCT X)
```

The average of the non-NULL values of `X`, or NULL when there are none. The result is a REAL (but see the note under [total](#total)). Text and blobs are converted to numbers.

```sql
SELECT region, avg(qty) AS avg_qty FROM sale GROUP BY region ORDER BY region;
```

| region | avg_qty |
| --- | --- |
| north | 2 |
| south | 4 |

```sql
SELECT avg(x) AS a, avg(DISTINCT x) AS d FROM (SELECT 1 AS x UNION ALL SELECT 1 UNION ALL SELECT 4);
```

| a | d |
| --- | --- |
| 2 | 2.5 |

## min {#min}

```
min(X)
```

The smallest non-NULL value of `X`, or NULL when there are none. Values of different types are ordered as in SQLite: numbers, then text, then blobs. Text is compared with the collation of `X` (its column's collation, or one given with `COLLATE`). With two or more arguments `min` is the [scalar function](./scalar#min).

## max {#max}

```
max(X)
```

The largest non-NULL value of `X`, or NULL when there are none. Ordering and collation work as for `min`.

```sql
SELECT min(product) AS first, max(product) AS last, min(qty) AS least, max(price) AS dearest FROM sale;
```

| first | last | least | dearest |
| --- | --- | --- | --- |
| apple | plum | 1 | 1.25 |

```sql
SELECT max(x) AS binary, max(x COLLATE NOCASE) AS nocase FROM (SELECT 'b' AS x UNION ALL SELECT 'B' UNION ALL SELECT 'a');
```

| binary | nocase |
| --- | --- |
| b | b |

## group_concat {#group_concat}

```
group_concat(X)
group_concat(X, SEP)
group_concat(DISTINCT X)
```

The non-NULL values of `X`, converted to text and joined. The separator is `,` (a comma with no space) when `SEP` is omitted. `SEP` is evaluated for each row: the separator placed before a value is the `SEP` of that value's row, and a NULL `SEP` joins with nothing. The result is NULL when there are no non-NULL values.

The order of the values is the order in which rows reach the aggregate, which is not guaranteed. To fix the order, aggregate over a subquery with `ORDER BY`:

```sql
SELECT group_concat(product) AS a, group_concat(product, ' | ') AS b, group_concat(DISTINCT product) AS c
FROM (SELECT product FROM sale ORDER BY product);
```

| a | b | c |
| --- | --- | --- |
| apple,apple,apple,pear,plum | apple \| apple \| apple \| pear \| plum | apple,pear,plum |

```sql
SELECT region, group_concat(qty, '+') AS parts FROM (SELECT * FROM sale ORDER BY region, qty) GROUP BY region ORDER BY region;
```

| region | parts |
| --- | --- |
| north | 1+2+3 |
| south | 4 |

## string_agg {#string_agg}

```
string_agg(X, SEP)
```

The same as `group_concat(X, SEP)`, with the separator required (the SQL-standard and PostgreSQL name). `string_agg(X)` with one argument fails with `wrong number of arguments`, and `DISTINCT` is not allowed because the function always has two arguments.

```sql
SELECT string_agg(region, '; ') AS regions FROM (SELECT DISTINCT region FROM sale ORDER BY region);
```

| regions |
| --- |
| north; south |

## Statistics {#statistics}

The statistical aggregates skip NULLs, convert text and blobs to numbers like [`sum`](#sum) and [`avg`](#avg) do, and return a REAL, or NULL when the statistic is undefined (too few values, or no spread for `corr`, `skewness` and `kurtosis`). They are computed in one pass with numerically stable updates, so data with a large common offset, such as timestamps or prices in cents, keeps its precision. They work with `DISTINCT`, `FILTER` and as [window functions](./window#aggregate-functions-as-window-functions); over a sliding frame (`ROWS 20 PRECEDING`), the variance, standard deviation, median and percentiles update as rows enter and leave the frame instead of recomputing it.

The names are PostgreSQL's (`var_samp`, `stddev_samp`, `covar_samp`, `corr`), with `variance` and `stddev` for the sample statistics. `skewness` and `kurtosis` are DuckDB's. `median` and the `percentile` functions are SQLite's.

### var_samp, variance, var_pop, stddev_samp, stddev, stddev_pop {#variance}

```
var_samp(X)       variance(X)
var_pop(X)
stddev_samp(X)    stddev(X)
stddev_pop(X)
```

The sample variance (divided by n − 1; NULL for fewer than two values) and the population variance (divided by n), and their square roots.

```sql
SELECT var_samp(qty) AS var_samp, var_pop(qty) AS var_pop, stddev_samp(qty) AS stddev_samp, stddev_pop(qty) AS stddev_pop FROM sale;
```

| var_samp | var_pop | stddev_samp | stddev_pop |
| --- | --- | --- | --- |
| 1.6666666666666667 | 1.25 | 1.2909944487358056 | 1.118033988749895 |

```sql
SELECT var_samp(qty) AS one_row FROM sale WHERE region = 'south';
```

| one_row |
| --- |
| NULL |

### covar_samp, covar_pop, corr {#covariance}

```
covar_samp(Y, X)
covar_pop(Y, X)
corr(Y, X)
```

The sample and population covariance of the pairs, and Pearson's correlation coefficient, from -1 to 1. Rows where `Y` or `X` is NULL are skipped. `corr` is NULL when either has no spread.

```sql
SELECT round(covar_samp(qty, price), 6) AS covar_samp, round(covar_pop(qty, price), 6) AS covar_pop, round(corr(qty, price), 6) AS corr FROM sale;
```

| covar_samp | covar_pop | corr |
| --- | --- | --- |
| -0.041667 | -0.03125 | -0.258199 |

### skewness, skewness_pop, kurtosis, kurtosis_pop {#skewness}

```
skewness(X)
skewness_pop(X)
kurtosis(X)
kurtosis_pop(X)
```

The asymmetry (skewness) and tailedness (excess kurtosis: 0 for a normal distribution) of the values. `skewness` and `kurtosis` are the sample statistics with bias correction, as in DuckDB and Excel (`SKEW`, `KURT`); they need three and four values. `skewness_pop` and `kurtosis_pop` are the population statistics, as pandas and Polars compute with `bias=True`. All are NULL when the values have no spread.

```sql
WITH v(x) AS (VALUES (2), (4), (4), (4), (5), (5), (7), (9))
SELECT round(skewness(x), 6) AS skewness, round(skewness_pop(x), 6) AS skewness_pop, round(kurtosis(x), 6) AS kurtosis, round(kurtosis_pop(x), 6) AS kurtosis_pop FROM v;
```

| skewness | skewness_pop | kurtosis | kurtosis_pop |
| --- | --- | --- | --- |
| 0.818488 | 0.65625 | 0.940625 | -0.21875 |

### median, percentile, percentile_cont, percentile_disc {#median}

```
median(X)
percentile(X, P)
percentile_cont(X, F)
percentile_disc(X, F)
```

As in SQLite: `median(X)` is `percentile_cont(X, 0.5)`. `percentile` takes `P` from 0 to 100 and `percentile_cont` takes `F` from 0 to 1; both interpolate between the two nearest values. `percentile_disc` returns one of the values: the one at position `F` × (n − 1), rounded down, in sorted order. The result is a REAL.

```sql
SELECT median(qty) AS median, percentile(qty, 25) AS p25, percentile_cont(qty, 0.25) AS cont, percentile_disc(qty, 0.25) AS disc FROM sale;
```

| median | p25 | cont | disc |
| --- | --- | --- | --- |
| 2.5 | 1.75 | 1.75 | 1 |

```sql
SELECT region, median(qty) AS median FROM sale GROUP BY region ORDER BY region;
```

| region | median |
| --- | --- |
| north | 2 |
| south | 4 |

They are stricter than the other aggregates, as in SQLite:
- a value that is not a number (text, a blob) is an error, not converted; so is an infinite value;
- `P` (or `F`) must be in range and the same on every row.

<!-- docs:error SMALT_ERROR -->
```sql
SELECT median(product) FROM sale;
```

<!-- docs:error SMALT_ERROR -->
```sql
SELECT percentile(qty, 150) FROM sale;
```

### Moving statistics {#moving-statistics}

With a window frame, the statistics move along the rows, as rolling functions do in dataframe libraries:

```sql
WITH w(x) AS (VALUES (1), (2), (4), (7), (11))
SELECT x, round(var_samp(x) OVER (ORDER BY x ROWS 2 PRECEDING), 4) AS moving_var, median(x) OVER (ORDER BY x ROWS 2 PRECEDING) AS moving_median FROM w ORDER BY x;
```

| x | moving_var | moving_median |
| --- | --- | --- |
| 1 | NULL | 1 |
| 2 | 0.5 | 1.5 |
| 4 | 2.3333 | 2 |
| 7 | 6.3333 | 4 |
| 11 | 12.3333 | 7 |

## Not available

`json_group_array` and `json_group_object` are not implemented and fail with `no such function`.
