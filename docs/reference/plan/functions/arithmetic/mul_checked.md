---
description: 'The product of two numbers, where integer overflow and text are errors, and reals are IEEE 754.'
---

# mul_checked

```ebnf
mul_checked ::= '"fn": "mul_checked"' ', "args": [' X ',' Y ']'
```

The product of `X` and `Y`, as [`mul`](./mul) gives it, except that an integer result outside the 64-bit range is an
error rather than a real, text is an error rather than converted, and a NaN result stays NaN. For a language whose
arithmetic checks its integers and has typed its operands, as Cypher's does.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number, or a `duration`. |
| `Y` | number | The same. |

## Returns

`int` for two integers, `real` when either is a `real`, else `num`, a `duration` for a `duration` and an `int`: declare
the type of the value on the call. NULL when `X` or `Y` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_RANGE` | Two integers whose product is outside the 64-bit range. |
| `SMALT_MISMATCH` | An operand is text or a blob. |

## Notes

- Reals follow IEEE 754 ([ADR 0018](../../../../adr/0018-bool-and-nan.md)): a NaN operand, or a NaN result such as
  `Infinity * 0`, gives NaN, where `mul` gives NULL.
- An integer and a real give a real. Integers are exact to 64 bits, `bigint` past 2^53.
- Dates and times work as for [`mul`](./mul).
- The errors arise while the plan runs, from the row that has the operands: a plan whose rows never overflow runs.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "real", "real", "duration", "int"],
    "rows": [[
      {"k": "call", "fn": "mul_checked", "args": [
        {"k": "lit", "value": 6, "type": "int"},
        {"k": "lit", "value": 7, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "mul_checked", "args": [
        {"k": "lit", "value": 0.5, "type": "real"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "mul_checked", "args": [
        {"k": "lit", "value": {"$real": "Infinity"}, "type": "real"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "mul_checked", "args": [
        {"k": "lit", "value": 3600000000, "type": "duration"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "duration"},
      {"k": "call", "fn": "mul_checked", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "real"}, {"name": "nan"}, {"name": "duration"}, {"name": "null"}]
}
```

| ints | real | nan | duration | null |
|---|---|---|---|---|
| 42 | 1.5 | NaN | PT2H | NULL |

An integer result outside the 64-bit range, which `mul` would give as a real:

<!-- docs:error SMALT_RANGE -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "mul_checked", "args": [
        {"k": "lit", "value": {"$bigint": "9223372036854775807"}, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "overflow"}]
}
```

Text, which `mul` would convert:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "mul_checked", "args": [
        {"k": "lit", "value": "2", "type": "text"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "text"}]
}
```

## Demo

The value of each fruit's stock:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "mul_checked", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "value"}]
}
```

| name | value |
|---|---|
| apple | 5 |
| pear | 3 |
| plum | NULL |
| cherry | 75 |
| lime | 0 |

## See also

- [`mul`](./mul), [`add_checked`](./add_checked), [`sub_checked`](./sub_checked)
- [`cast_integer_strict`](../conversion/cast_integer_strict)
- [Arithmetic functions](./)
