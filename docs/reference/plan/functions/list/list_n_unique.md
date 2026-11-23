---
description: 'The number of distinct elements of a list.'
---

# list_n_unique

```ebnf
list_n_unique ::= '"fn": "list_n_unique"' ', "args": [' LIST ']'
```

The number of distinct elements of a list. NULL elements count as one value.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |

## Returns

`int`. NULL when `LIST` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |

## Notes

- Numbers are equal by value (`1` and `1.0` are one value); text by its characters (`'a'` and `'A'` are two). It counts
  what [`list_unique`](./list_unique) keeps.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "list_n_unique", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "int"},
      {"k": "call", "fn": "list_n_unique", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": null, "type": "text"},
          {"k": "lit", "value": "A", "type": "text"},
          {"k": "lit", "value": null, "type": "text"}
        ], "type": "list<text>"}
      ], "type": "int"},
      {"k": "call", "fn": "list_n_unique", "args": [
        {"k": "call", "fn": "list_of", "args": [], "type": "list<int>"}
      ], "type": "int"},
      {"k": "call", "fn": "list_n_unique", "args": [{"k": "lit", "value": null, "type": "list<int>"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "nulls"}, {"name": "empty"}, {"name": "null"}]
}
```

| ints | nulls | empty | null |
|---|---|---|---|
| 3 | 3 | 0 | NULL |

## Demo

The number of fruit and of distinct colours, from the list of every fruit's colour:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "aggregate",
      "input": {"op": "scan", "table": "fruit", "columns": [2]},
      "keys": [],
      "aggs": [
        {
          "fn": "implode",
          "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}],
          "star": false,
          "distinct": false,
          "collation": "binary",
          "type": "list<text>"
        }
      ],
      "carry": []
    },
    "exprs": [
      {"k": "call", "fn": "list_len", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "list<text>", "collation": "binary"}
      ], "type": "int"},
      {"k": "call", "fn": "list_n_unique", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "list<text>", "collation": "binary"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "fruit"}, {"name": "colors"}]
}
```

| fruit | colors |
|---|---|
| 5 | 3 |

## See also

- [`list_unique`](./list_unique), [`list_len`](./list_len), [`list_count_matches`](./list_count_matches)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
