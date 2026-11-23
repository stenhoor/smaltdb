---
description: 'The remainder of one number divided by another, with the sign of the dividend, as a REAL.'
---

# mod

```ebnf
mod ::= '"fn": "mod"' ', "args": [' X ',' Y ']'
```

The remainder of `X` divided by `Y`, with the sign of `X`, as a REAL. It keeps the fraction: `mod(7.5, 2)` is 1.5.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | The dividend. Text that is a number in full counts as that number; other text and blobs give NULL. |
| `Y` | number | The divisor. Text that is a number in full counts as that number; other text and blobs give NULL. |

## Returns

`real`, also for two integers. NULL when either argument is NULL, NaN or not a number, when `Y` is 0, or when `X` is
infinite.

## Errors

None.

## Notes

- The arguments are taken as doubles, so integers beyond 2^53 lose their last digits;
  [`mod_trunc`](../arithmetic/mod_trunc) keeps integers exact.
- [`mod_trunc`](../arithmetic/mod_trunc) is the remainder of SQL's `%` (the same sign, integers for integers);
  [`mod_floor`](../arithmetic/mod_floor) takes the sign of the divisor.
- An infinite divisor leaves `X` as it is: `mod(5.5, Infinity)` is 5.5.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "mod", "args": [{"k": "lit", "value": 7, "type": "int"}, {"k": "lit", "value": 3, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "mod", "args": [{"k": "lit", "value": -7, "type": "int"}, {"k": "lit", "value": 3, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "mod", "args": [{"k": "lit", "value": 7, "type": "int"}, {"k": "lit", "value": -3, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "mod", "args": [{"k": "lit", "value": 7.5, "type": "real"}, {"k": "lit", "value": 2, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "mod", "args": [{"k": "lit", "value": 7, "type": "int"}, {"k": "lit", "value": 0, "type": "int"}], "type": "real"},
      {"k": "call", "fn": "mod", "args": [{"k": "lit", "value": null, "type": "int"}, {"k": "lit", "value": 3, "type": "int"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "int"}, {"name": "negative"}, {"name": "divisor"}, {"name": "fraction"}, {"name": "by_zero"}, {"name": "null"}]
}
```

| int | negative | divisor | fraction | by_zero | null |
|---|---|---|---|---|---|
| 1 | -1 | 1 | 1.5 | NULL | NULL |

## Demo

Each fruit's price modulo 0.5: what is left over above a multiple of 50 cents:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "mod", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "lit", "value": 0.5, "type": "real"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "over"}]
}
```

| name | over |
|---|---|
| apple | 0 |
| pear | 0.25 |
| plum | 0.25 |
| cherry | 0 |
| lime | 0.4 |

## See also

- [`mod_trunc`](../arithmetic/mod_trunc), [`mod_floor`](../arithmetic/mod_floor), [`trunc`](./trunc)
- [Math functions](./)
