---
description: 'The inverse hyperbolic cosine of a number.'
---

# acosh

```ebnf
acosh ::= '"fn": "acosh"' ', "args": [' X ']'
```

The inverse hyperbolic cosine of `X`: the number, 0 or more, whose hyperbolic cosine is `X`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`. NULL when the argument is NULL, NaN, not a number, or below 1.

## Errors

None.

## Notes

- A number below 1 gives NULL, not an error.
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
      {"k": "call", "fn": "acosh", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "acosh", "args": [{"k": "lit", "value": 2, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "acosh", "args": [{"k": "lit", "value": 10, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "acosh", "args": [{"k": "lit", "value": 0.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "acosh", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "one"}, {"name": "two"}, {"name": "ten"}, {"name": "below_1"}, {"name": "null"}]
}
```

| one | two | ten | below_1 | null |
|---|---|---|---|---|
| 0 | 1.3169578969248166 | 2.993222846126381 | NULL | NULL |

## Demo

`acosh` of 1 to 4, to four decimals:

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
        {"k": "call", "fn": "acosh", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "real"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "x"}, {"name": "acosh"}]
}
```

| x | acosh |
|---|---|
| 1 | 0 |
| 2 | 1.317 |
| 3 | 1.7627 |
| 4 | 2.0634 |

## See also

- [`cosh`](./cosh), [`asinh`](./asinh), [`atanh`](./atanh)
- [Math functions](./)
