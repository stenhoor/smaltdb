---
description: 'The number of rows the last write statement inserted, updated or deleted.'
---

# changes

```ebnf
changes ::= '"fn": "changes"' ', "args": []'
```

The number of rows the last write statement inserted, updated or deleted, on this database connection.

## Parameters

None.

## Returns

`int`. Never NULL.

## Errors

None.

## Notes

- A query doesn't change it: it stays the last write's count until the next write.
- Inside a write (its `returning`), it is still the count of the write before.
- [`total_changes`](./total_changes) counts every change since the database was opened.

## Examples

An update of the two fruit with fewer than 5 in stock (pear and lime), then the count:

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

```json
{"kind": "query", "plan": {"op": "values", "types": ["int"], "rows": [[{"k": "call", "fn": "changes", "args": [], "type": "int"}]]}, "columns": [{"name": "changes"}]}
```

| changes |
|---|
| 2 |

## Demo

Deleting apple's orders, then the count: three rows:

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
{"kind": "query", "plan": {"op": "values", "types": ["int"], "rows": [[{"k": "call", "fn": "changes", "args": [], "type": "int"}]]}, "columns": [{"name": "deleted"}]}
```

| deleted |
|---|
| 3 |

## See also

- [`total_changes`](./total_changes), [`last_insert_rowid`](./last_insert_rowid)
- [Database state functions](./)
