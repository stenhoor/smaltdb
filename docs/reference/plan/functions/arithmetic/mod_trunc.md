---
description: 'The remainder of division in SQLite''s meaning, with the sign of the dividend; by zero is NULL.'
---

# mod_trunc

```ebnf
mod_trunc ::= '"fn": "mod_trunc"' ', "args": [' X ',' Y ']'
```

The remainder of `X` divided by `Y`: SQL's `%`, in SQLite's meaning. It has the sign of `X` (`-7, 2` gives `-1`): the
remainder of [`div_trunc`](./div_trunc). By zero is NULL.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | The dividend: a number, or text or a blob taken as one. |
| `Y` | number | The divisor. |

## Returns

`int` for two integers, `real` when either is a `real`, else `num`: declare the type of the value on the call. NULL when
`X` or `Y` is NULL, or `Y` is zero (after conversion to an integer).

## Errors

None.

## Notes

- A real operand is first converted to an integer, truncating, and the remainder is a real: `7.5, 2` gives 1, as in
  SQLite. A `Y` that truncates to 0 (`0.5`) gives NULL.
- [`mod_floor`](./mod_floor) gives the remainder with the sign of `Y` (`-7, 2` gives 1), and keeps the fraction of a
  real; the math function [`mod`](../math/mod) is SQLite's `mod()`, a real.
- Text and blobs convert to the number they begin with, as SQLite converts them: `'3x'` is 3, `'abc'` is 0.
- A NaN converts to the integer 0: as `X` it gives 0, as `Y` NULL.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "real", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "mod_trunc", "args": [
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "mod_trunc", "args": [
        {"k": "lit", "value": -7, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "mod_trunc", "args": [
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": -2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "mod_trunc", "args": [
        {"k": "lit", "value": 7.5, "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "mod_trunc", "args": [
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "mod_trunc", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "negative_x"}, {"name": "negative_y"}, {"name": "real"}, {"name": "by_zero"}, {"name": "null"}]
}
```

| ints | negative_x | negative_y | real | by_zero | null |
|---|---|---|---|---|---|
| 1 | -1 | 1 | 1 | NULL | NULL |

## Demo

What is left of each fruit's stock when it is packed in boxes of 4:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "mod_trunc", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "qty"}, {"name": "loose"}]
}
```

| name | qty | loose |
|---|---|---|
| apple | 10 | 2 |
| pear | 4 | 0 |
| plum | NULL | NULL |
| cherry | 25 | 1 |
| lime | 0 | 0 |

## See also

- [`div_trunc`](./div_trunc), [`mod_floor`](./mod_floor), [`mod`](../math/mod)
- [Arithmetic functions](./)
