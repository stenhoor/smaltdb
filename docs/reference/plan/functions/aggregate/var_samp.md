---
description: 'The sample variance of a group''s numbers: squared deviations from the mean over `n − 1`.'
---

# var_samp, variance

```ebnf
var_samp ::= '"fn": "var_samp"' ', "args": [' X ']'
variance ::= '"fn": "variance"' ', "args": [' X ']'
```

The sample variance of the numbers `X` in a group: the sum of the squared deviations from their mean, divided by `n −
1`, for `n` values. `variance` is another name for it. An aggregate: a call in an
[`aggregate`](../../operations/aggregate)'s `aggs` (or a [`window`](../../operations/window)'s `calls`, over a frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `int` or `real`; others converted | The value. |

## Returns

`real`. NULL when the group has fewer than 2 values that are not NULL.

## Errors

None.

## Notes

- `var_samp` and `variance` are PostgreSQL's names; they give the same result.
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
      {"fn": "var_samp", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "variance", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "var_samp", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "filter": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "bool"}, "collation": "binary", "type": "real"},
      {"fn": "var_samp", "args": [
        {"k": "lit", "value": 5, "type": "int"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": []
  },
  "columns": [{"name": "var_samp"}, {"name": "variance"}, {"name": "one value"}, {"name": "all equal"}]
}
```

| var_samp | variance | one value | all equal |
|---|---|---|---|
| 1.6666666666666667 | 1.6666666666666667 | NULL | 0 |

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
      {"fn": "var_samp", "args": [
        {"k": "col", "input": 0, "index": 4, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "color"}, {"name": "var_samp"}]
}
```

| color | var_samp |
|---|---|
| red | 112.5 |
| green | 8 |
| purple | NULL |

## See also

- [`var_pop`](./var_pop), [`stddev_samp`](./stddev_samp), [`avg`](./avg)
- [Aggregate functions](./)
