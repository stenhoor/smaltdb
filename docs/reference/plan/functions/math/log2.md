---
description: 'The base-2 logarithm of a number.'
---

# log2

```ebnf
log2 ::= '"fn": "log2"' ', "args": [' X ']'
```

The base-2 logarithm of `X`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`. NULL when the argument is NULL, NaN, not a number, or at or below 0.

## Errors

None.

## Notes

- 0 and negative numbers give NULL, not an error.
- A NaN result is NULL, and infinities stay: `Infinity` gives `Infinity`.
- Results come from JavaScript's `Math` functions, so the last bit of a result can differ from SQLite's C library.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "log2", "args": [{"k": "lit", "value": 1024, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "log2", "args": [{"k": "lit", "value": 0.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "log2", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "log2", "args": [{"k": "lit", "value": -8, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "log2", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "power_of_2"}, {"name": "half"}, {"name": "zero"}, {"name": "negative"}, {"name": "null"}]
}
```

| power_of_2 | half | zero | negative | null |
|---|---|---|---|---|
| 10 | -1 | NULL | NULL | NULL |

## Demo

How many times each fruit's stock can be halved before it is below 2:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "floor", "args": [
        {"k": "call", "fn": "log2", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "real"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "halvings"}]
}
```

| name | halvings |
|---|---|
| apple | 3 |
| pear | 2 |
| plum | NULL |
| cherry | 4 |
| lime | NULL |

## See also

- [`log`](./log), [`log10`](./log10), [`ln`](./ln)
- [Math functions](./)
