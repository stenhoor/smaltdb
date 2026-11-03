# Functions

Every function smaltdb accepts, in alphabetical order. Names are case-insensitive. The functions follow SQLite's behaviour; each page says where they differ.

| Page | Contents |
| --- | --- |
| [Scalar functions](./scalar) | NULL handling, conditionals, `typeof`, scalar `min`/`max`, blobs, planner hints, last-statement information |
| [String functions](./string) | Length, case, substrings, trimming, concatenation, characters, `hex`, `quote`, `printf` |
| [Math functions](./math) | `abs`, `round`, `sign`, `random`; `sqrt`, `pow`, `exp`, `ln`, `log`, `ceil`, `floor`, `mod`, trigonometric and hyperbolic functions |
| [Date and time functions](./datetime) | `date`, `time`, `datetime`, `julianday`, `unixepoch`, `strftime`, `timediff`, `CURRENT_*`; time values, modifiers and format codes |
| [Aggregate functions](./aggregate) | `count`, `sum`, `total`, `avg`, `min`, `max`, `group_concat`, `string_agg`; statistics: `stddev`, `variance`, `corr`, `median`, `percentile`, …; `DISTINCT` and `FILTER` |
| [Window functions](./window) | Ranking and navigation functions, aggregates over windows, `OVER` syntax |
| [Table-valued functions](./table-valued) | `read_csv`, `read_json`, `read_parquet` (from [plugins](../../guide/plugins)), `pragma_*` |

Operators (`||`, `LIKE`, `GLOB`, arithmetic, comparisons), `CASE` and `CAST` are not functions; see [Expressions](../sql/expressions).

`SELECT * FROM information_schema.routines` lists the scalar and aggregate functions (not the window functions, table-valued functions or `CURRENT_*` keywords); see [information_schema](../sql/information-schema).

## All functions

