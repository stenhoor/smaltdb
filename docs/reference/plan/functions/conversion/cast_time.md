---
description: 'A time of day from a datetime, from text HH:MM[:SS[.f]], or from a number of microseconds within a day.'
---

# cast_time

```ebnf
cast_time ::= '"fn": "cast_time"' ', "args": [' X ']'
```

A `time` from a `datetime` (its time of day), from text `HH:MM[:SS[.f]]`, or from a whole number of microseconds since
midnight, less than a day. Anything else is an error.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `time`, `datetime`, `text` or a number | The value. A `time` is returned as it is. |

## Returns

`time`. NULL when `X` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `X` is text that is not a time (`'25:00'`, `'10'`, a date and time), a number that isn't whole, or a blob; or, when the plan is compiled, a `date` or `duration`. |
| `SMALT_RANGE` | `X` is a number of microseconds below 0 or of a day or more. |

## Notes

- Text with a date is an error: convert it with [`cast_datetime`](./cast_datetime) first, then take its time of day with
  `cast_time`.
- It is called with [`call`](../../expressions/call) only: a [`cast`](../../expressions/cast) expression doesn't take it
  as its `fn` (`SMALT_PLAN`, no such conversion).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["time", "time", "time", "time", "time"],
    "rows": [[
      {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "10:30", "type": "text"}], "type": "time"},
      {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "10:30:15.5", "type": "text"}], "type": "time"},
      {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": 3600000000, "type": "int"}], "type": "time"},
      {"k": "call", "fn": "cast_time", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [{"k": "lit", "value": "2026-11-23 18:45:00", "type": "text"}], "type": "datetime"}
      ], "type": "time"},
      {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "time"}
    ]]
  },
  "columns": [{"name": "text"}, {"name": "fraction"}, {"name": "us"}, {"name": "datetime"}, {"name": "null"}]
}
```

| text | fraction | us | datetime | null |
|---|---|---|---|---|
| 10:30:00 | 10:30:15.500 | 01:00:00 | 18:45:00 | NULL |

A whole day of microseconds:

<!-- docs:error SMALT_RANGE -->
```json
{
  "op": "values",
  "types": ["time"],
  "rows": [[{"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": 86400000000, "type": "int"}], "type": "time"}]]
}
```

## Demo

Times of day from a count of minutes, through microseconds:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {
      "op": "source",
      "kind": "function",
      "name": "range",
      "args": [{"k": "lit", "value": 0, "type": "int"}, {"k": "lit", "value": 720, "type": "int"}, {"k": "lit", "value": 360, "type": "int"}],
      "types": ["int"]
    },
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "cast_time", "args": [
        {"k": "call", "fn": "mul", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
          {"k": "lit", "value": 60000000, "type": "int"}
        ], "type": "int"}
      ], "type": "time"}
    ]
  },
  "columns": [{"name": "minutes"}, {"name": "time"}]
}
```

| minutes | time |
|---|---|
| 0 | 00:00:00 |
| 360 | 06:00:00 |
| 720 | 12:00:00 |

## See also

- [`cast_date`](./cast_date), [`cast_datetime`](./cast_datetime)
- [Dates and times](../temporal/)
- [Conversions](../../conversions): which conversion the engine uses from one type to another
- [Conversion functions](./)
