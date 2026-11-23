---
description: 'The values of a map, in key order.'
---

# map_values

```ebnf
map_values ::= '"fn": "map_values"' ', "args": [' MAP ']'
```

The values of a map as a list, in the order of their keys.

## Parameters

| Argument | Type | |
|---|---|---|
| `MAP` | `map<text, T>` | The map. |

## Returns

`list<T>`, `T` the map's value type. NULL when `MAP` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `MAP` isn't typed `map<text, …>` (when the plan is compiled). |

## Notes

- The values come in the order [`map_keys`](./map_keys) gives the keys, so the two line up by position.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<any>", "list<int>", "list<int>"],
    "rows": [[
      {"k": "call", "fn": "map_values", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": "c", "type": "text"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "map<text, int>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "map_values", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "x", "type": "text"},
          {"k": "lit", "value": "one", "type": "text"},
          {"k": "lit", "value": "y", "type": "text"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "map<text, any>"}
      ], "type": "list<any>"},
      {"k": "call", "fn": "map_values", "args": [
        {"k": "call", "fn": "map_of", "args": [], "type": "map<text, int>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "map_values", "args": [{"k": "lit", "value": null, "type": "map<text, int>"}], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "values"}, {"name": "mixed"}, {"name": "empty"}, {"name": "null"}]
}
```

| values | mixed | empty | null |
|---|---|---|---|
| [2,1,null] | ["one",2] | [] | NULL |

## Demo

The property values of each node:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "node", "columns": [0, 1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "map_values", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"}
      ], "type": "list<any>"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "values"}]
}
```

| id | values |
|---|---|
| 0 | [1815,"Ada"] |
| 1 | [1912,"Alan"] |
| 2 | [1906,"Grace"] |
| 3 | [1930,"Edsger"] |

## See also

- [`map_keys`](./map_keys), [`map_entries`](./map_entries), [`map_get`](./map_get)
- [`call`](../../expressions/call): how a plan calls a function
- [Map functions](./)
