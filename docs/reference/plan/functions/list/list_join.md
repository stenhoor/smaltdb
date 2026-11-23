---
description: 'The elements of a list as text, joined by a separator.'
---

# list_join

```ebnf
list_join ::= '"fn": "list_join"' ', "args": [' LIST ',' SEPARATOR (',' KEEP_NULLS)? ']'
```

The non-NULL elements of a list as text, joined by a separator.

## Parameters

| Argument | Type | |
|---|---|---|
| `LIST` | `list<T>` | The list. |
| `SEPARATOR` | `text` | Put between elements. A number is taken as its text. |
| `KEEP_NULLS` | `bool` | Optional: true makes a NULL element make the whole result NULL. NULL or left out is false: NULL elements are left out. |

## Returns

`text`. NULL when `LIST` or `SEPARATOR` is NULL, or when `KEEP_NULLS` is true and an element is NULL. An empty list
gives the empty text.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | A list argument isn't typed `list<…>` (when the plan is compiled). |

## Notes

- Each element becomes text as [`cast_text`](../conversion/cast_text) makes it: a `real` keeps its point (`1.0`), and
  dates and times are their ISO text.
- The [`group_concat`](../aggregate/group_concat) aggregate joins a group's values; [`split`](../text/split) cuts text
  into a list.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "list_join", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": null, "type": "text"},
          {"k": "lit", "value": "b", "type": "text"}
        ], "type": "list<text>"},
        {"k": "lit", "value": ", ", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "list_join", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": null, "type": "text"},
          {"k": "lit", "value": "b", "type": "text"}
        ], "type": "list<text>"},
        {"k": "lit", "value": ", ", "type": "text"},
        {"k": "lit", "value": 1, "type": "bool"}
      ], "type": "text"},
      {"k": "call", "fn": "list_join", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": 1, "type": "real"},
          {"k": "lit", "value": 2.5, "type": "real"}
        ], "type": "list<real>"},
        {"k": "lit", "value": "/", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "list_join", "args": [
        {"k": "call", "fn": "list_of", "args": [], "type": "list<text>"},
        {"k": "lit", "value": ", ", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "list_join", "args": [
        {"k": "call", "fn": "list_of", "args": [
          {"k": "lit", "value": "a", "type": "text"},
          {"k": "lit", "value": "b", "type": "text"}
        ], "type": "list<text>"},
        {"k": "lit", "value": null, "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "joined"}, {"name": "keep_nulls"}, {"name": "reals"}, {"name": "empty"}, {"name": "null_sep"}]
}
```

| joined | keep_nulls | reals | empty | null_sep |
|---|---|---|---|---|
| a, b | NULL | 1.0/2.5 | `''` | NULL |

## Demo

Each basket's items as one text:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "baskets", "columns": [0, 1, 2, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "list_join", "args": [
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "list<text>", "collation": "binary"},
        {"k": "lit", "value": " and ", "type": "text"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "owner"}, {"name": "items"}]
}
```

| owner | items |
|---|---|
| Ada | apple and pear |
| Alan | plum |
| Grace | `''` |
| Edsger | NULL |

## See also

- [`split`](../text/split), [`group_concat`](../aggregate/group_concat), [`concat_ws`](../text/concat_ws)
- [`call`](../../expressions/call): how a plan calls a function
- [List and struct functions](./)
