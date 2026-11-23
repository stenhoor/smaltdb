---
description: 'A number rounded to some digits after the decimal point, halves away from zero, as SQLite''s round.'
---

# round

```ebnf
round ::= '"fn": "round"' ', "args": [' X (',' DIGITS)? ']'
```

`X` rounded to `DIGITS` digits after the decimal point (0 by default), with a half rounded away from zero: 2.5 gives 3,
-2.5 gives -3. SQLite's `round`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number. Text and blobs are converted by their numeric prefix: text that doesn't start with a number gives 0. |
| `DIGITS` | `int` | Optional: the digits to keep after the decimal point, 0 by default. It is taken as an integer (2.9 is 2) and kept within 0 to 30: a negative number of digits is 0. |

## Returns

`real`, also for an integer argument. NULL when `X` or `DIGITS` is NULL.

## Errors

None.

## Notes

- Halves are decided on the exact binary value of `X`: 2.675 is stored as 2.67499999…, so it rounds to 2.67 with 2
  digits, while 0.125 is exactly a half.
- `DIGITS` can't round to tens or hundreds: a negative number of digits counts as 0.
- NaN and infinities stay as they are.
- [`round_half_away`](./round_half_away) is the same function under the name of its rule;
  [`round_half_even`](./round_half_even) rounds a half to the even digit.
- Text that doesn't start with a number gives 0, not NULL (`'abc'` gives 0).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "round", "args": [{"k": "lit", "value": 2.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "round", "args": [{"k": "lit", "value": -2.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "round", "args": [
        {"k": "lit", "value": 3.14159, "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "round", "args": [
        {"k": "lit", "value": 2.675, "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "round", "args": [
        {"k": "lit", "value": 0.125, "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "round", "args": [
        {"k": "lit", "value": 1234.5, "type": "real"},
        {"k": "lit", "value": -2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "round", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "half"}, {"name": "negative"}, {"name": "two_digits"}, {"name": "binary"}, {"name": "exact_half"}, {"name": "minus_two"}, {"name": "null"}]
}
```

| half | negative | two_digits | binary | exact_half | minus_two | null |
|---|---|---|---|---|---|---|
| 3 | -3 | 3.14 | 2.67 | 0.13 | 1235 | NULL |

## Demo

Each fruit's price with 10% added, to the cent:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "round", "args": [
        {"k": "call", "fn": "mul", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
          {"k": "lit", "value": 1.1, "type": "real"}
        ], "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "price"}]
}
```

| name | price |
|---|---|
| apple | 0.55 |
| pear | 0.83 |
| plum | 1.38 |
| cherry | 3.3 |
| lime | 0.44 |

## See also

- [`round_half_even`](./round_half_even), [`round_half_away`](./round_half_away), [`trunc`](./trunc), [`ceil`](./ceil), [`floor`](./floor)
- [Math functions](./)
