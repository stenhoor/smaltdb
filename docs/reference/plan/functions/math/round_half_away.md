---
description: 'A number rounded to some digits after the decimal point, with halves away from zero.'
---

# round_half_away

```ebnf
round_half_away ::= '"fn": "round_half_away"' ', "args": [' X (',' DIGITS)? ']'
```

`X` rounded to `DIGITS` digits after the decimal point (0 by default), with a half rounded away from zero: 2.5 gives 3,
-2.5 gives -3. It is [`round`](./round), under a name that says its rule, for a language that picks its rounding by
name.

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
- Text that doesn't start with a number gives 0, not NULL.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "round_half_away", "args": [{"k": "lit", "value": 2.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "round_half_away", "args": [{"k": "lit", "value": -2.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "round_half_away", "args": [{"k": "lit", "value": 3.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "round_half_away", "args": [
        {"k": "lit", "value": 0.125, "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "round_half_away", "args": [
        {"k": "lit", "value": 2.675, "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "round_half_away", "args": [
        {"k": "lit", "value": 2.5, "type": "real"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "real"}
    ]]
  },
  "columns": [{"name": "half"}, {"name": "negative"}, {"name": "next"}, {"name": "exact_half"}, {"name": "binary"}, {"name": "null"}]
}
```

| half | negative | next | exact_half | binary | null |
|---|---|---|---|---|---|
| 3 | -3 | 4 | 0.13 | 2.67 | NULL |

## Demo

Each fruit's price to one decimal, halves away from zero, beside [`round_half_even`](./round_half_even):

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "round_half_away", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "round_half_even", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "away"}, {"name": "even"}]
}
```

| name | away | even |
|---|---|---|
| apple | 0.5 | 0.5 |
| pear | 0.8 | 0.8 |
| plum | 1.3 | 1.2 |
| cherry | 3 | 3 |
| lime | 0.4 | 0.4 |

## See also

- [`round`](./round), [`round_half_even`](./round_half_even)
- [Math functions](./)
