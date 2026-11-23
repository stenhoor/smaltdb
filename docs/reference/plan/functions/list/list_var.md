---
description: 'The variance of the numbers of a list.'
---

# list_var

```ebnf
list_var ::= '"fn": "list_var"' ', "args": [' LIST (',' DDOF)? ']'
```

The variance of the non-NULL numbers of a list: the sum of their squared distances from the mean, divided by their
number less `DDOF`. With the default `DDOF` of 1 it is the sample variance; with 0, the population variance.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<int>`, `list<real>`, `list<num>` or `list<any>` | The list, of numbers. NULL elements are left out. |
| `DDOF` | `int` | Optional: the degrees of freedom taken away. NULL or left out is 1. |

## Returns

`real`. NULL when `LIST` is NULL, or when it hasn't more numbers than `DDOF`.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |
| `SMALT_MISMATCH` | An element isn't a number (text or a blob). |
| `SMALT_MISMATCH` | `DDOF` isn't an integer. |
| `SMALT_RANGE` | `DDOF` is negative. |

## Notes

- The [`var_samp`](../aggregate/var_samp) and [`var_pop`](../aggregate/var_pop) aggregates are a group's variances.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "list_var", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "real"},
      {"k": "call", "fn": "list_var", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "list_var", "args": [
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 5, "type": "int"}], "type": "list<int>"}
      ], "type": "real"},
      {"k": "call", "fn": "list_var", "args": [{"k": "lit", "value": null, "type": "list<int>"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "sample"}, {"name": "population"}, {"name": "one"}, {"name": "null"}]
}
```

| sample | population | one | null |
|---|---|---|---|
| 1.6666666666666667 | 1.25 | NULL | NULL |

A negative `DDOF` is an error:

<!-- docs:error SMALT_RANGE -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real"],
    "rows": [[
      {"k": "call", "fn": "list_var", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": -1, "type": "int"}
      ], "type": "real"}
    ]]
  },
  "columns": [{"name": "v"}]
}
```

## Demo

The population variance of each basket's counts:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"},
      {"k": "call", "fn": "list_var", "args": [
        {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "counts"}, {"name": "variance"}]
}
```

| owner | counts | variance |
|---|---|---|
| Ada | [2,1] | 0.25 |
| Alan | [6] | 0 |
| Grace | [] | NULL |
| Edsger | NULL | NULL |

## See also

- [`list_std`](./list_std), [`list_mean`](./list_mean)
- [`var_samp`](../aggregate/var_samp), [`var_pop`](../aggregate/var_pop)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
