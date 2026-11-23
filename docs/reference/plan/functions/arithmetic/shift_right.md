---
description: 'A 64-bit integer shifted right by a number of bits, keeping its sign.'
---

# shift_right

```ebnf
shift_right ::= '"fn": "shift_right"' ', "args": [' X ',' N ']'
```

`X` shifted `N` bits to the right: SQL's `>>`. Each place halves it, rounding toward negative infinity.

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
- The shift is arithmetic: the sign bit fills the left, so a negative value stays negative. A shift of 64 or more gives
  0, or -1 for a negative `X`.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "shift_right", "args": [
        {"k": "lit", "value": 8, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "shift_right", "args": [
        {"k": "lit", "value": -8, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "shift_right", "args": [
        {"k": "lit", "value": -8, "type": "int"},
        {"k": "lit", "value": 64, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "shift_right", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": -3, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "shift_right", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "two"}, {"name": "negative_x"}, {"name": "too_far"}, {"name": "negative_n"}, {"name": "null"}]
}
```

| two | negative_x | too_far | negative_n | null |
|---|---|---|---|---|
| 2 | -4 | -1 | 8 | NULL |

## Demo

Half of each fruit's stock, rounded down:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "shift_right", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "qty"}, {"name": "half"}]
}
```

| name | qty | half |
|---|---|---|
| apple | 10 | 5 |
| pear | 4 | 2 |
| plum | NULL | NULL |
| cherry | 25 | 12 |
| lime | 0 | 0 |

## See also

- [`shift_left`](./shift_left), [`div_floor`](./div_floor)
- [Arithmetic functions](./)
