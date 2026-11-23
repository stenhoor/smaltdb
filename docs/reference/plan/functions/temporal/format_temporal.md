---
description: 'A date, datetime or time written as text with a strftime format.'
---

# format_temporal

```ebnf
format_temporal ::= '"fn": "format_temporal"' ', "args": [' VALUE ',' FORMAT ']'
```

A `date`, `datetime` or `time` written as text with a `strftime` format: each directive in `FORMAT` (a `%` and a
letter) is replaced by a part of the value, and every other character is copied.

## Parameters

| Argument | Type | |
|---|---|---|
| `VALUE` | `date`, `datetime`, `time` | The value. |
| `FORMAT` | `text` | The format, of the directives below. |

## Format directives {#directives}

The examples are for `2026-11-07 15:04:09.123456`, a Saturday. Names are English.

| Directive | Meaning | Example | Needs |
|---|---|---|---|
| `%Y` | The year, four digits (a sign and more beyond 0 to 9999) | `2026` | a date |
| `%y` | The year's last two digits | `26` | a date |
| `%m` | The month, `01` to `12` | `11` | a date |
| `%d` | The day of the month, `01` to `31` | `07` | a date |
| `%e` | The day of the month, space-padded, ` 1` to `31` | ` 7` | a date |
| `%j` | The day of the year, `001` to `366` | `311` | a date |
| `%a` | The weekday's name, short | `Sat` | a date |
| `%A` | The weekday's name | `Saturday` | a date |
| `%b` | The month's name, short | `Nov` | a date |
| `%B` | The month's name | `November` | a date |
| `%u` | The ISO weekday, `1` (Monday) to `7` (Sunday) | `6` | a date |
| `%w` | The weekday, `0` (Sunday) to `6` | `6` | a date |
| `%F` | The date, as `%Y-%m-%d` | `2026-11-07` | a date |
| `%H` | The hour, `00` to `23` | `15` | a clock |
| `%I` | The hour on a 12-hour clock, `01` to `12` | `03` | a clock |
| `%p` | `AM` or `PM` | `PM` | a clock |
| `%M` | The minute, `00` to `59` | `04` | a clock |
| `%S` | The second, `00` to `59` | `09` | a clock |
| `%f` | The µs within the second, six digits | `123456` | a clock |
| `%T` | The time, as `%H:%M:%S` | `15:04:09` | a clock |
| `%%` | A `%` | `%` | |

A `date` has no clock and a `time` has no date: a directive the value hasn't is an error. A `datetime` has both.
[`parse_date`](./parse_date) and [`parse_datetime`](./parse_datetime) read text with the same directives, except `%u`
and `%w`.

## Returns

`text`. NULL when `VALUE` or `FORMAT` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `VALUE` isn't a `date`, `datetime` or `time` (text included): refused when the plan is compiled. |
| `SMALT_MISMATCH` | `FORMAT` has a directive not in the table, or one that needs a part the value hasn't (`%H` of a `date`). |

## Notes

- These are the engine's directives, not SQLite's: SQLite's `strftime` (the [`strftime`](../datetime/strftime)
  function) has `%f` as seconds with milliseconds (`09.123`), and `%J`, `%s`, `%V` and others this format hasn't.
- `%y` is the year modulo 100: 1969 and 2069 both give `69`.
- `%I` gives `12` at midnight and at noon; `%p` tells them apart.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text"],
    "rows": [[
      {"k": "call", "fn": "format_temporal", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-07 15:04:09.123456", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "%Y|%y|%m|%d|%e|%j|%a|%A|%b|%B|%u|%w|%F|%H|%I|%p|%M|%S|%f|%T|%%", "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "all"}]
}
```

| all |
|---|
| 2026\|26\|11\|07\| 7\|311\|Sat\|Saturday\|Nov\|November\|6\|6\|2026-11-07\|15\|03\|PM\|04\|09\|123456\|15:04:09\|% |

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "format_temporal", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-01", "type": "text"}], "type": "date"},
        {"k": "lit", "value": "%A %e %B %Y", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "format_temporal", "args": [
        {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "00:30", "type": "text"}], "type": "time"},
        {"k": "lit", "value": "%I:%M %p", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "format_temporal", "args": [
        {"k": "lit", "value": null, "type": "date"},
        {"k": "lit", "value": "%F", "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "date"}, {"name": "time"}, {"name": "null"}]
}
```

| date | time | null |
|---|---|---|
| Sunday  1 November 2026 | 12:30 AM | NULL |

A `date` has no hour:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text"],
    "rows": [[
      {"k": "call", "fn": "format_temporal", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"},
        {"k": "lit", "value": "%F %H:%M", "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "text"}]
}
```

## Demo

Each order's day, written for a receipt:

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
        {"k": "call", "fn": "format_temporal", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
          {"k": "lit", "value": "%a %e %b", "type": "text"}
        ], "type": "text"}
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
  "columns": [{"name": "id"}, {"name": "day"}]
}
```

| id | day |
|---|---|
| 1 | Mon  2 Nov |
| 2 | Mon  2 Nov |
| 3 | Tue  3 Nov |
| 4 | Wed  4 Nov |
| 5 | Thu  5 Nov |
| 6 | Thu  5 Nov |

## See also

- [`parse_date`](./parse_date), [`parse_datetime`](./parse_datetime), [`trunc_temporal`](./trunc_temporal)
- [`strftime`](../datetime/strftime): SQLite's, over text and numbers
- [`cast_text`](../conversion/cast_text): a temporal value as the text results give it
- [Date and time functions](./)
