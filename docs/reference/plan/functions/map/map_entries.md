---
description: 'The entries of a map as a list of key and value structs, in key order.'
---

# map_entries

```ebnf
map_entries ::= '"fn": "map_entries"' ', "args": [' MAP ']'
```

The entries of a map as a list of structs of the key and its value, in key order: the form of a map as a list ([ADR
0020](../../../../adr/0020-lists-and-structs.md)).

## Parameters

| Argument | Type | |
|---|---|---|
| `MAP` | `map<text, T>` | The map. |

## Returns

`list<struct<key text, value T>>`, `T` the map's value type. NULL when `MAP` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `MAP` isn't typed `map<text, …>` (when the plan is compiled). |

## Notes

- [`map_from_entries`](./map_from_entries) turns the list back into a map.
- Read an entry's key and value with [`struct_field`](../list/struct_field), 0 and 1;
  [`explode`](../../operations/explode) gives an entry per row.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<struct<key text, value int>>", "list<struct<key text, value int>>", "list<struct<key text, value int>>"],
    "rows": [[
      {"k": "call", "fn": "map_entries", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "map<text, int>"}
      ], "type": "list<struct<key text, value int>>"},
      {"k": "call", "fn": "map_entries", "args": [
        {"k": "call", "fn": "map_of", "args": [], "type": "map<text, int>"}
      ], "type": "list<struct<key text, value int>>"},
      {"k": "call", "fn": "map_entries", "args": [
        {"k": "lit", "value": null, "type": "map<text, int>"}
      ], "type": "list<struct<key text, value int>>"}
    ]]
  },
  "columns": [{"name": "entries"}, {"name": "empty"}, {"name": "null"}]
}
```

| entries | empty | null |
|---|---|---|
| [{"key":"a","value":2},{"key":"b","value":1}] | [] | NULL |

## Demo

The properties of the first node as entries:

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
      {"k": "call", "fn": "map_entries", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"}
      ], "type": "list<struct<key text, value any>>"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "entries"}]
}
```

| id | entries |
|---|---|
| 0 | [{"key":"born","value":1815},{"key":"name","value":"Ada"}] |

## See also

- [`map_from_entries`](./map_from_entries), [`map_keys`](./map_keys), [`map_values`](./map_values)
- [`struct_field`](../list/struct_field)
- [`call`](../../expressions/call): how a plan calls a function
- [Map functions](./)
