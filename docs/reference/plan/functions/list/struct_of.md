---
description: 'A struct of its arguments, as the fields of the call''s type.'
---

# struct_of

```ebnf
struct_of ::= '"fn": "struct_of"' ', "args": [' X (',' X)* ']'
```

A struct of its arguments, one field each, in order. The call's declared `type` names the fields: `struct<name text,
price real>`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | A field's value. A NULL argument is a NULL field. |

## Returns

`struct<…>`, one field per argument: the call's declared type. Never NULL.

## Errors

None.

## Notes

- Results give a struct as an object by field name: `{"name":"apple","price":0.5}`.
- Read a field with [`struct_field`](./struct_field), by its position.
- A list of `struct<key text, value T>` is what [`map_from_entries`](../map/map_from_entries) takes and
  [`map_entries`](../map/map_entries) gives.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["struct<x real, y real>", "struct<name text, n int, xs list<int>>", "struct<name text, n int>"],
    "rows": [[
      {"k": "call", "fn": "struct_of", "args": [
        {"k": "lit", "value": 1.5, "type": "real"},
        {"k": "lit", "value": -2, "type": "real"}
      ], "type": "struct<x real, y real>"},
      {"k": "call", "fn": "struct_of", "args": [
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "struct<name text, n int, xs list<int>>"},
      {"k": "call", "fn": "struct_of", "args": [
        {"k": "lit", "value": "b", "type": "text"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "struct<name text, n int>"}
    ]]
  },
  "columns": [{"name": "point"}, {"name": "mixed"}, {"name": "with_null"}]
}
```

| point | mixed | with_null |
|---|---|---|
| {"x":1.5,"y":-2} | {"name":"a","n":1,"xs":[1,2]} | {"name":"b","n":null} |

## Demo

The red fruit as structs of name and price:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 2, 3]},
      "pred": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "red", "type": "text"}
      ], "type": "bool"}
    },
    "exprs": [
      {"k": "call", "fn": "struct_of", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "real", "collation": "binary"}
      ], "type": "struct<name text, price real>"}
    ]
  },
  "columns": [{"name": "fruit"}]
}
```

| fruit |
|---|
| {"name":"apple","price":0.5} |
| {"name":"cherry","price":3} |

## See also

- [`struct_field`](./struct_field), [`list_of`](./list_of)
- [`map_from_entries`](../map/map_from_entries)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
