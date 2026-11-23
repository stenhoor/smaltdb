---
description: 'The elements of a list from an offset, a given number of them or to the end.'
---

# list_slice

```ebnf
list_slice ::= '"fn": "list_slice"' ', "args": [' LIST ',' OFFSET (',' LENGTH)? ']'
```

The elements of a list from an offset (from 0; negative counts from the end), `LENGTH` of them or, without it, to the
end.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |
| `OFFSET` | `int` | The first element's position: from 0, or from the end when negative. |
| `LENGTH` | `int` | Optional: how many elements, at most. NULL or left out takes the rest. |

## Returns

`list<T>`, the list's type. NULL when `LIST` or `OFFSET` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |
| `SMALT_MISMATCH` | `OFFSET` or `LENGTH` isn't an integer. |

## Notes

- A slice past either end is cut to the list: a negative offset beyond the start starts at the first element, and an
  offset past the end gives `[]`.
- A negative `LENGTH` gives `[]`.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<int>", "list<int>", "list<int>", "list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_slice", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_slice", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_slice", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": -2, "type": "int"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_slice", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 9, "type": "int"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_slice", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": 4, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "from_1"}, {"name": "two_from_1"}, {"name": "last_two"}, {"name": "past_end"}, {"name": "null_offset"}]
}
```

| from_1 | two_from_1 | last_two | past_end | null_offset |
|---|---|---|---|---|
| [2,3,4] | [2,3] | [3,4] | [] | NULL |

## Demo

Each basket's items after the first:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "list_slice", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "list<text>", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "list<text>"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "rest"}]
}
```

| owner | rest |
|---|---|
| Ada | ["pear"] |
| Alan | [] |
| Grace | [] |
| Edsger | NULL |

## See also

- [`list_get`](./list_get), [`list_gather`](./list_gather), [`list_gather_every`](./list_gather_every)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
