---
description: 'A number raised to a power.'
---

# pow, power

```ebnf
pow ::= '"fn": "pow"' ', "args": [' X ',' Y ']'
power ::= '"fn": "power"' ', "args": [' X ',' Y ']'
```

`X` raised to the power `Y`, as a REAL. `power` is the same function.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | The base. Text that is a number in full counts as that number; other text and blobs give NULL. |
| `Y` | number | The exponent. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`, also for two integers. NULL when either argument is NULL, NaN or not a number, or the power has no real value
(a negative base with a fractional exponent).

## Errors

None.

## Notes

- A result too large for a double is `Infinity`: `pow(10, 400)`, and `pow(0, -1)`.
- `pow(0, 0)` is 1, and so is `pow(1, Y)` for any `Y`, infinities included, as in C.
- Results come from JavaScript's `Math` functions, so the last bit of a result can differ from SQLite's C library.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "pow", "args": [{"k": "lit", "value": 2, "type": "int"}, {"k": "lit", "value": 10, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "power", "args": [{"k": "lit", "value": 9, "type": "int"}, {"k": "lit", "value": 0.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "pow", "args": [{"k": "lit", "value": 2, "type": "int"}, {"k": "lit", "value": -2, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "pow", "args": [{"k": "lit", "value": -8, "type": "int"}, {"k": "lit", "value": 0.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "pow", "args": [{"k": "lit", "value": 10, "type": "int"}, {"k": "lit", "value": 400, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "pow", "args": [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": 2, "type": "int"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "int"}, {"name": "root"}, {"name": "negative"}, {"name": "no_real_value"}, {"name": "too_large"}, {"name": "null"}]
}
```

| int | root | negative | no_real_value | too_large | null |
|---|---|---|---|---|---|
| 1024 | 3 | 0.25 | NULL | Infinity | NULL |

## Demo

Powers of two:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "source",
      "kind": "function",
      "name": "range",
      "args": [{"k": "lit", "value": 0, "type": "int"}, {"k": "lit", "value": 4, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}],
      "types": ["int"]
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "pow", "args": [
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "n"}, {"name": "power"}]
}
```

| n | power |
|---|---|
| 0 | 1 |
| 1 | 2 |
| 2 | 4 |
| 3 | 8 |
| 4 | 16 |

## See also

- [`sqrt`](./sqrt), [`exp`](./exp), [`log`](./log)
- [Math functions](./)
