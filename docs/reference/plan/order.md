---
description: 'The order of a plan''s rows: what each operation keeps, what a plan can ask for, and what is defined by order.'
---

# Order

Rows have an order only where a plan makes or keeps one. Without that, the engine is free to give them in any order,
and to change it from one run to the next as the data or its plan changes.

## Operations that keep an order

Whatever plan the engine picks:

- [`sort`](./operations/sort) is stable: rows with equal keys keep their input order, also as a top-N under a
  [`limit`](./operations/limit) and when the sort spills to disk.
- [`filter`](./operations/filter), [`project`](./operations/project) and [`limit`](./operations/limit) keep their
  input's order, and so does a [`window`](./operations/window) without an `order` of its own. Such a window also takes
  its rows in that order: its ranking and navigation calls (`row_number`, `lag`, …) and a `ROWS` frame look back over
  and accumulate the rows as its input gives them, in each partition.
- `semi` and `anti` [joins](./operations/join) keep the left input's order.
- A [`setop`](./operations/setop) of kind `unionAll` gives its first input's rows, in their order, then its second's.
- [`explode`](./operations/explode), [`unpivot`](./operations/unpivot) and [`paths`](./operations/paths) give each
  input row's rows in the input's order.
- A [`sample`](./operations/sample) without replacement keeps its input's order.

## Operations that keep one when asked

Keeping an order costs time, so these keep one only when the plan asks:

- A [`join`](./operations/join) with `"ordered": true` gives the left input's order, and for each left row its
  matches in the right input's order. A left join's unmatched left rows keep their place; a right or full join's
  unmatched right rows come last, in the right input's order.
- An [`aggregate`](./operations/aggregate), a [`pivot`](./operations/pivot) or a
  [`distinct`](./operations/distinct) with `"ordered": "first"` gives its groups in the order of each group's first
  row.

## Operations defined by order

- The [`first`](./functions/aggregate/first) and [`last`](./functions/aggregate/last) aggregates give the value of a
  group's first or last row: by input order, or with a key, at the row with the smallest (`last`: largest) key.
- A [`limit`](./operations/limit) with `"fromEnd": true` counts from the end: the last `count` rows before the last
  `offset` rows, in input order.
- A [`distinct`](./operations/distinct) with `on` keeps one row of each set of duplicates: the first by input order,
  or the last with `"keep": "last"`.

## Example

The orders sorted by `id`, then grouped by day: the groups come in the order of their first rows, and `first` and
`last` give the first and last fruit ordered each day.

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "sort",
      "input": {"op": "scan", "table": "orders", "columns": [3, 1, 0]},
      "keys": [{"expr": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}]
    },
    "keys": [{"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}, "collation": "binary"}],
    "aggs": [
      {"fn": "first", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "int"},
      {"fn": "last", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "int"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "day"}, {"name": "first"}, {"name": "last"}]
}
```

| day | first | last |
|---|---|---|
| 2026-11-02 | 1 | 2 |
| 2026-11-03 | 1 | 1 |
| 2026-11-04 | 4 | 4 |
| 2026-11-05 | 3 | 1 |

`first` and `last` also take the order's `id` as a key: each gives the fruit of the row with the smallest or the
largest, whatever order the rows come in.

The last two fruit by price, from a sorted input:

```json
{
  "kind": "query",
  "plan": {
    "op": "limit",
    "input": {
      "op": "sort",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
      "keys": [{"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}]
    },
    "count": {"k": "lit", "value": 2, "type": "int"},
    "fromEnd": true
  },
  "columns": [{"name": "name"}, {"name": "price"}]
}
```

| name | price |
|---|---|
| plum | 1.25 |
| cherry | 3 |

## See also

- [Plan shapes](./shapes)
- [Writing a property graph](./graph-writes#order): the order a plan that writes a graph runs in
