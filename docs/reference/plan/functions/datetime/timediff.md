---
description: 'The time from one time value to another, as years, months, days and a time.'
---

# timediff

```ebnf
timediff ::= '"fn": "timediff"' ', "args": [' A ',' B ']'
```

The time from `B` to `A`, as text in the form `±YYYY-MM-DD HH:MM:SS.SSS`: a sign, whole years, months and days,
then the time left: SQLite's `timediff()`. The months are calendar months counted from `B`, so the result, as a
modifier on `B`, gives `A`.

## Parameters

| Argument | Type | |
|---|---|---|
| `A` | any | A [time value](./#time-values): the end. |
| `B` | any | A time value: the start. |

## Returns

`text`. NULL when either argument is NULL or doesn't parse.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | In an index expression or a CHECK constraint, a time value reads the clock (`'now'`). |

## Notes

- A `date` or `datetime` value is read as the number underneath it, not as its date: pass it through
  [`cast_text`](../conversion/cast_text) first.
- It takes two time values and no modifiers: apply them first with [`datetime`](./datetime).
- The days are what is left after the months, so the same span can read differently from different starts.
- For a difference in days or seconds, subtract [`julianday`](./julianday) or [`unixepoch`](./unixepoch) values.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["text", "text", "text", "text", "text"],
    "rows": [[
      {"k": "call", "fn": "timediff", "args": [
        {"k": "lit", "value": "2026-11-07", "type": "text"},
        {"k": "lit", "value": "2026-01-01", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "timediff", "args": [
        {"k": "lit", "value": "2026-01-01", "type": "text"},
        {"k": "lit", "value": "2026-11-07", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "timediff", "args": [
        {"k": "lit", "value": "2026-11-07 12:00:00.5", "type": "text"},
        {"k": "lit", "value": "2026-11-07 10:00", "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "datetime", "args": [
        {"k": "lit", "value": "2026-01-01", "type": "text"},
        {"k": "call", "fn": "timediff", "args": [
          {"k": "lit", "value": "2026-11-07 08:30", "type": "text"},
          {"k": "lit", "value": "2026-01-01", "type": "text"}
        ], "type": "text"}
      ], "type": "text"},
      {"k": "call", "fn": "timediff", "args": [
        {"k": "lit", "value": "2026-11-07", "type": "text"},
        {"k": "lit", "value": null, "type": "text"}
      ], "type": "text"}
    ]]
  },
  "columns": [{"name": "later"}, {"name": "earlier"}, {"name": "time"}, {"name": "round_trip"}, {"name": "null"}]
}
```

| later | earlier | time | round_trip | null |
|---|---|---|---|---|
| +0000-10-06 00:00:00.000 | -0000-10-06 00:00:00.000 | +0000-00-00 02:00:00.500 | 2026-11-07 08:30:00 | NULL |

## Demo

The time from the first order's day to each order's day:

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
          {"k": "call", "fn": "timediff", "args": [
            {"k": "call", "fn": "cast_text", "args": [
              {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
            ], "type": "text"},
            {"k": "lit", "value": "2026-11-02", "type": "text"}
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
  "columns": [{"name": "day"}, {"name": "since_first"}]
}
```

| day | since_first |
|---|---|
| 2026-11-02 | +0000-00-00 00:00:00.000 |
| 2026-11-03 | +0000-00-01 00:00:00.000 |
| 2026-11-04 | +0000-00-02 00:00:00.000 |
| 2026-11-05 | +0000-00-03 00:00:00.000 |

## See also

- [`julianday`](./julianday), [`unixepoch`](./unixepoch), [`datetime`](./datetime)
- [Date and time text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
