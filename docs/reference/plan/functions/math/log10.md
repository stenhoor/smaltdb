---
description: 'The base-10 logarithm of a number.'
---

# log10

```ebnf
log10 ::= '"fn": "log10"' ', "args": [' X ']'
```

The base-10 logarithm of `X`.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`. NULL when the argument is NULL, NaN, not a number, or at or below 0.

## Errors

None.

## Notes

- Powers of 10 give exact results (`log10(1000)` is 3): it is a port of musl's `log10`, which SQLite's WebAssembly build
  uses.
- [`log`](./log) with one argument is the same.
- 0 and negative numbers give NULL, not an error.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "log10", "args": [{"k": "lit", "value": 1000, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "log10", "args": [{"k": "lit", "value": 0.001, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "log10", "args": [{"k": "lit", "value": "100", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "log10", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "log10", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "thousand"}, {"name": "small"}, {"name": "text"}, {"name": "zero"}, {"name": "null"}]
}
```

| thousand | small | text | zero | null |
|---|---|---|---|---|
| 3 | -3 | 2 | NULL | NULL |

## Demo

The order of magnitude of each fruit's stock:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "floor", "args": [
        {"k": "call", "fn": "log10", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
        ], "type": "real"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "magnitude"}]
}
```

| name | magnitude |
|---|---|
| apple | 1 |
| pear | 0 |
| plum | NULL |
| cherry | 1 |
| lime | NULL |

## See also

- [`log`](./log), [`log2`](./log2), [`ln`](./ln)
- [Math functions](./)
