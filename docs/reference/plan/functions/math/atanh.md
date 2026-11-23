---
description: 'The inverse hyperbolic tangent of a number.'
---

# atanh

```ebnf
atanh ::= '"fn": "atanh"' ', "args": [' X ']'
```

The inverse hyperbolic tangent of `X`: the number whose hyperbolic tangent is `X`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`. NULL when the argument is NULL, NaN, not a number, or outside -1 to 1.

## Errors

None.

## Notes

- 1 gives `Infinity` and -1 `-Infinity`; a number beyond them gives NULL, not an error.
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
      {"k": "call", "fn": "atanh", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "atanh", "args": [{"k": "lit", "value": 0.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "atanh", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "atanh", "args": [{"k": "lit", "value": 2, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "atanh", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "zero"}, {"name": "half"}, {"name": "one"}, {"name": "outside"}, {"name": "null"}]
}
```

| zero | half | one | outside | null |
|---|---|---|---|---|
| 0 | 0.5493061443340548 | Infinity | NULL | NULL |

## Demo

`atanh` undoes [`tanh`](./tanh):

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
        {"k": "call", "fn": "atanh", "args": [
          {"k": "call", "fn": "tanh", "args": [
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
          ], "type": "real"}
        ], "type": "real"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "x"}, {"name": "atanh_tanh"}]
}
```

| x | atanh_tanh |
|---|---|
| 0 | 0 |
| 1 | 1 |
| 2 | 2 |
| 3 | 3 |

## See also

- [`tanh`](./tanh), [`asinh`](./asinh), [`acosh`](./acosh)
- [Math functions](./)
