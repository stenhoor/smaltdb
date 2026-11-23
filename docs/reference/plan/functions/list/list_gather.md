---
description: 'The elements of a list at the positions a list of indexes gives.'
---

# list_gather

```ebnf
list_gather ::= '"fn": "list_gather"' ', "args": [' LIST ',' INDEXES (',' STRICT)? ']'
```

The elements of a list at the positions a second list gives, in that list's order, as Polars' `list.gather`. Positions
count from 0; a negative one counts from the end.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |
| `INDEXES` | `list<int>` | The positions. A NULL position gives a NULL element. |
| `STRICT` | `bool` | Optional: true makes a position out of range an error. NULL or left out is false: such a position gives NULL. |

## Returns

`list<T>`, the list's type, as long as `INDEXES`. NULL when `LIST` or `INDEXES` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |
| `SMALT_MISMATCH` | A position isn't an integer. |
| `SMALT_RANGE` | `STRICT` is true and a position is out of range. |

## Notes

- A position may repeat: its element comes as often.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<text>", "list<text>", "list<text>", "list<text>"],
    "rows": [[
      {"k": "call", "fn": "list_gather", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": "c", "type": "text"}
        ], "type": "list<text>"},
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 0, "type": "int"},
          {"k": "lit", "value": -1, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "list<text>"},
      {"k": "call", "fn": "list_gather", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": "c", "type": "text"}
        ], "type": "list<text>"},
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 5, "type": "int"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "list<text>"},
      {"k": "call", "fn": "list_gather", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": "c", "type": "text"}
        ], "type": "list<text>"},
        {"k": "call", "fn": "list_of", "args": [], "type": "list<int>"}
      ], "type": "list<text>"},
      {"k": "call", "fn": "list_gather", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": "c", "type": "text"}
        ], "type": "list<text>"},
        {"k": "lit", "value": null, "type": "list<int>"}
      ], "type": "list<text>"}
    ]]
  },
  "columns": [{"name": "picked"}, {"name": "out_of_range"}, {"name": "none"}, {"name": "null"}]
}
```

| picked | out_of_range | none | null |
|---|---|---|---|
| ["c","a","c"] | ["b",null,null] | [] | NULL |

With `STRICT` true, a position out of range is an error:

<!-- docs:error SMALT_RANGE -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<text>"],
    "rows": [[
      {"k": "call", "fn": "list_gather", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": "c", "type": "text"}
        ], "type": "list<text>"},
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 5, "type": "int"}], "type": "list<int>"},
        {"k": "lit", "value": 1, "type": "bool"}
      ], "type": "list<text>"}
    ]]
  },
  "columns": [{"name": "x"}]
}
```

## Demo

The second and first item of each basket:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "list_gather", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "list<text>", "collation": "binary"},
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 0, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "list<text>"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "swapped"}]
}
```

| owner | swapped |
|---|---|
| Ada | ["pear","apple"] |
| Alan | [null,"plum"] |
| Grace | [null,null] |
| Edsger | NULL |

## See also

- [`list_get`](./list_get), [`list_gather_every`](./list_gather_every), [`list_slice`](./list_slice)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
