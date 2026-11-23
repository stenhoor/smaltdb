---
description: 'A time value, after its modifiers, written with SQLite''s strftime format.'
---

# strftime

```ebnf
strftime ::= '"fn": "strftime"' ', "args": [' (FORMAT (',' TIME (',' MODIFIER)*)?)? ']'
```

A time value, after its modifiers, written with a format: each directive in `FORMAT` (a `%` and a letter) is replaced
by a part of the value, and every other character is copied. SQLite's `strftime()`.

## Parameters

| Argument | Type | |
|---|---|---|
| `FORMAT` | `text` | The format, of the [directives](#directives) below. Without it, the result is NULL. |
| `TIME` | any | Optional: a [time value](./#time-values): text, or a number (a julian day, or seconds with `unixepoch`). Without one, the current instant. |
| `MODIFIER` | `text` | Any number: [modifiers](./#modifiers), applied from left to right. |

## Returns

`text`. NULL when an argument is NULL, when the time value or a modifier doesn't parse, when the result is out of
range, and when `FORMAT` has a directive not in the table.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | In an index expression or a CHECK constraint, the call reads the clock or the host's time zone. |

## Notes

- A `date` or `datetime` value is read as the number underneath it, not as its date: pass it through
  [`cast_text`](../conversion/cast_text) first.
- These are SQLite's directives. The engine's [`format_temporal`](../temporal/format_temporal) formats the engine's
  types with its own: its `%f` is six digits of µs, and it has `%a`, `%b` and names, which SQLite's hasn't.
- Weekday numbers: `%w` counts from Sunday as 0, `%u` from Monday as 1.
- With a format alone, the time value is the current instant.

## Format directives {#directives}

For `2026-11-07 15:04:09.125`, a Saturday:

| Directive | Meaning | Example |
|---|---|---|
| `%d` | The day of the month, `01` to `31` | `07` |
| `%e` | The day of the month, space-padded | ` 7` |
| `%f` | The seconds with milliseconds, `SS.SSS` | `09.125` |
| `%F` | The date, as `%Y-%m-%d` | `2026-11-07` |
| `%G`, `%g` | The ISO 8601 week-based year; its last two digits | `2026`, `26` |
| `%H`, `%k` | The hour, `00` to `23`; space-padded | `15`, `15` |
| `%I`, `%l` | The hour on a 12-hour clock, `01` to `12`; space-padded | `03`, ` 3` |
| `%j` | The day of the year, `001` to `366` | `311` |
| `%J` | The julian day | `2461352.127883391` |
| `%m` | The month, `01` to `12` | `11` |
| `%M` | The minute, `00` to `59` | `04` |
| `%p`, `%P` | `AM` or `PM`; `am` or `pm` | `PM`, `pm` |
| `%R` | The hour and minute, as `%H:%M` | `15:04` |
| `%s` | The seconds since 1970 (with milliseconds after `subsec`) | `1794063849` |
| `%S` | The second, `00` to `59` | `09` |
| `%T` | The time, as `%H:%M:%S` | `15:04:09` |
| `%u` | The weekday, `1` (Monday) to `7` | `6` |
| `%U` | The week of the year, `00` to `53`, weeks from the first Sunday | `44` |
| `%V` | The ISO 8601 week of the year, `01` to `53` | `45` |
| `%w` | The weekday, `0` (Sunday) to `6` | `6` |
| `%W` | The week of the year, `00` to `53`, weeks from the first Monday | `44` |
| `%Y` | The year, `0000` to `9999` | `2026` |
| `%%` | A `%` | `%` |

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text"],
    "rows": [[
      {"k": "call", "fn": "strftime", "args": [
        {"k": "lit", "value": "%d|%e|%f|%F|%G|%g|%H|%I|%j|%J|%k|%l|%m|%M|%p|%P|%R|%s|%S|%T|%u|%U|%V|%w|%W|%Y|%%", "type": "text"},
        {"k": "lit", "value": "2026-11-07 15:04:09.125", "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "all"}]
}
```

| all |
|---|
| 07\| 7\|09.125\|2026-11-07\|2026\|26\|15\|03\|311\|2461352.127883391\|15\| 3\|11\|04\|PM\|pm\|15:04\|1794063849\|09\|15:04:09\|6\|44\|45\|6\|44\|2026\|% |

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "strftime", "args": [
        {"k": "lit", "value": "%Y-%m", "type": "text"},
        {"k": "lit", "value": "2026-11-07", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "strftime", "args": [
        {"k": "lit", "value": "%G-W%V-%u", "type": "text"},
        {"k": "lit", "value": "2027-01-01", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "strftime", "args": [
        {"k": "lit", "value": "%H:%M", "type": "text"},
        {"k": "lit", "value": "2026-11-07 13:45", "type": "text"},
        {"k": "lit", "value": "+1 hour", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "strftime", "args": [
        {"k": "lit", "value": "%s", "type": "text"},
        {"k": "lit", "value": "2026-11-07 12:30:45.25", "type": "text"},
        {"k": "lit", "value": "subsec", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "strftime", "args": [
        {"k": "lit", "value": "%Q", "type": "text"},
        {"k": "lit", "value": "2026-11-07", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "strftime", "args": [
        {"k": "lit", "value": null, "type": "text"},
        {"k": "lit", "value": "2026-11-07", "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [
    {"name": "month"},
    {"name": "iso_week"},
    {"name": "later"},
    {"name": "subsec"},
    {"name": "unknown"},
    {"name": "null"}
  ]
}
```

| month | iso_week | later | subsec | unknown | null |
|---|---|---|---|---|---|
| 2026-11 | 2026-W53-5 | 14:45 | 1794054645.250 | NULL | NULL |

## Demo

The ISO week of each order's day, and its weekday:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "distinct",
      "input": {
        "op": "project",
        "input": {"op": "scan", "table": "orders", "columns": [3]},
        "exprs": [
          {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"},
          {"k": "call", "fn": "strftime", "args": [
            {"k": "lit", "value": "%G-W%V-%u", "type": "text"},
            {"k": "call", "fn": "cast_text", "args": [
              {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
            ], "type": "text"}
          ], "type": "text"}
        ]
      },
      "collations": ["binary", "binary"]
    },
    "keys": [
      {
        "expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"},
        "desc": false,
        "nullsFirst": true,
        "collation": "binary"
      }
    ]
  },
  "columns": [{"name": "day"}, {"name": "iso_week"}]
}
```

| day | iso_week |
|---|---|
| 2026-11-02 | 2026-W45-1 |
| 2026-11-03 | 2026-W45-2 |
| 2026-11-04 | 2026-W45-3 |
| 2026-11-05 | 2026-W45-4 |

## See also

- [`format_temporal`](../temporal/format_temporal), [`date`](./date), [`datetime`](./datetime)
- [Date and time text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
