---
description: 'Sets columns of the table rows its input names by rowid.'
---

# update

```railroad
update
column-set
```

Sets columns of the table rows its input names by rowid (SQL's `UPDATE`): for each input row, each of `sets` gives a
column of the row whose rowid is in the input's column `rowid` a new value, computed from the input row.

## Fields

| Field | Type | |
|---|---|---|
| `table` | string | The table to write. |
| `db` | `"main"` or `"temp"` | The table's schema. |
| `input` | operation | The rows to update: a [`scan`](./scan) of the table, or with `from` the scan joined with other sources; either under a [`filter`](./filter) or not. |
| `rowid` | integer | The input column holding each row's rowid. |
| `sets` | `{column, value}` list | The columns to set, by position in the table (`-1` the rowid), and their new values: expressions over the input row. |
| `from` | boolean | Whether `input` joins the table with other sources (SQL's `UPDATE … FROM`). |
| `onConflict` | [conflict action](./append#conflict-action) | Optional: the action for every constraint, in place of each constraint's own (SQL's `UPDATE OR …`). |
| `returning` | expressions | Optional: what to give back for each row updated, as expressions over the row as it is after the update: the table's columns, then its rowid. |

## Output

One row for each row updated, with a column for each of `returning`; none without it.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | The table doesn't exist, it has no such column, `rowid` is not a column of the input, or `onConflict` is not a conflict action. |
| `SMALT_CONSTRAINT_PRIMARYKEY`, `SMALT_CONSTRAINT_UNIQUE`, … | An updated row breaks a constraint whose action makes it an error. |
| `SMALT_INTERNAL` | `input` has another shape: the engine plans only those above. |

## Notes

- `sets` read the input row, as the input read it: the values before the update.
- With `from`, a table row the join matches several times is updated once, from one of its matches. Without it,
  each input row updates its row: a row named twice is updated twice, and the last update stays.
- A plan that holds an `update` is a `write` statement's ([statements](../statements)).
- An `update`'s input may not hold a write of a property graph ([writing a property graph](../graph-writes)).

## Examples

Double the price of the red fruit, giving back the new prices:

```json
{
  "kind": "write",
  "plan": {
    "op": "update",
    "table": "fruit",
    "db": "main",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [-1, 2, 3]},
      "pred": {"k": "call", "fn": "cmp_eq", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}, {"k": "lit", "value": "red", "type": "text"}], "type": "bool"}
    },
    "rowid": 0,
    "sets": [
      {"column": 3, "value": {"k": "call", "fn": "mul", "args": [{"k": "col", "input": 0, "index": 2, "depth": 0, "type": "real", "collation": "binary"}, {"k": "lit", "value": 2, "type": "int"}], "type": "real"}}
    ],
    "from": false,
    "returning": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "real", "collation": "binary"}
    ]
  },
  "returning": [{"name": "name"}, {"name": "price"}]
}
```

| name | price |
|---|---|
| apple | 1 |
| cherry | 6 |

Giving pear (rowid 2) the id apple has:

<!-- docs:error SMALT_CONSTRAINT_PRIMARYKEY -->
```json
{
  "kind": "write",
  "plan": {
    "op": "update",
    "table": "fruit",
    "db": "main",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [-1]},
      "pred": {"k": "call", "fn": "cmp_eq", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}, {"k": "lit", "value": 2, "type": "int"}], "type": "bool"}
    },
    "rowid": 0,
    "sets": [{"column": 0, "value": {"k": "lit", "value": 1, "type": "int"}}],
    "from": false
  }
}
```

## Demo

Take orders 2 and 4 out of stock: the fruit joined with those orders (`from`), each fruit's `qty` less the order's
`n`.

```json
{
  "kind": "write",
  "plan": {
    "op": "update",
    "table": "fruit",
    "db": "main",
    "input": {
      "op": "filter",
      "input": {
        "op": "join",
        "kind": "inner",
        "inputs": [{"op": "scan", "table": "fruit", "columns": [-1, 0, 4]}, {"op": "scan", "table": "orders", "columns": [0, 1, 2]}],
        "on": {
          "k": "call",
          "fn": "cmp_eq",
          "args": [
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
            {"k": "col", "input": 1, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
          ],
          "type": "bool"
        }
      },
      "pred": {
        "k": "call",
        "fn": "in_list",
        "args": [
          {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"}
        ],
        "type": "bool"
      }
    },
    "rowid": 0,
    "sets": [
      {"column": 4, "value": {"k": "call", "fn": "sub", "args": [{"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}, {"k": "col", "input": 0, "index": 5, "depth": 0, "type": "int", "collation": "binary"}], "type": "int"}}
    ],
    "from": true,
    "returning": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 4, "depth": 0, "type": "int", "collation": "binary"}
    ]
  },
  "returning": [{"name": "name"}, {"name": "qty"}]
}
```

| name | qty |
|---|---|
| pear | 3 |
| cherry | 15 |

The table after the writes on this page:

<!-- docs:unordered -->
```json
{
  "kind": "query",
  "plan": {"op": "scan", "table": "fruit", "columns": [1, 3, 4]},
  "columns": [{"name": "name"}, {"name": "price"}, {"name": "qty"}]
}
```

| name | price | qty |
|---|---|---|
| apple | 1 | 10 |
| pear | 0.75 | 3 |
| plum | 1.25 | NULL |
| cherry | 6 | 15 |
| lime | 0.4 | 0 |

## See also

- [`append`](./append), [`delete`](./delete): the other writes of a table
- [`graphSet`](./graphSet): sets properties in a property graph
- [Operations](./)
