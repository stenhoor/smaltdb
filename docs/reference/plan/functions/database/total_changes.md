---
description: 'The number of rows inserted, updated or deleted since the database was opened.'
---

# total_changes

```ebnf
total_changes ::= '"fn": "total_changes"' ', "args": []'
```

The number of rows inserted, updated or deleted on this database connection since it was opened.

## Parameters

None.

## Returns

`int`. Never NULL.

## Errors

None.

## Notes

- It counts from when the database was opened, so its value depends on everything written before: here, the sample
  data's writes too. The examples record it in a table and give the difference, which doesn't depend on them.
- Inside a write, it is the count from before the write: the row below records the count before itself.
- [`changes`](./changes) counts the last write's rows alone.

## Examples

A table to hold a count, the count recorded, then two fruit updated (pear and lime):

```json
{"kind": "schema", "op": {"op": "createTable", "temp": false, "ifNotExists": false, "table": {"name": "mark", "storage": "row", "columns": [{"name": "n", "declaredType": "INTEGER", "type": "INTEGER", "notNull": false, "collation": "binary"}], "keys": [], "checks": [], "foreignKeys": []}}}
```

```json
{
  "kind": "write",
  "plan": {
    "op": "append",
    "table": "mark",
    "db": "main",
    "input": {"op": "values", "types": ["int"], "rows": [[{"k": "call", "fn": "total_changes", "args": [], "type": "int"}]]},
    "columns": [0],
    "upserts": []
  }
}
```

```json
{
  "kind": "write",
  "plan": {
    "op": "update",
    "table": "fruit",
    "db": "main",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [-1, 4]},
      "pred": {"k": "call", "fn": "cmp_lt", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 5, "type": "int"}
      ], "type": "bool"}
    },
    "rowid": 0,
    "sets": [{"column": 4, "value": {"k": "lit", "value": 5, "type": "int"}}],
    "from": false
  }
}
```

The changes since: the recorded row itself, and the two updated:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "sub", "args": [
        {"k": "call", "fn": "total_changes", "args": [], "type": "int"},
        {"k": "subquery", "mode": "scalar", "plan": {"op": "scan", "table": "mark", "columns": [0]}, "type": "int", "collation": "binary"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "since_mark"}]
}
```

| since_mark |
|---|
| 3 |

## Demo

Apple's three orders deleted: three more changes since the mark:

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
      "pred": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "bool"}
    },
    "rowid": 0
  }
}
```

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "sub", "args": [
        {"k": "call", "fn": "total_changes", "args": [], "type": "int"},
        {"k": "subquery", "mode": "scalar", "plan": {"op": "scan", "table": "mark", "columns": [0]}, "type": "int", "collation": "binary"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "since_mark"}]
}
```

| since_mark |
|---|
| 6 |

## See also

- [`changes`](./changes), [`last_insert_rowid`](./last_insert_rowid)
- [Database state functions](./)
