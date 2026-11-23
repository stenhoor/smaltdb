---
description: 'The inverse hyperbolic sine of a number.'
---

# asinh

```ebnf
asinh ::= '"fn": "asinh"' ', "args": [' X ']'
```

The inverse hyperbolic sine of `X`: the number whose hyperbolic sine is `X`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`. NULL when the argument is NULL, NaN, not a number.

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
      {"k": "call", "fn": "asinh", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "asinh", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "asinh", "args": [{"k": "lit", "value": -1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "asinh", "args": [{"k": "lit", "value": "0", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "asinh", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "zero"}, {"name": "one"}, {"name": "minus_one"}, {"name": "text"}, {"name": "null"}]
}
```

| zero | one | minus_one | text | null |
|---|---|---|---|---|
| 0 | 0.881373587019543 | -0.881373587019543 | 0 | NULL |

## Demo

`asinh` of 0 to 3, to four decimals:

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
        {"k": "call", "fn": "asinh", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "real"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "x"}, {"name": "asinh"}]
}
```

| x | asinh |
|---|---|
| 0 | 0 |
| 1 | 0.8814 |
| 2 | 1.4436 |
| 3 | 1.8184 |

## See also

- [`sinh`](./sinh), [`acosh`](./acosh), [`atanh`](./atanh)
- [Math functions](./)
