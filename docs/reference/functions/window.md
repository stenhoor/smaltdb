# Window functions

A window function computes a value for each row from a set of related rows (its *window*), without collapsing the rows the way `GROUP BY` does. smaltdb implements SQLite's window functions with the same results and, except where noted, the same error messages.

| Function | Result |
| --- | --- |
| [`row_number()`](#row_number) | Row number within the partition, from 1 |
| [`rank()`](#rank) | Rank with gaps for ties |
| [`dense_rank()`](#dense_rank) | Rank without gaps |
| [`percent_rank()`](#percent_rank) | `(rank - 1) / (partition rows - 1)` |
| [`cume_dist()`](#cume_dist) | Fraction of partition rows at or before this row's peers |
| [`ntile(N)`](#ntile) | Bucket number 1..N |
| [`lag(X [, OFFSET [, DEFAULT]])`](#lag) | `X` from an earlier row |
| [`lead(X [, OFFSET [, DEFAULT]])`](#lead) | `X` from a later row |
| [`first_value(X)`](#first_value) | `X` from the first row of the frame |
| [`last_value(X)`](#last_value) | `X` from the last row of the frame |
| [`nth_value(X, N)`](#nth_value) | `X` from the N-th row of the frame |
| Any [aggregate function](./aggregate) | The aggregate over the frame |

## Syntax summary

This is a summary; the full grammar, including the `WINDOW` clause, is in [SELECT](../sql/select).

```
function(args) [FILTER (WHERE condition)] OVER window_name
function(args) [FILTER (WHERE condition)] OVER ( [base_window] [PARTITION BY expr, …] [ORDER BY term, …] [frame] )

frame:   {ROWS | RANGE | GROUPS} start
       | {ROWS | RANGE | GROUPS} BETWEEN start AND end
         [EXCLUDE {NO OTHERS | CURRENT ROW | GROUP | TIES}]
start, end:
         UNBOUNDED PRECEDING | N PRECEDING | CURRENT ROW | N FOLLOWING | UNBOUNDED FOLLOWING
```

- **`PARTITION BY`** splits the rows into independent partitions. Without it, all rows form one partition.
- **`ORDER BY`** orders the rows within each partition. Rows with equal `ORDER BY` values are *peers*. `NULLS FIRST` / `NULLS LAST` are accepted.
- **Frame**: the rows an aggregate or `first_value` / `last_value` / `nth_value` sees. The default frame is `RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW` (the current row and all its peers) when there is an `ORDER BY`, and the whole partition when there is not. `ROWS` counts rows, `GROUPS` counts peer groups, and `RANGE` with `N PRECEDING` / `N FOLLOWING` compares the `ORDER BY` value (it requires exactly one `ORDER BY` term). With only a start bound, the end is `CURRENT ROW`.
- **`EXCLUDE`** removes rows from the frame: the current row, its peer group, or its peers but not itself (`TIES`).
- **Named windows**: `WINDOW w AS (…)` in the `SELECT`, then `OVER w`, or `OVER (w ORDER BY …)` to add an `ORDER BY` to a window that has none. A window that has a frame cannot be extended.
- **`FILTER`** works with aggregate functions used as window functions, not with the built-in window functions.
- `DISTINCT` is not allowed in a window function call.
- Window functions are allowed in the select list and `ORDER BY`, not in `WHERE`, `GROUP BY` or `HAVING`. They can take aggregates as arguments, e.g. `rank() OVER (ORDER BY count(*) DESC)`.

The examples use this table:

```sql
CREATE TABLE score(player TEXT, team TEXT, points INT);
INSERT INTO score VALUES
  ('ann', 'red', 10), ('bob', 'red', 20), ('cat', 'red', 20),
  ('dan', 'blue', 5), ('eve', 'blue', 15);
```

## Ranking functions

The ranking functions take no arguments and use the window's `ORDER BY` (without one, every row is a peer of every other).

### row_number {#row_number}

```
row_number() OVER (…)
```

The number of the row within its partition, starting at 1. Peers get different numbers in an unspecified order.

### rank {#rank}

```
rank() OVER (…)
```

The `row_number` of the first peer of the current row: ties share a rank, and a gap follows them.

### dense_rank {#dense_rank}

```
dense_rank() OVER (…)
```

The number of the current row's peer group, starting at 1: ties share a rank, and there are no gaps.

### percent_rank {#percent_rank}

```
percent_rank() OVER (…)
```

`(rank - 1) / (rows in partition - 1)`, a REAL from 0 to 1. A partition of one row gives 0.

### cume_dist {#cume_dist}

```
cume_dist() OVER (…)
```

The number of rows up to and including the current row's last peer, divided by the number of rows in the partition.

### ntile {#ntile}

```
ntile(N) OVER (…)
```

Splits the partition into `N` buckets of nearly equal size and returns the bucket number (1 to `N`) of the current row. When the rows do not divide evenly, the first buckets get one row more. `N` is converted to an integer as in SQLite: a REAL is truncated (`ntile(2.5)` is `ntile(2)`), and text uses its leading digits (`ntile('2')` is `ntile(2)`). If the result is not positive, the query fails with `argument of ntile must be a positive integer`.

```sql
SELECT player, team, points,
       row_number() OVER w AS row_number,
       rank() OVER w AS rank,
       dense_rank() OVER w AS dense_rank,
       percent_rank() OVER w AS percent_rank,
       cume_dist() OVER w AS cume_dist,
       ntile(2) OVER w AS ntile
FROM score
WINDOW w AS (PARTITION BY team ORDER BY points)
ORDER BY team, points, player;
```

| player | team | points | row_number | rank | dense_rank | percent_rank | cume_dist | ntile |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| dan | blue | 5 | 1 | 1 | 1 | 0 | 0.5 | 1 |
| eve | blue | 15 | 2 | 2 | 2 | 1 | 1 | 2 |
| ann | red | 10 | 1 | 1 | 1 | 0 | 0.3333333333333333 | 1 |
| bob | red | 20 | 2 | 2 | 2 | 0.5 | 1 | 1 |
| cat | red | 20 | 3 | 2 | 2 | 0.5 | 1 | 2 |

## Navigation functions

### lag {#lag}

```
lag(X) OVER (…)
lag(X, OFFSET) OVER (…)
lag(X, OFFSET, DEFAULT) OVER (…)
```

`X` evaluated on the row `OFFSET` rows before the current one in the partition (default 1). If there is no such row, the result is `DEFAULT` (default NULL). A negative `OFFSET` looks forward; a NULL `OFFSET` gives NULL. `lag` ignores the frame.

### lead {#lead}

```
lead(X) OVER (…)
lead(X, OFFSET) OVER (…)
lead(X, OFFSET, DEFAULT) OVER (…)
```

Like `lag`, but looks `OFFSET` rows after the current one.

```sql
SELECT player, points,
       lag(points) OVER (ORDER BY points, player) AS prev,
       lead(points, 2) OVER (ORDER BY points, player) AS next2,
       lag(points, 1, 0) OVER (ORDER BY points, player) AS prev_or_0,
       points - lag(points) OVER (ORDER BY points, player) AS gain
FROM score
ORDER BY points, player;
```

| player | points | prev | next2 | prev_or_0 | gain |
| --- | --- | --- | --- | --- | --- |
| dan | 5 | NULL | 15 | 0 | NULL |
| ann | 10 | 5 | 20 | 5 | 5 |
| eve | 15 | 10 | 20 | 10 | 5 |
| bob | 20 | 15 | NULL | 15 | 5 |
| cat | 20 | 20 | NULL | 20 | 0 |

### first_value {#first_value}

```
first_value(X) OVER (…)
```

`X` evaluated on the first row of the frame.

### last_value {#last_value}

```
last_value(X) OVER (…)
```

`X` evaluated on the last row of the frame. With the default frame, that is the last peer of the current row, not the last row of the partition; add `ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING` to get the partition's last row.

### nth_value {#nth_value}

```
nth_value(X, N) OVER (…)
```

`X` evaluated on the `N`-th row of the frame (counting from 1), or NULL if the frame has fewer rows. `N` must be a positive integer, or the query fails with `second argument to nth_value must be a positive integer`.

```sql
SELECT player, points,
       first_value(player) OVER (ORDER BY points, player) AS first,
       last_value(player) OVER (ORDER BY points, player) AS last_so_far,
       last_value(player) OVER (ORDER BY points, player ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS last,
       nth_value(player, 2) OVER (ORDER BY points, player) AS second
FROM score
ORDER BY points, player;
```

| player | points | first | last_so_far | last | second |
| --- | --- | --- | --- | --- | --- |
| dan | 5 | dan | dan | cat | NULL |
| ann | 10 | dan | ann | cat | ann |
| eve | 15 | dan | eve | cat | ann |
| bob | 20 | dan | bob | cat | ann |
| cat | 20 | dan | cat | cat | ann |

## Aggregate functions as window functions {#aggregate-functions-as-window-functions}

Every [aggregate function](./aggregate) (`count`, `sum`, `total`, `avg`, `min`, `max`, `group_concat`, `string_agg`) becomes a window function when it has an `OVER` clause. It then aggregates the rows of the current row's frame, and `FILTER (WHERE …)` restricts which frame rows count. Scalar functions cannot be used with `OVER` (`abs() may not be used as a window function`).

Running totals and moving averages:

```sql
SELECT player, points,
       sum(points) OVER (ORDER BY points, player) AS running,
       avg(points) OVER (ORDER BY points, player ROWS BETWEEN 1 PRECEDING AND 1 FOLLOWING) AS moving_avg,
       sum(points) OVER (PARTITION BY team) AS team_total,
       count(*) FILTER (WHERE points >= 15) OVER () AS high_scorers
FROM score
ORDER BY points, player;
```

| player | points | running | moving_avg | team_total | high_scorers |
| --- | --- | --- | --- | --- | --- |
| dan | 5 | 5 | 7.5 | 20 | 3 |
| ann | 10 | 15 | 10 | 50 | 3 |
| eve | 15 | 30 | 15 | 20 | 3 |
| bob | 20 | 50 | 18.333333333333332 | 50 | 3 |
| cat | 20 | 70 | 20 | 50 | 3 |

Frame units and exclusions. `RANGE 5 PRECEDING` covers rows whose `points` value is within 5 of the current one; `GROUPS` counts peer groups; `EXCLUDE CURRENT ROW` leaves the current row out:

```sql
SELECT player, points,
       count(*) OVER (ORDER BY points RANGE BETWEEN 5 PRECEDING AND CURRENT ROW) AS within_5,
       count(*) OVER (ORDER BY points GROUPS BETWEEN CURRENT ROW AND 1 FOLLOWING) AS this_and_next_group,
       sum(points) OVER (ORDER BY points ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING EXCLUDE CURRENT ROW) AS others
FROM score
ORDER BY points, player;
```

| player | points | within_5 | this_and_next_group | others |
| --- | --- | --- | --- | --- |
| dan | 5 | 1 | 2 | 65 |
| ann | 10 | 2 | 2 | 60 |
| eve | 15 | 2 | 3 | 55 |
| bob | 20 | 3 | 2 | 50 |
| cat | 20 | 3 | 2 | 50 |

## Errors

| Message | Cause |
| --- | --- |
| `misuse of window function f()` | A window function inside `WHERE`, `GROUP BY`, `HAVING`, or inside another window function's arguments (`f` is the inner function, as in SQLite), or a built-in window function such as `row_number()` without `OVER`. |
| `f() may not be used as a window function` | `OVER` on a scalar function. |
| `DISTINCT is not supported for window functions` | `count(DISTINCT x) OVER (…)`. |
| `FILTER clause may only be used with aggregate window functions` | `FILTER` on `rank()` and the other built-in window functions. |
| `no such window: w` | `OVER w` with no `WINDOW w AS (…)`. |
| `unsupported frame specification` | A frame that starts after it ends, e.g. `BETWEEN CURRENT ROW AND 1 PRECEDING`. |
| `RANGE with offset PRECEDING/FOLLOWING requires one ORDER BY expression` | `RANGE N PRECEDING` with zero or several `ORDER BY` terms. |
| `frame starting offset must be a non-negative integer` | `N PRECEDING` / `N FOLLOWING` that is not a non-negative integer in a `ROWS` or `GROUPS` frame (`… non-negative number` for `RANGE`; `frame ending offset …` for the end bound). |
| `cannot override frame specification of window: w` | `OVER (w ORDER BY …)` where `w` has a frame. |

All are `SMALT_ERROR`.

<!-- docs:error SMALT_ERROR -->
```sql
SELECT player FROM score WHERE rank() OVER (ORDER BY points) = 1;
```

To filter on a window function, compute it in a subquery or CTE:

```sql
SELECT player, points FROM (
  SELECT player, points, rank() OVER (PARTITION BY team ORDER BY points DESC) AS r FROM score
) WHERE r = 1 ORDER BY player;
```

| player | points |
| --- | --- |
| bob | 20 |
| cat | 20 |
| eve | 15 |
