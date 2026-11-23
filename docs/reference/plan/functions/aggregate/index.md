---
description: 'Functions over a group of rows: counts, sums, extremes, first and last, lists and text, percentiles and statistics.'
---

# Aggregate functions

```railroad
agg-call
```

An aggregate function gives one value for a group of rows. A plan calls one in an
[`aggregate`](../../operations/aggregate)'s `aggs` (one value for each group), in a [`pivot`](../../operations/pivot)'s
`aggs`, in a [`window`](../../operations/window)'s `calls` (over each row's frame), and in an
[`each`](../../expressions/each) of mode `agg` (over the elements of a list). A call names the function (`fn`), gives
its arguments (`args`, expressions over the input row) and the `type` of its result.

- **`star`.** SQL's `count(*)` is `count` with `"args": [], "star": true`: it counts every row. Every other call sets
  `"star": false`.
- **`distinct`.** The call takes each different value of its first argument once, and skips rows where it is NULL.
  Values compare by the collation the first argument carries. A function of two arguments keeps, for each value of the
  first, the row where it came first. `min`, `max` and `min_list` give the same result either way.
- **`filter`.** The call takes only the rows for which the expression is true: false and NULL leave the row out. Each
  call has its own filter.
- **NULL.** Aggregates skip NULL values, except `count` with `star`, which counts every row, `implode`, which keeps them
  in its list, `min_list`, and `first` and `last`, which give a row's value whatever it is (they skip rows whose keys
  are NULL).
- **An empty group.** A group with no values gives NULL, except `count` (0), `total` (0) and `implode` (`[]`). An
  `aggregate` with keys gives no group for no rows; one with no keys gives one row, over no rows too.
- **Order.** `first`, `last`, `group_concat`, `string_agg` and `implode` depend on the order of the group's rows: the
  order of the aggregate's input. The others give the same result in any order (`sum` and `avg` of reals up to
  rounding).
- **Collations.** Text compares (in `min`, `max`, `first`, `last` and `distinct`) by the collation the first argument
  carries ([meaning fields](../../meaning-fields)), `binary` when it carries none. The call's `collation` field doesn't
  change the result.
- **Numbers.** `sum`, `total`, `avg`, the `_float` forms and the variance and covariance statistics take text and blobs
  as the number they start with, as SQLite does. The percentile functions take only numbers and fail on anything else.
- **Errors.** A name that is no aggregate, a wrong number of arguments, or `count` with no argument and no `star` is
  refused when the plan is compiled (`SMALT_PLAN`). Errors while it runs (an integer `sum` that overflows, a percentile
  of text) are `SMALT_ERROR`.

## Examples

Counting every order, the different fruit ordered, and the pieces of fruit 1 only:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "scan",
      "table": "orders",
      "columns": [0, 1, 2, 3]
    },
    "keys": [],
    "aggs": [
      {"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"},
      {"fn": "count", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": true, "collation": "binary", "type": "int"},
      {"fn": "sum", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "filter": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "bool"}, "collation": "binary", "type": "int"}
    ],
    "carry": []
  },
  "columns": [{"name": "orders"}, {"name": "fruit"}, {"name": "pieces of 1"}]
}
```

| orders | fruit | pieces of 1 |
|---|---|---|
| 6 | 4 | 6 |

Over no rows, an aggregate with no keys still gives one row:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "filter",
      "input": {
        "op": "scan",
        "table": "orders",
        "columns": [0, 1, 2, 3]
      },
      "pred": {"k": "lit", "value": 0, "type": "bool"}
    },
    "keys": [],
    "aggs": [
      {"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"},
      {"fn": "sum", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "int"},
      {"fn": "total", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "implode", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "list<int>"},
      {"fn": "max", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "int"}
    ],
    "carry": []
  },
  "columns": [{"name": "count"}, {"name": "sum"}, {"name": "total"}, {"name": "implode"}, {"name": "max"}]
}
```

| count | sum | total | implode | max |
|---|---|---|---|---|
| 0 | NULL | 0 | [] | NULL |

