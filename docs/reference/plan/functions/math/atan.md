---
description: 'The arctangent of a number, in radians.'
---

# atan

```ebnf
atan ::= '"fn": "atan"' ', "args": [' X ']'
```

The arctangent of `X`: the angle, in radians from -π/2 to π/2, whose tangent is `X`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`. NULL when the argument is NULL, NaN, not a number.

## Errors

None.

## Notes

- [`atan2`](./atan2) takes the two sides of a triangle and gives the angle in the right quadrant.
- The result is a REAL computed in IEEE 754 doubles; a NaN result is NULL, and infinities stay.
- Results come from JavaScript's `Math` functions, so the last bit of a result can differ from SQLite's C library.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "atan", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "atan", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "atan", "args": [{"k": "lit", "value": -1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "atan", "args": [{"k": "lit", "value": {"$real": "Infinity"}, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "atan", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "zero"}, {"name": "one"}, {"name": "minus_one"}, {"name": "infinite"}, {"name": "null"}]
}
```

| zero | one | minus_one | infinite | null |
|---|---|---|---|---|
| 0 | 0.7853981633974483 | -0.7853981633974483 | 1.5707963267948966 | NULL |

## Demo

The arctangent of 0, 1, 1.7320508075688772, in degrees:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "values",
      "types": ["real"],
      "rows": [
        [{"k": "lit", "value": 0, "type": "real"}],
        [{"k": "lit", "value": 1, "type": "real"}],
        [{"k": "lit", "value": 1.7320508075688772, "type": "real"}]
      ]
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "real", "collation": "binary"},
      {"k": "call", "fn": "round", "args": [
        {"k": "call", "fn": "degrees", "args": [
          {"k": "call", "fn": "atan", "args": [
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "real", "collation": "binary"}
          ], "type": "real"}
        ], "type": "real"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "x"}, {"name": "degrees"}]
}
```

| x | degrees |
|---|---|
| 0 | 0 |
| 1 | 45 |
| 1.7320508075688772 | 60 |

## See also

- [`atan2`](./atan2), [`tan`](./tan), [`degrees`](./degrees)
- [Math functions](./)
