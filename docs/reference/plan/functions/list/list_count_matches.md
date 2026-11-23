---
description: 'The number of elements of a list equal to a value.'
---

# list_count_matches

```ebnf
list_count_matches ::= '"fn": "list_count_matches"' ', "args": [' LIST ',' VALUE ']'
```

The number of elements of a list equal to a value. A NULL value counts the NULL elements.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |
| `VALUE` | any | The value to count. |

## Returns

`int`. NULL when `LIST` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |

## Notes

- Numbers compare by value (`1` matches `1.0`); text matches only text, by its characters (`'a'` isn't `'A'`).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "list_count_matches", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "list_count_matches", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 1, "type": "real"}
      ], "type": "int"},
      {"k": "call", "fn": "list_count_matches", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "list_count_matches", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 5, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "list_count_matches", "args": [
        {"k": "lit", "value": null, "type": "list<int>"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "ones"}, {"name": "by_value"}, {"name": "nulls"}, {"name": "none"}, {"name": "null_list"}]
}
```

| ones | by_value | nulls | none | null_list |
|---|---|---|---|---|
| 2 | 2 | 1 | 0 | NULL |

## Demo

The quantities of the orders as a list (made by [`implode`](../aggregate/implode)), and how many of them are 1:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "aggregate",
      "input": {"op": "scan", "table": "orders", "columns": [2]},
      "keys": [],
      "aggs": [
        {
          "fn": "implode",
          "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}],
          "star": false,
          "distinct": false,
          "collation": "binary",
          "type": "list<int>"
        }
      ],
      "carry": []
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "list<int>", "collation": "binary"},
      {"k": "call", "fn": "list_count_matches", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "list<int>", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "n"}, {"name": "ones"}]
}
```

| n | ones |
|---|---|
| [3,1,2,10,5,1] | 2 |

## See also

- [`list_contains`](./list_contains), [`list_n_unique`](./list_n_unique)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
