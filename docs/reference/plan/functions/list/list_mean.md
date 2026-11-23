---
description: 'The mean of the numbers of a list.'
---

# list_mean

```ebnf
list_mean ::= '"fn": "list_mean"' ', "args": [' LIST ']'
```

The arithmetic mean of the non-NULL numbers of a list.

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

- The [`avg`](../aggregate/avg) aggregate is the mean of a group's values.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "list_mean", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "real"},
      {"k": "call", "fn": "list_mean", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 0.5, "type": "real"},
          {"k": "lit", "value": 0.75, "type": "real"},
          {"k": "lit", "value": 1.25, "type": "real"}
        ], "type": "list<real>"}
      ], "type": "real"},
      {"k": "call", "fn": "list_mean", "args": [{"k": "call", "fn": "list_of", "args": [], "type": "list<int>"}], "type": "real"},
      {"k": "call", "fn": "list_mean", "args": [{"k": "lit", "value": null, "type": "list<int>"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "reals"}, {"name": "empty"}, {"name": "null"}]
}
```

| ints | reals | empty | null |
|---|---|---|---|
| 1.5 | 0.8333333333333334 | NULL | NULL |

## Demo

The mean count in each basket:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"},
      {"k": "call", "fn": "list_mean", "args": [
        {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "counts"}, {"name": "mean"}]
}
```

| owner | counts | mean |
|---|---|---|
| Ada | [2,1] | 1.5 |
| Alan | [6] | 6 |
| Grace | [] | NULL |
| Edsger | NULL | NULL |

## See also

- [`list_median`](./list_median), [`list_sum`](./list_sum), [`list_var`](./list_var)
- [`avg`](../aggregate/avg)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
