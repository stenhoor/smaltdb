---
description: 'The text of its arguments joined, skipping NULLs.'
---

# concat

```ebnf
concat ::= '"fn": "concat"' ', "args": [' X (',' X)* ']'
```

The text of its arguments joined end to end. A NULL argument is skipped, so the result is never NULL.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | A value. A number is taken as its text, a blob as its bytes read as UTF-8 text. |

## Returns

`text`. Never NULL: when every argument is NULL, the empty text.

## Errors

None.

## Notes

- [`text_concat`](./text_concat) joins two values and gives NULL when either is NULL (SQL's `||`); `concat` skips
  NULLs.
- [`concat_ws`](./concat_ws) puts a separator between the values.
- A real is written as SQLite writes it: `2.0` keeps its `.0`.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "concat", "args": [
        {"k": "lit", "value": "smalt", "type": "text"},
        {"k": "lit", "value": "db", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "concat", "args": [
        {"k": "lit", "value": "a", "type": "text"},
        {"k": "lit", "value": null, "type": "text"},
        {"k": "lit", "value": "b", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "concat", "args": [
        {"k": "lit", "value": "n = ", "type": "text"},
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "lit", "value": ", x = ", "type": "text"},
        {"k": "lit", "value": 2, "type": "real"}
      ], "type": "text"},
      {"k": "call", "fn": "concat", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "text"}, {"name": "with_null"}, {"name": "numbers"}, {"name": "only_null"}]
}
```

| text | with_null | numbers | only_null |
|---|---|---|---|
| smaltdb | ab | n = 2, x = 2.0 | `''` |

## Demo

A label for each fruit; plum's quantity is NULL, so its label ends after ` x`:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "call", "fn": "concat", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
        {"k": "lit", "value": " x", "type": "text"},
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
      ], "type": "text"}
    ]
  },
  "columns": [{"name": "label"}]
}
```

| label |
|---|
| apple x10 |
| pear x4 |
| plum x |
| cherry x25 |
| lime x0 |

## See also

- [`concat_ws`](./concat_ws), [`text_concat`](./text_concat), [`printf`](./printf)
- [Text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
