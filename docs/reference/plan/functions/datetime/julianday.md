---
description: 'The julian day of a time value, after its modifiers: days since noon UTC on 24 November 4714 BC.'
---

# julianday

```ebnf
julianday ::= '"fn": "julianday"' ', "args": [' (TIME (',' MODIFIER)*)? ']'
```

The julian day of a time value, after its modifiers: the days since noon UTC on 24 November 4714 BC (proleptic
Gregorian), with a fraction for the time: SQLite's `julianday()`.

## Parameters

| Argument | Type | |
|---|---|---|
| `TIME` | any | Optional: a [time value](./#time-values): text, or a number (a julian day, or seconds with `unixepoch`). Without one, the current instant. |
| `MODIFIER` | `text` | Any number: [modifiers](./#modifiers), applied from left to right. |

## Returns

`real`. NULL when an argument is NULL, when the time value or a modifier doesn't parse, and when the result is out
of range.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | In an index expression or a CHECK constraint, the call reads the clock or the host's time zone. |

## Notes

- A `date` or `datetime` value is read as the number underneath it, not as its date: pass it through
  [`cast_text`](../conversion/cast_text) first.
- A julian day begins at noon: midnight is `.5`. The difference of two julian days is a number of days.
- The time is kept to the millisecond, so a fraction can show binary rounding (`2461352.0000000116`).
- A number given as the time value is read as a julian day, so `julianday` of a number is the number, within range.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["real", "real", "real", "real"],
    "rows": [[
      {"k": "call", "fn": "julianday", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "julianday", "args": [{"k": "lit", "value": "2026-11-07 12:00", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "julianday", "args": [{"k": "lit", "value": "2000-01-01 12:00", "type": "text"}], "type": "real"},
      {"k": "call", "fn": "julianday", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "real"}
    ]]
  },
  "columns": [{"name": "midnight"}, {"name": "noon"}, {"name": "j2000"}, {"name": "null"}]
}
```

| midnight | noon | j2000 | null |
|---|---|---|---|
| 2461351.5 | 2461352 | 2451545 | NULL |

## Demo

The days from each order's day to the end of the year:

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
          {"k": "call", "fn": "sub", "args": [
            {"k": "call", "fn": "julianday", "args": [{"k": "lit", "value": "2026-12-31", "type": "text"}], "type": "real"},
            {"k": "call", "fn": "julianday", "args": [
              {"k": "call", "fn": "cast_text", "args": [
                {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
              ], "type": "text"}
            ], "type": "real"}
          ], "type": "real"}
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
  "columns": [{"name": "day"}, {"name": "days_left"}]
}
```

| day | days_left |
|---|---|
| 2026-11-02 | 59 |
| 2026-11-03 | 58 |
| 2026-11-04 | 57 |
| 2026-11-05 | 56 |

## See also

- [`unixepoch`](./unixepoch), [`timediff`](./timediff), [`strftime`](./strftime) (`%J`)
- [Date and time text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
