---
description: 'A map under `any`, or a struct by field name, as a `map<text, any>`, else NULL.'
---

# any_map

```ebnf
any_map ::= '"fn": "any_map"' ', "args": [' X ']'
```

A map under `any`, or a struct by its field names, as a `map<text, any>`, else NULL. Its values keep their
types, as values under `any`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `any` | The value. |

## Returns

`map<text, any>`. NULL when `X` isn't a map or struct, or is NULL.

## Errors

None.

## Notes

- Give it a value typed `any`. A value whose type the plan knows reaches it as the engine holds that type (a `bool`
  as an integer, a list as a blob), so it isn't read as a typed value: `any_map` of an expression typed `bool` or
  `list<int>` gives NULL.
- A struct's fields become entries named for them, in key order, as a map's are.

## Examples

The function over each element of a list of mixed types, with [`each`](../../expressions/each): its elements are
values under `any`, `1`, `'a'`, a `bool`, NULL, a `list<int>` and a `map<text, int>`:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<map<text, any>>"],
    "rows": [[
      {"k": "each", "list": {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "bool"},
          {"k": "lit", "value": null, "type": "null"},
          {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}], "type": "list<int>"},
          {"k": "call", "fn": "map_of", "args": [{"k": "lit", "value": "k", "type": "text"}, {"k": "lit", "value": 1, "type": "int"}], "type": "map<text, int>"}
        ], "type": "list<any>"},
        "mode": "map",
        "body": {"k": "call", "fn": "any_map", "args": [{"k": "element", "part": "value", "depth": 0, "type": "any"}], "type": "map<text, any>"},
        "type": "list<map<text, any>>"}
    ]]
  },
  "columns": [{"name": "any_map"}]
}
```

| any_map |
|---|
| [null,null,null,null,null,{"k":1}] |

## Demo

Each person as a map of mixed values, its id and its properties, then the properties read back as a map. The id is
an integer, not a map:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "node", "columns": [0, 1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "any_map", "args": [{"k": "call", "fn": "map_get", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "id", "type": "text"},
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": "props", "type": "text"},
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"}
        ], "type": "map<text, any>"},
        {"k": "lit", "value": "props", "type": "text"}
      ], "type": "any"}], "type": "map<text, any>"},
      {"k": "call", "fn": "any_map", "args": [{"k": "call", "fn": "map_get", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "id", "type": "text"},
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": "props", "type": "text"},
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"}
        ], "type": "map<text, any>"},
        {"k": "lit", "value": "id", "type": "text"}
      ], "type": "any"}], "type": "map<text, any>"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "props"}, {"name": "not_a_map"}]
}
```

| id | props | not_a_map |
|---|---|---|
| 0 | {"born":1815,"name":"Ada"} | NULL |
| 1 | {"born":1912,"name":"Alan"} | NULL |
| 2 | {"born":1906,"name":"Grace"} | NULL |
| 3 | {"born":1930,"name":"Edsger"} | NULL |

## See also

- [`any_type`](./any_type), [`any_bool`](./any_bool), [`any_list`](./any_list)
- [Values under any](./)
- [`call`](../../expressions/call): how a plan calls a function
