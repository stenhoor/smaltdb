---
description: 'A value as a real, or an error for text that isn''t a number in full and for blobs.'
---

# cast_real_strict

```ebnf
cast_real_strict ::= '"fn": "cast_real_strict"' ', "args": [' X ']'
```

A value as a real, or an error for one that isn't a number. Where [`cast_real`](./cast_real) reads a prefix of text,
this one fails. The [conversion table](../../conversions) uses it from `num` and `text` to `real`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | A number, or text that is a number. |

## Returns

`real`. NULL when `X` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `X` is text that is not a number in full (`'4.5x'`, `'Infinity'`), or a blob. |

## Notes

- Integers convert to the nearest double.
- Text must be a decimal number in full: an optional sign, digits with an optional point (`.5` and `5.` count), an
  optional exponent, and spaces around them. Words such as `Infinity` and hexadecimal are errors.
- It can be the `fn` of a [`cast`](../../expressions/cast) expression as well as a [`call`](../../expressions/call):
  `{"k": "cast", "fn": "cast_real_strict", "to": "real", "arg": …}` gives the same value, with the type `to` names.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "cast_real_strict", "args": [{"k": "lit", "value": 3, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "cast_real_strict", "args": [{"k": "lit", "value": "4.5", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "cast_real_strict", "args": [{"k": "lit", "value": "1e3", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "cast_real_strict", "args": [{"k": "lit", "value": " .5 ", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "cast_real_strict", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "int"}, {"name": "text"}, {"name": "exponent"}, {"name": "spaces"}, {"name": "null"}]
}
```

| int | text | exponent | spaces | null |
|---|---|---|---|---|
| 3 | 4.5 | 1000 | 0.5 | NULL |

Text with a unit after the number:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "op": "values",
  "types": ["real"],
  "rows": [[{"k": "call", "fn": "cast_real_strict", "args": [{"k": "lit", "value": "4.5x", "type": "text"}], "type": "real"}]]
}
```

## Demo

Each fruit's stock as a real, halved:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "mul", "args": [
        {"k": "call", "fn": "cast_real_strict", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "real"},
        {"k": "lit", "value": 0.5, "type": "real"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "half"}]
}
```

| name | half |
|---|---|
| apple | 5 |
| pear | 2 |
| plum | NULL |
| cherry | 12.5 |
| lime | 0 |

## See also

- [`cast_real`](./cast_real), [`cast_integer_strict`](./cast_integer_strict)
- [Conversions](../../conversions): which conversion the engine uses from one type to another
- [`cast`](../../expressions/cast): a conversion as an expression
- [Conversion functions](./)
