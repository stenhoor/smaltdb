---
description: 'The sample skewness of a group''s numbers, with the bias correction for a sample.'
---

# skewness

```ebnf
skewness ::= '"fn": "skewness"' ', "args": [' X ']'
```

The sample skewness of the numbers `X` in a group: the population skewness `g1` corrected for a sample: `g1·√(n(n−1)) /
(n−2)`, for `n` values. An aggregate: a call in an [`aggregate`](../../operations/aggregate)'s `aggs` (or a
[`window`](../../operations/window)'s `calls`, over a frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `int` or `real`; others converted | The value. |

## Returns

`real`. NULL when the group has fewer than 3 values that are not NULL, or when they are all equal (no spread).

## Errors

None.

## Notes

- The plain name is the sample statistic and `_pop` the population one, as DuckDB names them; pandas and Polars give the
  population one with `bias=True`.
- NULL values are skipped. Other values are taken as numbers as [`sum`](./sum) takes them: text and blobs as the number
  they start with (0 when none).
- It is computed in one pass with Welford's updates, which stay accurate when the values are large and close together.
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
        [{"k": "lit", "value": 4, "type": "int"}],
        [{"k": "lit", "value": 10, "type": "int"}],
        [{"k": "lit", "value": null, "type": "int"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "skewness", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "skewness", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "filter": {"k": "call", "fn": "cmp_lt", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 10, "type": "int"}
      ], "type": "bool"}, "collation": "binary", "type": "real"},
      {"fn": "skewness", "args": [
        {"k": "lit", "value": 5, "type": "int"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": []
  },
  "columns": [{"name": "skewness"}, {"name": "without 10"}, {"name": "all equal"}]
}
```

| skewness | without 10 | all equal |
|---|---|---|
| 1.469334548210623 | 0.9352195295828245 | NULL |

## Demo

The pieces of all orders:

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
      {"fn": "skewness", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}
    ],
    "carry": []
  },
  "columns": [{"name": "skewness"}, {"name": "orders"}]
}
```

| skewness | orders |
|---|---|
| 1.5672526532175262 | 6 |

## See also

- [`skewness_pop`](./skewness_pop), [`kurtosis`](./kurtosis), [`avg`](./avg)
- [Aggregate functions](./)
