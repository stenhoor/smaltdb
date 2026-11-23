---
description: 'A number rounded to some digits after the decimal point, with halves to the even digit.'
---

# round_half_even

```ebnf
round_half_even ::= '"fn": "round_half_even"' ', "args": [' X (',' DIGITS)? ']'
```

`X` rounded to `DIGITS` digits after the decimal point (0 by default), with a half rounded to the even digit
(banker's rounding): 2.5 gives 2, 3.5 gives 4, -2.5 gives -2.

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
  digits, while 0.125 is exactly a half and rounds to 0.12.
- `DIGITS` can't round to tens or hundreds: a negative number of digits counts as 0.
- NaN and infinities stay as they are.
- Text that doesn't start with a number gives 0, not NULL.
- [`round`](./round) and [`round_half_away`](./round_half_away) round a half away from zero.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "round_half_even", "args": [{"k": "lit", "value": 2.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "round_half_even", "args": [{"k": "lit", "value": 3.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "round_half_even", "args": [{"k": "lit", "value": -2.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "round_half_even", "args": [
        {"k": "lit", "value": 0.125, "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "round_half_even", "args": [
        {"k": "lit", "value": 2.675, "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "round_half_even", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "down"}, {"name": "up"}, {"name": "negative"}, {"name": "exact_half"}, {"name": "binary"}, {"name": "null"}]
}
```

| down | up | negative | exact_half | binary | null |
|---|---|---|---|---|---|
| 2 | 4 | -2 | 0.12 | 2.67 | NULL |

## Demo

The halves from 0.5 to 4.5, rounded both ways:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "source",
      "kind": "function",
      "name": "range",
      "args": [{"k": "lit", "value": 0, "type": "int"}, {"k": "lit", "value": 4, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}],
      "types": ["int"]
    },
    "exprs": [
      {"k": "call", "fn": "add", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 0.5, "type": "real"}
      ], "type": "real"},
      {"k": "call", "fn": "round_half_even", "args": [
        {"k": "call", "fn": "add", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 0.5, "type": "real"}
        ], "type": "real"}
      ], "type": "real"},
      {"k": "call", "fn": "round_half_away", "args": [
        {"k": "call", "fn": "add", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 0.5, "type": "real"}
        ], "type": "real"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "x"}, {"name": "even"}, {"name": "away"}]
}
```

| x | even | away |
|---|---|---|
| 0.5 | 0 | 1 |
| 1.5 | 2 | 2 |
| 2.5 | 2 | 3 |
| 3.5 | 4 | 4 |
| 4.5 | 4 | 5 |

## See also

- [`round`](./round), [`round_half_away`](./round_half_away)
- [Math functions](./)
