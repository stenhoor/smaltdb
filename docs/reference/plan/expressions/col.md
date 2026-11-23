---
description: 'Column `index` of input `input` of the operation that holds the expression, or of one around it.'
---

# col

```railroad
col
```

Column `index` of input `input` of the operation that holds the expression, or of one around it. Columns are
positions: a plan never names a column.

## Fields

| Field | Type | |
|---|---|---|
| `input` | integer | Which input of the operation, from 0. A [`join`](../operations/join) has inputs 0 and 1; every other operation has one input, 0. |
| `index` | integer | Which column of that input, from 0. |
| `depth` | integer | 0 for the operation's own input. In a nested plan ([`subquery`](./subquery), [`inSubquery`](./inSubquery)), `d` > 0 reads the input of the operation `d` levels out: a correlated reference. |
| `type` | [type](../types) | The column's type. |
| `collation` | [collation](../collations) | The column's collation. |

and the [meaning fields](../meaning-fields) of an expression.

## Value

The column's value in the row being read: at `depth` 0 the operation's current row, at `depth` `d` the current row of
the operation `d` levels out, which the nested plan runs for.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | The operation has no input `input`, the input has no column `index`, or there is no operation `depth` levels out. |

## Notes

- An operation's columns are its input's [output](../operations/), in order: a [`scan`](../operations/scan) gives
  the columns it lists, a [`join`](../operations/join) the left input's then the right's.
- `type` is what the plan states; the engine picks its code by it and doesn't check it against the column's values.
  State the column's own type.
- A comparison doesn't take its collation from `collation`: a [`call`](./call) of `cmp_eq` on a `nocase` column
  compares by the call's `collation` (`binary` when it has none).
- `depth` counts nested plans, not [`each`](./each) expressions: a body of an `each` reads the row's columns at
  `depth` 0, as any expression of the operation does.

## Examples

A join's condition reads both inputs: `fruit.id` is column 0 of input 0, `orders.fruit` column 0 of input 1. The
projection above it reads the join's four columns as input 0:

<!-- docs:unordered -->
```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "join",
      "kind": "inner",
      "inputs": [
        {"op": "scan", "table": "fruit", "columns": [0, 1]},
        {"op": "scan", "table": "orders", "columns": [1, 2]}
      ],
      "on": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 1, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "type": "bool"}
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "int", "collation": "binary"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "n"}]
}
```

| name | n |
|---|---|
| apple | 3 |
| pear | 1 |
| apple | 2 |
| cherry | 10 |
| plum | 5 |
| apple | 1 |

A column the input doesn't have (the scan gives one column):

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "project",
  "input": {"op": "scan", "table": "fruit", "columns": [0]},
  "exprs": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}]
}
```

## Demo

Each fruit's total ordered, by a correlated subquery: inside it, `depth` 0 reads `orders`, and `depth` 1 reads the
fruit row it runs for:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
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
        "aggs": [{"fn": "sum", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "int"}],
        "carry": []
      }, "type": "int", "collation": "binary"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "ordered"}]
}
```

| name | ordered |
|---|---|
| apple | 6 |
| pear | 1 |
| plum | 5 |
| cherry | 10 |
| lime | NULL |

## See also

- [`subquery`](./subquery), [`element`](./element): values of a nested plan and of a list's elements
- [Operations](../operations/): the columns each operation gives
- [Expressions](./)
