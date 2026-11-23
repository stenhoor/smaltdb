---
description: 'The elements of a list in order, NULLs first unless asked otherwise.'
---

# list_sort

```ebnf
list_sort ::= '"fn": "list_sort"' ', "args": [' LIST (',' DESCENDING (',' NULLS_LAST)?)? ']'
```

The elements of a list in ascending order, or descending. NULL elements come first unless `NULLS_LAST` is true, in
either direction.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |
| `DESCENDING` | `bool` | Optional: true sorts from greatest to least. NULL or left out is false. |
| `NULLS_LAST` | `bool` | Optional: true puts NULL elements last. NULL or left out is false. |

## Returns

`list<T>`, the list's type. NULL when `LIST` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |

## Notes

- Elements order as SQLite orders values, by the `binary` collation: numbers before text, text by its characters' code
  points (`'B'` before `'a'`).
- Descending order reverses the non-NULL elements only.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<int>", "list<int>", "list<text>", "list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_sort", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": null, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_sort", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": null, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 1, "type": "bool"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_sort", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": null, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"},
        {"k": "lit", "value": 1, "type": "bool"},
        {"k": "lit", "value": 1, "type": "bool"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_sort", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "b", "type": "text"},
          {"k": "lit", "value": "B", "type": "text"},
          {"k": "lit", "value": "a", "type": "text"}
        ], "type": "list<text>"}
      ], "type": "list<text>"},
      {"k": "call", "fn": "list_sort", "args": [{"k": "lit", "value": null, "type": "list<int>"}], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "ascending"}, {"name": "descending"}, {"name": "nulls_last"}, {"name": "text"}, {"name": "null"}]
}
```

| ascending | descending | nulls_last | text | null |
|---|---|---|---|---|
| [null,1,2,3] | [null,3,2,1] | [3,2,1,null] | ["B","a","b"] | NULL |

## Demo

Each basket's items in reverse alphabetical order:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "list_sort", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "list<text>", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "bool"}
      ], "type": "list<text>"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "items"}]
}
```

| owner | items |
|---|---|
| Ada | ["pear","apple"] |
| Alan | ["plum"] |
| Grace | [] |
| Edsger | NULL |

## See also

- [`list_reverse`](./list_reverse), [`list_unique`](./list_unique), [`list_min`](./list_min)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
