---
description: 'A number with its fractional part dropped, rounding toward zero.'
---

# trunc

```ebnf
trunc ::= '"fn": "trunc"' ', "args": [' X ']'
```

`X` with its fractional part dropped: a real is rounded toward zero, and an integer is returned as it is.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

The argument's type: `int` for an `int`, unchanged; `real` for a `real`; `num` for another type (text, `num`, `any`).
NULL when `X` is NULL, a blob, or text that is not a number.

## Errors

None.

## Notes

- An integer is returned as it is, so integers beyond 2^53 keep every digit.
- NaN and infinities stay as they are.
- Of text, the result is a number under `num`, and a whole number there reads as an integer: `'2.1'` gives the integer
  3, where SQLite gives the REAL 3.0.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "int", "num", "real"],
    "rows": [[
      {"k": "call", "fn": "trunc", "args": [{"k": "lit", "value": 2.7, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "trunc", "args": [{"k": "lit", "value": -2.7, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "trunc", "args": [{"k": "lit", "value": -7, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "trunc", "args": [{"k": "lit", "value": "3.99", "type": "text"}], "type": "num"},
      {"k": "call", "fn": "trunc", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "positive"}, {"name": "negative"}, {"name": "int"}, {"name": "text"}, {"name": "null"}]
}
```

| positive | negative | int | text | null |
|---|---|---|---|---|
| 2 | -2 | -7 | 3 | NULL |

## Demo

Each fruit's price without its fraction:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
      {"k": "call", "fn": "trunc", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "price"}, {"name": "trunc"}]
}
```

| name | price | trunc |
|---|---|---|
| apple | 0.5 | 0 |
| pear | 0.75 | 0 |
| plum | 1.25 | 1 |
| cherry | 3 | 3 |
| lime | 0.4 | 0 |

## See also

- [`floor`](./floor), [`ceil`](./ceil), [`round`](./round), [`cast_integer`](../conversion/cast_integer)
- [Math functions](./)
