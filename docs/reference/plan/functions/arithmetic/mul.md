---
description: 'The product of two numbers, in SQLite''s meaning: an integer that overflows becomes a real.'
---

# mul

```ebnf
mul ::= '"fn": "mul"' ', "args": [' X ',' Y ']'
```

The product of `X` and `Y`: SQL's `*`, in SQLite's meaning. Two integers give an integer, and one that doesn't fit in 64
bits gives a real; text converts to a number.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number, or text or a blob taken as one; a `duration`. |
| `Y` | number | The same. |

## Returns

`int` for two integers, `real` when either is a `real`, else `num`, a `duration` for a `duration` and an `int`: declare
the type of the value on the call. NULL when `X` or `Y` is NULL.

## Errors

None.

## Notes

- Integers are exact to 64 bits. A product outside the 64-bit range is a `real`; [`mul_checked`](./mul_checked) makes it
  an error instead.
- Text and blobs convert to the number they begin with, as SQLite converts them: `'3x'` is 3, `'abc'` is 0.
  `mul_checked` refuses text.
- A NaN result is NULL, as SQLite has no NaN: a NaN operand, or `Infinity - Infinity`
  ([ADR 0018](../../../../adr/0018-bool-and-nan.md)). `Infinity * 0` is NULL; `mul_checked` keeps NaN.
- `duration * int` and `int * duration` are a `duration` ([ADR 0019](../../../../adr/0019-dates-and-times.md)).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "real", "real", "int", "duration", "int"],
    "rows": [[
      {"k": "call", "fn": "mul", "args": [
        {"k": "lit", "value": 6, "type": "int"},
        {"k": "lit", "value": 7, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "mul", "args": [
        {"k": "lit", "value": 0.5, "type": "real"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "mul", "args": [
        {"k": "lit", "value": {"$bigint": "9223372036854775807"}, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "mul", "args": [
        {"k": "lit", "value": "2", "type": "text"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "mul", "args": [
        {"k": "lit", "value": 3600000000, "type": "duration"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "duration"},
      {"k": "call", "fn": "mul", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "real"}, {"name": "overflow"}, {"name": "text"}, {"name": "duration"}, {"name": "null"}]
}
```

| ints | real | overflow | text | duration | null |
|---|---|---|---|---|---|
| 42 | 1.5 | 18446744073709552000 | 6 | PT2H | NULL |

## Demo

The value of each fruit's stock:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 3, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "call", "fn": "mul", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "real", "collation": "binary"},
        {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "int", "collation": "binary"}
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
| plum | NULL |
| cherry | 75 |
| lime | 0 |

## See also

- [`mul_checked`](./mul_checked), [`div_trunc`](./div_trunc)
- [Arithmetic functions](./)
