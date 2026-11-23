---
description: 'The sum of a group''s values as a real: 0 for no values.'
---

# total

```ebnf
total ::= '"fn": "total"' ', "args": [' X ']'
```

The sum of the values of `X` in a group, always a real, as SQLite's `total`. Unlike [`sum`](./sum), a group with no
values gives 0, and an integer sum beyond the 64-bit range goes on as a real. NULL values are skipped. An aggregate: a
call in an [`aggregate`](../../operations/aggregate)'s `aggs` (or a [`window`](../../operations/window)'s `calls`, over
a frame).

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `int`, `real`, `bool`; others converted | The value added. Text and blobs are taken as the number they start with (0 when none). |

## Returns

`real`. 0 when the group has no value that is not NULL. NULL when the sum is NaN (a NaN value, or `Infinity` and
`-Infinity` together).

## Errors

None.

## Notes

- With `distinct`, each different value is added once.

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
        [{"k": "lit", "value": 3, "type": "int"}],
        [{"k": "lit", "value": null, "type": "int"}],
        [{"k": "lit", "value": 4, "type": "int"}],
        [{"k": "lit", "value": {"$bigint": "9223372036854775807"}, "type": "int"}]
      ]
    },
    "keys": [],
    "aggs": [
      {"fn": "total", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "total", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "filter": {"k": "lit", "value": 0, "type": "bool"}, "collation": "binary", "type": "real"},
      {"fn": "sum", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "filter": {"k": "lit", "value": 0, "type": "bool"}, "collation": "binary", "type": "int"}
    ],
    "carry": []
  },
  "columns": [{"name": "total"}, {"name": "no rows"}, {"name": "sum of no rows"}]
}
```

| total | no rows | sum of no rows |
|---|---|---|
| 9223372036854776000 | 0 | NULL |

## Demo

The fruit in stock of each colour: plum's `qty` is NULL, so purple has no value to add:

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
      {"fn": "total", "args": [
        {"k": "col", "input": 0, "index": 4, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "real"},
      {"fn": "sum", "args": [
        {"k": "col", "input": 0, "index": 4, "depth": 0, "type": "int", "collation": "binary"}
      ], "star": false, "distinct": false, "collation": "binary", "type": "int"}
    ],
    "carry": [],
    "ordered": "first"
  },
  "columns": [{"name": "color"}, {"name": "total"}, {"name": "sum"}]
}
```

| color | total | sum |
|---|---|---|
| red | 35 | 35 |
| green | 4 | 4 |
| purple | 0 | NULL |

## See also

- [`sum`](./sum), [`sum_float`](./sum_float), [`avg`](./avg)
- [Aggregate functions](./)
