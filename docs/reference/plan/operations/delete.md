---
description: 'Deletes the table rows its input names by rowid.'
---

# delete

```railroad
delete
```

Deletes the table rows its input names by rowid (SQL's `DELETE`): for each input row, the row whose rowid is in the
input's column `rowid`.

## Fields

| Field | Type | |
|---|---|---|
| `table` | string | The table to write. |
| `db` | `"main"` or `"temp"` | The table's schema. |
| `input` | operation | The rows to delete: a [`scan`](./scan), or a [`filter`](./filter) over one. |
| `rowid` | integer | The input column holding each row's rowid. |
| `returning` | expressions | Optional: what to give back for each row deleted, as expressions over it: the table's columns, then its rowid. |

## Output

One row for each row deleted, with a column for each of `returning`; none without it.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | The table doesn't exist, or `rowid` is not a column of the input. |
| `SMALT_INTERNAL` | `input` has another shape: the engine plans only a scan, under a filter or not. |

## Notes

- The scan gives the rowids, whatever table it reads: a plan deletes the rows of `table` with those rowids. A
  language's `DELETE` scans the table it deletes from.
- A rowid that no row has deletes nothing.
- A plan that holds a `delete` is a `write` statement's ([statements](../statements)).
- A `delete`'s input may not hold a write of a property graph ([the order a plan that writes a graph runs in](../graph-writes#order)).

## Examples

Delete the fruit out of stock, giving back their names:

```json
{
  "kind": "write",
  "plan": {
    "op": "delete",
    "table": "fruit",
    "db": "main",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [-1, 4]},
      "pred": {"k": "call", "fn": "cmp_eq", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}, {"k": "lit", "value": 0, "type": "int"}], "type": "bool"}
    },
    "rowid": 0,
    "returning": [
      {"k": "col", "input": 0, "index": 5, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}
    ]
  },
  "returning": [{"name": "rowid"}, {"name": "name"}]
}
```

| rowid | name |
|---|---|
| 5 | lime |

A `rowid` the input doesn't have:

<!-- docs:error SMALT_PLAN -->
```json
{
  "kind": "write",
  "plan": {
    "op": "delete",
    "table": "fruit",
    "db": "main",
    "input": {"op": "scan", "table": "fruit", "columns": [-1]},
    "rowid": 1
  }
}
```

## Demo

Delete the orders of fruit that cost more than 1, then show the orders left:

```json
{
  "kind": "write",
  "plan": {
    "op": "delete",
    "table": "orders",
    "db": "main",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "orders", "columns": [-1, 1]},
      "pred": {
        "k": "inSubquery",
        "probe": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        "plan": {
          "op": "project",
          "input": {
            "op": "filter",
            "input": {"op": "scan", "table": "fruit", "columns": [0, 3]},
            "pred": {"k": "call", "fn": "cmp_gt", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}, {"k": "lit", "value": 1, "type": "int"}], "type": "bool"}
          },
          "exprs": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}]
        },
        "collation": "binary"
      }
    },
    "rowid": 0
  }
}
```

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {"op": "scan", "table": "orders", "columns": [0, 1, 2]},
    "keys": [
      {"expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, "desc": false, "nullsFirst": true, "collation": "binary"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "fruit"}, {"name": "n"}]
}
```

| id | fruit | n |
|---|---|---|
| 1 | 1 | 3 |
| 2 | 2 | 1 |
| 3 | 1 | 2 |
| 6 | 1 | 1 |

## See also

- [`append`](./append), [`update`](./update): the other writes of a table
- [`graphDelete`](./graphDelete): deletes nodes and relationships of a property graph
- [Operations](./)
