---
description: 'The correlation coefficient of two numbers over a group''s rows, from −1 to 1.'
---

# corr

```ebnf
corr ::= '"fn": "corr"' ', "args": [' Y ',' X ']'
```

The correlation coefficient (Pearson's) of `Y` and `X` over the rows of a group where both are not NULL: their
covariance divided by the product of their standard deviations, from −1 to 1, for `n` such rows. An aggregate: a call in
an [`aggregate`](../../operations/aggregate)'s `aggs` (or a [`window`](../../operations/window)'s `calls`, over a
frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `Y` | `int` or `real`; others converted | The first value (the dependent variable). |
| `X` | `int` or `real`; others converted | The second value (the independent variable). |

## Returns

`real`. NULL when fewer than 2 rows have both values, or when either value doesn't vary.

## Errors

None.

## Notes

- A row where either value is NULL is skipped. Other values are taken as numbers as [`sum`](./sum) takes them.
- Rounding can't take the result past −1 or 1: it is clamped to that range.
- It is computed in one pass with Welford's updates. A result that is NaN (from an `Infinity` among the values) is NULL.
- With `distinct`, rows are kept by the different values of `Y` only, so the pairs kept depend on which row of each `Y`
  comes first.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "values",
      "types": ["int", "int"],
      "rows": [
        [{"k": "lit", "value": 2, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}],
        [{"k": "lit", "value": 4, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}],
        [{"k": "lit", "value": 5, "type": "int"}, {"k": "lit", "value": 3, "type": "int"}],
        [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": 4, "type": "int"}],
        [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": null, "type": "int"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "corr", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "corr", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "corr", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": []
  },
  "columns": [{"name": "y, x"}, {"name": "x, y"}, {"name": "x constant"}]
}
```

| y, x | x, y | x constant |
|---|---|---|
| 0.9819805060619656 | 0.9819805060619656 | NULL |

## Demo

How the stock of the fruit moves with their price (plum, with no stock given, is skipped):

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
    "keys": [],
    "aggs": [
      {"fn": "corr", "args": [
        {"k": "col", "input": 0, "index": 4, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "real", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": []
  },
  "columns": [{"name": "corr"}]
}
```

| corr |
|---|
| 0.927889825141205 |

## See also

- [`covar_samp`](./covar_samp), [`covar_pop`](./covar_pop), [`stddev_samp`](./stddev_samp)
- [Aggregate functions](./)
