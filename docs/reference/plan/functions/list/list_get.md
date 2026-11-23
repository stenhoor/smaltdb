---
description: 'The element at a position of a list, from 0; negative counts from the end.'
---

# list_get

```ebnf
list_get ::= '"fn": "list_get"' ', "args": [' LIST ',' INDEX (',' STRICT)? ']'
```

The element at a position of a list, from 0. A negative position counts from the end: -1 is the last element.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |
| `INDEX` | `int` | The position: from 0, or from the end when negative. |
| `STRICT` | `bool` | Optional: true makes a position out of range an error. NULL or left out is false. |

## Returns

The list's element type. NULL when `LIST` or `INDEX` is NULL, when the element is NULL, or when `INDEX` is out of range
and `STRICT` isn't true.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |
| `SMALT_MISMATCH` | `INDEX` isn't an integer (`1.5`, `'1'`). |
| `SMALT_RANGE` | `STRICT` is true and `INDEX` is out of range. |

## Notes

- Positions count from 0, as in Polars and JavaScript; SQL arrays that count from 1 need `INDEX` less one.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "list_get", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": "c", "type": "text"}
        ], "type": "list<text>"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "list_get", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": "c", "type": "text"}
        ], "type": "list<text>"},
        {"k": "lit", "value": -1, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "list_get", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": "c", "type": "text"}
        ], "type": "list<text>"},
        {"k": "lit", "value": 5, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "list_get", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": "c", "type": "text"}
        ], "type": "list<text>"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "first"}, {"name": "last"}, {"name": "out_of_range"}, {"name": "null_index"}]
}
```

| first | last | out_of_range | null_index |
|---|---|---|---|
| a | c | NULL | NULL |

With `STRICT` true, a position out of range is an error:

<!-- docs:error SMALT_RANGE -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text"],
    "rows": [[
      {"k": "call", "fn": "list_get", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": "c", "type": "text"}
        ], "type": "list<text>"},
        {"k": "lit", "value": 5, "type": "int"},
        {"k": "lit", "value": 1, "type": "bool"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "x"}]
}
```

## Demo

The first and last item of each basket:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "list_get", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "list<text>", "collation": "binary"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "list_get", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "list<text>", "collation": "binary"},
        {"k": "lit", "value": -1, "type": "int"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "first"}, {"name": "last"}]
}
```

| owner | first | last |
|---|---|---|
| Ada | apple | pear |
| Alan | plum | plum |
| Grace | NULL | NULL |
| Edsger | NULL | NULL |

## See also

- [`list_gather`](./list_gather), [`list_item`](./list_item), [`list_slice`](./list_slice), [`list_len`](./list_len)
- [`map_get`](../map/map_get)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
