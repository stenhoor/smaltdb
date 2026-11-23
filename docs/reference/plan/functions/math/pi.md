---
description: 'The number π.'
---

# pi

```ebnf
pi ::= '"fn": "pi"' ', "args": []'
```

The number π (3.141592653589793), the nearest double to it.

## Parameters

None.

## Returns

`real`. Never NULL.

## Errors

None.

## Notes

- It takes no arguments.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real"],
    "rows": [[
      {"k": "call", "fn": "pi", "args": [], "type": "real"},
      {"k": "call", "fn": "degrees", "args": [{"k": "call", "fn": "pi", "args": [], "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "pi"}, {"name": "half_turn"}]
}
```

| pi | half_turn |
|---|---|
| 3.141592653589793 | 180 |

## Demo

The area of circles of radius 1 to 3, to two decimals:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "source",
      "kind": "function",
      "name": "range",
      "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 3, "type": "int"}, {"k": "lit", "value": 1, "type": "int"}],
      "types": ["int"]
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "round", "args": [
        {"k": "call", "fn": "mul", "args": [
          {"k": "call", "fn": "pi", "args": [], "type": "real"},
          {"k": "call", "fn": "mul", "args": [
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}
          ], "type": "int"}
        ], "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "radius"}, {"name": "area"}]
}
```

| radius | area |
|---|---|
| 1 | 3.14 |
| 2 | 12.57 |
| 3 | 28.27 |

## See also

- [`radians`](./radians), [`degrees`](./degrees)
- [Math functions](./)
