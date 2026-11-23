---
description: 'The tangent of an angle in radians.'
---

# tan

```ebnf
tan ::= '"fn": "tan"' ', "args": [' X ']'
```

The tangent of `X`, an angle in radians.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | An angle in radians. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`. NULL when the argument is NULL, NaN, not a number, or infinite.

## Errors

None.

## Notes

- Near a right angle the tangent is large but finite: π/2 is not exact as a double.
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
      {"k": "call", "fn": "tan", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "tan", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "tan", "args": [{"k": "lit", "value": "0", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "tan", "args": [{"k": "lit", "value": {"$real": "Infinity"}, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "tan", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "zero"}, {"name": "one"}, {"name": "text"}, {"name": "infinite"}, {"name": "null"}]
}
```

| zero | one | text | infinite | null |
|---|---|---|---|---|
| 0 | 1.5574077246549023 | 0 | NULL | NULL |

## Demo

The tangent of 0° to 60°, to four decimals:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "source",
      "kind": "function",
      "name": "range",
      "args": [{"k": "lit", "value": 0, "type": "int"}, {"k": "lit", "value": 60, "type": "int"}, {"k": "lit", "value": 15, "type": "int"}],
      "types": ["int"]
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "round", "args": [
        {"k": "call", "fn": "tan", "args": [
          {"k": "call", "fn": "radians", "args": [
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
          ], "type": "real"}
        ], "type": "real"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "degrees"}, {"name": "tan"}]
}
```

| degrees | tan |
|---|---|
| 0 | 0 |
| 15 | 0.2679 |
| 30 | 0.5774 |
| 45 | 1 |
| 60 | 1.7321 |

## See also

- [`sin`](./sin), [`cos`](./cos), [`atan`](./atan), [`atan2`](./atan2)
- [Math functions](./)
