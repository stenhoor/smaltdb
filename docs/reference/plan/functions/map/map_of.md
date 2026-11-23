---
description: 'A map of keys and values given in pairs.'
---

# map_of

```ebnf
map_of ::= '"fn": "map_of"' ', "args": [' (KEY ',' VALUE (',' KEY ',' VALUE)*)? ']'
```

A map of keys and values given in pairs: `KEY, VALUE, KEY, VALUE, …`. With no arguments it gives the empty map. This is
how a plan writes a map: a `lit` can't hold one.

## Parameters

| Argument | Type | |
|---|---|---|
| `KEY` | `text` | A key. |
| `VALUE` | any | Its value. A NULL value is kept: the map has the key, with NULL. |

## Returns

`map<text, T>`, where `T` is the values' type when they agree (a NULL takes the others' type), else `any`. Declare it as
the call's `type`. Never NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | The arguments aren't in pairs (when the plan is compiled), or a key isn't text (NULL, a number, a blob). |

## Notes

- A repeated key keeps its last value.
- A map keeps its entries in key order (by code point: `"B"` before `"a"`), whatever order they were given in, so two
  maps of the same entries are equal values.
- Values of different types make a `map<text, any>`. A `bool`, list, struct or map in it keeps its type ([values under
  `any`](../any/)).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["map<text, int>", "map<text, int>", "map<text, any>", "map<text, int>", "map<text, int>"],
    "rows": [[
      {"k": "call", "fn": "map_of", "args": [
        {"k": "lit", "value": "b", "type": "text"},
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "map<text, int>"},
      {"k": "call", "fn": "map_of", "args": [
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "map<text, int>"},
      {"k": "call", "fn": "map_of", "args": [
        {"k": "lit", "value": "n", "type": "text"},
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": "ok", "type": "text"},
        {"k": "lit", "value": 1, "type": "bool"},
        {"k": "lit", "value": "xs", "type": "text"},
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "map<text, any>"},
      {"k": "call", "fn": "map_of", "args": [
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "map<text, int>"},
      {"k": "call", "fn": "map_of", "args": [], "type": "map<text, int>"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "repeated"}, {"name": "mixed"}, {"name": "null_value"}, {"name": "empty"}]
}
```

| ints | repeated | mixed | null_value | empty |
|---|---|---|---|---|
| {"a":1,"b":2} | {"a":3} | {"n":1,"ok":true,"xs":[1,2]} | {"a":null} | {} |

A key must be text:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["map<text, text>"],
    "rows": [[
      {"k": "call", "fn": "map_of", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": "one", "type": "text"}
      ], "type": "map<text, text>"}
    ]]
  },
  "columns": [{"name": "m"}]
}
```

## Demo

The green fruit's colour and price as a map, for each one:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 2, 3]},
      "pred": {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "green", "type": "text"}
      ], "type": "bool"}
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "map_of", "args": [
        {"k": "lit", "value": "color", "type": "text"},
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": "price", "type": "text"},
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "real", "collation": "binary"}
      ], "type": "map<text, any>"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "about"}]
}
```

| name | about |
|---|---|
| pear | {"color":"green","price":0.75} |
| lime | {"color":"green","price":0.4} |

## See also

- [`map_from_entries`](./map_from_entries), [`map_get`](./map_get), [`map_merge`](./map_merge)
- [`list_of`](../list/list_of), [`struct_of`](../list/struct_of)
- [`call`](../../expressions/call): how a plan calls a function
- [Map functions](./)
