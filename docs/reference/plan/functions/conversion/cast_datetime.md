---
description: 'A datetime from a date (its midnight), from text in the datetime format, or from a number of microseconds.'
---

# cast_datetime

```ebnf
cast_datetime ::= '"fn": "cast_datetime"' ', "args": [' X ']'
```

A `datetime` from a `date` (its midnight), from text in the datetime format `YYYY-MM-DD HH:MM[:SS[.ffffff]]`, or from a
whole number of microseconds since 1970-01-01 00:00:00. Anything else is an error.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `date`, `datetime`, `text` or a number | The value. A `datetime` is returned as it is. |

## Returns

`datetime`. NULL when `X` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `X` is text that is not a date and time, a number that isn't whole, or a blob; or, when the plan is compiled, a `time` or `duration`. |

## Notes

- Text may have `T` between the date and the time, and may be a date alone (its midnight). A zone or offset after the
  time (`+02:00`) is an error: a `datetime` has no zone.
- From a `date` the conversion is exact: the [conversion table](../../conversions) uses it for `date` to `datetime`.
- It is called with [`call`](../../expressions/call) only: a [`cast`](../../expressions/cast) expression doesn't take it
  as its `fn` (`SMALT_PLAN`, no such conversion).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["datetime", "datetime", "datetime", "datetime", "datetime"],
    "rows": [[
      {"k": "call", "fn": "cast_datetime", "args": [{"k": "lit", "value": "2026-11-23 10:30", "type": "text"}], "type": "datetime"},
      {"k": "call", "fn": "cast_datetime", "args": [{"k": "lit", "value": "2026-11-23T10:30:00.25", "type": "text"}], "type": "datetime"},
      {"k": "call", "fn": "cast_datetime", "args": [{"k": "lit", "value": "2026-11-23", "type": "text"}], "type": "datetime"},
      {"k": "call", "fn": "cast_datetime", "args": [{"k": "lit", "value": 1000000, "type": "int"}], "type": "datetime"},
      {"k": "call", "fn": "cast_datetime", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "datetime"}
    ]]
  },
  "columns": [{"name": "text"}, {"name": "iso"}, {"name": "date_text"}, {"name": "us"}, {"name": "null"}]
}
```

| text | iso | date_text | us | null |
|---|---|---|---|---|
| 2026-11-23 10:30:00 | 2026-11-23 10:30:00.250 | 2026-11-23 00:00:00 | 1970-01-01 00:00:01 | NULL |

Text with an offset:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "op": "values",
  "types": ["datetime"],
  "rows": [[{"k": "call", "fn": "cast_datetime", "args": [{"k": "lit", "value": "2026-11-23 10:30:00+02:00", "type": "text"}], "type": "datetime"}]]
}
```

## Demo

Each order's day as the midnight that starts it:

```json
{
  "kind": "query",
  "plan": {
    "op": "project",
    "input": {"op": "scan", "table": "orders", "columns": [0, 3]},
    "exprs": [
      {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
      {"k": "call", "fn": "cast_datetime", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"}
      ], "type": "datetime"}
    ]
  },
  "columns": [{"name": "id"}, {"name": "midnight"}]
}
```

| id | midnight |
|---|---|
| 1 | 2026-11-02 00:00:00 |
| 2 | 2026-11-02 00:00:00 |
| 3 | 2026-11-03 00:00:00 |
| 4 | 2026-11-04 00:00:00 |
| 5 | 2026-11-05 00:00:00 |
| 6 | 2026-11-05 00:00:00 |

## See also

- [`cast_date`](./cast_date), [`cast_time`](./cast_time), [`parse_datetime`](../temporal/parse_datetime)
- [Dates and times](../temporal/)
- [Conversions](../../conversions): which conversion the engine uses from one type to another
- [Conversion functions](./)
