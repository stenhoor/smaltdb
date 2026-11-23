---
description: 'SQLite''s date and time functions, over text and numbers.'
---

# Date and time text functions

These are SQLite's date and time functions, ported from its `date.c` (3.54): the same parsing, modifiers and
rounding. They work on text and numbers, not on the engine's date and time types: each takes a
[time value](#time-values), then any number of [modifiers](#modifiers) applied from left to right, and gives text
(`date`, `time`, `datetime`, `strftime`, `timediff`) or a number (`julianday`, `unixepoch`). Times are UTC unless a
`localtime` modifier says otherwise.

- **NULL, not errors.** A NULL argument, a time value or a modifier that doesn't parse, and a result outside
  `-4713-11-24 12:00:00` to `9999-12-31 23:59:59.999` all give NULL.
- **Now.** No time value, `'now'`, `'subsec'` and `'subsecond'` are the current instant, UTC. The clock is read once
  for each run of a statement, so every row sees the same instant, as do [`current_date`](../temporal/current_date),
  [`current_time`](../temporal/current_time) and [`current_timestamp`](../temporal/current_timestamp). The catalog
  marks these functions as not deterministic for that reason.
- **The engine's types.** A `date`, `datetime` or `time` value is an integer underneath, and these functions read it
  as a number: a julian day. Give them its text with [`cast_text`](../conversion/cast_text), as the demos do. The
  [date and time functions](../temporal/) work on the types themselves.
- **Indexes and CHECK constraints.** In an index expression or a CHECK constraint, a call that reads the clock or
  the host's time zone (no time value, `'now'`, `'subsec'`, `localtime`, `utc`) fails when a row reaches it
  (`SMALT_ERROR`, `non-deterministic use of date() in an index`).

## Time values {#time-values}

| Form | Example | |
|---|---|---|
| `YYYY-MM-DD` | `2026-11-07` | Midnight at the start of the day |
| `YYYY-MM-DD HH:MM` | `2026-11-07 12:30` | |
| `YYYY-MM-DD HH:MM:SS` | `2026-11-07 12:30:45` | |
| `YYYY-MM-DD HH:MM:SS.SSS` | `2026-11-07 12:30:45.250` | Any number of fraction digits, kept to the millisecond |
| `YYYY-MM-DDTHH:MM…` | `2026-11-07T12:30:45` | A `T` between the date and the time |
| `HH:MM`, `HH:MM:SS`, `HH:MM:SS.SSS` | `12:30` | A time alone, on `2000-01-01` |
| any of these and a zone | `2026-11-07 12:30:45+02:00`, `…Z` | `[+-]HH:MM` or `Z`, after optional spaces: the time is moved to UTC |
| `24:00` | `2026-11-07 24:00` | Midnight at the end of the day |
| `now` | `now` | The current instant |
| `subsec`, `subsecond` | `subsec` | The current instant, with milliseconds in the result |
| a number | `2461351.5` | A julian day, or with `unixepoch` or `auto` seconds since 1970; numeric text is the same |

Years have four digits, or a `-` and four. Months, days, hours and minutes take two digits. Spaces before the value
aren't allowed; spaces after it are. A day from 29 to 31 that the month hasn't rolls into the next month.

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "datetime", "args": [{"k": "lit", "value": "2026-11-07T12:30:45.250", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [{"k": "lit", "value": "12:30", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [
        {"k": "lit", "value": "2026-11-07 12:30:45+02:00", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [{"k": "lit", "value": "2026-11-07 24:00", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [{"k": "lit", "value": 2461351.5, "type": "real"}], "type": "text"},
      {"k": "call", "fn": "date", "args": [{"k": "lit", "value": "2026-02-30", "type": "text"}], "type": "text"}
    ]]
  },
  "columns": [
    {"name": "t"},
    {"name": "time_only"},
    {"name": "zone"},
    {"name": "end_of_day"},
    {"name": "julian"},
    {"name": "rolled"}
  ]
}
```

| t | time_only | zone | end_of_day | julian | rolled |
|---|---|---|---|---|---|
| 2026-11-07 12:30:45 | 2000-01-01 12:30:00 | 2026-11-07 10:30:45 | 2026-11-08 00:00:00 | 2026-11-07 00:00:00 | 2026-03-02 |

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "date", "args": [{"k": "lit", "value": "2026-13-01", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "date", "args": [{"k": "lit", "value": "2026-1-7", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "date", "args": [{"k": "lit", "value": " 2026-01-07", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "date", "args": [{"k": "lit", "value": "20260107", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "date", "args": [{"k": "lit", "value": "nonsense", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "date", "args": [{"k": "lit", "value": "10000-01-01", "type": "text"}], "type": "text"}
    ]]
  },
  "columns": [
    {"name": "bad_month"},
    {"name": "one_digit"},
    {"name": "leading_space"},
    {"name": "compact"},
    {"name": "nonsense"},
    {"name": "too_late"}
  ]
}
```

| bad_month | one_digit | leading_space | compact | nonsense | too_late |
|---|---|---|---|---|---|
| NULL | NULL | NULL | NULL | NULL | NULL |

## Modifiers {#modifiers}

Each modifier is text, in any case, and changes the result of the ones before it.

| Modifier | Effect |
|---|---|
| `±N days`, `±N hours`, `±N minutes`, `±N seconds` | Add or subtract. `N` may have a fraction (`+1.5 hours`); the `+` and the plural `s` are optional |
| `±N months`, `±N years` | Add or subtract calendar months or years, keeping the day of the month; a day the month hasn't rolls over (see `floor`). A fraction is added as days: 30 to a month, 365 to a year |
| `±HH:MM`, `±HH:MM:SS`, `±HH:MM:SS.SSS` | Add or subtract a time |
| `±YYYY-MM-DD`, `±YYYY-MM-DD HH:MM[:SS[.SSS]]` | Add or subtract years, months (0 to 11) and days (0 to 30), and a time; the sign is required |
| `start of day`, `start of month`, `start of year` | Back to midnight; of the first day of the month; of 1 January |
| `weekday N` | Forward to the next day whose weekday is `N` (0 is Sunday, 6 Saturday), or no change when it is |
| `weekday -N` | Back to the last day whose weekday is `N`, or no change when it is |
| `unixepoch` | The number before it is seconds since 1970, not a julian day. Only as the first modifier |
| `julianday` | The number before it is a julian day (the default). Only as the first modifier |
| `auto` | A number from 0 to 5373484.5 is a julian day, any other seconds since 1970. Only as the first modifier |
| `localtime` | From UTC to the host's time zone (the browser's or Node.js's) |
| `utc` | From the host's time zone to UTC |
| `subsec`, `subsecond` | Milliseconds in the result of `time`, `datetime`, `unixepoch` and `strftime`'s `%s` |
| `floor` | After months or years that rolled over, back to the last day of the month meant |
| `ceiling` | Keep the rolled-over day (the default) |

A modifier that doesn't parse (`+1 fortnight`, `start of week`, `weekday 7`) gives NULL.

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "date", "args": [
        {"k": "lit", "value": "2026-11-07", "type": "text"},
        {"k": "lit", "value": "+10 days", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [
        {"k": "lit", "value": "2026-11-07 10:00", "type": "text"},
        {"k": "lit", "value": "+1.5 hours", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [
        {"k": "lit", "value": "2026-11-07 10:00", "type": "text"},
        {"k": "lit", "value": "-01:30", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [
        {"k": "lit", "value": "2026-11-07 10:00", "type": "text"},
        {"k": "lit", "value": "+0001-02-03", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "date", "args": [
        {"k": "lit", "value": "2026-11-07", "type": "text"},
        {"k": "lit", "value": "start of month", "type": "text"},
        {"k": "lit", "value": "+1 month", "type": "text"},
        {"k": "lit", "value": "-1 day", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "date", "args": [
        {"k": "lit", "value": "2026-11-07", "type": "text"},
        {"k": "lit", "value": "weekday 0", "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [
    {"name": "plus_days"},
    {"name": "fraction"},
    {"name": "hh_mm"},
    {"name": "ymd"},
    {"name": "month_end"},
    {"name": "next_sunday"}
  ]
}
```

| plus_days | fraction | hh_mm | ymd | month_end | next_sunday |
|---|---|---|---|---|---|
| 2026-11-17 | 2026-11-07 11:30:00 | 2026-11-07 08:30:00 | 2028-01-10 10:00:00 | 2026-11-30 | 2026-11-08 |

Months keep the day of the month, and roll over when the month hasn't it; `floor` goes back to the month's last day:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "date", "args": [
        {"k": "lit", "value": "2026-01-31", "type": "text"},
        {"k": "lit", "value": "+1 month", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "date", "args": [
        {"k": "lit", "value": "2026-01-31", "type": "text"},
        {"k": "lit", "value": "+1 month", "type": "text"},
        {"k": "lit", "value": "floor", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "date", "args": [
        {"k": "lit", "value": "2024-02-29", "type": "text"},
        {"k": "lit", "value": "+1 year", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "date", "args": [
        {"k": "lit", "value": "2024-02-29", "type": "text"},
        {"k": "lit", "value": "+1 year", "type": "text"},
        {"k": "lit", "value": "floor", "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "rolled"}, {"name": "floor"}, {"name": "leap_rolled"}, {"name": "leap_floor"}]
}
```

| rolled | floor | leap_rolled | leap_floor |
|---|---|---|---|
| 2026-03-03 | 2026-02-28 | 2025-03-01 | 2025-02-28 |

Numbers are julian days, or seconds since 1970 with `unixepoch`:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "datetime", "args": [
        {"k": "lit", "value": 1794054645, "type": "int"},
        {"k": "lit", "value": "unixepoch", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [
        {"k": "lit", "value": 1794054645.5, "type": "real"},
        {"k": "lit", "value": "unixepoch", "type": "text"},
        {"k": "lit", "value": "subsec", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [
        {"k": "lit", "value": 1794054645, "type": "int"},
        {"k": "lit", "value": "auto", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [{"k": "lit", "value": 2461351.5, "type": "real"}], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [
        {"k": "lit", "value": 1794054645, "type": "int"},
        {"k": "lit", "value": "+1 day", "type": "text"},
        {"k": "lit", "value": "unixepoch", "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "unix"}, {"name": "subsec"}, {"name": "auto"}, {"name": "julian"}, {"name": "not_first"}]
}
```

| unix | subsec | auto | julian | not_first |
|---|---|---|---|---|
| 2026-11-07 12:30:45 | 2026-11-07 12:30:45.500 | 2026-11-07 12:30:45 | 2026-11-07 00:00:00 | NULL |

## Functions {#functions}

- [`date`](./date): The date of a time value as YYYY-MM-DD text, after its modifiers.
- [`time`](./time): The time of day of a time value as HH:MM:SS text, after its modifiers.
- [`datetime`](./datetime): The date and time of a time value as YYYY-MM-DD HH:MM:SS text, after its modifiers.
- [`julianday`](./julianday): The julian day of a time value, after its modifiers: days since noon UTC on 24 November 4714 BC.
- [`unixepoch`](./unixepoch): The seconds since 1970-01-01 00:00:00 UTC of a time value, after its modifiers.
- [`strftime`](./strftime): A time value, after its modifiers, written with SQLite's strftime format.
- [`timediff`](./timediff): The time from one time value to another, as years, months, days and a time.
