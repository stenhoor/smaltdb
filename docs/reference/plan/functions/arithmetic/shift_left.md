---
description: 'A 64-bit integer shifted left by a number of bits.'
---

# shift_left

```ebnf
shift_left ::= '"fn": "shift_left"' ', "args": [' X ',' N ']'
```

`X` shifted `N` bits to the left: SQL's `<<`. Within range, each place doubles it.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | int | The integer to shift; other values convert as [`cast_integer`](../conversion/cast_integer) converts them. |
| `N` | int | The number of places. |

## Returns

`int`. NULL when `X` or `N` is NULL.

## Errors

None.

## Notes

- Operands are 64-bit two's-complement integers. A real is truncated, text takes the integer it begins with (`'abc'` is
  0), and a value beyond the 64-bit range saturates, as `cast_integer` does.
- NaN converts to 0.
- A negative `N` shifts the other way.
- Bits shifted past the 64th are lost, and a shift of 64 or more gives 0.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "shift_left", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "shift_left", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 63, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "shift_left", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 64, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "shift_left", "args": [
        {"k": "lit", "value": 8, "type": "int"},
        {"k": "lit", "value": -2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "shift_left", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "three"}, {"name": "sign_bit"}, {"name": "too_far"}, {"name": "negative_n"}, {"name": "null"}]
}
```

| three | sign_bit | too_far | negative_n | null |
|---|---|---|---|---|
| 8 | -9223372036854775808 | 0 | 2 | NULL |

## Demo

A bit for each fruit, by its id:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [0, 1]},
    "exprs": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "shift_left", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "bit"}]
}
```

| name | bit |
|---|---|
| apple | 2 |
| pear | 4 |
| plum | 8 |
| cherry | 16 |
| lime | 32 |

## See also

- [`shift_right`](./shift_right), [`bit_or`](./bit_or)
- [Arithmetic functions](./)
