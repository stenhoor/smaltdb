---
description: 'A struct''s field, by its position.'
---

# struct_field

```ebnf
struct_field ::= '"fn": "struct_field"' ', "args": [' STRUCT ',' INDEX ']'
```

The value of a struct's field, by its position from 0.

## Parameters

| Argument | Type | |
|---|---|---|
| `STRUCT` | `struct<…>` | The struct. |
| `INDEX` | `int` | The field's position, from 0. |

## Returns

The field's type: declare it as the call's `type`. NULL when `STRUCT` or `INDEX` is NULL, or when the field is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `STRUCT` isn't typed `struct<…>` (when the plan is compiled), or `INDEX` isn't an integer. |
| `SMALT_RANGE` | The struct has no field at `INDEX`. |

## Notes

- Only the field asked for is decoded.
- The engine doesn't work out the field's type from `INDEX`: the call declares it.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "real", "text"],
    "rows": [[
      {"k": "call", "fn": "struct_field", "args": [
        {"k": "call", "fn": "struct_of", "args": [
          {"k": "lit", "value": "apple", "type": "text"},
          {"k": "lit", "value": 0.5, "type": "real"}
        ], "type": "struct<name text, price real>"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "struct_field", "args": [
        {"k": "call", "fn": "struct_of", "args": [
          {"k": "lit", "value": "apple", "type": "text"},
          {"k": "lit", "value": 0.5, "type": "real"}
        ], "type": "struct<name text, price real>"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "struct_field", "args": [
        {"k": "lit", "value": null, "type": "struct<name text, price real>"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "name"}, {"name": "price"}, {"name": "null_struct"}]
}
```

| name | price | null_struct |
|---|---|---|
| apple | 0.5 | NULL |

A position the struct hasn't is an error:

<!-- docs:error SMALT_RANGE -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real"],
    "rows": [[
      {"k": "call", "fn": "struct_field", "args": [
        {"k": "call", "fn": "struct_of", "args": [
          {"k": "lit", "value": "apple", "type": "text"},
          {"k": "lit", "value": 0.5, "type": "real"}
        ], "type": "struct<name text, price real>"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"}
    ]]
  },
  "columns": [{"name": "field"}]
}
```

## Demo

The first entry of each node's properties (entries come in key order), each a struct of key and value:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "node", "columns": [0, 1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "struct_field", "args": [
        {"k": "call", "fn": "list_get", "args": [
          {"k": "call", "fn": "map_entries", "args": [
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"}
          ], "type": "list<struct<key text, value any>>"},
          {"k": "lit", "value": 0, "type": "int"}
        ], "type": "struct<key text, value any>"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "struct_field", "args": [
        {"k": "call", "fn": "list_get", "args": [
          {"k": "call", "fn": "map_entries", "args": [
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"}
          ], "type": "list<struct<key text, value any>>"},
          {"k": "lit", "value": 0, "type": "int"}
        ], "type": "struct<key text, value any>"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "any"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "key"}, {"name": "value"}]
}
```

| id | key | value |
|---|---|---|
| 0 | born | 1815 |
| 1 | born | 1912 |
| 2 | born | 1906 |
| 3 | born | 1930 |

## See also

- [`struct_of`](./struct_of), [`list_get`](./list_get)
- [`map_entries`](../map/map_entries)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
