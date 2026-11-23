---
description: 'The mean of a group''s values, as `avg` gives it, except that a NaN mean stays NaN.'
---

# avg_float

```ebnf
avg_float ::= '"fn": "avg_float"' ', "args": [' X ']'
```

The mean of the values of `X` in a group, as [`avg`](./avg) gives it, except that a NaN mean (a NaN value, or `Infinity`
and `-Infinity` together) is NaN where `avg` gives NULL ([ADR 0018](../../../../adr/0018-bool-and-nan.md)). NULL values
are skipped. An aggregate: a call in an [`aggregate`](../../operations/aggregate)'s `aggs` (or a
[`window`](../../operations/window)'s `calls`, over a frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `int`, `real`, `bool`; others converted | The value. Text and blobs are taken as the number they start with (0 when none). |

## Returns

`real`. NULL when the group has no value that is not NULL.

## Errors

None.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "values",
      "types": ["real", "real"],
      "rows": [
        [{"k": "lit", "value": 1.5, "type": "real"}, {"k": "lit", "value": {"$real": "Infinity"}, "type": "real"}],
        [{"k": "lit", "value": 2.5, "type": "real"}, {"k": "lit", "value": {"$real": "-Infinity"}, "type": "real"}],
        [{"k": "lit", "value": null, "type": "real"}, {"k": "lit", "value": 1, "type": "real"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "avg_float", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "real", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "avg_float", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "avg", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": []
  },
  "columns": [{"name": "finite"}, {"name": "avg_float"}, {"name": "avg"}]
}
```

| finite | avg_float | avg |
|---|---|---|
| 2 | NaN | NULL |

## Demo

The mean price of each colour of fruit:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "scan",
      "table": "fruit",
      "columns": [0, 1, 2, 3, 4]
    },
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "text", "collation": "binary"}, "collation": "binary"}
    ],
    "aggs": [
      {"fn": "avg_float", "args": [
        {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "real", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "color"}, {"name": "price"}]
}
```

| color | price |
|---|---|
| red | 1.75 |
| green | 0.575 |
| purple | 1.25 |

## See also

- [`avg`](./avg), [`sum_float`](./sum_float)
- [Aggregate functions](./)
