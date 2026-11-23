---
description: 'A map of a list of key and value structs.'
---

# map_from_entries

```ebnf
map_from_entries ::= '"fn": "map_from_entries"' ', "args": [' ENTRIES ']'
```

A map of a list of entries, each a struct of a key and its value: the form [`map_entries`](./map_entries) gives.

## Parameters

| Argument | Type | |
|---|---|---|
| `ENTRIES` | `list<struct<key text, value T>>` | The entries: structs of two fields, the key (text) then the value. The fields' names don't matter. NULL entries are passed over. |

## Returns

`map<text, T>`, `T` the second field's type. NULL when `ENTRIES` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `ENTRIES` isn't typed as a list of two-field structs (when the plan is compiled), or a key isn't text (NULL, a number, a blob). |

## Notes

- A repeated key keeps its last value.
- The [`implode`](../aggregate/implode) aggregate of [`struct_of`](../list/struct_of) calls makes such a list of a
  group's rows.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["map<text, int>", "map<text, int>", "map<text, int>", "map<text, int>"],
    "rows": [[
      {"k": "call", "fn": "map_from_entries", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "call", "fn": "struct_of", "args": [
            {"k": "lit", "value": "b", "type": "text"},
            {"k": "lit", "value": 2, "type": "int"}
          ], "type": "struct<key text, value int>"},
          {"k": "call", "fn": "struct_of", "args": [
            {"k": "lit", "value": "a", "type": "text"},
            {"k": "lit", "value": 1, "type": "int"}
          ], "type": "struct<key text, value int>"}
        ], "type": "list<struct<key text, value int>>"}
      ], "type": "map<text, int>"},
      {"k": "call", "fn": "map_from_entries", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "call", "fn": "struct_of", "args": [
            {"k": "lit", "value": "a", "type": "text"},
            {"k": "lit", "value": 1, "type": "int"}
          ], "type": "struct<key text, value int>"},
          {"k": "call", "fn": "struct_of", "args": [
            {"k": "lit", "value": "a", "type": "text"},
            {"k": "lit", "value": 3, "type": "int"}
          ], "type": "struct<key text, value int>"},
          {"k": "lit", "value": null, "type": "struct<key text, value int>"}
        ], "type": "list<struct<key text, value int>>"}
      ], "type": "map<text, int>"},
      {"k": "call", "fn": "map_from_entries", "args": [
        {"k": "call", "fn": "list_of", "args": [], "type": "list<struct<key text, value int>>"}
      ], "type": "map<text, int>"},
      {"k": "call", "fn": "map_from_entries", "args": [
        {"k": "lit", "value": null, "type": "list<struct<key text, value int>>"}
      ], "type": "map<text, int>"}
    ]]
  },
  "columns": [{"name": "entries"}, {"name": "repeated"}, {"name": "empty"}, {"name": "null"}]
}
```

| entries | repeated | empty | null |
|---|---|---|---|
| {"a":1,"b":2} | {"a":3} | {} | NULL |

A list of anything else is refused:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["map<text, text>"],
    "rows": [[
      {"k": "call", "fn": "map_from_entries", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"}
        ], "type": "list<text>"}
      ], "type": "map<text, text>"}
    ]]
  },
  "columns": [{"name": "m"}]
}
```

## Demo

Every fruit's price, by name: [`implode`](../aggregate/implode) makes the list of entries, one per fruit.

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "aggregate",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
      "keys": [],
      "aggs": [
        {
          "fn": "implode",
          "args": [
            {"k": "call", "fn": "struct_of", "args": [
              {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
              {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}
            ], "type": "struct<key text, value real>"}
          ],
          "star": false,
          "distinct": false,
          "collation": "binary",
          "type": "list<struct<key text, value real>>"
        }
      ],
      "carry": []
    },
    "exprs": [
      {"k": "call", "fn": "map_from_entries", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "list<struct<key text, value real>>", "collation": "binary"}
      ], "type": "map<text, real>"}
    ]
  },
  "columns": [{"name": "prices"}]
}
```

| prices |
|---|
| {"apple":0.5,"cherry":3,"lime":0.4,"pear":0.75,"plum":1.25} |

## See also

- [`map_entries`](./map_entries), [`map_of`](./map_of)
- [`struct_of`](../list/struct_of), [`implode`](../aggregate/implode)
- [`call`](../../expressions/call): how a plan calls a function
- [Map functions](./)
