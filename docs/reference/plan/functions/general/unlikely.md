---
description: '`X`, unchanged: a hint that it is usually false.'
---

# unlikely

```ebnf
unlikely ::= '"fn": "unlikely"' ', "args": [' X ']'
```

`X`, unchanged: SQLite's hint that `X` is usually false.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |

## Returns

`X`'s type: `X`, NULL when it is NULL.

## Errors

None.

## Notes

- They change nothing: SQLite's planner reads them as a hint of how often a condition is true. The engine gives the
  value back and plans as it would without them.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "text", "int"],
    "rows": [[
      {"k": "call", "fn": "unlikely", "args": [{"k": "lit", "value": 5, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "unlikely", "args": [{"k": "lit", "value": "a", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "unlikely", "args": [{"k": "lit", "value": null, "type": "int"}], "type": "int"}
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
      "pred": {"k": "call", "fn": "unlikely", "args": [
        {"k": "call", "fn": "cmp_eq", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "text", "collation": "binary"},
          {"k": "lit", "value": "red", "type": "text"}
        ], "type": "bool"}
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

- [`likely`](./likely), [`likelihood`](./likelihood)
- [General functions](./)
