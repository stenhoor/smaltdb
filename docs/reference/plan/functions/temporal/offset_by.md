---
description: 'A date or datetime moved by a duration, or by calendar months, days and time written as text such as 1mo.'
---

# offset_by

```ebnf
offset_by ::= '"fn": "offset_by"' ', "args": [' VALUE ',' OFFSET ']'
```

A `date` or `datetime` moved by `OFFSET`: a `duration`, or text such as `1mo`, `-2d` or `1y3mo` that counts calendar
months, days and time. The result has the value's type.

## Parameters

| Argument | Type | |
|---|---|---|
| `VALUE` | `date`, `datetime` | The value to move. |
| `OFFSET` | `text`, `duration` | How far: a `duration`, or text of numbers and units, with a `-` or `+` before it all. |

The units of an offset written as text, which may be combined (`1y2mo`, `3h30m`), each a whole number:

| Unit | | Unit | |
|---|---|---|---|
| `y` | years (12 months) | `h` | hours |
| `q` | quarters (3 months) | `m` | minutes |
| `mo` | months | `s` | seconds |
| `w` | weeks (7 days) | `ms` | milliseconds |
| `d` | days | `us` | µs |

## Returns

The type of `VALUE`: declare it as the call's `type`. NULL when `VALUE` or `OFFSET` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `VALUE` isn't a `date` or `datetime` (a `time` or text included): refused when the plan is compiled. |
| `SMALT_MISMATCH` | `OFFSET` is text that isn't an offset (`1 month`, `1d-2h`, `1D`, empty), or neither text nor a `duration`. |
| `SMALT_MISMATCH` | A `date` moved by a time that isn't whole days (`12h`). |

## Notes

- **Months** move on the calendar and keep the day of the month. When the new month is shorter, the result is its
  last day: `2026-01-31` and `1mo` give `2026-02-28`, and `2024-02-29` and `1y` give `2025-02-28`. Moving back is the
  same: `2026-03-31` and `-1mo` give `2026-02-28`. So two steps of `1mo` can end before one step of `2mo`.
- An offset moves by its months first, then its days, then its time: `2026-01-31 10:00` and `1mo2d3h` give
  `2026-03-02 13:00`.
- A sign applies to all of the offset: `-1mo2d` moves back a month and two days.
- A `duration` moves by its µs. A `date` moves by whole days: `24h` is a day.
- SQLite's `date(…, '+1 month')` rolls an overflowing day into the next month (`2026-03-03`); see
  [`date`](../datetime/date).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["date", "date", "date", "date", "date"],
    "rows": [[
      {"k": "call", "fn": "offset_by", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-01-31", "type": "text"}], "type": "date"},
        {"k": "lit", "value": "1mo", "type": "text"}
      ], "type": "date"},
      {"k": "call", "fn": "offset_by", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-03-31", "type": "text"}], "type": "date"},
        {"k": "lit", "value": "-1mo", "type": "text"}
      ], "type": "date"},
      {"k": "call", "fn": "offset_by", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2024-02-29", "type": "text"}], "type": "date"},
        {"k": "lit", "value": "1y", "type": "text"}
      ], "type": "date"},
      {"k": "call", "fn": "offset_by", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-01-31", "type": "text"}], "type": "date"},
        {"k": "lit", "value": "2w", "type": "text"}
      ], "type": "date"},
      {"k": "call", "fn": "offset_by", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-01-31", "type": "text"}], "type": "date"},
        {"k": "lit", "value": null, "type": "text"}
      ], "type": "date"}
    ]]
  },
  "columns": [{"name": "month"}, {"name": "back"}, {"name": "leap"}, {"name": "weeks"}, {"name": "null"}]
}
```

| month | back | leap | weeks | null |
|---|---|---|---|---|
| 2026-02-28 | 2026-02-28 | 2025-02-28 | 2026-02-14 | NULL |

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["datetime", "datetime", "datetime", "datetime"],
    "rows": [[
      {"k": "call", "fn": "offset_by", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-01-31 10:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "1mo2d3h", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "offset_by", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-01-31 10:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "-90m", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "offset_by", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-01-31 10:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "500ms", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "offset_by", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-01-31 10:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": 5400000000, "type": "duration"}
      ], "type": "datetime"}
    ]]
  },
  "columns": [{"name": "mixed"}, {"name": "minutes"}, {"name": "fraction"}, {"name": "duration"}]
}
```

| mixed | minutes | fraction | duration |
|---|---|---|---|
| 2026-03-02 13:00:00 | 2026-01-31 08:30:00 | 2026-01-31 10:00:00.500 | 2026-01-31 11:30:00 |

A `date` moves by whole days:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["date"],
    "rows": [[
      {"k": "call", "fn": "offset_by", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-01-31", "type": "text"}], "type": "date"},
        {"k": "lit", "value": "12h", "type": "text"}
      ], "type": "date"}
    ]]
  },
  "columns": [{"name": "day"}]
}
```

## Demo

Each order's day, and when its invoice falls due, a month later:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "project",
      "input": {"op": "scan", "table": "orders", "columns": [0, 3]},
      "exprs": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
        {"k": "call", "fn": "offset_by", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
          {"k": "lit", "value": "1mo", "type": "text"}
        ], "type": "date"}
      ]
    },
    "keys": [
      {
        "expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        "desc": false,
        "nullsFirst": true,
        "collation": "binary"
      }
    ]
  },
  "columns": [{"name": "id"}, {"name": "day"}, {"name": "due"}]
}
```

| id | day | due |
|---|---|---|
| 1 | 2026-11-02 | 2026-12-02 |
| 2 | 2026-11-02 | 2026-12-02 |
| 3 | 2026-11-03 | 2026-12-03 |
| 4 | 2026-11-04 | 2026-12-04 |
| 5 | 2026-11-05 | 2026-12-05 |
| 6 | 2026-11-05 | 2026-12-05 |

## See also

- [`trunc_temporal`](./trunc_temporal), [`make_date`](./make_date), [`from_zone`](./from_zone)
- [`add`](../arithmetic/add): a `datetime` plus a `duration`
- [Date and time functions](./)
