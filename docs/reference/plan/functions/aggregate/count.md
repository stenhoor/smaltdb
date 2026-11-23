---
description: 'The number of rows in a group, or of its rows where a value is not NULL.'
---

# count

```ebnf
count ::= '"fn": "count"' (', "args": [' X ']' | ', "args": [], "star": true')
```

The number of rows in a group. With `"args": [], "star": true` (SQL's `count(*)`) it counts every row; with an argument,
the rows where that value is not NULL. An aggregate: a call in an [`aggregate`](../../operations/aggregate)'s `aggs` (or
a [`window`](../../operations/window)'s `calls`, over a frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | Optional: the value. Rows where it is NULL are not counted. |

## Returns

`int`. Never NULL: a group with no rows (an aggregate with no keys over no rows) gives 0.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | No argument, and `star` not set. |

## Notes

- With `distinct`, it counts the different values of `X` that are not NULL, text compared by the collation `X` carries
  ([meaning fields](../../meaning-fields)).
- With a `filter`, it counts only the rows for which the filter is true; `count(*)` with a filter counts those rows.
- In a `window` it counts the rows of each row's frame.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "values",
      "types": ["int"],
      "rows": [
        [{"k": "lit", "value": 3, "type": "int"}],
        [{"k": "lit", "value": null, "type": "int"}],
        [{"k": "lit", "value": 3, "type": "int"}],
        [{"k": "lit", "value": 5, "type": "int"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"},
      {"fn": "count", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "int"},
      {"fn": "count", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": true, "collation": "binary", "type": "int"}
    ],
    "carry": []
  },
  "columns": [{"name": "rows"}, {"name": "values"}, {"name": "different"}]
}
```

| rows | values | different |
|---|---|---|
| 4 | 3 | 2 |

Without an argument, the call must set `star`:

<!-- docs:error SMALT_PLAN -->
```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "values",
      "types": ["int"],
      "rows": [[{"k": "lit", "value": 3, "type": "int"}]]
    },
    "keys": [],
    "aggs": [{"fn": "count", "args": [], "star": false, "distinct": false, "collation": "binary", "type": "int"}],
    "carry": []
  },
  "columns": [{"name": "rows"}]
}
```

## Demo

The orders of each day, and how many different fruit they were for:

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
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "date", "collation": "binary"}, "collation": "binary"}
    ],
    "aggs": [
      {"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"},
      {"fn": "count", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": true, "collation": "binary", "type": "int"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "day"}, {"name": "orders"}, {"name": "fruit"}]
}
```

| day | orders | fruit |
|---|---|---|
| 2026-11-02 | 2 | 2 |
| 2026-11-03 | 1 | 1 |
| 2026-11-04 | 1 | 1 |
| 2026-11-05 | 2 | 2 |

## See also

- [`sum`](./sum), [`total`](./total)
- [Aggregate functions](./)
