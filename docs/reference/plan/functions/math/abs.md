---
description: 'The absolute value of a number.'
---

# abs

```ebnf
abs ::= '"fn": "abs"' ', "args": [' X ']'
```

The absolute value of a number: an integer stays an integer and a real stays a real.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number. Text and blobs are converted by their numeric prefix: text that doesn't start with a number gives 0. |

## Returns

The argument's type for a number. NULL when `X` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | `X` is the integer -9223372036854775808, whose absolute value doesn't fit in 64 bits. |

## Notes

- NaN stays NaN.
- Text converts by its numeric prefix (`'-2.5 kg'` gives 2.5). An integer prefix gives an integer (`'-3'` gives 3),
  where SQLite gives a REAL (3.0).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "real", "num", "num", "int"],
    "rows": [[
      {"k": "call", "fn": "abs", "args": [{"k": "lit", "value": -5, "type": "int"}], "type": "int"},
      {"k": "call", "fn": "abs", "args": [{"k": "lit", "value": -2.5, "type": "real"}], "type": "real"},
      {"k": "call", "fn": "abs", "args": [{"k": "lit", "value": "-3", "type": "text"}], "type": "num"},
      {"k": "call", "fn": "abs", "args": [{"k": "lit", "value": "abc", "type": "text"}], "type": "num"},
      {"k": "call", "fn": "abs", "args": [{"k": "lit", "value": null, "type": "int"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "int"}, {"name": "real"}, {"name": "text"}, {"name": "not_a_number"}, {"name": "null"}]
}
```

| int | real | text | not_a_number | null |
|---|---|---|---|---|
| 5 | 2.5 | 3 | 0 | NULL |

The smallest integer has no absolute value in 64 bits:

<!-- docs:error SMALT_ERROR -->
```json
{
  "op": "values",
  "types": ["int"],
  "rows": [[{"k": "call", "fn": "abs", "args": [{"k": "lit", "value": {"$bigint": "-9223372036854775808"}, "type": "int"}], "type": "int"}]]
}
```

## Demo

How far each fruit's stock is from 10:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "abs", "args": [
        {"k": "call", "fn": "sub", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 10, "type": "int"}
        ], "type": "int"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "distance"}]
}
```

| name | distance |
|---|---|
| apple | 0 |
| pear | 6 |
| plum | NULL |
| cherry | 15 |
| lime | 10 |

## See also

- [`sign`](./sign), [`neg`](../arithmetic/neg)
- [Math functions](./)
