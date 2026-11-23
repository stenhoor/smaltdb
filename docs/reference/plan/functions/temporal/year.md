---
description: 'The year of a date or datetime.'
---

# year

```ebnf
year ::= '"fn": "year"' ', "args": [' VALUE ']'
```

The year of a `date` or `datetime`, as an integer. Years before 1 count down through 0: 1 BC is year 0, 44 BC is
year -43.

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

- A `datetime` has no zone: the year is the one its wall-clock text shows. For the year somewhere else, move the
  instant there first with [`to_zone`](./to_zone).
- [`format_temporal`](./format_temporal) with `%Y` gives the year as text, four digits or more.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "year", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"}
      ], "type": "int"},
      {"k": "call", "fn": "year", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-12-31 23:59:59", "type": "text"}
        ], "type": "datetime"}
      ], "type": "int"},
      {"k": "call", "fn": "year", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "-0043-03-15", "type": "text"}], "type": "date"}
      ], "type": "int"},
      {"k": "call", "fn": "year", "args": [{"k": "lit", "value": null, "type": "date"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "date"}, {"name": "datetime"}, {"name": "old"}, {"name": "null"}]
}
```

| date | datetime | old | null |
|---|---|---|---|
| 2026 | 2026 | -43 | NULL |

A `time` has no year:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "year", "args": [
        {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "12:30", "type": "text"}], "type": "time"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "year"}]
}
```

## Demo

The orders of each year and month, counted:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {"op": "scan", "table": "orders", "columns": [3]},
    "keys": [
      {
        "expr": {"k": "call", "fn": "year", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
        ], "type": "int"},
        "collation": "binary"
      },
      {
        "expr": {"k": "call", "fn": "month", "args": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
        ], "type": "int"},
        "collation": "binary"
      }
    ],
    "aggs": [{"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}],
    "carry": []
  },
  "columns": [{"name": "year"}, {"name": "month"}, {"name": "orders"}]
}
```

| year | month | orders |
|---|---|---|
| 2026 | 11 | 6 |

## See also

- [`month`](./month), [`day`](./day), [`trunc_temporal`](./trunc_temporal), [`make_date`](./make_date)
- [Date and time functions](./)
- [`call`](../../expressions/call): how a plan calls a function
