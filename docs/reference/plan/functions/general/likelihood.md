---
description: '`X`, unchanged: a hint of how often it is true.'
---

# likelihood

```ebnf
likelihood ::= '"fn": "likelihood"' ', "args": [' X ',' P ']'
```

`X`, unchanged: SQLite's hint that `X` is true with probability `P`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |
| `P` | `real` | The probability, from 0 to 1. Not read. |

## Returns

`X`'s type: `X`, NULL when it is NULL.

## Errors

None.

## Notes

- They change nothing: SQLite's planner reads them as a hint of how often a condition is true. The engine gives the
  value back and plans as it would without them.
- `P` isn't checked: any value, NULL included, gives `X`. SQL's `likelihood` requires a constant from 0.0 to 1.0;
  that check is the language's.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "text", "int"],
    "rows": [[
      {"k": "call", "fn": "likelihood", "args": [{"k": "lit", "value": 5, "type": "int"}, {"k": "lit", "value": 0.9, "type": "real"}], "type": "int"},
      {"k": "call", "fn": "likelihood", "args": [{"k": "lit", "value": "a", "type": "text"}, {"k": "lit", "value": 0.9, "type": "real"}], "type": "text"},
      {"k": "call", "fn": "likelihood", "args": [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": 0.9, "type": "real"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "int"}, {"name": "text"}, {"name": "null"}]
}
```

| int | text | null |
|---|---|---|
| 5 | a | NULL |

## Demo

The red fruit, the condition marked with the hint:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "fruit", "columns": [1, 2]},
      "pred": {"k": "call", "fn": "likelihood", "args": [
        {"k": "call", "fn": "cmp_eq", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
          {"k": "lit", "value": "red", "type": "text"}
        ], "type": "bool"}, {"k": "lit", "value": 0.2, "type": "real"}
      ], "type": "bool"}
    },
    "exprs": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"}]
  },
  "columns": [{"name": "name"}]
}
```

| name |
|---|
| apple |
| cherry |

## See also

- [`likely`](./likely), [`unlikely`](./unlikely)
- [General functions](./)
