---
description: 'The arccosine of a number, in radians.'
---

# acos

```ebnf
acos ::= '"fn": "acos"' ', "args": [' X ']'
```

The arccosine of `X`: the angle, in radians from 0 to π, whose cosine is `X`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`. NULL when the argument is NULL, NaN, not a number, or outside -1 to 1.

## Errors

None.

## Notes

- A number outside -1 to 1 gives NULL, not an error.
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
      {"k": "call", "fn": "acos", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "acos", "args": [{"k": "lit", "value": -1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "acos", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "acos", "args": [{"k": "lit", "value": 2, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "acos", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "one"}, {"name": "minus_one"}, {"name": "zero"}, {"name": "outside"}, {"name": "null"}]
}
```

| one | minus_one | zero | outside | null |
|---|---|---|---|---|
| 0 | 3.141592653589793 | 1.5707963267948966 | NULL | NULL |

## Demo

The arccosine of 1, 0.5, 0, in degrees:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "values",
      "types": ["real"],
      "rows": [[{"k": "lit", "value": 1, "type": "real"}], [{"k": "lit", "value": 0.5, "type": "real"}], [{"k": "lit", "value": 0, "type": "real"}]]
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "real", "collation": "binary"},
      {"k": "call", "fn": "round", "args": [
        {"k": "call", "fn": "degrees", "args": [
          {"k": "call", "fn": "acos", "args": [
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
| 1 | 0 |
| 0.5 | 60 |
| 0 | 90 |

## See also

- [`cos`](./cos), [`asin`](./asin), [`atan`](./atan), [`degrees`](./degrees)
- [Math functions](./)
