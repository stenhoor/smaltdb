---
description: 'A date from a datetime, from text in the date format, or from a number of days.'
---

# cast_date

```ebnf
cast_date ::= '"fn": "cast_date"' ', "args": [' X ']'
```

A `date` from a `datetime` (its day), from text in the date format `YYYY-MM-DD`, or from a whole number of days since
1970-01-01. Anything else is an error.

## Parameters

| Argument | Type | |
|---|---|---|
| `X` | `date`, `datetime`, `text` or a number | The value. A `date` is returned as it is. |

## Returns

`date`. NULL when `X` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `X` is text that is not a date in the format `YYYY-MM-DD` (a date and time, `'2026-02-30'`), a number that isn't whole, or a blob; or, when the plan is compiled, a `time` or `duration`. |
| `SMALT_RANGE` | `X` is a number of days too large for a date. |

## Notes

- Text with a time after the date is an error: convert it with [`cast_datetime`](./cast_datetime) first, then take its
  day with `cast_date`.
- It is called with [`call`](../../expressions/call) only: a [`cast`](../../expressions/cast) expression doesn't take it
  as its `fn` (`SMALT_PLAN`, no such conversion).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["date", "date", "date", "date"],
    "rows": [[
      {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-23", "type": "text"}], "type": "date"},
      {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": 0, "type": "int"}], "type": "date"},
      {"k": "call", "fn": "cast_date", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [{"k": "lit", "value": "2026-11-23 10:30:00", "type": "text"}], "type": "datetime"}
      ], "type": "date"},
      {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "date"}
    ]]
  },
  "columns": [{"name": "text"}, {"name": "days"}, {"name": "datetime"}, {"name": "null"}]
}
```

| text | days | datetime | null |
|---|---|---|---|
| 2026-11-23 | 1970-01-01 | 2026-11-23 | NULL |

A day that doesn't exist:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "op": "values",
  "types": ["date"],
  "rows": [[{"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-02-30", "type": "text"}], "type": "date"}]]
}
```

A `cast` expression doesn't take it:

<!-- docs:error SMALT_PLAN -->
```json
{
  "op": "values",
  "types": ["date"],
  "rows": [[{"k": "cast", "fn": "cast_date", "to": "date", "arg": {"k": "lit", "value": "2026-11-23", "type": "text"}}]]
}
```

## Demo

Orders on or after a date given as text:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "orders", "columns": [0, 3]},
    "pred": {"k": "call", "fn": "cmp_ge", "args": [
      {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
      {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-04", "type": "text"}], "type": "date"}
    ], "type": "bool"}
  },
  "columns": [{"name": "id"}, {"name": "day"}]
}
```

| id | day |
|---|---|
| 4 | 2026-11-04 |
| 5 | 2026-11-05 |
| 6 | 2026-11-05 |

## See also

- [`cast_datetime`](./cast_datetime), [`cast_time`](./cast_time), [`parse_date`](../temporal/parse_date)
- [Dates and times](../temporal/)
- [Conversions](../../conversions): which conversion the engine uses from one type to another
- [Conversion functions](./)
