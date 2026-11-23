---
description: 'e raised to the power of a number.'
---

# exp

```ebnf
exp ::= '"fn": "exp"' ', "args": [' X ']'
```

*e* (2.71828…) raised to the power `X`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`. NULL when the argument is NULL, NaN, not a number.

## Errors

None.

## Notes

- A result too large for a double is `Infinity` (`exp(1000)`); one too small is 0.
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
      {"k": "call", "fn": "exp", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "exp", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "exp", "args": [{"k": "lit", "value": 1000, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "exp", "args": [{"k": "lit", "value": -1000, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "exp", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "zero"}, {"name": "one"}, {"name": "too_large"}, {"name": "too_small"}, {"name": "null"}]
}
```

| zero | one | too_large | too_small | null |
|---|---|---|---|---|
| 1 | 2.718281828459045 | Infinity | 0 | NULL |

## Demo

`exp` undoes [`ln`](./ln):

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "source",
      "kind": "function",
      "name": "range",
      "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 4, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}],
      "types": ["int"]
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "round", "args": [
        {"k": "call", "fn": "exp", "args": [
          {"k": "call", "fn": "ln", "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}], "type": "real"}
        ], "type": "real"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "n"}, {"name": "exp_ln"}]
}
```

| n | exp_ln |
|---|---|
| 1 | 1 |
| 2 | 2 |
| 3 | 3 |
| 4 | 4 |

## See also

- [`ln`](./ln), [`pow`](./pow)
- [Math functions](./)
