---
description: 'The difference of two numbers, in SQLite''s meaning: an integer that overflows becomes a real.'
---

# sub

```ebnf
sub ::= '"fn": "sub"' ', "args": [' X ',' Y ']'
```

`X` less `Y`: SQL's binary `-`, in SQLite's meaning. Two integers give an integer, and one that doesn't fit in 64 bits
gives a real; text converts to a number.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | number | A number, or text or a blob taken as one; a `date`, `datetime`, `time` or `duration`. |
| `Y` | number | The same. |

## Returns

`int` for two integers, `real` when either is a `real`, else `num`, a `duration` or `datetime` for temporal operands:
declare the type of the value on the call. NULL when `X` or `Y` is NULL.

## Errors

None.

## Notes

- Integers are exact to 64 bits. A difference outside the 64-bit range is a `real`; [`sub_checked`](./sub_checked) makes
  it an error instead.
- Text and blobs convert to the number they begin with, as SQLite converts them: `'3x'` is 3, `'abc'` is 0.
  `sub_checked` refuses text.
- A NaN result is NULL, as SQLite has no NaN: a NaN operand, or `Infinity - Infinity`
  ([ADR 0018](../../../../adr/0018-bool-and-nan.md)). `sub_checked` keeps NaN.
- Dates and times subtract as their integers ([ADR 0019](../../../../adr/0019-dates-and-times.md)): `datetime -
  datetime`, `time - time` and `duration - duration` are a `duration`; `date - date` is a `duration` of the days between
  them; `datetime - duration` is a `datetime`. Declare that type on the call: declared `int`, `date - date` gives the
  µs.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "real", "real", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "sub", "args": [
        {"k": "lit", "value": 10, "type": "int"},
        {"k": "lit", "value": 3, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "sub", "args": [
        {"k": "lit", "value": 0.5, "type": "real"},
        {"k": "lit", "value": 2, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "sub", "args": [
        {"k": "lit", "value": {"$bigint": "-9223372036854775808"}, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "real"},
      {"k": "call", "fn": "sub", "args": [
        {"k": "lit", "value": "abc", "type": "text"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "int"},
      {"k": "call", "fn": "sub", "args": [
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "ints"}, {"name": "real"}, {"name": "overflow"}, {"name": "text"}, {"name": "null"}]
}
```

| ints | real | overflow | text | null |
|---|---|---|---|---|
| 7 | -1.5 | -9223372036854776000 | -1 | NULL |

Differences of dates and times:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["duration", "duration", "duration", "datetime"],
    "rows": [[
      {"k": "call", "fn": "sub", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-05", "type": "text"}], "type": "date"},
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-02", "type": "text"}], "type": "date"}
      ], "type": "duration"},
      {"k": "call", "fn": "sub", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-05 12:00:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-05 10:30:00", "type": "text"}
        ], "type": "datetime"}
      ], "type": "duration"},
      {"k": "call", "fn": "sub", "args": [
        {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "12:00", "type": "text"}], "type": "time"},
        {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "10:15", "type": "text"}], "type": "time"}
      ], "type": "duration"},
      {"k": "call", "fn": "sub", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-05 12:00:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": 3600000000, "type": "duration"}
      ], "type": "datetime"}
    ]]
  },
  "columns": [{"name": "dates"}, {"name": "datetimes"}, {"name": "times"}, {"name": "earlier"}]
}
```

| dates | datetimes | times | earlier |
|---|---|---|---|
| P3D | PT1H30M | PT1H45M | 2026-11-05 11:00:00 |

## Demo

How long after the first order each order came:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "orders", "columns": [0, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
      {"k": "call", "fn": "sub", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-02", "type": "text"}], "type": "date"}
      ], "type": "duration"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "day"}, {"name": "after"}]
}
```

| id | day | after |
|---|---|---|
| 1 | 2026-11-02 | PT0S |
| 2 | 2026-11-02 | PT0S |
| 3 | 2026-11-03 | P1D |
| 4 | 2026-11-04 | P2D |
| 5 | 2026-11-05 | P3D |
| 6 | 2026-11-05 | P3D |

## See also

- [`sub_checked`](./sub_checked), [`add`](./add), [`neg`](./neg)
- [Arithmetic functions](./)
