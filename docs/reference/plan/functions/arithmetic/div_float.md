---
description: 'Division as floats always, IEEE 754: by zero gives Infinity or NaN.'
---

# div_float

```ebnf
div_float ::= '"fn": "div_float"' ', "args": [' X ',' Y ']'
```

`X` divided by `Y` as floats, whatever their types (`7, 2` gives 3.5), following IEEE 754: a non-zero value divided by
zero is `Infinity` or `-Infinity`, and `0, 0` is NaN. For a language whose `/` is true division, as smaltdf's and
Python's are.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | The dividend: a number, or text or a blob taken as one. |
| `Y` | number | The divisor. |

## Returns

`real`. NULL when `X` or `Y` is NULL.

## Errors

None.

## Notes

- [`div_trunc`](./div_trunc) is SQL's division (integers truncate, by zero is NULL), and [`div_floor`](./div_floor)
  rounds toward negative infinity.
- NaN in, NaN out ([ADR 0018](../../../../adr/0018-bool-and-nan.md)).
- Integers beyond 2^53 convert to the nearest real first.
- Text and blobs convert to the number they begin with, as SQLite converts them: `'3x'` is 3, `'abc'` is 0.
- A `duration` divides as its µs, to a `real`.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "div_float", "args": [
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "div_float", "args": [
        {"k": "lit", "value": -7, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "div_float", "args": [
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "div_float", "args": [
        {"k": "lit", "value": -1, "type": "int"},
        {"k": "lit", "value": 0, "type": "real"}
      ], "type": "real"},
      {"k": "call", "fn": "div_float", "args": [
        {"k": "lit", "value": 0, "type": "int"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "div_float", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"}
    ]]
  },
  "columns": [
    {"name": "ints"},
    {"name": "negative"},
    {"name": "by_zero"},
    {"name": "negative_by_zero"},
    {"name": "zero_by_zero"},
    {"name": "null"}
  ]
}
```

| ints | negative | by_zero | negative_by_zero | zero_by_zero | null |
|---|---|---|---|---|---|
| 3.5 | -3.5 | Infinity | -Infinity | NaN | NULL |

## Demo

Each fruit's stock in boxes of 4, in fractions of a box:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "div_float", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "real"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "qty"}, {"name": "boxes"}]
}
```

| name | qty | boxes |
|---|---|---|
| apple | 10 | 2.5 |
| pear | 4 | 1 |
| plum | NULL | NULL |
| cherry | 25 | 6.25 |
| lime | 0 | 0 |

## See also

- [`div_trunc`](./div_trunc), [`div_floor`](./div_floor)
- [Arithmetic functions](./)
