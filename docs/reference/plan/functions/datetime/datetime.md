---
description: 'The date and time of a time value as YYYY-MM-DD HH:MM:SS text, after its modifiers.'
---

# datetime

```ebnf
datetime ::= '"fn": "datetime"' ', "args": [' (TIME (',' MODIFIER)*)? ']'
```

The date and time of a time value, after its modifiers, as text in the form `YYYY-MM-DD HH:MM:SS`, or with
`.SSS` after the `subsec` modifier: SQLite's `datetime()`.

## Parameters

| Argument | Type | |
|---|---|---|
| `TIME` | any | Optional: a [time value](./#time-values): text, or a number (a julian day, or seconds with `unixepoch`). Without one, the current instant. |
| `MODIFIER` | `text` | Any number: [modifiers](./#modifiers), applied from left to right. |

## Returns

`text`. NULL when an argument is NULL, when the time value or a modifier doesn't parse, and when the result is out
of range.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | In an index expression or a CHECK constraint, the call reads the clock or the host's time zone. |

## Notes

- A `date` or `datetime` value is read as the number underneath it, not as its date: pass it through
  [`cast_text`](../conversion/cast_text) first.
- A zone in the time value (`+02:00`, `Z`) moves it to UTC. The result has no zone.
- The engine's `datetime` type writes the same form in results, with up to six fraction digits;
  [`cast_datetime`](../conversion/cast_datetime) reads this text back.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "datetime", "args": [{"k": "lit", "value": "2026-11-07T12:30:45", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [
        {"k": "lit", "value": "2026-11-07 12:30:45+02:00", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [
        {"k": "lit", "value": "2026-11-07 12:30", "type": "text"},
        {"k": "lit", "value": "start of month", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [
        {"k": "lit", "value": "2026-11-07 12:30:45.25", "type": "text"},
        {"k": "lit", "value": "subsec", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "t"}, {"name": "zone"}, {"name": "start"}, {"name": "subsec"}, {"name": "null"}]
}
```

| t | zone | start | subsec | null |
|---|---|---|---|---|
| 2026-11-07 12:30:45 | 2026-11-07 10:30:45 | 2026-11-01 00:00:00 | 2026-11-07 12:30:45.250 | NULL |

## Demo

Each order's day at 09:15, as text:

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
          {"k": "call", "fn": "datetime", "args": [
            {"k": "call", "fn": "cast_text", "args": [
              {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
            ], "type": "text"},
            {"k": "lit", "value": "+9 hours", "type": "text"},
            {"k": "lit", "value": "+15 minutes", "type": "text"}
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
  "columns": [{"name": "day"}, {"name": "opens"}]
}
```

| day | opens |
|---|---|
| 2026-11-02 | 2026-11-02 09:15:00 |
| 2026-11-03 | 2026-11-03 09:15:00 |
| 2026-11-04 | 2026-11-04 09:15:00 |
| 2026-11-05 | 2026-11-05 09:15:00 |

## See also

- [`date`](./date), [`time`](./time), [`strftime`](./strftime), [`make_datetime`](../temporal/make_datetime)
- [Date and time text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
