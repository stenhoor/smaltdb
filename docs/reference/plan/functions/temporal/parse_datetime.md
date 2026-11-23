---
description: 'A datetime read from text, in the result format or with a strftime format; NULL when it isn''t one.'
---

# parse_datetime

```ebnf
parse_datetime ::= '"fn": "parse_datetime"' ', "args": [' TEXT (',' FORMAT)? ']'
```

A `datetime` read from text. With one argument the text is in the form results give a `datetime`
(`YYYY-MM-DD HH:MM:SS.ffffff`, the seconds and fraction optional), with a space or a `T` between the date and the
time, or a date alone (midnight). With a `FORMAT` it is read with the [directives](./format_temporal#directives) of
a `strftime` format. Text that doesn't match, or isn't a date and time that exist, gives NULL.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text. A number is read as its text. Spaces around it are ignored. |
| `FORMAT` | `text` | Optional: the format, of the directives except `%u` and `%w`. |

## Returns

`datetime`. NULL when `TEXT` or `FORMAT` is NULL, when the text doesn't match, and when the date or the time doesn't
exist.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `FORMAT` has an unknown directive, `%u` or `%w`, or no year (`%Y` or `%y`). |

## Notes

- Without a format, hours, minutes and seconds take two digits, and the fraction up to nine, cut to µs. A zone
  (`+01:00`, `Z`) or `24:00` doesn't match: NULL. [`cast_datetime`](../conversion/cast_datetime) reads the same text but
  fails where `parse_datetime` gives NULL.
- The value has no zone: it is the wall-clock time the text gives. [`from_zone`](./from_zone) gives the UTC instant
  of a wall-clock time in a zone.
- A format needs a year. A missing month or day is 1, and a missing clock part 0. `%I` reads a 12-hour clock: with
  `%p`, 12 AM is midnight and 12 PM noon; without it, the hour as written. `%f` reads up to nine digits, cut to µs.
- A format matches all of the text; a space in it matches any run of spaces.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["datetime", "datetime", "datetime", "datetime", "datetime", "datetime"],
    "rows": [[
      {"k": "call", "fn": "parse_datetime", "args": [
        {"k": "lit", "value": "2026-11-07 12:30:05", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "parse_datetime", "args": [
        {"k": "lit", "value": "2026-11-07T12:30:00.5", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "parse_datetime", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "datetime"},
      {"k": "call", "fn": "parse_datetime", "args": [
        {"k": "lit", "value": "7.11.2026 3:05 pm", "type": "text"},
        {"k": "lit", "value": "%d.%m.%Y %I:%M %p", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "parse_datetime", "args": [
        {"k": "lit", "value": "2026-11-07 12:30:00+01:00", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "parse_datetime", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "datetime"}
    ]]
  },
  "columns": [{"name": "iso"}, {"name": "t"}, {"name": "date"}, {"name": "format"}, {"name": "zone"}, {"name": "null"}]
}
```

| iso | t | date | format | zone | null |
|---|---|---|---|---|---|
| 2026-11-07 12:30:05 | 2026-11-07 12:30:00.500 | 2026-11-07 00:00:00 | 2026-11-07 15:05:00 | NULL | NULL |

`%w` writes a weekday but can't read one:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["datetime"],
    "rows": [[
      {"k": "call", "fn": "parse_datetime", "args": [
        {"k": "lit", "value": "6 2026-11-07", "type": "text"},
        {"k": "lit", "value": "%w %F", "type": "text"}
      ], "type": "datetime"}
    ]]
  },
  "columns": [{"name": "at"}]
}
```

## Demo

The orders made before noon on 4 November, if each was made at midnight of its day:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "orders", "columns": [0, 3]},
    "pred": {"k": "call", "fn": "cmp_lt", "args": [
      {"k": "call", "fn": "cast_datetime", "args": [
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"}
      ], "type": "datetime"},
      {"k": "call", "fn": "parse_datetime", "args": [
        {"k": "lit", "value": "2026-11-04 12:00", "type": "text"}
      ], "type": "datetime"}
    ], "type": "bool"}
  },
  "columns": [{"name": "id"}, {"name": "day"}]
}
```

| id | day |
|---|---|
| 1 | 2026-11-02 |
| 2 | 2026-11-02 |
| 3 | 2026-11-03 |
| 4 | 2026-11-04 |

## See also

- [`parse_date`](./parse_date), [`format_temporal`](./format_temporal), [`make_datetime`](./make_datetime), [`from_zone`](./from_zone)
- [`cast_datetime`](../conversion/cast_datetime): a `datetime` from text, failing on text that isn't one
- [Date and time functions](./)
