---
description: 'Parts, construction, parsing, formatting, truncation, offsets and time zones of date, datetime and time values.'
---

# Date and time functions

These functions work on the engine's date and time types ([ADR 0019](../../../../adr/0019-dates-and-times.md)):
`date` (days since 1970-01-01), `datetime` and `time` (µs since 1970-01-01 00:00:00, and since midnight) and
`duration` (µs). Each takes the types it names, and a plan that gives it another, text included, is refused when it is
compiled (`SMALT_MISMATCH`): a value's type says what its integer counts, so a function can't guess. A NULL argument
gives NULL. Results give these values as text: `2026-11-07`, `2026-11-07 12:30:00.500`, `12:30:00` and `PT1H30M`
([types](../../types)).

A date or time written in a plan is a call of [`cast_date`](../conversion/cast_date),
[`cast_datetime`](../conversion/cast_datetime) or [`cast_time`](../conversion/cast_time) on text; a `lit` of type
`date` with text in it is still text, and these functions refuse it when they run. A `duration` is a number of µs: a
`lit` of type `duration` (`5400000000` is `PT1H30M`), or the difference of two `datetime` values (`sub`).

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["date", "datetime", "time", "duration"],
    "rows": [[
      {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"},
      {"k": "call", "fn": "cast_datetime", "args": [
        {"k": "lit", "value": "2026-11-07 12:30:00.5", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "12:30", "type": "text"}], "type": "time"},
      {"k": "call", "fn": "sub", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-07 12:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-06 10:30", "type": "text"}
        ], "type": "datetime"}
      ], "type": "duration"}
    ]]
  },
  "columns": [{"name": "date"}, {"name": "datetime"}, {"name": "time"}, {"name": "duration"}]
}
```

| date | datetime | time | duration |
|---|---|---|---|
| 2026-11-07 | 2026-11-07 12:30:00.500 | 12:30:00 | P1DT1H30M |

SQLite's own date and time functions, which work on text and numbers, are the
[date and time text functions](../datetime/). They read a `date` or `datetime` as a number, not as its date: give them
its text ([`cast_text`](../conversion/cast_text)).

## Time zones {#zones}

A `datetime` has no zone: whether a value is a UTC instant or a wall-clock time is what the data means, and
[`to_zone`](./to_zone), [`from_zone`](./from_zone) and [`zone_offset`](./zone_offset) say which they take. A zone is
text:

- an IANA name: `Europe/Paris`, `America/New_York`, `Asia/Kolkata`;
- `UTC`, `Etc/UTC` or `Z`;
- a fixed offset from UTC: a sign, two digits of hours (up to 23) and optionally two of minutes, with or without a
  colon: `+05:30`, `+0530`, `-08`.

Offsets of IANA zones, summer time included, come from the runtime's `Intl.DateTimeFormat`: the engine carries no
time zone database, so a zone the runtime doesn't know is an error (`SMALT_MISMATCH`). A zone is an argument like any
other, so a column can give each row its own.

## Formats {#formats}

[`format_temporal`](./format_temporal) writes a value with a `strftime` format, and [`parse_date`](./parse_date) and
[`parse_datetime`](./parse_datetime) read text with one. The [directives](./format_temporal#directives) are the
engine's own, with English names; they are not those of SQLite's [`strftime`](../datetime/strftime).

## Arithmetic {#arithmetic}

Arithmetic on these values is the arithmetic on their integers, with these result types: `datetime - datetime` and
`time - time` give a `duration`, `date - date` the days between them as a `duration`, `datetime ± duration` a
`datetime`, and `duration * int` or `duration / int` a `duration`. Calendar months and days are
[`offset_by`](./offset_by)'s.

## Functions {#functions}

- [`year`](./year): The year of a date or datetime.
- [`month`](./month): The month of a date or datetime, 1 to 12.
- [`day`](./day): The day of the month of a date or datetime, 1 to 31.
- [`weekday`](./weekday): The ISO day of the week of a date or datetime: Monday is 1, Sunday 7.
- [`day_of_year`](./day_of_year): The day of the year of a date or datetime, 1 to 366.
- [`hour`](./hour): The hour of a datetime or time, 0 to 23.
- [`minute`](./minute): The minute of a datetime or time, 0 to 59.
- [`second`](./second): The second of a datetime or time, 0 to 59, without its fraction.
- [`microsecond`](./microsecond): The µs within the second of a datetime or time, 0 to 999999.
- [`make_date`](./make_date): A date from its year, month and day.
- [`make_datetime`](./make_datetime): A datetime from its year, month and day, and optionally its hour, minute, second and µs.
- [`parse_date`](./parse_date): A date read from text, in the result format or with a strftime format; NULL when it isn't one.
- [`parse_datetime`](./parse_datetime): A datetime read from text, in the result format or with a strftime format; NULL when it isn't one.
- [`format_temporal`](./format_temporal): A date, datetime or time written as text with a strftime format.
- [`trunc_temporal`](./trunc_temporal): A date, datetime or time cut back to the start of its year, quarter, month, week, day, hour, minute or second.
- [`offset_by`](./offset_by): A date or datetime moved by a duration, or by calendar months, days and time written as text such as 1mo.
- [`to_zone`](./to_zone): The wall-clock time in a time zone at a UTC instant.
- [`from_zone`](./from_zone): The UTC instant of a wall-clock time in a time zone, with a choice for times that occur twice or not at all.
- [`zone_offset`](./zone_offset): A time zone's offset from UTC at a UTC instant, as a duration.
- [`current_date`](./current_date): Today's date in UTC, as YYYY-MM-DD text.
- [`current_time`](./current_time): The time now in UTC, as HH:MM:SS text.
- [`current_timestamp`](./current_timestamp): The date and time now in UTC, as YYYY-MM-DD HH:MM:SS text.
