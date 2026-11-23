---
description: 'The square root of a number.'
---

# sqrt

```ebnf
sqrt ::= '"fn": "sqrt"' ', "args": [' X ']'
```

The square root of `X`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`. NULL when the argument is NULL, NaN, not a number, or negative.

## Errors

None.

## Notes

- A negative number gives NULL, not an error.
- The result is exact (correctly rounded).
- The result is a REAL computed in IEEE 754 doubles; a NaN result is NULL, and infinities stay.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "sqrt", "args": [{"k": "lit", "value": 16, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "sqrt", "args": [{"k": "lit", "value": 2, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "sqrt", "args": [{"k": "lit", "value": "6.25", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "sqrt", "args": [{"k": "lit", "value": -1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "sqrt", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "int"}, {"name": "real"}, {"name": "text"}, {"name": "negative"}, {"name": "null"}]
}
```

| int | real | text | negative | null |
|---|---|---|---|---|
| 4 | 1.4142135623730951 | 2.5 | NULL | NULL |

## Demo

The side of a square holding each fruit's stock:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "sqrt", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "side"}]
}
```

| name | side |
|---|---|
| apple | 3.1622776601683795 |
| pear | 2 |
| plum | NULL |
| cherry | 5 |
| lime | 0 |

## See also

- [`pow`](./pow), [`exp`](./exp)
- [Math functions](./)
