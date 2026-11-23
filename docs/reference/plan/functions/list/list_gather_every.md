---
description: 'Every n-th element of a list, from an offset.'
---

# list_gather_every

```ebnf
list_gather_every ::= '"fn": "list_gather_every"' ', "args": [' LIST ',' N (',' OFFSET)? ']'
```

Every `N`-th element of a list, from the one at `OFFSET`, as Polars' `list.gather_every`.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |
| `N` | `int` | The step: 1 takes every element, 2 every other one. |
| `OFFSET` | `int` | Optional: the first element's position, from 0. Left out, 0. |

## Returns

`list<T>`, the list's type. NULL when `LIST`, `N` or `OFFSET` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |
| `SMALT_MISMATCH` | `N` or `OFFSET` isn't an integer. |
| `SMALT_RANGE` | `N` isn't positive, or `OFFSET` is negative. |

## Notes

- An offset past the end gives `[]`.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<int>", "list<int>", "list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_gather_every", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 0, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"},
          {"k": "lit", "value": 5, "type": "int"},
          {"k": "lit", "value": 6, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_gather_every", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 0, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"},
          {"k": "lit", "value": 5, "type": "int"},
          {"k": "lit", "value": 6, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_gather_every", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 0, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 5, "type": "int"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_gather_every", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 0, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "every_3rd"}, {"name": "odd_places"}, {"name": "past_end"}, {"name": "null_n"}]
}
```

| every_3rd | odd_places | past_end | null_n |
|---|---|---|---|
| [0,3,6] | [1,3,5] | [] | NULL |

A step of 0 is an error:

<!-- docs:error SMALT_RANGE -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_gather_every", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 0, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "x"}]
}
```

## Demo

Every other fruit name, in order of id:

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
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "list<text>", "collation": "binary"},
      {"k": "call", "fn": "list_gather_every", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "list<text>", "collation": "binary"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "list<text>"}
    ]
  },
  "columns": [{"name": "names"}, {"name": "every_other"}]
}
```

| names | every_other |
|---|---|
| ["apple","pear","plum","cherry","lime"] | ["apple","plum","lime"] |

## See also

- [`list_gather`](./list_gather), [`list_slice`](./list_slice)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
