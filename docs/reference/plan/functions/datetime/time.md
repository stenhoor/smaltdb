---
description: 'The time of day of a time value as HH:MM:SS text, after its modifiers.'
---

# time

```ebnf
time ::= '"fn": "time"' ', "args": [' (TIME (',' MODIFIER)*)? ']'
```

The time of day of a time value, after its modifiers, as text in the form `HH:MM:SS`, or `HH:MM:SS.SSS` with the
`subsec` modifier: SQLite's `time()`.

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
- Without `subsec` the fraction of the second is cut off, not rounded; with it, the milliseconds are kept, and a finer
  fraction is cut to them.
- Adding time past midnight wraps: `23:30` and `+1 hour` give `00:30:00` (of the next day, which `time` doesn't
  show).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "time", "args": [{"k": "lit", "value": "2026-11-07 12:30:45.678", "type": "text"}], "type": "text"},
      {"k": "call", "fn": "time", "args": [
        {"k": "lit", "value": "2026-11-07 12:30:45.678", "type": "text"},
        {"k": "lit", "value": "subsec", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "time", "args": [
        {"k": "lit", "value": "12:30", "type": "text"},
        {"k": "lit", "value": "+90 minutes", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "time", "args": [
        {"k": "lit", "value": "23:30", "type": "text"},
        {"k": "lit", "value": "+1 hour", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "time", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "plain"}, {"name": "subsec"}, {"name": "later"}, {"name": "wraps"}, {"name": "null"}]
}
```

| plain | subsec | later | wraps | null |
|---|---|---|---|---|
| 12:30:45 | 12:30:45.678 | 14:00:00 | 00:30:00 | NULL |

## Demo

Each order day's midnight, three and a half hours on:

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
          {"k": "call", "fn": "time", "args": [
            {"k": "call", "fn": "cast_text", "args": [
              {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
            ], "type": "text"},
            {"k": "lit", "value": "+03:30", "type": "text"}
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
  "columns": [{"name": "day"}, {"name": "at"}]
}
```

| day | at |
|---|---|
| 2026-11-02 | 03:30:00 |
| 2026-11-03 | 03:30:00 |
| 2026-11-04 | 03:30:00 |
| 2026-11-05 | 03:30:00 |

## See also

- [`datetime`](./datetime), [`strftime`](./strftime), [`cast_time`](../conversion/cast_time)
- [Date and time text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
