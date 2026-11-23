---
description: 'The cosine of an angle in radians.'
---

# cos

```ebnf
cos ::= '"fn": "cos"' ', "args": [' X ']'
```

The cosine of `X`, an angle in radians.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | An angle in radians. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`. NULL when the argument is NULL, NaN, not a number, or infinite.

## Errors

None.

## Notes

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
      {"k": "call", "fn": "cos", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "cos", "args": [{"k": "lit", "value": 3.141592653589793, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "cos", "args": [{"k": "lit", "value": "0", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "cos", "args": [{"k": "lit", "value": {"$real": "Infinity"}, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "cos", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "zero"}, {"name": "half_turn"}, {"name": "text"}, {"name": "infinite"}, {"name": "null"}]
}
```

| zero | half_turn | text | infinite | null |
|---|---|---|---|---|
| 1 | -1 | 1 | NULL | NULL |

## Demo

The cosine of 0° to 90°, to four decimals:

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
        {"k": "call", "fn": "cos", "args": [
          {"k": "call", "fn": "radians", "args": [
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
          ], "type": "real"}
        ], "type": "real"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "degrees"}, {"name": "cos"}]
}
```

| degrees | cos |
|---|---|
| 0 | 1 |
| 30 | 0.866 |
| 60 | 0.5 |
| 90 | 0 |

## See also

- [`sin`](./sin), [`tan`](./tan), [`acos`](./acos), [`radians`](./radians)
- [Math functions](./)
