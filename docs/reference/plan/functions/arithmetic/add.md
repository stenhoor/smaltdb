---
description: 'The sum of two numbers, in SQLite''s meaning: an integer that overflows becomes a real.'
---

# add

```ebnf
add ::= '"fn": "add"' ', "args": [' X ',' Y ']'
```

The sum of `X` and `Y`: SQL's `+`, in SQLite's meaning. Two integers give an integer, and one that doesn't fit in 64
bits gives a real; text converts to a number.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number, or text or a blob taken as one; a `datetime` or `duration`. |
| `Y` | number | The same. |

## Returns

`int` for two integers, `real` when either is a `real`, else `num`, a `datetime` or `duration` for those operands:
declare the type of the value on the call. NULL when `X` or `Y` is NULL.

## Errors

None.

## Notes

- Integers are exact to 64 bits: past 2^53 they are `bigint`. A sum outside the 64-bit range is a `real` (SQLite's
  rule). [`add_checked`](./add_checked) makes it an error instead.
- Text and blobs convert to the number they begin with, as SQLite converts them: `'3x'` is 3, `'abc'` is 0.
  `add_checked` refuses text.
- A NaN result is NULL, as SQLite has no NaN: a NaN operand, or `Infinity - Infinity`
  ([ADR 0018](../../../../adr/0018-bool-and-nan.md)). `add_checked` keeps NaN.
- Dates and times add as their integers: `datetime + duration` and `duration + datetime` are a `datetime`, `duration +
  duration` a `duration`. Other operands count as integers: `date + int` is an `int`, a day count
  ([ADR 0019](../../../../adr/0019-dates-and-times.md)). To move a date by calendar months, use
  [`offset_by`](../temporal/offset_by).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "real", "real", "int", "real", "int"],
    "rows": [[
      {"k": "call", "fn": "add", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "add", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 2.5, "type": "real"}
      ], "type": "real"},
      {"k": "call", "fn": "add", "args": [
        {"k": "lit", "value": {"$bigint": "9223372036854775807"}, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "add", "args": [
        {"k": "lit", "value": "3x", "type": "text"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "add", "args": [
        {"k": "lit", "value": {"$real": "Infinity"}, "type": "real"},
        {"k": "lit", "value": {"$real": "-Infinity"}, "type": "real"}
      ], "type": "real"},
      {"k": "call", "fn": "add", "args": [
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "real"}, {"name": "overflow"}, {"name": "text"}, {"name": "nan"}, {"name": "null"}]
}
```

| ints | real | overflow | text | nan | null |
|---|---|---|---|---|---|
| 3 | 3.5 | 9223372036854776000 | 4 | NULL | NULL |

A `datetime` plus a `duration` (an hour, as µs):

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["datetime", "duration"],
    "rows": [[
      {"k": "call", "fn": "add", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-05 12:00:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": 3600000000, "type": "duration"}
      ], "type": "datetime"},
      {"k": "call", "fn": "add", "args": [
        {"k": "lit", "value": 3600000000, "type": "duration"},
        {"k": "lit", "value": 60000000, "type": "duration"}
      ], "type": "duration"}
    ]]
  },
  "columns": [{"name": "later"}, {"name": "durations"}]
}
```

| later | durations |
|---|---|
| 2026-11-05 13:00:00 | PT1H1M |

## Demo

Each fruit's stock after 10 more arrive; plum's stock is unknown:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "fruit", "columns": [1, 4]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "text", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "add", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "lit", "value": 10, "type": "int"}
      ], "type": "int"}
    ]
  },
  "columns": [{"name": "name"}, {"name": "qty"}, {"name": "after"}]
}
```

| name | qty | after |
|---|---|---|
| apple | 10 | 20 |
| pear | 4 | 14 |
| plum | NULL | NULL |
| cherry | 25 | 35 |
| lime | 0 | 10 |

## See also

- [`add_checked`](./add_checked), [`sub`](./sub), [`mul`](./mul)
- [`offset_by`](../temporal/offset_by)
- [Arithmetic functions](./)
- [`call`](../../expressions/call): how a plan calls a function