In a `window`, an aggregate is computed over each row's frame: here a running total, in order of id:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "window",
      "input": {
        "op": "scan",
        "table": "orders",
        "columns": [0, 1, 2, 3]
      },
      "partition": [],
      "order": [
        {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
      ],
      "frame": {"unit": "ROWS", "start": {"kind": "unboundedPreceding"}, "end": {"kind": "currentRow"}, "exclude": "NO OTHERS"},
      "calls": [
        {"fn": "sum", "args": [
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
        ], "star": false, "type": "int", "collation": "binary"}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "fruit"}, {"name": "n"}, {"name": "day"}, {"name": "running"}]
}
```

| id | fruit | n | day | running |
|---|---|---|---|---|
| 1 | 1 | 3 | 2026-11-02 | 3 |
| 2 | 2 | 1 | 2026-11-02 | 4 |
| 3 | 1 | 2 | 2026-11-03 | 6 |
| 4 | 4 | 10 | 2026-11-04 | 16 |
| 5 | 3 | 5 | 2026-11-05 | 21 |
| 6 | 1 | 1 | 2026-11-05 | 22 |

In an `each` of mode `agg`, over the elements of a list: the `body` reads the results with
[`eachAgg`](../../expressions/eachAgg). A NULL list gives NULL:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "scan",
      "table": "baskets",
      "columns": [1, 3]
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "each", "list": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "list<int>", "collation": "binary"}, "mode": "agg", "body": {"k": "eachAgg", "index": 0, "depth": 0, "type": "int"}, "aggs": [
        {"fn": "sum", "args": [
          {"k": "element", "part": "value", "depth": 0, "type": "int"}
        ], "star": false, "distinct": false, "collation": "binary", "type": "int"}
      ], "type": "int"},
      {"k": "each", "list": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "list<int>", "collation": "binary"}, "mode": "agg", "body": {"k": "eachAgg", "index": 0, "depth": 0, "type": "int"}, "aggs": [
        {"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "items"}, {"name": "kinds"}]
}
```

| owner | items | kinds |
|---|---|---|
| Ada | 3 | 2 |
| Alan | 6 | 1 |
| Grace | NULL | 0 |
| Edsger | NULL | NULL |

## Functions {#functions}

- [`count`](./count): The number of rows in a group, or of its rows where a value is not NULL.
- [`sum`](./sum): The sum of a group's values: an integer while every value is one, NULL for no values.
- [`total`](./total): The sum of a group's values as a real: 0 for no values.
- [`avg`](./avg): The mean of a group's values, as a real: NULL for no values.
- [`sum_float`](./sum_float): The sum of a group's values, as `sum` gives it, except that a NaN sum stays NaN.
- [`avg_float`](./avg_float): The mean of a group's values, as `avg` gives it, except that a NaN mean stays NaN.
- [`min`](./min): The least of a group's values that are not NULL.
- [`max`](./max): The greatest of a group's values that are not NULL.
- [`first`](./first): The value of a group's first row: in input order, or at the smallest key.
- [`last`](./last): The value of a group's last row: in input order, or at the largest key.
- [`group_concat`](./group_concat): A group's values as text, joined by a separator: a comma unless another is given.
- [`string_agg`](./string_agg): A group's values as text, joined by a separator.
- [`implode`](./implode): A group's values as a list, in the group's order, NULLs included.
- [`min_list`](./min_list): The least of the lists a group's rows make of its arguments.
- [`median`](./median): The middle of a group's numbers, halfway between the two middle ones when their count is even.
- [`percentile`](./percentile): The value at a percentage of the way through a group's sorted numbers, interpolated between two.
- [`percentile_cont`](./percentile_cont): The value at a fraction of the way through a group's sorted numbers, interpolated between two.
- [`percentile_disc`](./percentile_disc): The value at a fraction of the way through a group's sorted numbers: always one of them.
- [`var_samp`, `variance`](./var_samp): The sample variance of a group's numbers: squared deviations from the mean over `n − 1`.
- [`var_pop`](./var_pop): The population variance of a group's numbers: squared deviations from the mean over `n`.
- [`stddev_samp`, `stddev`](./stddev_samp): The sample standard deviation of a group's numbers: the square root of `var_samp`.
- [`stddev_pop`](./stddev_pop): The population standard deviation of a group's numbers: the square root of `var_pop`.
- [`skewness`](./skewness): The sample skewness of a group's numbers, with the bias correction for a sample.
- [`skewness_pop`](./skewness_pop): The population skewness of a group's numbers, without a bias correction.
- [`kurtosis`](./kurtosis): The sample excess kurtosis of a group's numbers, with the bias correction for a sample.
- [`kurtosis_pop`](./kurtosis_pop): The population excess kurtosis of a group's numbers, without a bias correction: 0 for a normal distribution.
- [`covar_samp`](./covar_samp): The sample covariance of two numbers over a group's rows: co-deviations over `n − 1`.
- [`covar_pop`](./covar_pop): The population covariance of two numbers over a group's rows: co-deviations over `n`.
- [`corr`](./corr): The correlation coefficient of two numbers over a group's rows, from −1 to 1.
