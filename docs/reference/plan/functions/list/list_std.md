---
description: 'The standard deviation of the numbers of a list.'
---

# list_std

```ebnf
list_std ::= '"fn": "list_std"' ', "args": [' LIST (',' DDOF)? ']'
```

The standard deviation of the non-NULL numbers of a list: the square root of their [variance](./list_var) with `DDOF`
degrees of freedom taken away (1 by default, the sample standard deviation; 0 for the population's).

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

- The [`stddev_samp`](../aggregate/stddev_samp) and [`stddev_pop`](../aggregate/stddev_pop) aggregates are a group's
  standard deviations.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "list_std", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"},
          {"k": "lit", "value": 5, "type": "int"},
          {"k": "lit", "value": 5, "type": "int"},
          {"k": "lit", "value": 7, "type": "int"},
          {"k": "lit", "value": 9, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "real"},
      {"k": "call", "fn": "list_std", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"},
          {"k": "lit", "value": 5, "type": "int"},
          {"k": "lit", "value": 5, "type": "int"},
          {"k": "lit", "value": 7, "type": "int"},
          {"k": "lit", "value": 9, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "list_std", "args": [
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 5, "type": "int"}], "type": "list<int>"}
      ], "type": "real"},
      {"k": "call", "fn": "list_std", "args": [{"k": "lit", "value": null, "type": "list<int>"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "sample"}, {"name": "population"}, {"name": "one"}, {"name": "null"}]
}
```

| sample | population | one | null |
|---|---|---|---|
| 2.138089935299395 | 2 | NULL | NULL |

A negative `DDOF` is an error:

<!-- docs:error SMALT_RANGE -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real"],
    "rows": [[
      {"k": "call", "fn": "list_std", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": -1, "type": "int"}
      ], "type": "real"}
    ]]
  },
  "columns": [{"name": "s"}]
}
```

## Demo

The population standard deviation of each basket's counts:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"},
      {"k": "call", "fn": "list_std", "args": [
        {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "counts"}, {"name": "std"}]
}
```

| owner | counts | std |
|---|---|---|
| Ada | [2,1] | 0.5 |
| Alan | [6] | 0 |
| Grace | [] | NULL |
| Edsger | NULL | NULL |

## See also

- [`list_var`](./list_var), [`list_mean`](./list_mean)
- [`stddev_samp`](../aggregate/stddev_samp), [`stddev_pop`](../aggregate/stddev_pop)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
