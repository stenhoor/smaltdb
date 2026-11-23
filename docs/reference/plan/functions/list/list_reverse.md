---
description: 'The elements of a list in reverse order.'
---

# list_reverse

```ebnf
list_reverse ::= '"fn": "list_reverse"' ', "args": [' LIST ']'
```

The elements of a list in reverse order.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |

## Returns

`list<T>`, the list's type. NULL when `LIST` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |

## Notes

- [`list_sort`](./list_sort) with `DESCENDING` true orders the elements from greatest to least instead.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<int>", "list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_reverse", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": null, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_reverse", "args": [
        {"k": "call", "fn": "list_of", "args": [], "type": "list<int>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_reverse", "args": [{"k": "lit", "value": null, "type": "list<int>"}], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "reversed"}, {"name": "empty"}, {"name": "null"}]
}
```

| reversed | empty | null |
|---|---|---|
| [3,null,1] | [] | NULL |

## Demo

Each basket's items, last first:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "list_reverse", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "list<text>", "collation": "binary"}
      ], "type": "list<text>"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "items"}]
}
```

| owner | items |
|---|---|
| Ada | ["pear","apple"] |
| Alan | ["plum"] |
| Grace | [] |
| Edsger | NULL |

## See also

- [`list_sort`](./list_sort), [`list_shift`](./list_shift)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
