---
description: 'The sum of two numbers, where integer overflow and text are errors, and reals are IEEE 754.'
---

# add_checked

```ebnf
add_checked ::= '"fn": "add_checked"' ', "args": [' X ',' Y ']'
```

The sum of `X` and `Y`, as [`add`](./add) gives it, except that an integer result outside the 64-bit range is an error
rather than a real, text is an error rather than converted, and a NaN result stays NaN. For a language whose arithmetic
checks its integers and has typed its operands, as Cypher's does.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number, or a date or time value as for `add`. |
| `Y` | number | The same. |

## Returns

`int` for two integers, `real` when either is a `real`, else `num`, a temporal type for temporal operands as for `add`:
declare the type of the value on the call. NULL when `X` or `Y` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_RANGE` | Two integers whose sum is outside the 64-bit range. |
| `SMALT_MISMATCH` | An operand is text or a blob. |

## Notes

- Reals follow IEEE 754 ([ADR 0018](../../../../adr/0018-bool-and-nan.md)): a NaN operand, or a NaN result such as
  `Infinity - Infinity`, gives NaN, where `add` gives NULL.
- An integer and a real give a real. Integers are exact to 64 bits, `bigint` past 2^53.
- Dates and times work as for [`add`](./add).
- The errors arise while the plan runs, from the row that has the operands: a plan whose rows never overflow runs.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "real", "real", "int"],
    "rows": [[
      {"k": "call", "fn": "add_checked", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "add_checked", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 2.5, "type": "real"}
      ], "type": "real"},
      {"k": "call", "fn": "add_checked", "args": [
        {"k": "lit", "value": {"$real": "Infinity"}, "type": "real"},
        {"k": "lit", "value": {"$real": "-Infinity"}, "type": "real"}
      ], "type": "real"},
      {"k": "call", "fn": "add_checked", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "real"}, {"name": "nan"}, {"name": "null"}]
}
```

| ints | real | nan | null |
|---|---|---|---|
| 3 | 3.5 | NaN | NULL |

An integer result outside the 64-bit range, which `add` would give as a real:

<!-- docs:error SMALT_RANGE -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "add_checked", "args": [
        {"k": "lit", "value": {"$bigint": "9223372036854775807"}, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "overflow"}]
}
```

Text, which `add` would convert:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "add_checked", "args": [
        {"k": "lit", "value": "2", "type": "text"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "text"}]
}
```

## Demo

Each fruit's price plus a 0.1 charge, where a language's `+` refuses to convert:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "add_checked", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "lit", "value": 0.1, "type": "real"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "charged"}]
}
```

| name | charged |
|---|---|
| apple | 0.6 |
| pear | 0.85 |
| plum | 1.35 |
| cherry | 3.1 |
| lime | 0.5 |

## See also

- [`add`](./add), [`sub_checked`](./sub_checked), [`mul_checked`](./mul_checked)
- [`cast_integer_strict`](../conversion/cast_integer_strict)
- [Arithmetic functions](./)
