---
description: 'The hyperbolic tangent of a number.'
---

# tanh

```ebnf
tanh ::= '"fn": "tanh"' ', "args": [' X ']'
```

The hyperbolic tangent of `X`: sinh(`X`) / cosh(`X`), between -1 and 1.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`. NULL when the argument is NULL, NaN, not a number.

## Errors

None.

## Notes

- Large arguments give 1 or -1.
- It is a port of musl's `tanh`, which SQLite's WebAssembly build uses, so results agree with it to the bit.
- The result is a REAL computed in IEEE 754 doubles; a NaN result is NULL, and infinities stay.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "tanh", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "tanh", "args": [{"k": "lit", "value": 0.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "tanh", "args": [{"k": "lit", "value": 100, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "tanh", "args": [{"k": "lit", "value": -100, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "tanh", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "zero"}, {"name": "half"}, {"name": "large"}, {"name": "negative"}, {"name": "null"}]
}
```

| zero | half | large | negative | null |
|---|---|---|---|---|
| 0 | 0.46211715726000974 | 1 | -1 | NULL |

## Demo

`tanh` of 0 to 3, to four decimals:

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
        {"k": "call", "fn": "tanh", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "real"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "x"}, {"name": "tanh"}]
}
```

| x | tanh |
|---|---|
| 0 | 0 |
| 1 | 0.7616 |
| 2 | 0.964 |
| 3 | 0.9951 |

## See also

- [`sinh`](./sinh), [`cosh`](./cosh), [`atanh`](./atanh)
- [Math functions](./)
