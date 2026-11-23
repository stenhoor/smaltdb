---
description: 'The keys of a map, in key order.'
---

# map_keys

```ebnf
map_keys ::= '"fn": "map_keys"' ', "args": [' MAP ']'
```

The keys of a map as a list, in key order (by code point).

## Parameters

| Argument | Type | |
|---|---|---|
| `MAP` | `map<text, T>` | The map. |

## Returns

`list<text>`. NULL when `MAP` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `MAP` isn't typed `map<text, …>` (when the plan is compiled). |

## Notes

- [`map_values`](./map_values) gives the values in the same order.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<text>", "list<text>", "list<text>"],
    "rows": [[
      {"k": "call", "fn": "map_keys", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": "B", "type": "text"},
          {"k": "lit", "value": 3, "type": "int"}
        ], "type": "map<text, int>"}
      ], "type": "list<text>"},
      {"k": "call", "fn": "map_keys", "args": [
        {"k": "call", "fn": "map_of", "args": [], "type": "map<text, int>"}
      ], "type": "list<text>"},
      {"k": "call", "fn": "map_keys", "args": [{"k": "lit", "value": null, "type": "map<text, int>"}], "type": "list<text>"}
    ]]
  },
  "columns": [{"name": "keys"}, {"name": "empty"}, {"name": "null"}]
}
```

| keys | empty | null |
|---|---|---|
| ["B","a","b"] | [] | NULL |

## Demo

The property names of the first node:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "node", "columns": [0, 1]},
      "pred": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "bool"}
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "map_keys", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"}
      ], "type": "list<text>"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "keys"}]
}
```

| id | keys |
|---|---|
| 0 | ["born","name"] |

## See also

- [`map_values`](./map_values), [`map_entries`](./map_entries), [`map_contains_key`](./map_contains_key)
- [`call`](../../expressions/call): how a plan calls a function
- [Map functions](./)
