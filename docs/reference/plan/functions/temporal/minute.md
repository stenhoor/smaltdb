---
description: 'The minute of a datetime or time, 0 to 59.'
---

# minute

```ebnf
minute ::= '"fn": "minute"' ', "args": [' VALUE ']'
```

The minute within the hour of a `datetime` or `time`, as an integer from 0 to 59.

## Parameters

| Argument | Type | |
|---|---|---|
| `VALUE` | `datetime`, `time` | The value. |

## Returns

`int`. NULL when `VALUE` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `VALUE` is of another type, `date` and text included: a plan that gives one is refused when it is compiled. Make a `datetime` or `time` from text with [`cast_datetime`](../conversion/cast_datetime) or [`cast_time`](../conversion/cast_time). |

## Notes

- A `datetime` has no zone: the minute is the one its wall-clock text shows. For the minute somewhere else, move the
  instant there first with [`to_zone`](./to_zone).
- For the minutes since midnight, combine it with [`hour`](./hour), or subtract the day from the value: the difference
  of two `datetime` values is a `duration` (`sub`).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "minute", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-07 15:04:09", "type": "text"}
        ], "type": "datetime"}
      ], "type": "int"},
      {"k": "call", "fn": "minute", "args": [
        {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "09:30", "type": "text"}], "type": "time"}
      ], "type": "int"},
      {"k": "call", "fn": "minute", "args": [{"k": "lit", "value": null, "type": "datetime"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "datetime"}, {"name": "time"}, {"name": "null"}]
}
```

| datetime | time | null |
|---|---|---|
| 4 | 30 | NULL |

A `date` has no minutes:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "minute", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "minute"}]
}
```

## Demo

Each order's day at 45 minutes past midnight for each item ordered (`n`); a `duration` literal is a number of µs:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "project",
      "input": {"op": "scan", "table": "orders", "columns": [0, 2, 3]},
      "exprs": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "call", "fn": "add", "args": [
          {"k": "call", "fn": "cast_datetime", "args": [
            {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "date", "collation": "binary"}
          ], "type": "datetime"},
          {"k": "call", "fn": "mul", "args": [
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
            {"k": "lit", "value": 2700000000, "type": "duration"}
          ], "type": "duration"}
        ], "type": "datetime"},
        {"k": "call", "fn": "minute", "args": [
          {"k": "call", "fn": "add", "args": [
            {"k": "call", "fn": "cast_datetime", "args": [
              {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "date", "collation": "binary"}
            ], "type": "datetime"},
            {"k": "call", "fn": "mul", "args": [
              {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
              {"k": "lit", "value": 2700000000, "type": "duration"}
            ], "type": "duration"}
          ], "type": "datetime"}
        ], "type": "int"}
      ]
    },
    "keys": [
      {
        "expr": {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        "desc": false,
        "nullsFirst": true,
        "collation": "binary"
      }
    ]
  },
  "columns": [{"name": "id"}, {"name": "at"}, {"name": "minute"}]
}
```

| id | at | minute |
|---|---|---|
| 1 | 2026-11-02 02:15:00 | 15 |
| 2 | 2026-11-02 00:45:00 | 45 |
| 3 | 2026-11-03 01:30:00 | 30 |
| 4 | 2026-11-04 07:30:00 | 30 |
| 5 | 2026-11-05 03:45:00 | 45 |
| 6 | 2026-11-05 00:45:00 | 45 |

## See also

- [`hour`](./hour), [`second`](./second), [`microsecond`](./microsecond), [`trunc_temporal`](./trunc_temporal)
- [Date and time functions](./)
- [`call`](../../expressions/call): how a plan calls a function
