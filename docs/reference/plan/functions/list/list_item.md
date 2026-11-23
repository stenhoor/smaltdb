---
description: 'The one element of a list of one; any other length is an error.'
---

# list_item

```ebnf
list_item ::= '"fn": "list_item"' ', "args": [' LIST ']'
```

The one element of a list that has exactly one. A list of any other length is an error.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |

## Returns

The list's element type. NULL when `LIST` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |
| `SMALT_RANGE` | The list hasn't exactly one element. |

## Notes

- Use it where a list must hold one value, such as the result of a lookup that should match once;
  [`list_get`](./list_get) at 0 takes the first element of any list.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "list_item", "args": [
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": "a", "type": "text"}], "type": "list<text>"}
      ], "type": "text"},
      {"k": "call", "fn": "list_item", "args": [
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "list<text>"}
      ], "type": "text"},
      {"k": "call", "fn": "list_item", "args": [{"k": "lit", "value": null, "type": "list<text>"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "one"}, {"name": "null_element"}, {"name": "null"}]
}
```

| one | null_element | null |
|---|---|---|
| a | NULL | NULL |

A list of two is an error:

<!-- docs:error SMALT_RANGE -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text"],
    "rows": [[
      {"k": "call", "fn": "list_item", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"}
        ], "type": "list<text>"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "x"}]
}
```

## Demo

The item of each basket that holds one:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "baskets", "columns": [1, 2]},
      "pred": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "call", "fn": "list_len", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "list<text>", "collation": "binary"}
        ], "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "bool"}
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "list_item", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "list<text>", "collation": "binary"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "item"}]
}
```

| owner | item |
|---|---|
| Alan | plum |

## See also

- [`list_get`](./list_get), [`list_len`](./list_len)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
