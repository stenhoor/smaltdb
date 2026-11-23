---
description: 'The number of entries of a map.'
---

# map_len

```ebnf
map_len ::= '"fn": "map_len"' ', "args": [' MAP ']'
```

The number of entries of a map, keys with NULL values included.

## Parameters

| Argument | Type | |
|---|---|---|
| `MAP` | `map<text, T>` | The map. |

## Returns

`int`. NULL when `MAP` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `MAP` isn't typed `map<text, …>` (when the plan is compiled). |

## Notes

- A map has each key once, so a key given twice counts once.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "map_len", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "map<text, int>"}
      ], "type": "int"},
      {"k": "call", "fn": "map_len", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "map<text, int>"}
      ], "type": "int"},
      {"k": "call", "fn": "map_len", "args": [{"k": "call", "fn": "map_of", "args": [], "type": "map<text, int>"}], "type": "int"},
      {"k": "call", "fn": "map_len", "args": [{"k": "lit", "value": null, "type": "map<text, int>"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "two"}, {"name": "repeated"}, {"name": "empty"}, {"name": "null"}]
}
```

| two | repeated | empty | null |
|---|---|---|---|
| 2 | 1 | 0 | NULL |

Every map function takes a map typed `map<text, …>`; a list isn't one:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "map_len", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"}
        ], "type": "list<text>"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "n"}]
}
```

## Demo

The number of properties of each node:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "node", "columns": [0, 1]},
    "exprs": [
      {"k": "call", "fn": "map_get", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"},
        {"k": "lit", "value": "name", "type": "text"}
      ], "type": "any"},
      {"k": "call", "fn": "map_len", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "properties"}]
}
```

| name | properties |
|---|---|
| Ada | 2 |
| Alan | 2 |
| Grace | 2 |
| Edsger | 2 |

## See also

- [`map_keys`](./map_keys)
- [`list_len`](../list/list_len)
- [`call`](../../expressions/call): how a plan calls a function
- [Map functions](./)
