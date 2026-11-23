---
description: 'The entries of two maps; where both have a key, the second map''s value.'
---

# map_merge

```ebnf
map_merge ::= '"fn": "map_merge"' ', "args": [' MAP ',' MAP2 ']'
```

The entries of two maps. Where both have a key, the second map's value wins, as Cypher's `SET n += map` sets properties.

## Parameters

| Argument | Type | |
|---|---|---|
| `MAP` | `map<text, T>` | The map. |
| `MAP2` | `map<text, U>` | The map whose entries win. |

## Returns

`map<text, T>` when the two maps' value types agree, else `map<text, any>`. NULL when either map is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `MAP` or `MAP2` isn't typed `map<text, …>` (when the plan is compiled). |

## Notes

- A NULL value in the second map is a value like any other: it replaces the first map's value with NULL, and the key
  stays.
- Maps of different value types merge into a `map<text, any>`, where a `bool`, list, struct or map keeps its type
  ([values under `any`](../any/)).
- To take keys away, use [`map_remove`](./map_remove).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["map<text, int>", "map<text, int>", "map<text, any>", "map<text, int>"],
    "rows": [[
      {"k": "call", "fn": "map_merge", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": 20, "type": "int"},
          {"k": "lit", "value": "c", "type": "text"},
          {"k": "lit", "value": 30, "type": "int"}
        ], "type": "map<text, int>"}
      ], "type": "map<text, int>"},
      {"k": "call", "fn": "map_merge", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "map<text, int>"}
      ], "type": "map<text, int>"},
      {"k": "call", "fn": "map_merge", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": "x", "type": "text"}
        ], "type": "map<text, text>"}
      ], "type": "map<text, any>"},
      {"k": "call", "fn": "map_merge", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "lit", "value": null, "type": "map<text, int>"}
      ], "type": "map<text, int>"}
    ]]
  },
  "columns": [{"name": "merged"}, {"name": "null_value"}, {"name": "types"}, {"name": "null"}]
}
```

| merged | null_value | types | null |
|---|---|---|---|
| {"a":1,"b":20,"c":30} | {"a":null} | {"a":1,"b":"x"} | NULL |

## Demo

The first node's properties with `born` replaced and `field` added:

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
      {"k": "call", "fn": "map_merge", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"},
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "born", "type": "text"},
          {"k": "lit", "value": 1816, "type": "int"},
          {"k": "lit", "value": "field", "type": "text"},
          {"k": "lit", "value": "computing", "type": "text"}
        ], "type": "map<text, any>"}
      ], "type": "map<text, any>"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "props"}]
}
```

| id | props |
|---|---|
| 0 | {"born":1816,"field":"computing","name":"Ada"} |

## See also

- [`map_remove`](./map_remove), [`map_of`](./map_of)
- [`list_concat`](../list/list_concat)
- [`call`](../../expressions/call): how a plan calls a function
- [Map functions](./)
