---
description: 'A conversion of a value to a type, by the conversion the plan names.'
---

# cast

```railroad
cast
```

A conversion of a value to a type, by the conversion the plan names. Nothing in a plan converts by itself: a language
says which conversion it means, SQLite's CAST (`cast_integer`) or a strict one that fails on what doesn't convert
(`cast_integer_strict`).

## Fields

| Field | Type | |
|---|---|---|
| `fn` | string | The conversion: one of the engine's conversion operations, below. |
| `to` | [type](../types) | The type of the result: the type `fn` gives. |
| `arg` | expression | The value to convert. |

and the [meaning fields](../meaning-fields) of an expression.

| `fn` | Gives | |
|---|---|---|
| [`cast_integer`](../functions/conversion/cast_integer) | `int` | SQLite's `CAST(x AS INTEGER)`: text by its numeric prefix (`'12abc'` gives 12). |
| [`cast_real`](../functions/conversion/cast_real) | `real` | SQLite's `CAST(x AS REAL)`. |
| [`cast_text`](../functions/conversion/cast_text) | `text` | SQLite's `CAST(x AS TEXT)`; a date or time as its result text, a list, struct or map as JSON. |
| [`cast_blob`](../functions/conversion/cast_blob) | `blob` | SQLite's `CAST(x AS BLOB)`: text as its UTF-8 bytes. |
| [`cast_numeric`](../functions/conversion/cast_numeric) | `num` | SQLite's `CAST(x AS NUMERIC)`. |
| [`cast_integer_strict`](../functions/conversion/cast_integer_strict) | `int` | An integer, or an error for what isn't one. |
| [`cast_real_strict`](../functions/conversion/cast_real_strict) | `real` | A real, or an error for what isn't a number. |
| [`affinity_numeric`](../functions/conversion/affinity_numeric), [`affinity_text`](../functions/conversion/affinity_text) | the value's type | The conversion SQLite applies to a comparison operand of that affinity. |

## Value

`fn` of `arg`. NULL when `arg` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_PLAN` | `fn` isn't one of the engine's operations: `cast_date`, `cast_datetime`, `cast_time` and the named functions (`upper`) are refused. |
| `SMALT_MISMATCH` | `cast_integer_strict` or `cast_real_strict` is given a value that isn't a number or all a number. |
| `SMALT_RANGE` | `cast_integer_strict` is given a number outside the 64-bit range. |

## Notes

- `to` states the result's type; the engine doesn't convert to it. `fn` does the converting, so `to` should be the
  type `fn` gives: `cast_text` with `"to": "int"` still gives text.
- The conversions to dates and times (`cast_date`, `cast_datetime`, `cast_time`) are functions: a
  [`call`](./call) names them, as it may name any of the operations above.
- Which conversion turns one type into another without loss is [the conversion table](../conversions).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "real", "text", "blob", "num", "int"],
    "rows": [[
      {"k": "cast", "fn": "cast_integer", "to": "int", "arg": {"k": "lit", "value": "12abc", "type": "text"}},
      {"k": "cast", "fn": "cast_real", "to": "real", "arg": {"k": "lit", "value": "2.5x", "type": "text"}},
      {"k": "cast", "fn": "cast_text", "to": "text", "arg": {"k": "lit", "value": 1, "type": "real"}},
      {"k": "cast", "fn": "cast_blob", "to": "blob", "arg": {"k": "lit", "value": "hi", "type": "text"}},
      {"k": "cast", "fn": "cast_numeric", "to": "num", "arg": {"k": "lit", "value": "3.0", "type": "text"}},
      {"k": "cast", "fn": "cast_integer", "to": "int", "arg": {"k": "lit", "value": null, "type": "text"}}
    ]]
  },
  "columns": [{"name": "integer"}, {"name": "real"}, {"name": "text"}, {"name": "blob"}, {"name": "numeric"}, {"name": "null"}]
}
```

| integer | real | text | blob | numeric | null |
|---|---|---|---|---|---|
| 12 | 2.5 | 1.0 | x'6869' | 3 | NULL |

The strict form refuses what SQLite's reads by its prefix:

<!-- docs:error SMALT_MISMATCH -->
```json
{"op": "values", "types": ["int"], "rows": [[{"k": "cast", "fn": "cast_integer_strict", "to": "int", "arg": {"k": "lit", "value": "12abc", "type": "text"}}]]}
```

A date conversion is a call, not a cast:

<!-- docs:error SMALT_PLAN -->
```json
{"op": "values", "types": ["date"], "rows": [[{"k": "cast", "fn": "cast_date", "to": "date", "arg": {"k": "lit", "value": "2026-11-23", "type": "text"}}]]}
```

## Demo

Each fruit's price as an integer and as text:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "cast", "fn": "cast_integer", "to": "int", "arg": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}},
      {"k": "cast", "fn": "cast_text", "to": "text", "arg": {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}}
    ]
  },
  "columns": [{"name": "name"}, {"name": "whole"}, {"name": "text"}]
}
```

| name | whole | text |
|---|---|---|
| apple | 0 | 0.5 |
| pear | 0 | 0.75 |
| plum | 1 | 1.25 |
| cherry | 3 | 3.0 |
| lime | 0 | 0.4 |

## See also

- [`call`](./call): a function, a date conversion included
- [Conversion functions](../functions/conversion/), [Conversions](../conversions)
- [Expressions](./)
