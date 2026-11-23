---
description: 'The position of the least element of a list.'
---

# list_arg_min

```ebnf
list_arg_min ::= '"fn": "list_arg_min"' ', "args": [' LIST ']'
```

The position, from 0, of the least non-NULL element of a list: the first one when several are equal.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |

## Returns

`int`. NULL when `LIST` is NULL or has no non-NULL element.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |

## Notes

- Elements compare as SQLite orders values, by the `binary` collation, so it takes text too.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "list_arg_min", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": null, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "int"},
      {"k": "call", "fn": "list_arg_min", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": "c", "type": "text"},
          {"k": "lit", "value": "a", "type": "text"}
        ], "type": "list<text>"}
      ], "type": "int"},
      {"k": "call", "fn": "list_arg_min", "args": [
        {"k": "call", "fn": "list_of", "args": [], "type": "list<int>"}
      ], "type": "int"},
      {"k": "call", "fn": "list_arg_min", "args": [{"k": "lit", "value": null, "type": "list<int>"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "text"}, {"name": "empty"}, {"name": "null"}]
}
```

| ints | text | empty | null |
|---|---|---|---|
| 2 | 2 | NULL | NULL |

## Demo

The item each basket holds fewest of: the item at the position of the smallest count.

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "list_get", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "list<text>", "collation": "binary"},
        {"k": "call", "fn": "list_arg_min", "args": [
          {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"}
        ], "type": "int"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "fewest"}]
}
```

| owner | fewest |
|---|---|
| Ada | pear |
| Alan | plum |
| Grace | NULL |
| Edsger | NULL |

## See also

- [`list_arg_max`](./list_arg_max), [`list_min`](./list_min), [`list_get`](./list_get)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
