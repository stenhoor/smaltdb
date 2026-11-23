---
description: 'A list of its arguments, in order.'
---

# list_of

```ebnf
list_of ::= '"fn": "list_of"' ', "args": [' (X (',' X)*)? ']'
```

A list of its arguments, in order. With no arguments it gives the empty list. This is how a plan writes a list: a `lit`
can't hold one.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | An element. A NULL argument is a NULL element. |

## Returns

`list<T>`, where `T` is the arguments' type when they agree (a NULL takes the others' type), else `any`. Declare it as
the call's `type` (`list<int>`). Never NULL.

## Errors

None.

## Notes

- Arguments of different types make a `list<any>`. A `bool`, list, struct or map in it keeps its type ([values under
  `any`](../any/)): `[1,"a",[1]]`.
- Lists nest: an argument that is a list makes a `list<list<…>>`.
- The [`implode`](../aggregate/implode) aggregate makes a list of a group's values; [`split`](../text/split) makes one
  of the pieces of a text.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<text>", "list<any>", "list<list<int>>", "list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_of", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_of", "args": [
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": null, "type": "text"},
        {"k": "lit", "value": "b", "type": "text"}
      ], "type": "list<text>"},
      {"k": "call", "fn": "list_of", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "list<int>"}
      ], "type": "list<any>"},
      {"k": "call", "fn": "list_of", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"},
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 3, "type": "int"}], "type": "list<int>"}
      ], "type": "list<list<int>>"},
      {"k": "call", "fn": "list_of", "args": [], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "with_null"}, {"name": "mixed"}, {"name": "nested"}, {"name": "empty"}]
}
```

| ints | with_null | mixed | nested | empty |
|---|---|---|---|---|
| [1,2,3] | ["a",null,"b"] | [1,"a",[1]] | [[1,2],[3]] | [] |

## Demo

Each green fruit's name and colour as a list:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 2]},
      "pred": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "green", "type": "text"}
      ], "type": "bool"}
    },
    "exprs": [
      {"k": "call", "fn": "list_of", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"}
      ], "type": "list<text>"}
    ]
  },
  "columns": [{"name": "pair"}]
}
```

| pair |
|---|
| ["pear","green"] |
| ["lime","green"] |

## See also

- [`struct_of`](./struct_of), [`list_len`](./list_len), [`list_concat`](./list_concat)
- [`implode`](../aggregate/implode), [`map_of`](../map/map_of)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
