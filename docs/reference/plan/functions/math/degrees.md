---
description: 'An angle in radians converted to degrees.'
---

# degrees

```ebnf
degrees ::= '"fn": "degrees"' ', "args": [' X ']'
```

The angle `X`, in radians, converted to degrees: `X` × 180 / π.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | An angle in radians. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`. NULL when the argument is NULL, NaN, not a number.

## Errors

None.

## Notes

- The result is a REAL computed in IEEE 754 doubles; a NaN result is NULL, and infinities stay.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "degrees", "args": [{"k": "lit", "value": 3.141592653589793, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "degrees", "args": [{"k": "lit", "value": 1.5707963267948966, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "degrees", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "degrees", "args": [{"k": "lit", "value": "0", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "degrees", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "half_turn"}, {"name": "quarter"}, {"name": "one"}, {"name": "text"}, {"name": "null"}]
}
```

| half_turn | quarter | one | text | null |
|---|---|---|---|---|
| 180 | 90 | 57.29577951308232 | 0 | NULL |

## Demo

The angles whose tangent is 0, 1, 2 and 3, in degrees:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "source",
      "kind": "function",
      "name": "range",
      "args": [{"k": "lit", "value": 0, "type": "int"}, {"k": "lit", "value": 3, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}],
      "types": ["int"]
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "round", "args": [
        {"k": "call", "fn": "degrees", "args": [
          {"k": "call", "fn": "atan", "args": [
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
          ], "type": "real"}
        ], "type": "real"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "tan"}, {"name": "degrees"}]
}
```

| tan | degrees |
|---|---|
| 0 | 0 |
| 1 | 45 |
| 2 | 63.4349 |
| 3 | 71.5651 |

## See also

- [`radians`](./radians), [`pi`](./pi), [`atan`](./atan)
- [Math functions](./)
