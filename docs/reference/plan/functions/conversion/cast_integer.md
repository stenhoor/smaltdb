---
description: 'A value as an integer, as SQLite''s CAST(x AS INTEGER): never an error.'
---

# cast_integer

```ebnf
cast_integer ::= '"fn": "cast_integer"' ', "args": [' X ']'
```

A value as an integer, as SQLite's `CAST(x AS INTEGER)`. It never fails: what isn't a number becomes 0, and a real too
large for 64 bits saturates.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |

## Returns

`int`. NULL when `X` is NULL.

## Errors

None.

## Notes

- A real is truncated toward zero (`-3.9` gives -3). Beyond the 64-bit range it saturates at 9223372036854775807 or
  -9223372036854775808, infinities included; NaN gives 0.
- Text and blobs are read by their longest numeric prefix, after leading spaces: `'12abc'` gives 12, `'3.9'` 3, `'1e3'`
  1000. Text that doesn't start with a number gives 0, and so does hexadecimal (`'0x1F'`).
- A `date`, `datetime`, `time` or `duration` gives the integer it is stored as: days since 1970-01-01, or microseconds.
- [`cast_integer_strict`](./cast_integer_strict) fails instead of guessing.
- It can be the `fn` of a [`cast`](../../expressions/cast) expression as well as a [`call`](../../expressions/call):
  `{"k": "cast", "fn": "cast_integer", "to": "int", "arg": …}` gives the same value, with the type `to` names.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "cast_integer", "args": [{"k": "lit", "value": -3.9, "type": "real"}], "type": "int"},
      {"k": "call", "fn": "cast_integer", "args": [{"k": "lit", "value": "12abc", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "cast_integer", "args": [{"k": "lit", "value": "1e3", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "cast_integer", "args": [{"k": "lit", "value": "abc", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "cast_integer", "args": [{"k": "lit", "value": 1e+30, "type": "real"}], "type": "int"},
      {"k": "call", "fn": "cast_integer", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "real"}, {"name": "prefix"}, {"name": "exponent"}, {"name": "not_a_number"}, {"name": "too_large"}, {"name": "null"}]
}
```

| real | prefix | exponent | not_a_number | too_large | null |
|---|---|---|---|---|---|
| -3 | 12 | 1000 | 0 | 9223372036854775807 | NULL |

The same conversion as a `cast` expression:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[{"k": "cast", "fn": "cast_integer", "to": "int", "arg": {"k": "lit", "value": " 42 ", "type": "text"}}]]
  },
  "columns": [{"name": "cast"}]
}
```

| cast |
|---|
| 42 |

## Demo

Each fruit's price in whole units, dropping the fraction:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
      {"k": "call", "fn": "cast_integer", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "price"}, {"name": "units"}]
}
```

| name | price | units |
|---|---|---|
| apple | 0.5 | 0 |
| pear | 0.75 | 0 |
| plum | 1.25 | 1 |
| cherry | 3 | 3 |
| lime | 0.4 | 0 |

## See also

- [`cast_integer_strict`](./cast_integer_strict), [`cast_real`](./cast_real), [`cast_numeric`](./cast_numeric), [`trunc`](../math/trunc)
- [Conversions](../../conversions): which conversion the engine uses from one type to another
- [`cast`](../../expressions/cast): a conversion as an expression
- [Conversion functions](./)
