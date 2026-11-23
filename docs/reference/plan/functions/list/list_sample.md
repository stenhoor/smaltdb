---
description: 'Elements of a list chosen at random, with or without replacement.'
---

# list_sample

```ebnf
list_sample ::= '"fn": "list_sample"' ', "args": [' LIST ',' N (',' WITH_REPLACEMENT (',' SEED)?)? ']'
```

`N` elements of a list chosen at random. Without replacement, each element is chosen at most once and they come in the
list's order; with replacement, an element may be chosen again and they come in the order drawn. A seed gives the same
choice each time.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |
| `N` | `int` | How many elements. |
| `WITH_REPLACEMENT` | `bool` | Optional: true lets an element be chosen more than once. NULL or left out is false. |
| `SEED` | `int` | Optional: a seed for the random numbers. NULL or left out takes a different choice each time. |

## Returns

`list<T>`, the list's type. NULL when `LIST` or `N` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |
| `SMALT_MISMATCH` | `N` or `SEED` isn't an integer. |
| `SMALT_RANGE` | `N` is negative; without replacement, `N` is more than the list has; with replacement, the list is empty and `N` isn't 0. |

## Notes

- The function isn't deterministic: without a seed, the same call may give a different list each time it runs.
- A seed fixes the choice for this engine; another engine, or another version of this one, may choose differently.
- Without replacement, `N` equal to the list's length gives the whole list.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<int>", "list<int>", "list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_sample", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"},
          {"k": "lit", "value": 5, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "lit", "value": 0, "type": "bool"},
        {"k": "lit", "value": 42, "type": "int"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_sample", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 5, "type": "int"},
        {"k": "lit", "value": 1, "type": "bool"},
        {"k": "lit", "value": 7, "type": "int"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_sample", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_sample", "args": [
        {"k": "lit", "value": null, "type": "list<int>"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "two"}, {"name": "replaced"}, {"name": "all"}, {"name": "null"}]
}
```

| two | replaced | all | null |
|---|---|---|---|
| [3,4] | [1,1,3,3,2] | [1,2,3] | NULL |

Without replacement, a list can't give more elements than it has:

<!-- docs:error SMALT_RANGE -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_sample", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 5, "type": "int"}
      ], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "x"}]
}
```

## Demo

Two of the fruit, chosen with a seed:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "aggregate",
      "input": {"op": "scan", "table": "fruit", "columns": [1]},
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
      {"k": "call", "fn": "list_sample", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "list<text>", "collation": "binary"},
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "lit", "value": 0, "type": "bool"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "list<text>"}
    ]
  },
  "columns": [{"name": "picked"}]
}
```

| picked |
|---|
| ["pear","cherry"] |

## See also

- [`list_gather`](./list_gather), [`list_shift`](./list_shift)
- [`random`](../general/random)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
