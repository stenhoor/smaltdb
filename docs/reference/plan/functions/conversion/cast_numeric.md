---
description: 'A value as a number, integer or real, as SQLite''s CAST(x AS NUMERIC): never an error.'
---

# cast_numeric

```ebnf
cast_numeric ::= '"fn": "cast_numeric"' ', "args": [' X ']'
```

A value as a number, as SQLite's `CAST(x AS NUMERIC)`: an integer when the number is a whole one that fits in 64 bits,
else a real. It never fails: what isn't a number becomes 0.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |

## Returns

`num`. NULL when `X` is NULL.

## Errors

None.

## Notes

- Text and blobs are read by their longest numeric prefix, after leading spaces: `'12.0'` and `'1.5e2'` give the
  integers 12 and 150, `'-2.50 kg'` the real -2.5. Text that doesn't start with a number gives 0. A whole number beyond
  the 64-bit range (`'9223372036854775808'`) gives a real.
- Numbers keep their value. Under `num` a whole number reads as an integer, so the real 3.0 gives the integer 3, where
  SQLite keeps the REAL 3.0.
- It can be the `fn` of a [`cast`](../../expressions/cast) expression as well as a [`call`](../../expressions/call):
  `{"k": "cast", "fn": "cast_numeric", "to": "num", "arg": …}` gives the same value, with the type `to` names.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["num", "num", "num", "num", "num", "num"],
    "rows": [[
      {"k": "call", "fn": "cast_numeric", "args": [{"k": "lit", "value": "12", "type": "text"}], "type": "num"},
      {"k": "call", "fn": "cast_numeric", "args": [{"k": "lit", "value": "12.0", "type": "text"}], "type": "num"},
      {"k": "call", "fn": "cast_numeric", "args": [{"k": "lit", "value": "12.5", "type": "text"}], "type": "num"},
      {"k": "call", "fn": "cast_numeric", "args": [{"k": "lit", "value": "  -2.50 kg", "type": "text"}], "type": "num"},
      {"k": "call", "fn": "cast_numeric", "args": [{"k": "lit", "value": "abc", "type": "text"}], "type": "num"},
      {"k": "call", "fn": "cast_numeric", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "num"}
    ]]
  },
  "columns": [{"name": "int"}, {"name": "whole"}, {"name": "real"}, {"name": "prefix"}, {"name": "not_a_number"}, {"name": "null"}]
}
```

| int | whole | real | prefix | not_a_number | null |
|---|---|---|---|---|---|
| 12 | 12 | 12.5 | -2.5 | 0 | NULL |

The same conversion as a `cast` expression:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["num"],
    "rows": [[{"k": "cast", "fn": "cast_numeric", "to": "num", "arg": {"k": "lit", "value": "1.5e2", "type": "text"}}]]
  },
  "columns": [{"name": "cast"}]
}
```

| cast |
|---|
| 150 |

## Demo

Text a user typed, as numbers, then summed with each fruit's stock:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "add", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "call", "fn": "cast_numeric", "args": [{"k": "lit", "value": " 2 ", "type": "text"}], "type": "num"}
      ], "type": "num"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "plus_2"}]
}
```

| name | plus_2 |
|---|---|
| apple | 12 |
| pear | 6 |
| plum | NULL |
| cherry | 27 |
| lime | 2 |

## See also

- [`cast_integer`](./cast_integer), [`cast_real`](./cast_real), [`affinity_numeric`](./affinity_numeric)
- [Conversions](../../conversions): which conversion the engine uses from one type to another
- [`cast`](../../expressions/cast): a conversion as an expression
- [Conversion functions](./)
