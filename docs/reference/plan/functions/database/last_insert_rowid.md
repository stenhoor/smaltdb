---
description: 'The rowid of the last row inserted.'
---

# last_insert_rowid

```ebnf
last_insert_rowid ::= '"fn": "last_insert_rowid"' ', "args": []'
```

The rowid of the last row inserted on this database connection.

## Parameters

None.

## Returns

`int`. Never NULL.

## Errors

None.

## Notes

- Updates, deletes and queries don't change it.
- Inside a write (its `returning`), it is still the rowid from before it.
- A table's single-column `INTEGER` primary key is its rowid: an insert that leaves it out is given the next rowid
  ([schema](../../../engine/schema)).

## Examples

Two fruit inserted, ids 6 and 7, then the rowid of the last:

```json
{
  "kind": "write",
  "plan": {
    "op": "append",
    "table": "fruit",
    "db": "main",
    "input": {
      "op": "values",
      "types": ["int", "text", "text"],
      "rows": [
        [{"k": "lit", "value": 6, "type": "int"}, {"k": "lit", "value": "kiwi", "type": "text"}, {"k": "lit", "value": "green", "type": "text"}],
        [{"k": "lit", "value": 7, "type": "int"}, {"k": "lit", "value": "fig", "type": "text"}, {"k": "lit", "value": "purple", "type": "text"}]
      ]
    },
    "columns": [0, 1, 2],
    "upserts": []
  }
}
```

```json
{"kind": "query", "plan": {"op": "values", "types": ["int"], "rows": [[{"k": "call", "fn": "last_insert_rowid", "args": [], "type": "int"}]]}, "columns": [{"name": "rowid"}]}
```

| rowid |
|---|
| 7 |

## Demo

An order inserted without its id: the table gives it the next rowid, and `last_insert_rowid` says which:

```json
{
  "kind": "write",
  "plan": {
    "op": "append",
    "table": "orders",
    "db": "main",
    "input": {
      "op": "values",
      "types": ["int", "int", "date"],
      "rows": [[
        {"k": "lit", "value": 5, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-06", "type": "text"}], "type": "date"}
      ]]
    },
    "columns": [1, 2, 3],
    "upserts": []
  }
}
```

```json
{"kind": "query", "plan": {"op": "values", "types": ["int"], "rows": [[{"k": "call", "fn": "last_insert_rowid", "args": [], "type": "int"}]]}, "columns": [{"name": "new_order"}]}
```

| new_order |
|---|
| 7 |

## See also

- [`changes`](./changes), [`total_changes`](./total_changes)
- [Database state functions](./)
