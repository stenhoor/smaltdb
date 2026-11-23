---
description: 'The difference of two numbers, where integer overflow and text are errors, and reals are IEEE 754.'
---

# sub_checked

```ebnf
sub_checked ::= '"fn": "sub_checked"' ', "args": [' X ',' Y ']'
```

`X` less `Y`, as [`sub`](./sub) gives it, except that an integer result outside the 64-bit range is an error rather than
a real, text is an error rather than converted, and a NaN result stays NaN. For a language whose arithmetic checks its
integers and has typed its operands, as Cypher's does.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number, or a date or time value as for `sub`. |
| `Y` | number | The same. |

## Returns

`int` for two integers, `real` when either is a `real`, else `num`, a temporal type for temporal operands as for `sub`:
declare the type of the value on the call. NULL when `X` or `Y` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_RANGE` | Two integers whose difference is outside the 64-bit range. |
| `SMALT_MISMATCH` | An operand is text or a blob. |

## Notes

- Reals follow IEEE 754 ([ADR 0018](../../../../adr/0018-bool-and-nan.md)): a NaN operand, or a NaN result such as
  `Infinity - Infinity`, gives NaN, where `sub` gives NULL.
- An integer and a real give a real. Integers are exact to 64 bits, `bigint` past 2^53.
- Dates and times work as for [`sub`](./sub).
- The errors arise while the plan runs, from the row that has the operands: a plan whose rows never overflow runs.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "real", "real", "duration", "int"],
    "rows": [[
      {"k": "call", "fn": "sub_checked", "args": [
        {"k": "lit", "value": 10, "type": "int"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "sub_checked", "args": [
        {"k": "lit", "value": 0.5, "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "sub_checked", "args": [
        {"k": "lit", "value": {"$real": "NaN"}, "type": "real"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "sub_checked", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-05", "type": "text"}], "type": "date"},
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-02", "type": "text"}], "type": "date"}
      ], "type": "duration"},
      {"k": "call", "fn": "sub_checked", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "real"}, {"name": "nan"}, {"name": "dates"}, {"name": "null"}]
}
```

| ints | real | nan | dates | null |
|---|---|---|---|---|
| 7 | -1.5 | NaN | P3D | NULL |

An integer result outside the 64-bit range, which `sub` would give as a real:

<!-- docs:error SMALT_RANGE -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "sub_checked", "args": [
        {"k": "lit", "value": {"$bigint": "-9223372036854775808"}, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "overflow"}]
}
```

Text, which `sub` would convert:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "sub_checked", "args": [
        {"k": "lit", "value": "2", "type": "text"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "text"}]
}
```

## Demo

How many of each order remain after one is sent:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "orders", "columns": [0, 2]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "sub_checked", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "left"}]
}
```

| id | left |
|---|---|
| 1 | 2 |
| 2 | 0 |
| 3 | 1 |
| 4 | 9 |
| 5 | 4 |
| 6 | 0 |

## See also

- [`sub`](./sub), [`add_checked`](./add_checked), [`mul_checked`](./mul_checked)
- [`cast_integer_strict`](../conversion/cast_integer_strict)
- [Arithmetic functions](./)
