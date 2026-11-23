---
description: 'The rows of its input for which a condition is true.'
---

# filter

```railroad
filter
```

The rows of its input for which a condition is true. SQL's `WHERE` and `HAVING` are filters.

## Fields

| Field | Type | |
|---|---|---|
| `input` | operation | The rows to filter. |
| `pred` | [expression](../expressions/) | The condition, over the input's columns (input 0). |

## Output

Its input's columns.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `pred` reads a column the input doesn't have. |

Errors the condition raises (a function's, a subquery's) are the filter's.

## Notes

- A row is kept when its condition is true: not NULL and not 0. A condition that is NULL (unknown) drops the row, as
  false does: to keep rows whose value is NULL, test for it with [`isNull`](../expressions/isNull).
- A condition of another type is read as a number, as SQLite reads one: text by its leading number, so `'2abc'` is
  true and `'x'` false.
- Rows keep their input's order ([order](../order)).
- The condition may hold [subqueries](../expressions/subquery), which read the filter's row as an enclosing scope
  (`depth` 1).

## Examples

The fruit with more than 5 in stock. Plum's `qty` is NULL, so its condition is unknown and it is dropped:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "pred": {"k": "call", "fn": "cmp_gt", "args": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "lit", "value": 5, "type": "int"}
    ], "type": "bool"}
  },
  "columns": [{"name": "name"}, {"name": "qty"}]
}
```

| name | qty |
|---|---|
| apple | 10 |
| cherry | 25 |

Two conditions with [`and`](../expressions/and), one testing for NULL:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3, 4]},
    "pred": {"k": "and", "args": [
      {"k": "call", "fn": "cmp_gt", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "bool"},
      {"k": "isNull", "arg": {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}, "not": false}
    ]}
  },
  "columns": [{"name": "name"}, {"name": "price"}, {"name": "qty"}]
}
```

| name | price | qty |
|---|---|---|
| plum | 1.25 | NULL |

A condition over a column the input doesn't have:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "filter",
  "input": {"op": "scan", "table": "fruit", "columns": [1]},
  "pred": {
    "k": "isNull",
    "arg": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
    "not": false
  }
}
```

## Demo

The fruit that have no orders: a filter with a correlated subquery, whose `col` at `depth` 1 reads the fruit's row:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
    "pred": {
      "k": "not",
      "arg": {
        "k": "subquery",
        "mode": "exists",
        "plan": {
          "op": "filter",
          "input": {"op": "scan", "table": "orders", "columns": [1]},
          "pred": {"k": "call", "fn": "cmp_eq", "args": [
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
            {"k": "col", "input": 0, "index": 0, "depth": 1, "type": "int", "collation": "binary"}
          ], "type": "bool"}
        },
        "type": "bool",
        "collation": "binary"
      }
    }
  },
  "columns": [{"name": "id"}, {"name": "name"}]
}
```

| id | name |
|---|---|
| 5 | lime |

## See also

- [`project`](./project), [`join`](./join): a join's `on` is a condition too
- [`and`](../expressions/and), [`or`](../expressions/or), [`not`](../expressions/not), [`isNull`](../expressions/isNull)
- [Operations](./)
