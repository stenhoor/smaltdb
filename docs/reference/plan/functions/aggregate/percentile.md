---
description: 'The value at a percentage of the way through a group''s sorted numbers, interpolated between two.'
---

# percentile

```ebnf
percentile ::= '"fn": "percentile"' ', "args": [' X ',' P ']'
```

The percentile `P` of the numbers `X` in a group, as SQLite's `percentile`. With the `n` values sorted, it is the value
at position `p·(n−1)` (from 0), where `p` is `P / 100`, interpolated linearly between the two values around it when that
position falls between them. An aggregate: a call in an [`aggregate`](../../operations/aggregate)'s `aggs` (or a
[`window`](../../operations/window)'s `calls`, over a frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `int` or `real` | The value. |
| `P` | `real` | Where: a percentage, 0 to 100. The same on every row of the group. |

## Returns

`real`. NULL when the group has no value that is not NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | A value of `X` is not a number (text or a blob), or is `Infinity` or `-Infinity`. |
| `SMALT_ERROR` | `P` is NULL, not a number, or outside 0 to 100, or not the same on every row. |

## Notes

- `percentile(X, P)` is `percentile_cont(X, P / 100)`.
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
      {"fn": "percentile", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 0, "type": "real"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "percentile", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 25, "type": "real"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "percentile", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 50, "type": "real"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "percentile", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 100, "type": "real"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": []
  },
  "columns": [{"name": "0"}, {"name": "25"}, {"name": "50"}, {"name": "100"}]
}
```

| 0 | 25 | 50 | 100 |
|---|---|---|---|
| 1 | 1.75 | 3 | 10 |

`P` outside 0 to 100:

<!-- docs:error SMALT_ERROR -->
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
      {"fn": "percentile", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 200, "type": "real"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": []
  },
  "columns": [{"name": "p"}]
}
```

## Demo

The middle order, and the order nine tenths of the way up, of all orders:

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
      {"fn": "percentile", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 50, "type": "real"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "percentile", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 90, "type": "real"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": []
  },
  "columns": [{"name": "middle"}, {"name": "top tenth"}]
}
```

| middle | top tenth |
|---|---|
| 2.5 | 7.5 |

## See also

- [`percentile_cont`](./percentile_cont), [`percentile_disc`](./percentile_disc), [`median`](./median)
- [Aggregate functions](./)
