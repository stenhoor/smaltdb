---
description: 'The middle of a group''s numbers, halfway between the two middle ones when their count is even.'
---

# median

```ebnf
median ::= '"fn": "median"' ', "args": [' X ']'
```

The median of the numbers `X` in a group, as SQLite's `median`: the middle value once they are sorted, or the mean of
the two middle values when there is an even number of them. It is [`percentile_cont`](./percentile_cont) at 0.5. An
aggregate: a call in an [`aggregate`](../../operations/aggregate)'s `aggs` (or a [`window`](../../operations/window)'s
`calls`, over a frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `int` or `real` | The value. |

## Returns

`real`. NULL when the group has no value that is not NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | A value of `X` is not a number (text or a blob), or is `Infinity` or `-Infinity`. |

## Notes

- NULL values are skipped. Integers and reals are taken as numbers; any other value (text, even text that reads as a
  number, or a blob) is an error, as in SQLite.
- The result is the same whatever order the rows come in.

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
        [{"k": "lit", "value": 1, "type": "int"}],
        [{"k": "lit", "value": 2, "type": "int"}],
        [{"k": "lit", "value": 4, "type": "int"}],
        [{"k": "lit", "value": 10, "type": "int"}],
        [{"k": "lit", "value": null, "type": "int"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "median", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "median", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "filter": {"k": "call", "fn": "cmp_lt", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 10, "type": "int"}
      ], "type": "bool"}, "collation": "binary", "type": "real"},
      {"fn": "median", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "filter": {"k": "lit", "value": 0, "type": "bool"}, "collation": "binary", "type": "real"}
    ],
    "carry": []
  },
  "columns": [{"name": "four values"}, {"name": "three values"}, {"name": "no rows"}]
}
```

| four values | three values | no rows |
|---|---|---|
| 3 | 2 | NULL |

Text is not a number here:

<!-- docs:error SMALT_ERROR -->
```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "values",
      "types": ["text"],
      "rows": [[{"k": "lit", "value": "3", "type": "text"}]]
    },
    "keys": [],
    "aggs": [
      {"fn": "median", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": []
  },
  "columns": [{"name": "median"}]
}
```

## Demo

The median order of each fruit (by id):

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
      {"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, "collation": "binary"}
    ],
    "aggs": [
      {"fn": "median", "args": [{"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "fruit"}, {"name": "median"}, {"name": "orders"}]
}
```

| fruit | median | orders |
|---|---|---|
| 1 | 2 | 3 |
| 2 | 1 | 1 |
| 4 | 10 | 1 |
| 3 | 5 | 1 |

## See also

- [`percentile_cont`](./percentile_cont), [`percentile`](./percentile), [`avg`](./avg), [`list_median`](../list/list_median)
- [Aggregate functions](./)
