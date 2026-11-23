---
description: 'A date, datetime or time cut back to the start of its year, quarter, month, week, day, hour, minute or second.'
---

# trunc_temporal

```ebnf
trunc_temporal ::= '"fn": "trunc_temporal"' ', "args": [' VALUE ',' UNIT ']'
```

A `date`, `datetime` or `time` cut back to the start of the `UNIT` it is in: `month` gives the first of its month,
`hour` the start of its hour. The result has the value's type.

## Parameters

| Argument | Type | |
|---|---|---|
| `VALUE` | `date`, `datetime`, `time` | The value. |
| `UNIT` | `text` | `year`, `quarter`, `month`, `week` (back to Monday), `day`, `hour`, `minute`, `second`, `millisecond` or `microsecond`, in lower case. |

## Returns

The type of `VALUE`: declare it as the call's `type`. NULL when `VALUE` or `UNIT` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `VALUE` isn't a `date`, `datetime` or `time` (text included): refused when the plan is compiled. |
| `SMALT_MISMATCH` | `UNIT` isn't one of the units, or is one the value hasn't: a `date` has no `hour` to `microsecond`, a `time` no `year` to `day`. |

## Notes

- Weeks are ISO weeks: `week` goes back to the Monday on or before the day. Quarters start in January, April, July
  and October.
- A `datetime` truncated to `day` or longer is midnight of that day. `day` leaves a `date` as it is, and
  `microsecond` leaves anything as it is.
- To truncate a UTC instant to a day somewhere else, move it there first with [`to_zone`](./to_zone), and back after
  with [`from_zone`](./from_zone).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["datetime", "datetime", "datetime", "datetime", "datetime"],
    "rows": [[
      {"k": "call", "fn": "trunc_temporal", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-07 15:04:09.123456", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "year", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "trunc_temporal", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-07 15:04:09.123456", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "quarter", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "trunc_temporal", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-07 15:04:09.123456", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "week", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "trunc_temporal", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-07 15:04:09.123456", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "hour", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "trunc_temporal", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-07 15:04:09.123456", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "millisecond", "type": "text"}
      ], "type": "datetime"}
    ]]
  },
  "columns": [{"name": "year"}, {"name": "quarter"}, {"name": "week"}, {"name": "hour"}, {"name": "millisecond"}]
}
```

| year | quarter | week | hour | millisecond |
|---|---|---|---|---|
| 2026-01-01 00:00:00 | 2026-10-01 00:00:00 | 2026-11-02 00:00:00 | 2026-11-07 15:00:00 | 2026-11-07 15:04:09.123 |

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["date", "time", "date"],
    "rows": [[
      {"k": "call", "fn": "trunc_temporal", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"},
        {"k": "lit", "value": "month", "type": "text"}
      ], "type": "date"},
      {"k": "call", "fn": "trunc_temporal", "args": [
        {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "09:05:30.75", "type": "text"}], "type": "time"},
        {"k": "lit", "value": "minute", "type": "text"}
      ], "type": "time"},
      {"k": "call", "fn": "trunc_temporal", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"},
        {"k": "lit", "value": null, "type": "text"}
      ], "type": "date"}
    ]]
  },
  "columns": [{"name": "date"}, {"name": "time"}, {"name": "null"}]
}
```

| date | time | null |
|---|---|---|
| 2026-11-01 | 09:05:00 | NULL |

A `date` has no hours:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["date"],
    "rows": [[
      {"k": "call", "fn": "trunc_temporal", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"},
        {"k": "lit", "value": "hour", "type": "text"}
      ], "type": "date"}
    ]]
  },
  "columns": [{"name": "start"}]
}
```

## Demo

The items ordered in each week, by the week's Monday:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {"op": "scan", "table": "orders", "columns": [2, 3]},
    "keys": [
      {
        "expr": {"k": "call", "fn": "trunc_temporal", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
          {"k": "lit", "value": "week", "type": "text"}
        ], "type": "date"},
        "collation": "binary"
      }
    ],
    "aggs": [
      {"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"},
      {
        "fn": "sum",
        "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}],
        "star": false,
        "distinct": false,
        "collation": "binary",
        "type": "int"
      }
    ],
    "carry": []
  },
  "columns": [{"name": "week"}, {"name": "orders"}, {"name": "items"}]
}
```

| week | orders | items |
|---|---|---|
| 2026-11-02 | 6 | 22 |

## See also

- [`offset_by`](./offset_by), [`year`](./year), [`weekday`](./weekday), [`format_temporal`](./format_temporal)
- [Date and time functions](./)
