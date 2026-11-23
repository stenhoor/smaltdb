---
description: 'A value as a real, as SQLite''s CAST(x AS REAL): never an error.'
---

# cast_real

```ebnf
cast_real ::= '"fn": "cast_real"' ', "args": [' X ']'
```

A value as a real, as SQLite's `CAST(x AS REAL)`. It never fails: what isn't a number becomes 0.0.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |

## Returns

`real`. NULL when `X` is NULL.

## Errors

None.

## Notes

- An integer beyond 2^53 is rounded to the nearest double (9007199254740993 gives 9007199254740992).
- Text and blobs are read by their longest numeric prefix, after leading spaces: `'12.5abc'` gives 12.5. Text that
  doesn't start with a number gives 0, and so does `'inf'`; a number too large for a double (`'1e400'`) gives
  `Infinity`.
- [`cast_real_strict`](./cast_real_strict) fails instead of guessing.
- It can be the `fn` of a [`cast`](../../expressions/cast) expression as well as a [`call`](../../expressions/call):
  `{"k": "cast", "fn": "cast_real", "to": "real", "arg": …}` gives the same value, with the type `to` names.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "cast_real", "args": [{"k": "lit", "value": 3, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "cast_real", "args": [{"k": "lit", "value": "12.5abc", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "cast_real", "args": [{"k": "lit", "value": "abc", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "cast_real", "args": [{"k": "lit", "value": {"$blob": "312e35"}, "type": "blob"}], "type": "real"},
      {"k": "call", "fn": "cast_real", "args": [{"k": "lit", "value": "1e400", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "cast_real", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "int"}, {"name": "prefix"}, {"name": "not_a_number"}, {"name": "blob"}, {"name": "too_large"}, {"name": "null"}]
}
```

| int | prefix | not_a_number | blob | too_large | null |
|---|---|---|---|---|---|
| 3 | 12.5 | 0 | 1.5 | Infinity | NULL |

The same conversion as a `cast` expression, so an integer divides as a real:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real"],
    "rows": [[
      {"k": "call", "fn": "div_trunc", "args": [
        {"k": "cast", "fn": "cast_real", "to": "real", "arg": {"k": "lit", "value": 7, "type": "int"}},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"}
    ]]
  },
  "columns": [{"name": "half"}]
}
```

| half |
|---|
| 3.5 |

## Demo

Each fruit's stock as a real, divided by 4 without truncating:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "div_trunc", "args": [
        {"k": "call", "fn": "cast_real", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "real"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "quarter"}]
}
```

| name | quarter |
|---|---|
| apple | 2.5 |
| pear | 1 |
| plum | NULL |
| cherry | 6.25 |
| lime | 0 |

## See also

- [`cast_real_strict`](./cast_real_strict), [`cast_integer`](./cast_integer), [`cast_numeric`](./cast_numeric), [`div_float`](../arithmetic/div_float)
- [Conversions](../../conversions): which conversion the engine uses from one type to another
- [`cast`](../../expressions/cast): a conversion as an expression
- [Conversion functions](./)
