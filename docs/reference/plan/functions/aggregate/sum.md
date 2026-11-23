---
description: 'The sum of a group''s values: an integer while every value is one, NULL for no values.'
---

# sum

```ebnf
sum ::= '"fn": "sum"' ', "args": [' X ']'
```

The sum of the values of `X` in a group, as SQLite's `sum`: an integer while every value is an integer, else a real.
NULL values are skipped. An aggregate: a call in an [`aggregate`](../../operations/aggregate)'s `aggs` (or a
[`window`](../../operations/window)'s `calls`, over a frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `int`, `real`, `bool`; others converted | The value added. Text and blobs are taken as the number they start with (0 when none), as SQLite takes them. |

## Returns

`int` for an `int` or `bool` argument, `real` for a `real` one, else `num` (an integer or a real, by the values). NULL
when the group has no value that is not NULL, and when the sum of reals is NaN (a NaN value, or `Infinity` and
`-Infinity` together).

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | An integer sum goes beyond the 64-bit range (`integer overflow`). |

## Notes

- [`total`](./total) is the same sum as a real: 0 for no values, and no overflow. [`sum_float`](./sum_float) keeps a NaN
  result NaN ([ADR 0018](../../../../adr/0018-bool-and-nan.md)).
- Integers add exactly; once a real is added the sum is a real, added with compensation (Kahan–Neumaier) as SQLite 3.43
  and later add.
- With `distinct`, each different value is added once.

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
        [{"k": "lit", "value": 3, "type": "int"}, {"k": "lit", "value": 0.5, "type": "real"}],
        [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": 0.25, "type": "real"}],
        [{"k": "lit", "value": 4, "type": "int"}, {"k": "lit", "value": null, "type": "real"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "sum", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "int"},
      {"fn": "sum", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "sum", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "filter": {"k": "lit", "value": 0, "type": "bool"}, "collation": "binary", "type": "int"}
    ],
    "carry": []
  },
  "columns": [{"name": "integers"}, {"name": "reals"}, {"name": "no rows"}]
}
```

| integers | reals | no rows |
|---|---|---|
| 7 | 0.75 | NULL |

An integer sum beyond the 64-bit range fails; `total` gives a real:

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
        [{"k": "lit", "value": {"$bigint": "9223372036854775807"}, "type": "int"}],
        [{"k": "lit", "value": 1, "type": "int"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "sum", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "int"}
    ],
    "carry": []
  },
  "columns": [{"name": "sum"}]
}
```

## Demo

The pieces ordered each day:

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
      {"expr": {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "date", "collation": "binary"}, "collation": "binary"}
    ],
    "aggs": [
      {"fn": "sum", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "int"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "day"}, {"name": "pieces"}]
}
```

| day | pieces |
|---|---|
| 2026-11-02 | 4 |
| 2026-11-03 | 2 |
| 2026-11-04 | 10 |
| 2026-11-05 | 6 |

## See also

- [`total`](./total), [`sum_float`](./sum_float), [`avg`](./avg), [`count`](./count)
- [Aggregate functions](./)
