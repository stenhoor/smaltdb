---
description: 'The elements in either of two lists, each once.'
---

# list_union

```ebnf
list_union ::= '"fn": "list_union"' ', "args": [' LIST ',' LIST2 ']'
```

The elements that are in either of two lists, each once: the first list's in order, then the second's that the first
hasn't.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |
| `LIST2` | `list<T>` | The other list. |

## Returns

`list<T>`, the first list's type, each element once. NULL when either list is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |

## Notes

- Elements are equal by value: numbers compare as numbers (`1` and `1.0` are one value), text by its characters (`'a'`
  and `'A'` are two), and NULL is one value.
- The result has the first list's type; give two lists of the same element type.
- [`list_concat`](./list_concat) keeps repeats.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<int>", "list<text>", "list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_union", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"}
        ], "type": "list<int>"},
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 4, "type": "int"},
          {"k": "lit", "value": 3, "type": "int"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_union", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": null, "type": "int"}
        ], "type": "list<int>"},
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": null, "type": "int"},
          {"k": "lit", "value": 5, "type": "int"}
        ], "type": "list<int>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_union", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"}
        ], "type": "list<text>"},
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "A", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"}
        ], "type": "list<text>"}
      ], "type": "list<text>"},
      {"k": "call", "fn": "list_union", "args": [
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "list<int>"},
        {"k": "lit", "value": null, "type": "list<int>"}
      ], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "nulls"}, {"name": "text"}, {"name": "null"}]
}
```

| ints | nulls | text | null |
|---|---|---|---|
| [1,2,3,4] | [1,null,5] | ["a","b","A"] | NULL |

## Demo

Each basket's items with a pear and a plum, each once:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "list<text>", "collation": "binary"},
      {"k": "call", "fn": "list_union", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "list<text>", "collation": "binary"},
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "pear", "type": "text"},
          {"k": "lit", "value": "plum", "type": "text"}
        ], "type": "list<text>"}
      ], "type": "list<text>"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "items"}, {"name": "result"}]
}
```

| owner | items | result |
|---|---|---|
| Ada | ["apple","pear"] | ["apple","pear","plum"] |
| Alan | ["plum"] | ["plum","pear"] |
| Grace | [] | ["pear","plum"] |
| Edsger | NULL | NULL |

## See also

- [`list_intersect`](./list_intersect), [`list_except`](./list_except), [`list_symmetric_except`](./list_symmetric_except), [`list_unique`](./list_unique)
- [`setop`](../../operations/setop)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
