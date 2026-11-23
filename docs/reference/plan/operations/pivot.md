---
description: 'Values of a column turned into columns: one row per group, aggregates per value.'
---

# pivot

```railroad
pivot
group-key
agg-call
```

Values of a column turned into columns: one row per group of `keys`, and for each of `values`, each of `aggs` over the
group's rows whose `on` is that value.

## Fields

| Field | Type | |
|---|---|---|
| `input` | operation | The rows to pivot. |
| `keys` | group keys | The expressions that group the rows, `{expr, collation}`, as an [`aggregate`](./aggregate)'s keys. None: one group of every row. |
| `on` | expression | The value that decides which column a row counts in. |
| `collation` | [collation](../collations) | How `on` is compared with `values` when they are text. |
| `values` | values | The values of `on` that become columns, in order: plain JSON values, as a [`lit`](../expressions/lit) holds them. At least one. `null` matches a NULL `on`. |
| `aggs` | aggregate calls | The aggregates computed for each value, as an [`aggregate`](./aggregate)'s calls. At least one. |
| `ordered` | `"first"` | Optional: give the groups in the order of each group's first row. |

## Output

The keys, then for each of `values` in order, one column for each of `aggs`: with two values and two calls, the
first value's two calls, then the second value's. An aggregate column has its call's `type`.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `values` or `aggs` is empty, a value is not a plain value, or an aggregate is not one the engine has. |

## Notes

- A pivot is an [`aggregate`](./aggregate) whose calls each count only the rows with their value: a call over a value
  no row has gives what its function gives over no rows (`count` 0, `sum` NULL). A call's own `filter` applies as
  well.
- The values are part of the plan. A pivot over the values a column has (a dynamic pivot) reads them with a query
  first, then builds the plan.
- With no keys, a pivot gives one row, also over no input rows.
- Groups come in no promised order, unless `ordered` is `"first"` ([order](../order)).

## Examples

The fruit of each colour, and their stock, for two colours:

```json
{
  "kind": "query",
  "plan": {
    "op": "pivot",
    "input": {"op": "scan", "table": "fruit", "columns": [2, 4]},
    "keys": [],
    "on": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
    "collation": "binary",
    "values": ["red", "green"],
    "aggs": [
      {"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"},
      {"fn": "sum", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "int"}
    ]
  },
  "columns": [{"name": "red"}, {"name": "red_qty"}, {"name": "green"}, {"name": "green_qty"}]
}
```

| red | red_qty | green | green_qty |
|---|---|---|---|
| 2 | 35 | 2 | 4 |

`collation` decides how text matches: `nocase` takes `"RED"` for `red`.

```json
{
  "kind": "query",
  "plan": {
    "op": "pivot",
    "input": {"op": "scan", "table": "fruit", "columns": [2]},
    "keys": [],
    "on": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
    "collation": "nocase",
    "values": ["RED", "Purple"],
    "aggs": [{"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}]
  },
  "columns": [{"name": "red"}, {"name": "purple"}]
}
```

| red | purple |
|---|---|
| 2 | 1 |

A pivot without values:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "pivot",
  "input": {"op": "scan", "table": "fruit", "columns": [2]},
  "keys": [],
  "on": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
  "collation": "binary",
  "values": [],
  "aggs": [{"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}]
}
```

## Demo

How many of apples (fruit 1), pears (2) and cherries (4) were ordered each day, by day:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "pivot",
      "input": {"op": "scan", "table": "orders", "columns": [3, 1, 2]},
      "keys": [{"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}, "collation": "binary"}],
      "on": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      "collation": "binary",
      "values": [1, 2, 4],
      "aggs": [
        {"fn": "sum", "args": [{"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "int"}
      ]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "day"}, {"name": "apple"}, {"name": "pear"}, {"name": "cherry"}]
}
```

| day | apple | pear | cherry |
|---|---|---|---|
| 2026-11-02 | 3 | 1 | NULL |
| 2026-11-03 | 2 | NULL | NULL |
| 2026-11-04 | NULL | NULL | 10 |
| 2026-11-05 | 1 | NULL | NULL |

## See also

- [`unpivot`](./unpivot): columns turned into rows
- [`aggregate`](./aggregate)
- [Operations](./)
