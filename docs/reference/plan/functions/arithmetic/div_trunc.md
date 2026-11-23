---
description: 'Division in SQLite''s meaning: two integers divide truncating toward zero, and division by zero is NULL.'
---

# div_trunc

```ebnf
div_trunc ::= '"fn": "div_trunc"' ', "args": [' X ',' Y ']'
```

`X` divided by `Y`: SQL's `/`, in SQLite's meaning. Two integers give an integer, truncated toward zero (`-7, 2` gives
`-3`); a real operand gives real division. Division by zero is NULL.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | The dividend: a number, or text or a blob taken as one; a `duration`. |
| `Y` | number | The divisor. |

## Returns

`int` for two integers, `real` when either is a `real`, else `num`, a `duration` for a `duration` and an `int`: declare
the type of the value on the call. NULL when `X` or `Y` is NULL, or `Y` is zero.

## Errors

None.

## Notes

- The three divisions differ in what they give: `div_trunc` truncates the quotient of two integers toward zero (`7, 2`
  gives 3), [`div_float`](./div_float) always divides as floats (3.5), and [`div_floor`](./div_floor) rounds toward
  negative infinity (`-7, 2` gives -4, where `div_trunc` gives -3).
- Division by zero, integer or real, is NULL. The least integer divided by -1 doesn't fit, and gives a real.
- Text and blobs convert to the number they begin with, as SQLite converts them: `'3x'` is 3, `'abc'` is 0.
- A NaN result is NULL, as SQLite has no NaN: a NaN operand, or `Infinity - Infinity`
  ([ADR 0018](../../../../adr/0018-bool-and-nan.md)).
- `duration / int` is a `duration` ([ADR 0019](../../../../adr/0019-dates-and-times.md)).
- Its remainder is [`mod_trunc`](./mod_trunc).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "real", "int", "int", "duration", "int"],
    "rows": [[
      {"k": "call", "fn": "div_trunc", "args": [
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "div_trunc", "args": [
        {"k": "lit", "value": -7, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "div_trunc", "args": [
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": 2, "type": "real"}
      ], "type": "real"},
      {"k": "call", "fn": "div_trunc", "args": [
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": 0, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "div_trunc", "args": [
        {"k": "lit", "value": "9", "type": "text"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "div_trunc", "args": [
        {"k": "lit", "value": 3600000000, "type": "duration"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "duration"},
      {"k": "call", "fn": "div_trunc", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [
    {"name": "ints"},
    {"name": "negative"},
    {"name": "real"},
    {"name": "by_zero"},
    {"name": "text"},
    {"name": "duration"},
    {"name": "null"}
  ]
}
```

| ints | negative | real | by_zero | text | duration | null |
|---|---|---|---|---|---|---|
| 3 | -3 | 3.5 | NULL | 4 | PT30M | NULL |

## Demo

How many boxes of 4 each fruit's stock fills:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "div_trunc", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 4, "type": "int"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "qty"}, {"name": "boxes"}]
}
```

| name | qty | boxes |
|---|---|---|
| apple | 10 | 2 |
| pear | 4 | 1 |
| plum | NULL | NULL |
| cherry | 25 | 6 |
| lime | 0 | 0 |

## See also

- [`div_float`](./div_float), [`div_floor`](./div_floor), [`mod_trunc`](./mod_trunc)
- [Arithmetic functions](./)
