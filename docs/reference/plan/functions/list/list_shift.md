---
description: 'The elements of a list moved some places later or earlier, NULLs filling the places left.'
---

# list_shift

```ebnf
list_shift ::= '"fn": "list_shift"' ', "args": [' LIST (',' N)? ']'
```

The elements of a list moved `N` places later (earlier when `N` is negative), as Polars' `shift`. The list keeps its
length: elements moved past an end are dropped, and NULLs fill the places left.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |
| `N` | `int` | Optional: how many places. Left out, 1. |

## Returns

`list<T>`, the list's type. NULL when `LIST` or `N` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |
| `SMALT_MISMATCH` | `N` isn't an integer. |

## Notes

- [`list_diff`](./list_diff) takes each element less the one `N` places before it.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<int>", "list<int>", "list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_shift", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_shift", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": -1, "type": "int"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_shift", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 5, "type": "int"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_shift", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "later"}, {"name": "earlier"}, {"name": "past_end"}, {"name": "null_n"}]
}
```

| later | earlier | past_end | null_n |
|---|---|---|---|
| [null,1,2] | [2,3,null] | [null,null,null] | NULL |

## Demo

Each basket's counts, each next to the one before it:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"},
      {"k": "call", "fn": "list_shift", "args": [
        {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"}
      ], "type": "list<int>"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "counts"}, {"name": "previous"}]
}
```

| owner | counts | previous |
|---|---|---|
| Ada | [2,1] | [null,2] |
| Alan | [6] | [null] |
| Grace | [] | [] |
| Edsger | NULL | NULL |

## See also

- [`list_diff`](./list_diff), [`list_reverse`](./list_reverse)
- [`lag`](../window/lag)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
