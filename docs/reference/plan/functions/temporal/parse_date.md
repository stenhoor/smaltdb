---
description: 'A date read from text, in the result format or with a strftime format; NULL when it isn''t one.'
---

# parse_date

```ebnf
parse_date ::= '"fn": "parse_date"' ', "args": [' TEXT (',' FORMAT)? ']'
```

A `date` read from text. With one argument the text is in the form results give a `date`: `YYYY-MM-DD`. With a
`FORMAT` it is read with the [directives](./format_temporal#directives) of a `strftime` format. Text that doesn't
match, or that names a day that doesn't exist, gives NULL.

## Parameters

| Argument | Type | |
|---|---|---|
| `TEXT` | `text` | The text. A number is read as its text. Spaces around it are ignored. |
| `FORMAT` | `text` | Optional: the format, of `%Y`, `%y`, `%m`, `%d`, `%e`, `%j`, `%b`, `%B`, `%a`, `%A`, `%F`, the clock directives and `%%`. |

## Returns

`date`. NULL when `TEXT` or `FORMAT` is NULL, when the text doesn't match, and when the date doesn't exist
(`2026-02-30`).

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `FORMAT` has an unknown directive, `%u` or `%w`, or no year (`%Y` or `%y`). |

## Notes

- Without a format, the text is `YYYY-MM-DD` and nothing more: two-digit months and days, and a year of four digits or a
  sign and four to six (`-0043-03-15`, `+12026-01-01`). [`cast_date`](../conversion/cast_date) reads the same text
  but fails where `parse_date` gives NULL.
- A format needs a year. A missing month or day is 1; `%j` gives the day of the year instead. `%y` reads 69 to 99 as
  the 1900s and 00 to 68 as the 2000s.
- A format matches all of the text. A space in it matches any run of spaces; month names match in any case; weekday
  names are read but not checked. Clock directives (`%H`, `%M`, …) must match, and are then dropped.
- A number field takes one or two digits (`%Y` up to six), so a format whose fields aren't separated (`%Y%m%d`) can
  split the digits where it shouldn't and give NULL.
- A `date` value given as `TEXT` is read as its day count, which isn't a date: NULL.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["date", "date", "date", "date", "date", "date"],
    "rows": [[
      {"k": "call", "fn": "parse_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"},
      {"k": "call", "fn": "parse_date", "args": [
        {"k": "lit", "value": "07/11/2026", "type": "text"},
        {"k": "lit", "value": "%d/%m/%Y", "type": "text"}
      ], "type": "date"},
      {"k": "call", "fn": "parse_date", "args": [
        {"k": "lit", "value": "Sat 7 November 26", "type": "text"},
        {"k": "lit", "value": "%a %d %B %y", "type": "text"}
      ], "type": "date"},
      {"k": "call", "fn": "parse_date", "args": [
        {"k": "lit", "value": "2026-311", "type": "text"},
        {"k": "lit", "value": "%Y-%j", "type": "text"}
      ], "type": "date"},
      {"k": "call", "fn": "parse_date", "args": [{"k": "lit", "value": "2026-02-30", "type": "text"}], "type": "date"},
      {"k": "call", "fn": "parse_date", "args": [{"k": "lit", "value": "2026-11-07 12:00", "type": "text"}], "type": "date"}
    ]]
  },
  "columns": [
    {"name": "iso"},
    {"name": "format"},
    {"name": "names"},
    {"name": "day_of_year"},
    {"name": "no_day"},
    {"name": "no_match"}
  ]
}
```

| iso | format | names | day_of_year | no_day | no_match |
|---|---|---|---|---|---|
| 2026-11-07 | 2026-11-07 | 2026-11-07 | 2026-11-07 | NULL | NULL |

A format to read a date needs its year:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["date"],
    "rows": [[
      {"k": "call", "fn": "parse_date", "args": [
        {"k": "lit", "value": "11/07", "type": "text"},
        {"k": "lit", "value": "%m/%d", "type": "text"}
      ], "type": "date"}
    ]]
  },
  "columns": [{"name": "day"}]
}
```

## Demo

The orders of the day a note gives as `4/11/2026`:

```json
{
  "kind": "query",
  "plan": {
    "op": "filter",
    "input": {"op": "scan", "table": "orders", "columns": [0, 2, 3]},
    "pred": {"k": "call", "fn": "cmp_eq", "args": [
      {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "date", "collation": "binary"},
      {"k": "call", "fn": "parse_date", "args": [
        {"k": "lit", "value": "4/11/2026", "type": "text"},
        {"k": "lit", "value": "%d/%m/%Y", "type": "text"}
      ], "type": "date"}
    ], "type": "bool"}
  },
  "columns": [{"name": "id"}, {"name": "n"}, {"name": "day"}]
}
```

| id | n | day |
|---|---|---|
| 4 | 10 | 2026-11-04 |

## See also

- [`parse_datetime`](./parse_datetime), [`format_temporal`](./format_temporal), [`make_date`](./make_date)
- [`cast_date`](../conversion/cast_date): a `date` from text, failing on text that isn't one
- [Date and time functions](./)
