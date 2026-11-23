---
description: 'Whether a map has a key.'
---

# map_contains_key

```ebnf
map_contains_key ::= '"fn": "map_contains_key"' ', "args": [' MAP ',' KEY ']'
```

Whether a map has a key, whatever its value: a key whose value is NULL is there.

## Parameters

| Argument | Type | |
|---|---|---|
| `MAP` | `map<text, T>` | The map. |
| `KEY` | `text` | The key. |

## Returns

`bool`. NULL when `MAP` or `KEY` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `MAP` isn't typed `map<text, …>` (when the plan is compiled). |
| `SMALT_MISMATCH` | `KEY` is a value other than text (a number, a blob). |

## Notes

- Keys match exactly, by their characters.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "map_contains_key", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "lit", "value": "a", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "map_contains_key", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "lit", "value": "b", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "map_contains_key", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "lit", "value": "c", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "map_contains_key", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "lit", "value": null, "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "map_contains_key", "args": [
        {"k": "lit", "value": null, "type": "map<text, int>"},
        {"k": "lit", "value": "a", "type": "text"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "has"}, {"name": "null_value"}, {"name": "missing"}, {"name": "null_key"}, {"name": "null_map"}]
}
```

| has | null_value | missing | null_key | null_map |
|---|---|---|---|---|
| true | true | false | NULL | NULL |

## Demo

Which nodes have a `born` property, and which a `died` one:

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
      {"k": "call", "fn": "map_contains_key", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"},
        {"k": "lit", "value": "born", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "map_contains_key", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"},
        {"k": "lit", "value": "died", "type": "text"}
      ], "type": "bool"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "born"}, {"name": "died"}]
}
```

| name | born | died |
|---|---|---|
| Ada | true | false |
| Alan | true | false |
| Grace | true | false |
| Edsger | true | false |

## See also

- [`map_get`](./map_get), [`map_keys`](./map_keys)
- [`list_contains`](../list/list_contains)
- [`call`](../../expressions/call): how a plan calls a function
- [Map functions](./)
