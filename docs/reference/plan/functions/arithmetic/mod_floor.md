---
description: 'The remainder of division rounded toward negative infinity, with the sign of the divisor; by zero is NULL.'
---

# mod_floor

```ebnf
mod_floor ::= '"fn": "mod_floor"' ', "args": [' X ',' Y ']'
```

The remainder of [`div_floor`](./div_floor): it has the sign of `Y` (`-7, 2` gives `1`), as Python's `%`. Two integers
give an integer; a real operand gives a real, its fraction kept. By zero is NULL.

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

- [`mod_trunc`](./mod_trunc) is SQL's `%`: the sign of `X` (`-7, 2` gives -1), and reals truncated to integers first.
  The two agree when the operands have the same sign.
- NaN stays NaN ([ADR 0018](../../../../adr/0018-bool-and-nan.md)). By zero is NULL, for reals too.
- Text and blobs convert to the number they begin with, as SQLite converts them: `'3x'` is 3, `'abc'` is 0.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "real", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "mod_floor", "args": [
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "mod_floor", "args": [
        {"k": "lit", "value": -7, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "mod_floor", "args": [
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": -2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "mod_floor", "args": [
        {"k": "lit", "value": -7.5, "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "mod_floor", "args": [
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "mod_floor", "args": [
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
| 1 | 1 | -1 | 0.5 | NULL | NULL |

## Demo

Each fruit's stock less a target of 12, in steps of 5, and what is left over: `mod_floor` keeps it between 0 and 4,
above the step `div_floor` gives, where `mod_trunc` gives it the sign of the shortfall.

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
      {"k": "call", "fn": "mod_floor", "args": [
        {"k": "call", "fn": "sub", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 12, "type": "int"}
        ], "type": "int"},
        {"k": "lit", "value": 5, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "mod_trunc", "args": [
        {"k": "call", "fn": "sub", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 12, "type": "int"}
        ], "type": "int"},
        {"k": "lit", "value": 5, "type": "int"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "qty"}, {"name": "steps"}, {"name": "rest"}, {"name": "mod_trunc"}]
}
```

| name | qty | steps | rest | mod_trunc |
|---|---|---|---|---|
| apple | 10 | -1 | 3 | -2 |
| pear | 4 | -2 | 2 | -3 |
| plum | NULL | NULL | NULL | NULL |
| cherry | 25 | 2 | 3 | 3 |
| lime | 0 | -3 | 3 | -2 |

## See also

- [`div_floor`](./div_floor), [`mod_trunc`](./mod_trunc), [`mod`](../math/mod)
- [Arithmetic functions](./)