| Function | Kind | Description |
| --- | --- | --- |
| [`abs(X)`](./math#abs) | scalar | Absolute value |
| [`acos(X)`](./math#sin) | scalar | Arc cosine, in radians |
| [`acosh(X)`](./math#sinh) | scalar | Inverse hyperbolic cosine |
| [`asin(X)`](./math#sin) | scalar | Arc sine, in radians |
| [`asinh(X)`](./math#sinh) | scalar | Inverse hyperbolic sine |
| [`atan(X)`](./math#sin) | scalar | Arc tangent, in radians |
| [`atan2(Y, X)`](./math#sin) | scalar | Angle of the point (`X`, `Y`), in radians |
| [`atanh(X)`](./math#sinh) | scalar | Inverse hyperbolic tangent |
| [`avg(X)`](./aggregate#avg) | aggregate | Average of non-NULL values |
| [`ceil(X)`, `ceiling(X)`](./math#ceil) | scalar | Round up |
| [`changes()`](./scalar#changes) | scalar | Rows changed by the last INSERT, UPDATE or DELETE |
| [`char(X, …)`](./string#char) | scalar | String from Unicode code points |
| [`coalesce(X, Y, …)`](./scalar#coalesce) | scalar | First non-NULL argument |
| [`concat(X, …)`](./string#concat) | scalar | Concatenation, skipping NULLs |
| [`concat_ws(SEP, X, …)`](./string#concat_ws) | scalar | Concatenation with a separator, skipping NULLs |
| [`corr(Y, X)`](./aggregate#covariance) | aggregate | Correlation coefficient |
| [`cos(X)`](./math#sin) | scalar | Cosine |
| [`cosh(X)`](./math#sinh) | scalar | Hyperbolic cosine |
| [`count(*)`, `count(X)`](./aggregate#count) | aggregate | Number of rows, or of non-NULL values |
| [`covar_pop(Y, X)`](./aggregate#covariance) | aggregate | Population covariance |
| [`covar_samp(Y, X)`](./aggregate#covariance) | aggregate | Sample covariance |
| [`cume_dist()`](./window#cume_dist) | window | Cumulative distribution within the partition |
| [`CURRENT_DATE`](./datetime#current_date) | keyword | Current UTC date, `YYYY-MM-DD` |
| [`CURRENT_TIME`](./datetime#current_date) | keyword | Current UTC time, `HH:MM:SS` |
| [`CURRENT_TIMESTAMP`](./datetime#current_date) | keyword | Current UTC date and time, `YYYY-MM-DD HH:MM:SS` |
| [`date(TIME, MOD, …)`](./datetime#date) | scalar | Date as `YYYY-MM-DD` |
| [`datetime(TIME, MOD, …)`](./datetime#datetime) | scalar | Date and time as `YYYY-MM-DD HH:MM:SS` |
| [`degrees(X)`](./math#pi) | scalar | Radians to degrees |
| [`dense_rank()`](./window#dense_rank) | window | Rank without gaps |
| [`exp(X)`](./math#exp) | scalar | *e* to the power `X` |
| [`first_value(X)`](./window#first_value) | window | Value from the first row of the frame |
| [`floor(X)`](./math#ceil) | scalar | Round down |
| [`format(FORMAT, …)`](./string#printf) | scalar | Same as `printf` |
| [`group_concat(X [, SEP])`](./aggregate#group_concat) | aggregate | Values joined into text |
| [`hex(X)`](./string#hex) | scalar | Upper-case hexadecimal of the bytes |
| [`ifnull(X, Y)`](./scalar#ifnull) | scalar | `X` if not NULL, else `Y` |
| [`if(COND, X, …)`](./scalar#iif) | scalar | Same as `iif` |
| [`iif(COND, X, Y)`](./scalar#iif) | scalar | `X` if `COND` is true, else `Y` |
| [`instr(X, Y)`](./string#instr) | scalar | Position of `Y` in `X` |
| [`julianday(TIME, MOD, …)`](./datetime#julianday) | scalar | Julian day number |
| [`kurtosis(X)`](./aggregate#skewness) | aggregate | Sample excess kurtosis |
| [`kurtosis_pop(X)`](./aggregate#skewness) | aggregate | Population excess kurtosis |
| [`lag(X [, N [, DEFAULT]])`](./window#lag) | window | Value from an earlier row |
| [`last_insert_rowid()`](./scalar#last_insert_rowid) | scalar | Rowid of the last inserted row |
| [`last_value(X)`](./window#last_value) | window | Value from the last row of the frame |
| [`lead(X [, N [, DEFAULT]])`](./window#lead) | window | Value from a later row |
| [`length(X)`](./string#length) | scalar | Characters in text, bytes in a blob |
| [`likelihood(X, P)`](./scalar#likelihood) | scalar | Returns `X` (planner hint, ignored) |
| [`likely(X)`](./scalar#likely) | scalar | Returns `X` (planner hint, ignored) |
| [`ln(X)`](./math#ln) | scalar | Natural logarithm |
| [`log(X)`, `log(B, X)`](./math#ln) | scalar | Base-10 logarithm, or to base `B` |
| [`log10(X)`](./math#ln) | scalar | Base-10 logarithm |
| [`log2(X)`](./math#ln) | scalar | Base-2 logarithm |
| [`lower(X)`](./string#lower) | scalar | ASCII lower case |
| [`ltrim(X [, CHARS])`](./string#ltrim) | scalar | Remove characters from the start |
| [`max(X)`](./aggregate#max) | aggregate | Largest value |
| [`max(X, Y, …)`](./scalar#max) | scalar | Largest argument |
| [`median(X)`](./aggregate#median) | aggregate | Median |
| [`min(X)`](./aggregate#min) | aggregate | Smallest value |
| [`min(X, Y, …)`](./scalar#min) | scalar | Smallest argument |
| [`mod(X, Y)`](./math#mod) | scalar | Remainder of `X / Y`, as a REAL |
| [`nth_value(X, N)`](./window#nth_value) | window | Value from the N-th row of the frame |
| [`ntile(N)`](./window#ntile) | window | Bucket number 1..N |
| [`nullif(X, Y)`](./scalar#nullif) | scalar | NULL if `X = Y`, else `X` |
| [`octet_length(X)`](./string#octet_length) | scalar | Bytes in the UTF-8 encoding |
| [`percent_rank()`](./window#percent_rank) | window | Relative rank, 0 to 1 |
| [`percentile(X, P)`](./aggregate#median) | aggregate | `P`th percentile (0–100), interpolated |
| [`percentile_cont(X, F)`](./aggregate#median) | aggregate | Percentile at fraction `F`, interpolated |
| [`percentile_disc(X, F)`](./aggregate#median) | aggregate | Percentile at fraction `F`, one of the values |
| [`pi()`](./math#pi) | scalar | π |
| [`pow(X, Y)`, `power(X, Y)`](./math#pow) | scalar | `X` to the power `Y` |
| [`pragma_foreign_key_list(TABLE)`](./table-valued#pragma_foreign_key_list) | table-valued | Foreign keys of a table |
| [`pragma_index_info(INDEX)`](./table-valued#pragma_index_info) | table-valued | Key columns of an index |
| [`pragma_index_list(TABLE)`](./table-valued#pragma_index_list) | table-valued | Indexes of a table |
| [`pragma_index_xinfo(INDEX)`](./table-valued#pragma_index_xinfo) | table-valued | All columns of an index |
| [`pragma_table_info(TABLE)`](./table-valued#pragma_table_info) | table-valued | Columns of a table |
| [`pragma_table_xinfo(TABLE)`](./table-valued#pragma_table_xinfo) | table-valued | `pragma_table_info` plus `hidden` |
| [`printf(FORMAT, …)`](./string#printf) | scalar | C-style formatted text |
| [`quote(X)`](./string#quote) | scalar | Value as an SQL literal |
| [`radians(X)`](./math#pi) | scalar | Degrees to radians |
| [`random()`](./math#random) | scalar | Random 64-bit integer |
| [`randomblob(N)`](./scalar#randomblob) | scalar | `N` random bytes |
| [`rank()`](./window#rank) | window | Rank with gaps |
| [`read_csv(LOCATION, …)`](./table-valued#read_csv) | table-valued | Rows of a CSV or TSV file (`@smaltdb/io` plugin) |
| [`read_json(LOCATION, …)`](./table-valued#read_json) | table-valued | Rows of a JSON or NDJSON file (`@smaltdb/io` plugin) |
| [`read_parquet(LOCATION, …)`](./table-valued#read_parquet) | table-valued | Rows of a Parquet file (`@smaltdb/parquet` plugin) |
| [`replace(X, Y, Z)`](./string#replace) | scalar | Replace every `Y` in `X` with `Z` |
| [`round(X [, DIGITS])`](./math#round) | scalar | Round to `DIGITS` decimal places |
| [`row_number()`](./window#row_number) | window | Row number within the partition |
| [`rtrim(X [, CHARS])`](./string#rtrim) | scalar | Remove characters from the end |
| [`sign(X)`](./math#sign) | scalar | -1, 0 or 1 |
| [`sin(X)`](./math#sin) | scalar | Sine |
| [`sinh(X)`](./math#sinh) | scalar | Hyperbolic sine |
| [`skewness(X)`](./aggregate#skewness) | aggregate | Sample skewness |
| [`skewness_pop(X)`](./aggregate#skewness) | aggregate | Population skewness |
| [`smaltdb_version()`](./scalar#smaltdb_version) | scalar | The smaltdb package version |
| [`sqrt(X)`](./math#sqrt) | scalar | Square root |
| [`stddev(X)`, `stddev_samp(X)`](./aggregate#variance) | aggregate | Sample standard deviation |
| [`stddev_pop(X)`](./aggregate#variance) | aggregate | Population standard deviation |
| [`strftime(FORMAT, TIME, MOD, …)`](./datetime#strftime) | scalar | Formatted date and time |
| [`string_agg(X, SEP)`](./aggregate#string_agg) | aggregate | Same as `group_concat(X, SEP)` |
| [`substr(X, START [, LENGTH])`](./string#substr) | scalar | Part of a string or blob |
| [`substring(X, START [, LENGTH])`](./string#substr) | scalar | Same as `substr` |
| [`sum(X)`](./aggregate#sum) | aggregate | Sum; NULL when there are no values |
| [`tan(X)`](./math#sin) | scalar | Tangent |
| [`tanh(X)`](./math#sinh) | scalar | Hyperbolic tangent |
| [`time(TIME, MOD, …)`](./datetime#time) | scalar | Time as `HH:MM:SS` |
| [`timediff(A, B)`](./datetime#timediff) | scalar | Difference between two times |
| [`total(X)`](./aggregate#total) | aggregate | Sum; 0 when there are no values |
| [`total_changes()`](./scalar#total_changes) | scalar | Rows changed since the connection opened |
| [`trim(X [, CHARS])`](./string#trim) | scalar | Remove characters from both ends |
| [`trunc(X)`](./math#ceil) | scalar | Round toward zero |
| [`typeof(X)`](./scalar#typeof) | scalar | Storage class: `null`, `integer`, `real`, `text`, `blob` |
| [`unicode(X)`](./string#unicode) | scalar | Code point of the first character |
| [`unixepoch(TIME, MOD, …)`](./datetime#unixepoch) | scalar | Seconds since 1970-01-01 |
| [`unlikely(X)`](./scalar#unlikely) | scalar | Returns `X` (planner hint, ignored) |
| [`upper(X)`](./string#upper) | scalar | ASCII upper case |
| [`var_pop(X)`](./aggregate#variance) | aggregate | Population variance |
| [`var_samp(X)`, `variance(X)`](./aggregate#variance) | aggregate | Sample variance |
| [`zeroblob(N)`](./scalar#zeroblob) | scalar | `N` zero bytes |

Every aggregate function can also be used as a window function with `OVER`; see [Window functions](./window#aggregate-functions-as-window-functions).

## Not available {#not-available}

These SQLite functions are **not** implemented. Each fails with `SMALT_ERROR` `no such function: name` (or `no such table-valued function` in `FROM`) when the statement is prepared.

| Group | Functions |
| --- | --- |
| JSON | `json`, `jsonb`, `json_array`, `json_array_length`, `json_extract`, `json_insert`, `json_object`, `json_patch`, `json_quote`, `json_remove`, `json_replace`, `json_set`, `json_type`, `json_valid`, `json_group_array`, `json_group_object`, and the table-valued `json_each` and `json_tree`. The `->` and `->>` operators fail with `SMALT_UNSUPPORTED`. |
| Text | `unhex`, `unistr`, `unistr_quote`, and the function forms `like(…)` and `glob(…)` (the `LIKE` and `GLOB` operators work). `REGEXP` has no implementation. |
| SQLite-specific | `sqlite_version`, `sqlite_source_id`, `sqlite_compileoption_get`, `sqlite_compileoption_used`, `sqlite_offset`, `load_extension`, `subtype` |
| Table-valued | `generate_series` (use a recursive CTE; see [SELECT](../sql/select)) |

<!-- docs:error SMALT_ERROR -->
```sql
SELECT json_extract('{"a": 1}', '$.a');
```

<!-- docs:error SMALT_UNSUPPORTED -->
```sql
SELECT '{"a": 1}' ->> '$.a';
```

There are no user-defined functions: functions cannot be added from JavaScript.

A sequence of numbers without `generate_series`:

```sql
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 5)
SELECT group_concat(i) AS numbers FROM n;
```

| numbers |
| --- |
| 1,2,3,4,5 |
