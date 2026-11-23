---
description: 'Two lists, one after the other.'
---

# list_concat

```ebnf
list_concat ::= '"fn": "list_concat"' ', "args": [' LIST ',' LIST2 ']'
```

The elements of two lists, the first list's then the second's.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |
| `LIST2` | `list<T>` | The list to put after it. |

## Returns

`list<T>`, the first list's type. NULL when either list is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |

## Notes

- Give two lists of the same type: the engine doesn't check that the element types agree, and the result has the first
  list's type.
- [`list_union`](./list_union) keeps each element once.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<int>", "list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_concat", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"},
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_concat", "args": [
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "list<int>"},
        {"k": "call", "fn": "list_of", "args": [], "type": "list<int>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_concat", "args": [
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "list<int>"},
        {"k": "lit", "value": null, "type": "list<int>"}
      ], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "both"}, {"name": "empty"}, {"name": "null"}]
}
```

| both | empty | null |
|---|---|---|
| [1,2,2,3] | [1] | NULL |

## Demo

Each basket with a lime added at the end:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "list_concat", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "list<text>", "collation": "binary"},
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": "lime", "type": "text"}], "type": "list<text>"}
      ], "type": "list<text>"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "items"}]
}
```

| owner | items |
|---|---|
| Ada | ["apple","pear","lime"] |
| Alan | ["plum","lime"] |
| Grace | ["lime"] |
| Edsger | NULL |

## See also

- [`list_union`](./list_union), [`list_of`](./list_of)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
