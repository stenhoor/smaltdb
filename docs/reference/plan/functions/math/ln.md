---
description: 'The natural logarithm of a number.'
---

# ln

```ebnf
ln ::= '"fn": "ln"' ', "args": [' X ']'
```

The natural logarithm (base *e*) of `X`.

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
      {"k": "call", "fn": "ln", "args": [{"k": "lit", "value": 1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "ln", "args": [{"k": "lit", "value": 2.718281828459045, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "ln", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "ln", "args": [{"k": "lit", "value": -1, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "ln", "args": [{"k": "lit", "value": null, "type": "real"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "one"}, {"name": "e"}, {"name": "zero"}, {"name": "negative"}, {"name": "null"}]
}
```

| one | e | zero | negative | null |
|---|---|---|---|---|
| 0 | 1 | NULL | NULL | NULL |

## Demo

The natural logarithm of each fruit's stock (lime has none):

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "round", "args": [
        {"k": "call", "fn": "ln", "args": [{"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"}], "type": "real"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "ln"}]
}
```

| name | ln |
|---|---|
| apple | 2.3026 |
| pear | 1.3863 |
| plum | NULL |
| cherry | 3.2189 |
| lime | NULL |

## See also

- [`log`](./log), [`log10`](./log10), [`log2`](./log2), [`exp`](./exp)
- [Math functions](./)
