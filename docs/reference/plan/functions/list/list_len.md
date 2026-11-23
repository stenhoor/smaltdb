---
description: 'The number of elements of a list.'
---

# list_len

```ebnf
list_len ::= '"fn": "list_len"' ', "args": [' LIST ']'
```

The number of elements of a list, NULL elements included.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |

## Returns

`int`. NULL when `LIST` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |

## Notes

- Every list function takes a list typed `list<…>`: a plan that gives one a value of another type is refused when it is
  compiled (`SMALT_MISMATCH`), as the error example shows. A `lit` of value `null` may carry a list type (`list<int>`).
- [`map_len`](../map/map_len) counts a map's entries; [`length`](../text/length) counts a text's characters.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "list_len", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "int"},
      {"k": "call", "fn": "list_len", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": null, "type": "text"}
        ], "type": "list<text>"}
      ], "type": "int"},
      {"k": "call", "fn": "list_len", "args": [{"k": "call", "fn": "list_of", "args": [], "type": "list<int>"}], "type": "int"},
      {"k": "call", "fn": "list_len", "args": [{"k": "lit", "value": null, "type": "list<int>"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "three"}, {"name": "with_null"}, {"name": "empty"}, {"name": "null"}]
}
```

| three | with_null | empty | null |
|---|---|---|---|
| 3 | 2 | 0 | NULL |

Text isn't a list, even when it reads as one:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[{"k": "call", "fn": "list_len", "args": [{"k": "lit", "value": "[1,2]", "type": "text"}], "type": "int"}]]
  },
  "columns": [{"name": "n"}]
}
```

## Demo

The number of items in each basket:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "list_len", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "list<text>", "collation": "binary"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "items"}]
}
```

| owner | items |
|---|---|
| Ada | 2 |
| Alan | 1 |
| Grace | 0 |
| Edsger | NULL |

## See also

- [`list_get`](./list_get), [`list_item`](./list_item)
- [`map_len`](../map/map_len)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
