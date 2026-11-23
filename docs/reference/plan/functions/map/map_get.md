---
description: 'The value of a key of a map, or NULL when the map hasn''t the key.'
---

# map_get

```ebnf
map_get ::= '"fn": "map_get"' ', "args": [' MAP ',' KEY ']'
```

The value of a key of a map, or NULL when the map hasn't the key.

## Parameters

| Argument | Type | |
|---|---|---|
| `MAP` | `map<text, T>` | The map. |
| `KEY` | `text` | The key. |

## Returns

The map's value type: `T`, or `any` for a `map<text, any>`. NULL when `MAP` or `KEY` is NULL, when the map hasn't the
key, or when its value is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `MAP` isn't typed `map<text, …>` (when the plan is compiled). |
| `SMALT_MISMATCH` | `KEY` is a value other than text (a number, a blob). |

## Notes

- Keys match exactly, by their characters: `"Name"` isn't `"name"`.
- Only the value asked for is decoded. [`map_contains_key`](./map_contains_key) tells a missing key from a NULL value.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "map_get", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "lit", "value": "b", "type": "text"}
      ], "type": "int"},
      {"k": "call", "fn": "map_get", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "lit", "value": "c", "type": "text"}
      ], "type": "int"},
      {"k": "call", "fn": "map_get", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "lit", "value": "B", "type": "text"}
      ], "type": "int"},
      {"k": "call", "fn": "map_get", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "lit", "value": null, "type": "text"}
      ], "type": "int"},
      {"k": "call", "fn": "map_get", "args": [
        {"k": "lit", "value": null, "type": "map<text, int>"},
        {"k": "lit", "value": "a", "type": "text"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "found"}, {"name": "missing"}, {"name": "other_case"}, {"name": "null_key"}, {"name": "null_map"}]
}
```

| found | missing | other_case | null_key | null_map |
|---|---|---|---|---|
| 2 | NULL | NULL | NULL | NULL |

A key must be text:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "map_get", "args": [
        {"k": "call", "fn": "map_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "map<text, int>"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "v"}]
}
```

## Demo

Each person's name and year of birth, from the properties of the `social` graph's nodes:

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
      {"k": "call", "fn": "map_get", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "map<text, any>", "collation": "binary"},
        {"k": "lit", "value": "born", "type": "text"}
      ], "type": "any"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "born"}]
}
```

| name | born |
|---|---|
| Ada | 1815 |
| Alan | 1912 |
| Grace | 1906 |
| Edsger | 1930 |

## See also

- [`map_contains_key`](./map_contains_key), [`map_values`](./map_values)
- [`list_get`](../list/list_get), [`struct_field`](../list/struct_field)
- [`call`](../../expressions/call): how a plan calls a function
- [Map functions](./)
