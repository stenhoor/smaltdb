---
description: 'The date of a time value as YYYY-MM-DD text, after its modifiers.'
---

# date

```ebnf
date ::= '"fn": "date"' ', "args": [' (TIME (',' MODIFIER)*)? ']'
```

The date of a time value, after its modifiers, as text in the form `YYYY-MM-DD`: SQLite's `date()`. Years before
1 have a `-`.

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
- A day the month hasn't rolls over: `2026-02-30` is `2026-03-02`. [`make_date`](../temporal/make_date) and
  [`parse_date`](../temporal/parse_date) refuse it.
- `+1 month` rolls over too, where [`offset_by`](../temporal/offset_by) keeps to the month's last day; `floor`
  does the same here.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "date", "args": [{"k": "lit", "value": "2026-11-07 12:30:45", "type": "text"}], "type": "text"},
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
        {"k": "lit", "value": 1794054645, "type": "int"},
        {"k": "lit", "value": "unixepoch", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "date", "args": [
        {"k": "lit", "value": "2026-11-07", "type": "text"},
        {"k": "lit", "value": "+1 fortnight", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "date", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "text"}
    ]]
  },
  "columns": [{"name": "plain"}, {"name": "month"}, {"name": "floor"}, {"name": "unix"}, {"name": "bad"}, {"name": "null"}]
}
```

| plain | month | floor | unix | bad | null |
|---|---|---|---|---|---|
| 2026-11-07 | 2026-03-03 | 2026-02-28 | 2026-11-07 | NULL | NULL |

## Demo

The Sunday on or after each order's day, from the day's text:

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
          {"k": "call", "fn": "date", "args": [
            {"k": "call", "fn": "cast_text", "args": [
              {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
            ], "type": "text"},
            {"k": "lit", "value": "weekday 0", "type": "text"}
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
  "columns": [{"name": "day"}, {"name": "sunday"}]
}
```

| day | sunday |
|---|---|
| 2026-11-02 | 2026-11-08 |
| 2026-11-03 | 2026-11-08 |
| 2026-11-04 | 2026-11-08 |
| 2026-11-05 | 2026-11-08 |

## See also

- [`datetime`](./datetime), [`strftime`](./strftime), [`cast_date`](../conversion/cast_date), [`offset_by`](../temporal/offset_by)
- [Date and time text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
