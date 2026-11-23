---
description: 'Division rounded toward negative infinity: an integer for two integers; by zero is NULL.'
---

# div_floor

```ebnf
div_floor ::= '"fn": "div_floor"' ', "args": [' X ',' Y ']'
```

`X` divided by `Y`, rounded toward negative infinity (`-7, 2` gives `-4`): Python's `//`. Two integers give an integer;
a real operand gives the floor of the real quotient, as a real. Division by zero is NULL.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | The dividend: a number, or text or a blob taken as one. |
| `Y` | number | The divisor. |

## Returns

`int` for two integers, `real` when either is a `real`, else `num`: declare the type of the value on the call. NULL when
`X` or `Y` is NULL, or `Y` is zero.

## Errors

None.

## Notes

- [`div_trunc`](./div_trunc) rounds toward zero instead (`-7, 2` gives -3); the two agree when the operands have the
  same sign. [`div_float`](./div_float) doesn't round.
- Its remainder is [`mod_floor`](./mod_floor): `X` is `div_floor(X, Y) * Y + mod_floor(X, Y)`.
- NaN stays NaN ([ADR 0018](../../../../adr/0018-bool-and-nan.md)). Division by zero is NULL, for reals too.
- The least integer divided by -1 doesn't fit, and gives a real.
- Text and blobs convert to the number they begin with, as SQLite converts them: `'3x'` is 3, `'abc'` is 0.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "real", "int", "real", "int"],
    "rows": [[
      {"k": "call", "fn": "div_floor", "args": [
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "div_floor", "args": [
        {"k": "lit", "value": -7, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "div_floor", "args": [
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": -2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "div_floor", "args": [
        {"k": "lit", "value": -7.5, "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "div_floor", "args": [
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "div_floor", "args": [
        {"k": "lit", "value": {"$real": "NaN"}, "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "div_floor", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [
    {"name": "ints"},
    {"name": "negative_x"},
    {"name": "negative_y"},
    {"name": "real"},
    {"name": "by_zero"},
    {"name": "nan"},
    {"name": "null"}
  ]
}
```

| ints | negative_x | negative_y | real | by_zero | nan | null |
|---|---|---|---|---|---|---|
| 3 | -4 | -4 | -4 | NULL | NaN | NULL |

## Demo

Each fruit's stock less a target of 12, in steps of 5: `div_floor` rounds a shortfall down, away from zero, where
`div_trunc` rounds it toward zero.

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "div_floor", "args": [
        {"k": "call", "fn": "sub", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 12, "type": "int"}
        ], "type": "int"},
        {"k": "lit", "value": 5, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "div_trunc", "args": [
        {"k": "call", "fn": "sub", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 12, "type": "int"}
        ], "type": "int"},
        {"k": "lit", "value": 5, "type": "int"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "qty"}, {"name": "steps"}, {"name": "div_trunc"}]
}
```

| name | qty | steps | div_trunc |
|---|---|---|---|
| apple | 10 | -1 | 0 |
| pear | 4 | -2 | -1 |
| plum | NULL | NULL | NULL |
| cherry | 25 | 2 | 2 |
| lime | 0 | -3 | -2 |

## See also

- [`mod_floor`](./mod_floor), [`div_trunc`](./div_trunc), [`div_float`](./div_float)
- [`floor`](../math/floor)
- [Arithmetic functions](./)
