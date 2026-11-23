---
description: 'The arcsine of a number, in radians.'
---

# asin

```ebnf
asin ::= '"fn": "asin"' ', "args": [' X ']'
```

The arcsine of `X`: the angle, in radians from -π/2 to π/2, whose sine is `X`.

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
      {"k": "call", "fn": "asin", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "asin", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "asin", "args": [{"k": "lit", "value": 0.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "asin", "args": [{"k": "lit", "value": 1.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "asin", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "zero"}, {"name": "one"}, {"name": "half"}, {"name": "outside"}, {"name": "null"}]
}
```

| zero | one | half | outside | null |
|---|---|---|---|---|
| 0 | 1.5707963267948966 | 0.5235987755982989 | NULL | NULL |

## Demo

The arcsine of 0, 0.5, 1, in degrees:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "values",
      "types": ["real"],
      "rows": [[{"k": "lit", "value": 0, "type": "real"}], [{"k": "lit", "value": 0.5, "type": "real"}], [{"k": "lit", "value": 1, "type": "real"}]]
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "real", "collation": "binary"},
      {"k": "call", "fn": "round", "args": [
        {"k": "call", "fn": "degrees", "args": [
          {"k": "call", "fn": "asin", "args": [
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
| 0.5 | 30 |
| 1 | 90 |

## See also

- [`sin`](./sin), [`acos`](./acos), [`atan`](./atan), [`degrees`](./degrees)
- [Math functions](./)
