---
description: 'The base-10 logarithm of a number, or with two arguments its logarithm to a base.'
---

# log

```ebnf
log ::= '"fn": "log"' ', "args": [' (B ',')? X ']'
```

With one argument, the base-10 logarithm of `X`, as [`log10`](./log10). With two, the logarithm of `X` to the base `B`:
the base comes first.

## Parameters

| Argument | Type | |
|---|---|---|
| `B` | number | Optional: the base. A base of 1 or less gives NULL. Text that is a number in full counts as that number; other text and blobs give NULL. |
| `X` | number | The number. With one argument, text that is a number in full counts, and other text and blobs give NULL; after a base, text and blobs are read by their numeric prefix (`'8 kg'` is 8, `'abc'` is 0). |

## Returns

`real`. NULL when an argument is NULL, NaN or not a number, `X` is at or below 0, or `B` is at or below 1.

## Errors

None.

## Notes

- `log(B, X)` is `ln(X) / ln(B)`, so a base of 1 or less gives NULL, and the last bit can differ from the exact
  logarithm: `log(10, 1000)` is 2.9999999999999996, where `log(1000)` is 3.
- With a base, `X` is read as SQLite reads it there: by its numeric prefix, so text that isn't a number is 0 and gives
  NULL.
- A NaN result is NULL, and infinities stay: `Infinity` gives `Infinity`.
- Results come from JavaScript's `Math` functions, so the last bit of a result can differ from SQLite's C library.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "log", "args": [{"k": "lit", "value": 100, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "log", "args": [{"k": "lit", "value": 2, "type": "int"}, {"k": "lit", "value": 8, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "log", "args": [{"k": "lit", "value": 10, "type": "int"}, {"k": "lit", "value": 1000, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "log", "args": [{"k": "lit", "value": 1, "type": "int"}, {"k": "lit", "value": 8, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "log", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "log", "args": [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": 8, "type": "int"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "base_10"}, {"name": "base_2"}, {"name": "divided"}, {"name": "base_1"}, {"name": "zero"}, {"name": "null"}]
}
```

| base_10 | base_2 | divided | base_1 | zero | null |
|---|---|---|---|---|---|
| 2 | 3 | 2.9999999999999996 | NULL | NULL | NULL |

## Demo

How many digits each fruit's stock has in base 10 and in base 2, from `log`:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "add", "args": [
        {"k": "call", "fn": "floor", "args": [
          {"k": "call", "fn": "log", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}], "type": "real"}
        ], "type": "real"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "add", "args": [
        {"k": "call", "fn": "floor", "args": [
          {"k": "call", "fn": "log", "args": [
            {"k": "lit", "value": 2, "type": "int"},
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}
          ], "type": "real"}
        ], "type": "real"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "decimal"}, {"name": "binary"}]
}
```

| name | decimal | binary |
|---|---|---|
| apple | 2 | 4 |
| pear | 1 | 3 |
| plum | NULL | NULL |
| cherry | 2 | 5 |
| lime | NULL | NULL |

## See also

- [`log10`](./log10), [`log2`](./log2), [`ln`](./ln), [`pow`](./pow)
- [Math functions](./)
