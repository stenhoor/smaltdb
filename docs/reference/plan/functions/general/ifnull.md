---
description: 'The first argument, or the second when the first is NULL.'
---

# ifnull

```ebnf
ifnull ::= '"fn": "ifnull"' ', "args": [' X ',' Y ']'
```

The first argument, or the second when the first is NULL: [`coalesce`](./coalesce) of two values.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | any | The value. |
| `Y` | any | The value in its place when `X` is NULL. |

## Returns

The arguments' type: declare it on the call. NULL when both are NULL.

## Errors

None.

## Notes

- `Y` is evaluated only when `X` is NULL.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "ifnull", "args": [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": 0, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "ifnull", "args": [{"k": "lit", "value": 5, "type": "int"}, {"k": "lit", "value": 0, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "ifnull", "args": [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": null, "type": "int"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "null_first"}, {"name": "value_first"}, {"name": "both_null"}]
}
```

| null_first | value_first | both_null |
|---|---|---|
| 0 | 5 | NULL |

## Demo

Each fruit's stock value, `price × qty`, as 0 where the stock isn't known:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "ifnull", "args": [
        {"k": "call", "fn": "mul", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
          {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "real"},
        {"k": "lit", "value": 0, "type": "real"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "value"}]
}
```

| name | value |
|---|---|
| apple | 5 |
| pear | 3 |
| plum | 0 |
| cherry | 75 |
| lime | 0 |

## See also

- [`coalesce`](./coalesce), [`nullif`](./nullif)
- [General functions](./)
