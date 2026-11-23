---
description: 'Two values joined as text; NULL when either is NULL.'
---

# text_concat

```ebnf
text_concat ::= '"fn": "text_concat"' ', "args": [' LEFT ',' RIGHT ']'
```

The text of `LEFT` followed by the text of `RIGHT`. It is an operation: SQL's `||` is `text_concat`, and NULL on
either side makes the result NULL.

## Parameters

| Argument | Type | |
|---|---|---|
| `LEFT` | any | The first value. A number is taken as its text, a blob as its bytes read as UTF-8 text. |
| `RIGHT` | any | The second value, taken the same way. |

## Returns

`text`. NULL when either argument is NULL.

## Errors

None.

## Notes

- [`concat`](./concat) joins any number of values and skips NULLs.
- A real is written as SQLite writes it: `2.0` keeps its `.0`.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "text_concat", "args": [
        {"k": "lit", "value": "smalt", "type": "text"},
        {"k": "lit", "value": "db", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "text_concat", "args": [
        {"k": "lit", "value": "n", "type": "text"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "text"},
      {"k": "call", "fn": "text_concat", "args": [
        {"k": "lit", "value": "x", "type": "text"},
        {"k": "lit", "value": 2, "type": "real"}
      ], "type": "text"},
      {"k": "call", "fn": "text_concat", "args": [
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": null, "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "text"}, {"name": "int"}, {"name": "real"}, {"name": "null"}]
}
```

| text | int | real | null |
|---|---|---|---|
| smaltdb | n2 | x2.0 | NULL |

## Demo

Each fruit with its quantity; plum's is NULL, so its whole result is NULL:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "call", "fn": "text_concat", "args": [
        {"k": "call", "fn": "text_concat", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
          {"k": "lit", "value": ": ", "type": "text"}
        ], "type": "text"},
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "stock"}]
}
```

| stock |
|---|
| apple: 10 |
| pear: 4 |
| NULL |
| cherry: 25 |
| lime: 0 |

## See also

- [`concat`](./concat), [`concat_ws`](./concat_ws)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
