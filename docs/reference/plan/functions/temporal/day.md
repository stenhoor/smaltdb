---
description: 'The day of the month of a date or datetime, 1 to 31.'
---

# day

```ebnf
day ::= '"fn": "day"' ', "args": [' VALUE ']'
```

The day of the month of a `date` or `datetime`, as an integer from 1 to 31.

## Parameters

| Argument | Type | |
|---|---|---|
| `VALUE` | `date`, `datetime` | The value. |

## Returns

`int`. NULL when `VALUE` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `VALUE` is of another type, text included: a plan that gives one is refused when it is compiled. Make a `date` from text with [`cast_date`](../conversion/cast_date) or [`parse_date`](./parse_date). |

## Notes

- `day` is the day of the month. [`day_of_year`](./day_of_year) counts from 1 January, and
  [`weekday`](./weekday) gives the day of the week.
- [`format_temporal`](./format_temporal) gives the day as text: `%d` (`07`) or `%e` (` 7`).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "day", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"}
      ], "type": "int"},
      {"k": "call", "fn": "day", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2024-02-29", "type": "text"}], "type": "date"}
      ], "type": "int"},
      {"k": "call", "fn": "day", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-01-31 23:59:59", "type": "text"}
        ], "type": "datetime"}
      ], "type": "int"},
      {"k": "call", "fn": "day", "args": [{"k": "lit", "value": null, "type": "date"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "date"}, {"name": "leap"}, {"name": "datetime"}, {"name": "null"}]
}
```

| date | leap | datetime | null |
|---|---|---|---|
| 7 | 29 | 31 | NULL |

A `time` has no day:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "day", "args": [
        {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "12:30", "type": "text"}], "type": "time"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "day"}]
}
```

## Demo

The orders from the 4th of the month on:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "orders", "columns": [0, 3]},
    "pred": {"k": "call", "fn": "cmp_ge", "args": [
      {"k": "call", "fn": "day", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"}
      ], "type": "int"},
      {"k": "lit", "value": 4, "type": "int"}
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

- [`year`](./year), [`month`](./month), [`weekday`](./weekday), [`day_of_year`](./day_of_year)
- [Date and time functions](./)
- [`call`](../../expressions/call): how a plan calls a function
