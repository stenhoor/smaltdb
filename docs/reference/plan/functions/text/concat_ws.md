---
description: 'The text of its arguments joined with a separator, skipping NULLs.'
---

# concat_ws

```ebnf
concat_ws ::= '"fn": "concat_ws"' ', "args": [' SEPARATOR ',' X (',' X)* ']'
```

The text of the arguments after the first, joined with the first between them. NULL arguments are skipped, and take no
separator.

## Parameters

| Argument | Type | |
|---|---|---|
| `SEPARATOR` | `text` | What goes between the values. A number is taken as its text. |
| `X` | any | A value. A number is taken as its text, a blob as its bytes read as UTF-8 text. |

## Returns

`text`. NULL when `SEPARATOR` is NULL; the empty text when every `X` is NULL.

## Errors

None.

## Notes

- [`list_join`](../list/list_join) joins the items of a list; the aggregate
  [`group_concat`](../aggregate/group_concat) joins a column's values across rows.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "concat_ws", "args": [
        {"k": "lit", "value": "-", "type": "text"},
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": "b", "type": "text"},
        {"k": "lit", "value": "c", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "concat_ws", "args": [
        {"k": "lit", "value": "-", "type": "text"},
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": null, "type": "text"},
        {"k": "lit", "value": "c", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "concat_ws", "args": [
        {"k": "lit", "value": ", ", "type": "text"},
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 2.5, "type": "real"}
      ], "type": "text"},
      {"k": "call", "fn": "concat_ws", "args": [
        {"k": "lit", "value": "-", "type": "text"},
        {"k": "lit", "value": null, "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "concat_ws", "args": [
        {"k": "lit", "value": null, "type": "text"},
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": "b", "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "text"}, {"name": "with_null"}, {"name": "numbers"}, {"name": "only_null"}, {"name": "null_separator"}]
}
```

| text | with_null | numbers | only_null | null_separator |
|---|---|---|---|---|
| a-b-c | a-c | 1, 2.5 | `''` | NULL |

## Demo

Each fruit's name, colour and quantity in one line; plum's missing quantity leaves no trailing separator:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 2, 4]},
    "exprs": [
      {"k": "call", "fn": "concat_ws", "args": [
        {"k": "lit", "value": ", ", "type": "text"},
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "fruit"}]
}
```

| fruit |
|---|
| apple, red, 10 |
| pear, green, 4 |
| plum, purple |
| cherry, red, 25 |
| lime, green, 0 |

## See also

- [`concat`](./concat), [`text_concat`](./text_concat), [`list_join`](../list/list_join)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
