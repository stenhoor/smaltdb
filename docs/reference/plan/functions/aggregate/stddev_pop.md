---
description: 'The population standard deviation of a group''s numbers: the square root of `var_pop`.'
---

# stddev_pop

```ebnf
stddev_pop ::= '"fn": "stddev_pop"' ', "args": [' X ']'
```

The population standard deviation of the numbers `X` in a group: the square root of [`var_pop`](./var_pop), for `n`
values. An aggregate: a call in an [`aggregate`](../../operations/aggregate)'s `aggs` (or a
[`window`](../../operations/window)'s `calls`, over a frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `int` or `real`; others converted | The value. |

## Returns

`real`. NULL when the group has fewer than one value that are not NULL.

## Errors

None.

## Notes

- NULL values are skipped. Other values are taken as numbers as [`sum`](./sum) takes them: text and blobs as the number
  they start with (0 when none).
- They are computed in one pass with Welford's updates, which stay accurate when the values are large and close
  together.
- A result that is NaN (from an `Infinity` among the values) is NULL.

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
        [{"k": "lit", "value": 3, "type": "int"}],
        [{"k": "lit", "value": 4, "type": "int"}],
        [{"k": "lit", "value": null, "type": "int"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "stddev_pop", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "stddev_pop", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "filter": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "bool"}, "collation": "binary", "type": "real"},
      {"fn": "stddev_pop", "args": [
        {"k": "lit", "value": 5, "type": "int"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": []
  },
  "columns": [{"name": "stddev_pop"}, {"name": "one value"}, {"name": "all equal"}]
}
```

| stddev_pop | one value | all equal |
|---|---|---|
| 1.118033988749895 | 0 | 0 |

## Demo

How much the stock of each colour of fruit varies:

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
      {"fn": "stddev_pop", "args": [
        {"k": "col", "input": 0, "index": 4, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "color"}, {"name": "stddev_pop"}]
}
```

| color | stddev_pop |
|---|---|
| red | 7.5 |
| green | 2 |
| purple | NULL |

## See also

- [`stddev_samp`](./stddev_samp), [`var_pop`](./var_pop), [`avg`](./avg)
- [Aggregate functions](./)
