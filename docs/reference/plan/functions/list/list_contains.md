---
description: 'Whether a list has an element equal to a value.'
---

# list_contains

```ebnf
list_contains ::= '"fn": "list_contains"' ', "args": [' LIST ',' VALUE (',' NULLS_EQUAL)? ']'
```

Whether a list has an element equal to a value. A NULL value looks for a NULL element.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |
| `VALUE` | any | The value to look for. |
| `NULLS_EQUAL` | `bool` | Optional: false (or NULL) makes a NULL `VALUE` give NULL instead of looking for a NULL element. |

## Returns

`bool`. NULL when `LIST` is NULL, or when `VALUE` is NULL and `NULLS_EQUAL` is given and isn't true.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |

## Notes

- Elements compare as SQLite compares values, by the `binary` collation: `1` equals `1.0`, `'1'` isn't `1`, and `'a'`
  isn't `'A'`.
- Unlike SQL's `IN`, a NULL element doesn't make the answer NULL: a value that no element equals gives false.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["bool", "bool", "bool", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "list_contains", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "list_contains", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 1, "type": "real"}
      ], "type": "bool"},
      {"k": "call", "fn": "list_contains", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "list_contains", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "bool"},
      {"k": "call", "fn": "list_contains", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 0, "type": "bool"}
      ], "type": "bool"},
      {"k": "call", "fn": "list_contains", "args": [
        {"k": "lit", "value": null, "type": "list<int>"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "bool"}
    ]]
  },
  "columns": [
    {"name": "found"},
    {"name": "by_value"},
    {"name": "missing"},
    {"name": "null_value"},
    {"name": "nulls_unequal"},
    {"name": "null_list"}
  ]
}
```

| found | by_value | missing | null_value | nulls_unequal | null_list |
|---|---|---|---|---|---|
| true | true | false | true | NULL | NULL |

## Demo

The baskets with a pear in them:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "baskets", "columns": [1, 2]},
      "pred": {"k": "call", "fn": "list_contains", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "list<text>", "collation": "binary"},
        {"k": "lit", "value": "pear", "type": "text"}
      ], "type": "bool"}
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "list<text>", "collation": "binary"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "items"}]
}
```

| owner | items |
|---|---|
| Ada | ["apple","pear"] |

## See also

- [`list_count_matches`](./list_count_matches), [`list_get`](./list_get)
- [`in_list`](../comparison/in_list), [`map_contains_key`](../map/map_contains_key)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
