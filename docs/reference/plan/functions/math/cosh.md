---
description: 'The hyperbolic cosine of a number.'
---

# cosh

```ebnf
cosh ::= '"fn": "cosh"' ', "args": [' X ']'
```

The hyperbolic cosine of `X`: (*e*^`X` + *e*^−`X`) / 2.

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
      {"k": "call", "fn": "cosh", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "cosh", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "cosh", "args": [{"k": "lit", "value": -1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "cosh", "args": [{"k": "lit", "value": 1000, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "cosh", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "zero"}, {"name": "one"}, {"name": "minus_one"}, {"name": "large"}, {"name": "null"}]
}
```

| zero | one | minus_one | large | null |
|---|---|---|---|---|
| 1 | 1.5430806348152437 | 1.5430806348152437 | Infinity | NULL |

## Demo

`cosh` of 0 to 3, to four decimals:

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
        {"k": "call", "fn": "cosh", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "real"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "x"}, {"name": "cosh"}]
}
```

| x | cosh |
|---|---|
| 0 | 1 |
| 1 | 1.5431 |
| 2 | 3.7622 |
| 3 | 10.0677 |

## See also

- [`sinh`](./sinh), [`tanh`](./tanh), [`acosh`](./acosh)
- [Math functions](./)
