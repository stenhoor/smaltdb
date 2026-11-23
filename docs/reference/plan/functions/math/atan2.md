---
description: 'The angle, in radians, of the point (X, Y) from the positive x axis.'
---

# atan2

```ebnf
atan2 ::= '"fn": "atan2"' ', "args": [' Y ',' X ']'
```

The angle, in radians from -π to π, between the positive x axis and the point (`X`, `Y`): the arctangent of `Y` / `X`,
in the right quadrant. `Y` comes first.

## Parameters

| Argument | Type | |
|---|---|---|
| `Y` | number | The y coordinate. Text that is a number in full counts as that number; other text and blobs give NULL. |
| `X` | number | The x coordinate. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`. NULL when either argument is NULL, NaN or not a number.

## Errors

None.

## Notes

- `atan2(0, 0)` is 0, not NULL.
- [`atan`](./atan) of `Y / X` loses the quadrant: `atan2(1, -1)` is 3π/4, `atan(-1)` is -π/4.
- Results come from JavaScript's `Math` functions, so the last bit of a result can differ from SQLite's C library.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "atan2", "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "atan2", "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": -1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "atan2", "args": [{"k": "lit", "value": 0, "type": "int"}, {"k": "lit", "value": -1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "atan2", "args": [{"k": "lit", "value": 0, "type": "int"}, {"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "atan2", "args": [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "first"}, {"name": "second"}, {"name": "negative_x"}, {"name": "origin"}, {"name": "null"}]
}
```

| first | second | negative_x | origin | null |
|---|---|---|---|---|
| 0.7853981633974483 | 2.356194490192345 | 3.141592653589793 | 0 | NULL |

## Demo

The direction of the point (price, qty) for each fruit, in degrees:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "round", "args": [
        {"k": "call", "fn": "degrees", "args": [
          {"k": "call", "fn": "atan2", "args": [
            {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"},
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"}
          ], "type": "real"}
        ], "type": "real"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "degrees"}]
}
```

| name | degrees |
|---|---|
| apple | 87.1 |
| pear | 79.4 |
| plum | NULL |
| cherry | 83.2 |
| lime | 0 |

## See also

- [`atan`](./atan), [`degrees`](./degrees)
- [Math functions](./)
