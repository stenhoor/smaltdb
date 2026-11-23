---
description: 'Rows drawn at random from its input, fixed by a seed.'
---

# sample

```railroad
sample
```

Rows drawn at random from its input, fixed by a seed: `count` rows, or a `fraction` of the input's, each row at most
once or, with `replace`, any number of times.

## Fields

| Field | Type | |
|---|---|---|
| `input` | operation | The rows to draw from. |
| `count` | [expression](../expressions/) | How many rows, an expression over no columns. Give `count` or `fraction`, not both. |
| `fraction` | [expression](../expressions/) | The share of the input's rows: `0.5` is half. An expression over no columns. |
| `replace` | boolean | `false`: each row at most once. `true`: each draw may take any row, also one drawn before. |
| `seed` | integer | Fixes the draws: the same seed gives the same rows from the same input, in the same order. |

## Output

Its input's columns.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | Both `count` and `fraction` are given, or neither, or `seed` is not an integer. |

## Notes

- The number of rows is `count`, or `fraction` times the number of input rows. NULL, 0 or a negative number gives no
  rows.
- Without `replace`, each row is given a rank fixed by the seed and its position, and the rows ranked at or below that
  number are kept, in their input order: all of them when there are fewer. A number that isn't whole is rounded down
  (`2.5` keeps 2 rows).
- With `replace`, draws are made while their count is below that number (`2.5` makes 3), each taking the row at a
  position fixed by the seed and the draw's number, and rows come in the order drawn.
- Which rows a seed draws depends on their positions, so a sample of an input with no promised order is fixed only as
  long as that order is. Sort below it for a sample that stays the same.

## Examples

Two of the five fruit:

```json
{
  "kind": "query",
  "plan": {
    "op": "sample",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
    "count": {"k": "lit", "value": 2, "type": "int"},
    "replace": false,
    "seed": 42
  },
  "columns": [{"name": "id"}, {"name": "name"}]
}
```

| id | name |
|---|---|
| 2 | pear |
| 5 | lime |

Another seed draws other rows:

```json
{
  "kind": "query",
  "plan": {
    "op": "sample",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
    "count": {"k": "lit", "value": 2, "type": "int"},
    "replace": false,
    "seed": 7
  },
  "columns": [{"name": "id"}, {"name": "name"}]
}
```

| id | name |
|---|---|
| 2 | pear |
| 4 | cherry |

Six draws with replacement, in the order drawn:

```json
{
  "kind": "query",
  "plan": {
    "op": "sample",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
    "count": {"k": "lit", "value": 6, "type": "int"},
    "replace": true,
    "seed": 42
  },
  "columns": [{"name": "id"}, {"name": "name"}]
}
```

| id | name |
|---|---|
| 4 | cherry |
| 3 | plum |
| 2 | pear |
| 3 | plum |
| 5 | lime |
| 2 | pear |

Both a count and a fraction:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "sample",
  "input": {"op": "scan", "table": "fruit", "columns": [1]},
  "count": {"k": "lit", "value": 2, "type": "int"},
  "fraction": {"k": "lit", "value": 0.5, "type": "real"},
  "replace": false,
  "seed": 42
}
```

## Demo

Half the orders, from an input sorted by id so that the sample stays the same:

```json
{
  "kind": "query",
  "plan": {
    "op": "sample",
    "input": {
      "op": "sort",
      "input": {"op": "scan", "table": "orders", "columns": [0, 1, 2]},
      "keys": [
        {
          "expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
          "desc": false,
          "nullsFirst": true,
          "collation": "binary"
        }
      ]
    },
    "fraction": {"k": "lit", "value": 0.5, "type": "real"},
    "replace": false,
    "seed": 2026
  },
  "columns": [{"name": "id"}, {"name": "fruit"}, {"name": "n"}]
}
```

| id | fruit | n |
|---|---|---|
| 3 | 1 | 2 |
| 4 | 4 | 10 |
| 5 | 3 | 5 |

## See also

- [`limit`](./limit): the first rows
- [`random_at`](../functions/general/random_at): the value a seed and a position fix
- [Operations](./)
