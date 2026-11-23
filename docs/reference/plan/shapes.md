---
description: 'Which trees are plans: any operation over any other, the columns each expression may read, and nested plans.'
---

# Plan shapes

Any tree that follows the grammar and these rules is a valid plan: a sort directly over an aggregate, a filter over a
join, a bare scan. The engine rearranges what it is given into the shape its planner reads (SQL's: LIMIT, ORDER BY,
DISTINCT, the projection, windows, HAVING, the aggregate, WHERE, then the FROM items) without changing its rows. A
projection of a sort keeps the sort's order.

## What an expression may read

An expression reads the columns of the operation that holds it, by position ([`col`](./expressions/col)):

| Expression of | Reads |
|---|---|
| a [`join`](./operations/join)'s `on` and `asof` | input 0 (the left input) and input 1 (the right) |
| a [`values`](./operations/values) row, a `sample`'s `count` and `fraction`, a frame's offsets, an `iterate`'s `limit` and `offset`, an `asOf`, a `tolerance` | no columns: constants and parameters |
| a `returning` expression | the row written: the table's columns, then its rowid |
| an `append`'s upsert | the existing row (the table's columns, then its rowid), then the proposed row, likewise |
| a [`graphCreate`](./operations/graphCreate)'s nodes and relationships | the input's columns, then the ids made before it |
| any other operation's expressions | input 0, its one input |

A nested plan in an expression ([`subquery`](./expressions/subquery), [`inSubquery`](./expressions/inSubquery)) reads
its own inputs at `depth` 0, and the row of the operation around it at `depth` 1 (a correlated reference), and so on
outwards. A [`source`](./operations/source) on the right of a join may read the left input's columns in its arguments
(a lateral source).

## Example

A sort straight over an aggregate, and a filter over the sort: no project in between, and the filter keeps the sort's
order.

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {
      "op": "sort",
      "input": {
        "op": "aggregate",
        "input": {"op": "scan", "table": "orders", "columns": [1, 2]},
        "keys": [{"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "collation": "binary"}],
        "aggs": [{"fn": "sum", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}], "star": false, "distinct": false, "collation": "binary", "type": "int"}],
        "carry": []
      },
      "keys": [{"expr": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, "desc": true, "nullsFirst": false, "collation": "binary"}]
    },
    "pred": {"k": "call", "fn": "cmp_gt", "args": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "lit", "value": 1, "type": "int"}
    ], "type": "bool"}
  },
  "columns": [{"name": "fruit"}, {"name": "ordered"}]
}
```

| fruit | ordered |
|---|---|
| 4 | 10 |
| 1 | 6 |
| 3 | 5 |

A column that isn't there:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "filter",
  "input": {"op": "scan", "table": "fruit", "columns": [1]},
  "pred": {"k": "call", "fn": "cmp_eq", "args": [
    {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
    {"k": "lit", "value": 1, "type": "int"}
  ], "type": "bool"}
}
```

## Limits

A plan nests at most `MAX_PLAN_DEPTH` operations and expressions deep (exported from `smaltdb/engine`'s `plan`), and
reads at most 32766 parameters. Deeper is `SMALT_PLAN`.

## See also

- [Operations](./operations/), [Expressions](./expressions/)
- [Validation](../engine/running#validation): what the engine checks before it plans
