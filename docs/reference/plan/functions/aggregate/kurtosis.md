---
description: 'The sample excess kurtosis of a group''s numbers, with the bias correction for a sample.'
---

# kurtosis

```ebnf
kurtosis ::= '"fn": "kurtosis"' ', "args": [' X ']'
```

The sample excess kurtosis of the numbers `X` in a group: the population excess kurtosis `g2` corrected for a sample:
`(n−1) / ((n−2)(n−3)) · ((n+1)·g2 + 6)`, for `n` values. An aggregate: a call in an
[`aggregate`](../../operations/aggregate)'s `aggs` (or a [`window`](../../operations/window)'s `calls`, over a frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `int` or `real`; others converted | The value. |

## Returns

`real`. NULL when the group has fewer than 4 values that are not NULL, or when they are all equal (no spread).

## Errors

None.

## Notes

- The plain name is the sample statistic and `_pop` the population one, as DuckDB names them; pandas and Polars give the
  population one with `bias=True`.
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
      {"fn": "kurtosis", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "kurtosis", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "filter": {"k": "call", "fn": "cmp_ne", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "bool"}, "collation": "binary", "type": "real"},
      {"fn": "kurtosis", "args": [{"k": "lit", "value": 5, "type": "int"}], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": []
  },
  "columns": [{"name": "kurtosis"}, {"name": "without 4"}, {"name": "all equal"}]
}
```

| kurtosis | without 4 | all equal |
|---|---|---|
| -1.200000000000001 | NULL | NULL |

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
      {"fn": "kurtosis", "args": [{"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}
    ],
    "carry": []
  },
  "columns": [{"name": "kurtosis"}, {"name": "orders"}]
}
```

| kurtosis | orders |
|---|---|
| 2.3055801035222836 | 6 |

## See also

- [`kurtosis_pop`](./kurtosis_pop), [`skewness`](./skewness), [`avg`](./avg)
- [Aggregate functions](./)
