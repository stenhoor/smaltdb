---
description: 'A map without some keys.'
---

# map_remove

```ebnf
map_remove ::= '"fn": "map_remove"' ', "args": [' MAP ',' KEYS ']'
```

A map without the keys a list names. Keys it hasn't are passed over.

## Parameters

| Argument | Type | |
|---|---|---|
| `MAP` | `map<text, T>` | The map. |
| `KEYS` | `list<text>` | The keys to take away. NULL elements are passed over. |

## Returns

`map<text, T>`, the map's type. NULL when `MAP` is NULL. A NULL `KEYS` takes nothing away: the map as it is.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `MAP` isn't typed `map<text, …>` or `KEYS` isn't typed `list<…>` (when the plan is compiled), or a key in `KEYS` isn't text. |

## Notes

- Unlike most functions, a NULL `KEYS` doesn't make the result NULL.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["map<text, int>", "map<text, int>", "map<text, int>", "map<text, int>"],
    "rows": [[
      {"k": "call", "fn": "map_remove", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": "c", "type": "text"},
          {"k": "lit", "value": 3, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "c", "type": "text"},
          {"k": "lit", "value": "z", "type": "text"}
        ], "type": "list<text>"}
      ], "type": "map<text, int>"},
      {"k": "call", "fn": "map_remove", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": null, "type": "text"}
        ], "type": "list<text>"}
      ], "type": "map<text, int>"},
      {"k": "call", "fn": "map_remove", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "lit", "value": null, "type": "list<text>"}
      ], "type": "map<text, int>"},
      {"k": "call", "fn": "map_remove", "args": [
        {"k": "lit", "value": null, "type": "map<text, int>"},
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": "a", "type": "text"}], "type": "list<text>"}
      ], "type": "map<text, int>"}
    ]]
  },
  "columns": [{"name": "removed"}, {"name": "null_key"}, {"name": "null_keys"}, {"name": "null_map"}]
}
```

| removed | null_key | null_keys | null_map |
|---|---|---|---|
| {"b":2} | {"a":1} | {"a":1,"b":2} | NULL |

## Demo

Each node's properties without the year of birth:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "node", "columns": [0, 1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "map_remove", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"},
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": "born", "type": "text"}], "type": "list<text>"}
      ], "type": "map<text, any>"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "props"}]
}
```

| id | props |
|---|---|
| 0 | {"name":"Ada"} |
| 1 | {"name":"Alan"} |
| 2 | {"name":"Grace"} |
| 3 | {"name":"Edsger"} |

## See also

- [`map_merge`](./map_merge), [`map_contains_key`](./map_contains_key)
- [`list_except`](../list/list_except)
- [`call`](../../expressions/call): how a plan calls a function
- [Map functions](./)
