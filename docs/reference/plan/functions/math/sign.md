---
description: '-1, 0 or 1 for a negative, zero or positive number.'
---

# sign

```ebnf
sign ::= '"fn": "sign"' ', "args": [' X ']'
```

-1, 0 or 1 for a negative, zero or positive number.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number. Text that is a number in full, with optional spaces around it, counts as that number. |

## Returns

`int`. NULL when `X` is NULL, a blob, or text that is not a number in full.

## Errors

None.

## Notes

- Text that only starts with a number (`'12x'`) gives NULL, where [`abs`](./abs) and [`round`](./round) read its prefix.
- NaN gives 0. Negative zero gives 0.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "sign", "args": [{"k": "lit", "value": -0.25, "type": "real"}], "type": "int"},
      {"k": "call", "fn": "sign", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "sign", "args": [{"k": "lit", "value": 42, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "sign", "args": [{"k": "lit", "value": " -4 ", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "sign", "args": [{"k": "lit", "value": "12x", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "sign", "args": [{"k": "lit", "value": null, "type": "int"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "negative"}, {"name": "zero"}, {"name": "positive"}, {"name": "text"}, {"name": "not_a_number"}, {"name": "null"}]
}
```

| negative | zero | positive | text | not_a_number | null |
|---|---|---|---|---|---|
| -1 | 0 | 1 | -1 | NULL | NULL |

## Demo

Whether each fruit's stock is above, at or below 4:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "sign", "args": [
        {"k": "call", "fn": "sub", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 4, "type": "int"}
        ], "type": "int"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "versus_4"}]
}
```

| name | versus_4 |
|---|---|
| apple | 1 |
| pear | 0 |
| plum | NULL |
| cherry | 1 |
| lime | -1 |

## See also

- [`abs`](./abs)
- [Math functions](./)
