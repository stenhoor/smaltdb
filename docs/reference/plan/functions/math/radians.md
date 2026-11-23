---
description: 'An angle in degrees converted to radians.'
---

# radians

```ebnf
radians ::= '"fn": "radians"' ', "args": [' X ']'
```

The angle `X`, in degrees, converted to radians: `X` × π / 180. The trigonometric functions take radians.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | An angle in degrees. Text that is a number in full counts as that number; other text and blobs give NULL. |

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
    "types": ["real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "radians", "args": [{"k": "lit", "value": 180, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "radians", "args": [{"k": "lit", "value": 90, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "radians", "args": [{"k": "lit", "value": "45", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "radians", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "half_turn"}, {"name": "right"}, {"name": "text"}, {"name": "null"}]
}
```

| half_turn | right | text | null |
|---|---|---|---|
| 3.141592653589793 | 1.5707963267948966 | 0.7853981633974483 | NULL |

## Demo

The sine of 0° to 90°, by way of radians:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "source",
      "kind": "function",
      "name": "range",
      "args": [{"k": "lit", "value": 0, "type": "int"}, {"k": "lit", "value": 90, "type": "int"}, {"k": "lit", "value": 30, "type": "int"}],
      "types": ["int"]
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "round", "args": [
        {"k": "call", "fn": "sin", "args": [
          {"k": "call", "fn": "radians", "args": [
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
          ], "type": "real"}
        ], "type": "real"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "degrees"}, {"name": "sin"}]
}
```

| degrees | sin |
|---|---|
| 0 | 0 |
| 30 | 0.5 |
| 60 | 0.866 |
| 90 | 1 |

## See also

- [`degrees`](./degrees), [`pi`](./pi), [`sin`](./sin)
- [Math functions](./)
