---
description: 'The least number of a list.'
---

# list_min

```ebnf
list_min ::= '"fn": "list_min"' ', "args": [' LIST ']'
```

The least of the non-NULL numbers of a list.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<int>`, `list<real>`, `list<num>` or `list<any>` | The list, of numbers. NULL elements are left out. |

## Returns

The list's element type. NULL when `LIST` is NULL or has no numbers.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |
| `SMALT_MISMATCH` | An element isn't a number (text or a blob). |

## Notes

- It takes numbers only: a list of text is an error when it runs. [`list_sort`](./list_sort) and
  [`list_arg_min`](./list_arg_min) order text too.
- The [`min`](../aggregate/min) aggregate is the least of a group's values.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "real", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "list_min", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": null, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "int"},
      {"k": "call", "fn": "list_min", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 0.5, "type": "real"},
          {"k": "lit", "value": -1.25, "type": "real"}
        ], "type": "list<real>"}
      ], "type": "real"},
      {"k": "call", "fn": "list_min", "args": [{"k": "call", "fn": "list_of", "args": [], "type": "list<int>"}], "type": "int"},
      {"k": "call", "fn": "list_min", "args": [{"k": "lit", "value": null, "type": "list<int>"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "reals"}, {"name": "empty"}, {"name": "null"}]
}
```

| ints | reals | empty | null |
|---|---|---|---|
| 1 | -1.25 | NULL | NULL |

Text is no number:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text"],
    "rows": [[
      {"k": "call", "fn": "list_min", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": "a", "type": "text"}
        ], "type": "list<text>"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "least"}]
}
```

## Demo

The smallest count in each basket:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"},
      {"k": "call", "fn": "list_min", "args": [
        {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "counts"}, {"name": "least"}]
}
```

| owner | counts | least |
|---|---|---|
| Ada | [2,1] | 1 |
| Alan | [6] | 6 |
| Grace | [] | NULL |
| Edsger | NULL | NULL |

## See also

- [`list_max`](./list_max), [`list_arg_min`](./list_arg_min), [`list_sort`](./list_sort)
- [`min`](../aggregate/min), [`min`](../general/min) (scalar)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
