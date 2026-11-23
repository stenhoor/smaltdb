---
description: 'The hyperbolic sine of a number.'
---

# sinh

```ebnf
sinh ::= '"fn": "sinh"' ', "args": [' X ']'
```

The hyperbolic sine of `X`: (*e*^`X` − *e*^−`X`) / 2.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`. NULL when the argument is NULL, NaN, not a number.

## Errors

None.

## Notes

- A result too large for a double is `Infinity`.
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
      {"k": "call", "fn": "sinh", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "sinh", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "sinh", "args": [{"k": "lit", "value": -1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "sinh", "args": [{"k": "lit", "value": 1000, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "sinh", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "zero"}, {"name": "one"}, {"name": "minus_one"}, {"name": "large"}, {"name": "null"}]
}
```

| zero | one | minus_one | large | null |
|---|---|---|---|---|
| 0 | 1.1752011936438014 | -1.1752011936438014 | Infinity | NULL |

## Demo

`sinh` of 0 to 3, to four decimals:

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
        {"k": "call", "fn": "sinh", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "real"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "x"}, {"name": "sinh"}]
}
```

| x | sinh |
|---|---|
| 0 | 0 |
| 1 | 1.1752 |
| 2 | 3.6269 |
| 3 | 10.0179 |

## See also

- [`cosh`](./cosh), [`tanh`](./tanh), [`asinh`](./asinh)
- [Math functions](./)
