---
description: 'One column for each of its expressions, over each row of its input.'
---

# project

```railroad
project
```

One column for each of its expressions, over each row of its input: SQL's select list. It picks, reorders, repeats and
computes columns.

## Fields

| Field | Type | |
|---|---|---|
| `input` | operation | The rows to compute over. |
| `exprs` | [expressions](../expressions/) | The output columns, in order, each over the input's columns (input 0). May be empty. |

## Output

One column for each of `exprs`, in order, with the expression's type.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | An expression reads a column the input doesn't have, or is not a valid expression. |

Errors the expressions raise when they run (a function's, a subquery's) are the project's.

## Notes

- One row for each input row, in the input's order: a projection of a [`sort`](./sort) keeps the sort's order
  ([order](../order)).
- With no `exprs`, each input row gives a row of no columns.
- An expression may hold [subqueries](../expressions/subquery), which read the row as an enclosing scope (`depth` 1).

## Examples

A column, and a column computed from another:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "mul", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "double_price"}]
}
```

| name | double_price |
|---|---|
| apple | 1 |
| pear | 1.5 |
| plum | 2.5 |
| cherry | 6 |
| lime | 0.8 |

Columns reordered and repeated, beside a constant:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "orders", "columns": [0, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "lit", "value": "order", "type": "text"}
    ]
  },
  "columns": [{"name": "day"}, {"name": "id"}, {"name": "id_again"}, {"name": "kind"}]
}
```

| day | id | id_again | kind |
|---|---|---|---|
| 2026-11-02 | 1 | 1 | order |
| 2026-11-02 | 2 | 2 | order |
| 2026-11-03 | 3 | 3 | order |
| 2026-11-04 | 4 | 4 | order |
| 2026-11-05 | 5 | 5 | order |
| 2026-11-05 | 6 | 6 | order |

A column the input doesn't have:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "project",
  "input": {"op": "scan", "table": "fruit", "columns": [1]},
  "exprs": [{"k": "col", "input": 0, "index": 3, "depth": 0, "type": "real", "collation": "binary"}]
}
```

## Demo

Each fruit with the number of it ordered, from a correlated scalar subquery (NULL for a fruit with no orders):

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {
        "k": "subquery",
        "mode": "scalar",
        "plan": {
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
          "aggs": [
            {"fn": "sum", "args": [
              {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
            ], "star": false, "distinct": false, "collation": "binary", "type": "int"}
          ],
          "carry": []
        },
        "type": "int",
        "collation": "binary"
      }
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

- [`filter`](./filter), [`values`](./values)
- [Expressions](../expressions/)
- [Operations](./)
