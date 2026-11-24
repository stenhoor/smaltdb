---
description: 'A plan that writes: an append, update or delete, or a write of a property graph.'
---

# write

```railroad
write-statement
returned-column
```

A plan that writes: an [`append`](../operations/append), [`update`](../operations/update) or
[`delete`](../operations/delete), or a plan that [writes a property graph](../graph-writes). Its rows are what the
plan gives back.

## Fields

| Field | Type | |
|---|---|---|
| `plan` | [operation](../operations/) | The plan that writes. |
| `returning` | `{"name", "type"}` objects | Optional: one for each column the plan gives back, naming it; a column without a `type` has the type the plan gives it. Without it they are named `column1`, … and typed from the plan. |
| `source` | result columns | Optional: an `append`'s input columns, described as a [query](./query)'s `columns` are. |

## Result

The rows the plan gives back: an `append`'s, `update`'s or `delete`'s `returning` rows, or a graph write's rows. The
result also has:

| | |
|---|---|
| `changes` | The rows written; for a graph write, the sum of `graph`'s counts |
| `lastInsertRowid` | The rowid of the last row an `append` made |
| `graph` | For a plan that writes a graph: what it did, counted ([writing a property graph](../graph-writes)) |

They are not enumerable, so the rows compare and serialize as a query's do.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | The plan is not valid, or `returning` describes another number of columns than the plan gives back. |
| `SMALT_CONSTRAINT_*` | A row breaks a constraint: a primary key, a unique key, NOT NULL, a CHECK, a foreign key ([errors](../../api/errors)). |
| `SMALT_UNSUPPORTED` | A graph write where the engine can't run one ([writing a property graph](../graph-writes#order)). |

## Notes

- A `returning` expression reads the row written: the table's columns, then its rowid.
- A write that fails leaves nothing: the statement is rolled back, or, in a [transaction](./transaction), the
  statement's part of it.

## Examples

A new fruit, and the id it was given:

```json
{
  "kind": "write",
  "plan": {
    "op": "append",
    "table": "fruit",
    "db": "main",
    "input": {"op": "values", "types": ["text", "real", "int"], "rows": [[
      {"k": "lit", "value": "kiwi", "type": "text"},
      {"k": "lit", "value": 0.6, "type": "real"},
      {"k": "lit", "value": 8, "type": "int"}
    ]]},
    "columns": [1, 3, 4],
    "upserts": [],
    "returning": [
      {"k": "col", "input": 0, "index": 5, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}
    ]
  },
  "returning": [{"name": "id"}, {"name": "name"}]
}
```

| id | name |
|---|---|
| 6 | kiwi |

Column 5 of `fruit`'s row is its rowid, which is its `id`.

A primary key that is taken:

<!-- docs:error SMALT_CONSTRAINT_PRIMARYKEY -->
```json
{
  "kind": "write",
  "plan": {
    "op": "append",
    "table": "fruit",
    "db": "main",
    "input": {"op": "values", "types": ["int", "text"], "rows": [[{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": "quince", "type": "text"}]]},
    "columns": [0, 1],
    "upserts": []
  }
}
```

## Demo

Orders of 2 or fewer deleted, and the ids of the orders gone:

```json
{
  "kind": "write",
  "plan": {
    "op": "delete",
    "table": "orders",
    "db": "main",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "orders", "columns": [-1, 2]},
      "pred": {"k": "call", "fn": "cmp_le", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "bool"}
    },
    "rowid": 0,
    "returning": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}]
  },
  "returning": [{"name": "deleted"}]
}
```

| deleted |
|---|
| 2 |
| 3 |
| 6 |

## See also

- [`append`](../operations/append), [`update`](../operations/update), [`delete`](../operations/delete)
- [Writing a property graph](../graph-writes)
- [Statements](./)
