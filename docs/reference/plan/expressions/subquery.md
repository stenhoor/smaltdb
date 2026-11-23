---
description: 'A nested plan''s first value, or whether it has a row.'
---

# subquery

```railroad
subquery
```

A nested plan's first value, or whether it has a row. The nested plan may read the row it runs for: its
[`col`](./col) expressions with `depth` 1 read the input of the operation that holds the subquery.

## Fields

| Field | Type | |
|---|---|---|
| `mode` | `"scalar"` or `"exists"` | `scalar`: the first column of the plan's first row. `exists`: whether the plan has a row. |
| `plan` | [operation](../operations/) | The nested plan. |
| `type` | [type](../types) | The type of the value: the column's for `scalar`; `bool` or `int` for `exists`. |
| `collation` | [collation](../collations) | The value's collation. |

and the [meaning fields](../meaning-fields) of an expression.

## Value

- `scalar`: the first column of the first row the plan gives; NULL when it gives no row. Further rows and columns are
  not read.
- `exists`: true when the plan gives a row, else false; never NULL. Typed `int`, it is `1` or `0`.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `mode` is neither, the nested plan is invalid, or a `scalar` subquery's plan has no columns. |

## Notes

- An uncorrelated subquery (one that reads no enclosing row) gives the same value for every row. A correlated one is
  run for each row, or turned into a join where the planner can (the [`decorrelate`](../meaning-fields#inline-and-decorrelate) field turns
  that off); the result is the same.
- The first row of a plan without a [`sort`](../operations/sort) is whichever the plan gives first: sort the nested
  plan, or aggregate it, where it may give more than one.
- A comparison of the value doesn't take its collation from `collation`: give the comparison its own.
- The nested plan doesn't read the elements of an [`each`](./each) around the subquery.

## Examples

A scalar subquery of no rows is NULL; `exists` as `bool` and as `int`:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "bool", "int"],
    "rows": [[
      {"k": "subquery", "mode": "scalar", "plan": {"op": "values", "types": ["int"], "rows": []}, "type": "int", "collation": "binary"},
      {"k": "subquery", "mode": "exists", "plan": {"op": "values", "types": ["int"], "rows": []}, "type": "bool", "collation": "binary"},
      {"k": "subquery", "mode": "exists", "plan": {"op": "values", "types": ["int"], "rows": [[{"k": "lit", "value": 7, "type": "int"}]]}, "type": "int", "collation": "binary"}
    ]]
  },
  "columns": [{"name": "none"}, {"name": "any"}, {"name": "any_int"}]
}
```

| none | any | any_int |
|---|---|---|
| NULL | false | 1 |

A scalar subquery needs a column:

<!-- docs:error SMALT_PLAN -->
```json
{"op": "values", "types": ["int"], "rows": [[{"k": "subquery", "mode": "scalar", "plan": {"op": "values", "types": [], "rows": [[]]}, "type": "int", "collation": "binary"}]]}
```

## Demo

Whether each fruit has been ordered, and the largest order of it:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "subquery", "mode": "exists", "plan": {
        "op": "filter",
        "input": {"op": "scan", "table": "orders", "columns": [1]},
        "pred": {"k": "call", "fn": "cmp_eq", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "col", "input": 0, "index": 0, "depth": 1, "type": "int", "collation": "binary"}
        ], "type": "bool"}
      }, "type": "bool", "collation": "binary"},
      {"k": "subquery", "mode": "scalar", "plan": {
        "op": "aggregate",
        "input": {
          "op": "filter",
          "input": {"op": "scan", "table": "orders", "columns": [1, 2]},
          "pred": {"k": "call", "fn": "cmp_eq", "args": [
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
            {"k": "col", "input": 0, "index": 0, "depth": 1, "type": "int", "collation": "binary"}
          ], "type": "bool"}
        },
        "keys": [],
        "aggs": [{"fn": "max", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "int"}],
        "carry": []
      }, "type": "int", "collation": "binary"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "ordered"}, {"name": "largest"}]
}
```

| name | ordered | largest |
|---|---|---|
| apple | true | 3 |
| pear | true | 1 |
| plum | true | 5 |
| cherry | true | 10 |
| lime | false | NULL |

## See also

- [`inSubquery`](./inSubquery): whether a value is among a nested plan's
- [`col`](./col): `depth`, for correlated references
- [`join`](../operations/join): `semi` and `anti` joins
- [Expressions](./)
