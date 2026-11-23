---
description: 'The first of several lists, when they all have as many elements; else an error.'
---

# list_same_lengths

```ebnf
list_same_lengths ::= '"fn": "list_same_lengths"' ', "args": [' LIST ',' LIST2 (',' LIST2)* ']'
```

The first of several lists, when every list has as many elements as it; else an error. A NULL list matches only another
NULL list. It checks that lists to be read side by side line up.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |
| `LIST2` | `list<…>` | Another list, of any element type. |

## Returns

`list<T>`, the first list's type: the first list itself. NULL when the lists are all NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |
| `SMALT_RANGE` | Two of the lists have different lengths, or one is NULL and another isn't. |

## Notes

- An [`explode`](../../operations/explode) with `also` columns checks each row's lists this way before it reads them
  side by side.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>", "list<int>", "list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_same_lengths", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"},
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"}
        ], "type": "list<text>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_same_lengths", "args": [
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "list<int>"},
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": "a", "type": "text"}], "type": "list<text>"},
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": 0.5, "type": "real"}], "type": "list<real>"}
      ], "type": "list<int>"},
      {"k": "call", "fn": "list_same_lengths", "args": [
        {"k": "lit", "value": null, "type": "list<int>"},
        {"k": "lit", "value": null, "type": "list<text>"}
      ], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "same"}, {"name": "three"}, {"name": "nulls"}]
}
```

| same | three | nulls |
|---|---|---|
| [1,2] | [1] | NULL |

Lists of different lengths are an error:

<!-- docs:error SMALT_RANGE -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["list<int>"],
    "rows": [[
      {"k": "call", "fn": "list_same_lengths", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "int"},
          {"k": "lit", "value": 2, "type": "int"}
        ], "type": "list<int>"},
        {"k": "call", "fn": "list_of", "args": [{"k": "lit", "value": "a", "type": "text"}], "type": "list<text>"}
      ], "type": "list<int>"}
    ]]
  },
  "columns": [{"name": "x"}]
}
```

## Demo

Each basket's counts, checked against its items: every basket has a count for each item.

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "list_same_lengths", "args": [
        {"k": "col", "input": 0, "index": 3, "depth": 0, "type": "list<int>", "collation": "binary"},
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "list<text>", "collation": "binary"}
      ], "type": "list<int>"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "counts"}]
}
```

| owner | counts |
|---|---|
| Ada | [2,1] |
| Alan | [6] |
| Grace | [] |
| Edsger | NULL |

## See also

- [`list_len`](./list_len)
- [`explode`](../../operations/explode)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
