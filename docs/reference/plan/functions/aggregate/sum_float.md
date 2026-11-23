---
description: 'The sum of a group''s values, as `sum` gives it, except that a NaN sum stays NaN.'
---

# sum_float

```ebnf
sum_float ::= '"fn": "sum_float"' ', "args": [' X ']'
```

The sum of the values of `X` in a group, as [`sum`](./sum) gives it, except that a NaN sum (a NaN value, or `Infinity`
and `-Infinity` together) is NaN where `sum` gives NULL: IEEE 754's result ([ADR
0018](../../../../adr/0018-bool-and-nan.md)). NULL values are skipped. An aggregate: a call in an
[`aggregate`](../../operations/aggregate)'s `aggs` (or a [`window`](../../operations/window)'s `calls`, over a frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `int`, `real`, `bool`; others converted | The value added. Text and blobs are taken as the number they start with (0 when none). |

## Returns

`int` for an `int` or `bool` argument, `real` for a `real` one, else `num`. NULL when the group has no value that is not
NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | An integer sum goes beyond the 64-bit range (`integer overflow`), as for `sum`. |

## Notes

- A language whose sums follow IEEE 754 (smaltdf, a dataframe's `sum`) calls `sum_float`; SQL's `sum` is `sum`.

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
      {"fn": "sum_float", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "real", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "sum_float", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "sum", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": []
  },
  "columns": [{"name": "finite"}, {"name": "sum_float"}, {"name": "sum"}]
}
```

| finite | sum_float | sum |
|---|---|---|
| 4 | NaN | NULL |

## Demo

The price of one of each fruit, by colour:

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
      {"fn": "sum_float", "args": [{"k": "col", "input": 0, "index": 3, "depth": 0, "type": "real", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "real"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "color"}, {"name": "price"}]
}
```

| color | price |
|---|---|
| red | 3.5 |
| green | 1.15 |
| purple | 1.25 |

## See also

- [`sum`](./sum), [`avg_float`](./avg_float), [`total`](./total)
- [Aggregate functions](./)
