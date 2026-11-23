---
description: 'The non-NULL elements of a list.'
---

# list_drop_nulls

```ebnf
list_drop_nulls ::= '"fn": "list_drop_nulls"' ', "args": [' LIST ']'
```

The non-NULL elements of a list, in order.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |

## Returns

`list<T>`, the list's type. NULL when `LIST` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |

## Notes

- The statistics (`list_sum`, `list_mean`, …) leave NULL elements out already.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<int>", "list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_drop_nulls", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": null, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_drop_nulls", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": null, "type": "int"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_drop_nulls", "args": [{"k": "lit", "value": null, "type": "list<int>"}], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "dropped"}, {"name": "all_null"}, {"name": "null"}]
}
```

| dropped | all_null | null |
|---|---|---|
| [1,2] | [] | NULL |

## Demo

The fruit quantities as a list, and without the one that is NULL:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "aggregate",
      "input": {"op": "scan", "table": "fruit", "columns": [4]},
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
      {"k": "call", "fn": "list_drop_nulls", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "list<int>", "collation": "binary"}
      ], "type": "list<int>"}
    ]
  },
  "columns": [{"name": "qty"}, {"name": "known"}]
}
```

| qty | known |
|---|---|
| [10,4,null,25,0] | [10,4,25,0] |

## See also

- [`list_len`](./list_len), [`list_count_matches`](./list_count_matches)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
