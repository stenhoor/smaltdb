---
description: 'The median of the numbers of a list.'
---

# list_median

```ebnf
list_median ::= '"fn": "list_median"' ', "args": [' LIST ']'
```

The median of the non-NULL numbers of a list: the middle one in order, or the mean of the two in the middle when there
is an even number of them.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<int>`, `list<real>`, `list<num>` or `list<any>` | The list, of numbers. NULL elements are left out. |

## Returns

`real`. NULL when `LIST` is NULL or has no numbers.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |
| `SMALT_MISMATCH` | An element isn't a number (text or a blob). |

## Notes

- The [`median`](../aggregate/median) aggregate is the median of a group's values.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "list_median", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "real"},
      {"k": "call", "fn": "list_median", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 10, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "real"},
      {"k": "call", "fn": "list_median", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1.5, "type": "real"},
          {"k": "lit", "value": null, "type": "real"},
          {"k": "lit", "value": 0.5, "type": "real"}
        ], "type": "list<real>"}
      ], "type": "real"},
      {"k": "call", "fn": "list_median", "args": [
        {"k": "call", "fn": "list_of", "args": [], "type": "list<int>"}
      ], "type": "real"},
      {"k": "call", "fn": "list_median", "args": [{"k": "lit", "value": null, "type": "list<int>"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "odd"}, {"name": "even"}, {"name": "with_null"}, {"name": "empty"}, {"name": "null"}]
}
```

| odd | even | with_null | empty | null |
|---|---|---|---|---|
| 2 | 2.5 | 1 | NULL | NULL |

## Demo

The median count in each basket:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"},
      {"k": "call", "fn": "list_median", "args": [
        {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "counts"}, {"name": "median"}]
}
```

| owner | counts | median |
|---|---|---|
| Ada | [2,1] | 1.5 |
| Alan | [6] | 6 |
| Grace | [] | NULL |
| Edsger | NULL | NULL |

## See also

- [`list_mean`](./list_mean), [`list_min`](./list_min), [`list_max`](./list_max)
- [`median`](../aggregate/median)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
