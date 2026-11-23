---
description: 'A value as an integer, or an error for one that isn''t: no prefixes of text, no saturation.'
---

# cast_integer_strict

```ebnf
cast_integer_strict ::= '"fn": "cast_integer_strict"' ', "args": [' X ']'
```

A value as an integer, or an error for a value that isn't one. Where [`cast_integer`](./cast_integer) reads a prefix of
text or saturates, this one fails. The [conversion table](../../conversions) uses it from `real`, `num` and `text` to
`int`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | An integer, a real, or text that is an integer. |

## Returns

`int`. NULL when `X` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `X` is text that is not an integer in full (`'4.2'`, `'12abc'`, `''`), or a blob. |
| `SMALT_RANGE` | `X` is outside the 64-bit range: a real beyond it, an infinity or NaN, or text of a larger integer. |

## Notes

- A real is truncated toward zero (`-3.9` gives -3) when the result fits in 64 bits.
- Text must be an integer in full: an optional sign and digits, with spaces around them allowed. A decimal point or an
  exponent in text is an error, though the same value as a real converts.
- It can be the `fn` of a [`cast`](../../expressions/cast) expression as well as a [`call`](../../expressions/call):
  `{"k": "cast", "fn": "cast_integer_strict", "to": "int", "arg": …}` gives the same value, with the type `to` names.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "cast_integer_strict", "args": [{"k": "lit", "value": 42, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "cast_integer_strict", "args": [{"k": "lit", "value": -3.9, "type": "real"}], "type": "int"},
      {"k": "call", "fn": "cast_integer_strict", "args": [{"k": "lit", "value": " +7 ", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "cast_integer_strict", "args": [{"k": "lit", "value": "-9223372036854775808", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "cast_integer_strict", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "int"}, {"name": "real"}, {"name": "text"}, {"name": "large"}, {"name": "null"}]
}
```

| int | real | text | large | null |
|---|---|---|---|---|
| 42 | -3 | 7 | -9223372036854775808 | NULL |

Text that only starts with an integer:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "op": "values",
  "types": ["int"],
  "rows": [[{"k": "call", "fn": "cast_integer_strict", "args": [{"k": "lit", "value": "12abc", "type": "text"}], "type": "int"}]]
}
```

A real beyond the 64-bit range, as a `cast` expression:

<!-- docs:error SMALT_RANGE -->
```json
{
  "op": "values",
  "types": ["int"],
  "rows": [[{"k": "cast", "fn": "cast_integer_strict", "to": "int", "arg": {"k": "lit", "value": 1e+30, "type": "real"}}]]
}
```

## Demo

Each fruit's price in whole units; a price too large for an integer would stop the query rather than saturate:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "cast_integer_strict", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "units"}]
}
```

| name | units |
|---|---|
| apple | 0 |
| pear | 0 |
| plum | 1 |
| cherry | 3 |
| lime | 0 |

## See also

- [`cast_integer`](./cast_integer), [`cast_real_strict`](./cast_real_strict)
- [Conversions](../../conversions): which conversion the engine uses from one type to another
- [`cast`](../../expressions/cast): a conversion as an expression
- [Conversion functions](./)
