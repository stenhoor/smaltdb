---
description: 'The sum of the numbers of a list.'
---

# list_sum

```ebnf
list_sum ::= '"fn": "list_sum"' ', "args": [' LIST ']'
```

The sum of the non-NULL numbers of a list. A list with none sums to 0.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<int>`, `list<real>`, `list<num>` or `list<any>` | The list, of numbers. NULL elements are left out. |

## Returns

`int` for a list of `int` or `bool`, `real` for a list of `real`, else `num`. NULL when `LIST` is NULL; 0 for an empty
list or one of NULLs only.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |
| `SMALT_MISMATCH` | An element isn't a number (text or a blob). |

## Notes

- The [`sum`](../aggregate/sum) aggregate sums a group's values, and gives NULL for none.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "real", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "list_sum", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": null, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "int"},
      {"k": "call", "fn": "list_sum", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 0.5, "type": "real"},
          {"k": "lit", "value": 1.25, "type": "real"}
        ], "type": "list<real>"}
      ], "type": "real"},
      {"k": "call", "fn": "list_sum", "args": [{"k": "call", "fn": "list_of", "args": [], "type": "list<int>"}], "type": "int"},
      {"k": "call", "fn": "list_sum", "args": [{"k": "lit", "value": null, "type": "list<int>"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "reals"}, {"name": "empty"}, {"name": "null"}]
}
```

| ints | reals | empty | null |
|---|---|---|---|
| 7 | 1.75 | 0 | NULL |

## Demo

The number of things in each basket:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"},
      {"k": "call", "fn": "list_sum", "args": [
        {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "counts"}, {"name": "total"}]
}
```

| owner | counts | total |
|---|---|---|
| Ada | [2,1] | 3 |
| Alan | [6] | 6 |
| Grace | [] | 0 |
| Edsger | NULL | NULL |

## See also

- [`list_mean`](./list_mean), [`list_min`](./list_min), [`list_max`](./list_max)
- [`sum`](../aggregate/sum)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
