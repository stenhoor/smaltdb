---
description: 'The mean of a group''s values, as a real: NULL for no values.'
---

# avg

```ebnf
avg ::= '"fn": "avg"' ', "args": [' X ']'
```

The mean of the values of `X` in a group: their sum, as [`sum`](./sum) adds them, divided by how many there are. NULL
values are skipped. An aggregate: a call in an [`aggregate`](../../operations/aggregate)'s `aggs` (or a
[`window`](../../operations/window)'s `calls`, over a frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `int`, `real`, `bool`; others converted | The value. Text and blobs are taken as the number they start with (0 when none). |

## Returns

`real`. NULL when the group has no value that is not NULL, and when the sum is NaN (a NaN value, or `Infinity` and
`-Infinity` together).

## Errors

None.

## Notes

- [`avg_float`](./avg_float) is the same, except that a NaN mean stays NaN ([ADR
  0018](../../../../adr/0018-bool-and-nan.md)).
- Integers are added exactly, so a mean of large integers doesn't fail where their `sum` would.
- With `distinct`, the mean of the different values.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "values",
      "types": ["int", "real"],
      "rows": [
        [{"k": "lit", "value": 3, "type": "int"}, {"k": "lit", "value": 1.5, "type": "real"}],
        [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": 2.5, "type": "real"}],
        [{"k": "lit", "value": 4, "type": "int"}, {"k": "lit", "value": {"$real": "NaN"}, "type": "real"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "avg", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "avg", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "avg_float", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": []
  },
  "columns": [{"name": "integers"}, {"name": "with NaN"}, {"name": "avg_float"}]
}
```

| integers | with NaN | avg_float |
|---|---|---|
| 3.5 | NULL | NaN |

## Demo

The mean price and stock of each colour of fruit:

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
      {"fn": "avg", "args": [{"k": "col", "input": 0, "index": 3, "depth": 0, "type": "real", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "avg", "args": [{"k": "col", "input": 0, "index": 4, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "color"}, {"name": "price"}, {"name": "qty"}]
}
```

| color | price | qty |
|---|---|---|
| red | 1.75 | 17.5 |
| green | 0.575 | 2 |
| purple | 1.25 | NULL |

## See also

- [`avg_float`](./avg_float), [`sum`](./sum), [`median`](./median)
- [Aggregate functions](./)
