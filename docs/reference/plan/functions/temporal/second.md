---
description: 'The second of a datetime or time, 0 to 59, without its fraction.'
---

# second

```ebnf
second ::= '"fn": "second"' ', "args": [' VALUE ']'
```

The second within the minute of a `datetime` or `time`, as an integer from 0 to 59. The fraction of the second is
[`microsecond`](./microsecond).

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

- The fraction is cut off, not rounded: `09.75` gives 9.
- A `datetime` or `time` has no leap second: 60 is never a second.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "second", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-07 15:04:09.75", "type": "text"}
        ], "type": "datetime"}
      ], "type": "int"},
      {"k": "call", "fn": "second", "args": [
        {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "09:30:59", "type": "text"}], "type": "time"}
      ], "type": "int"},
      {"k": "call", "fn": "second", "args": [
        {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "09:30", "type": "text"}], "type": "time"}
      ], "type": "int"},
      {"k": "call", "fn": "second", "args": [{"k": "lit", "value": null, "type": "time"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "datetime"}, {"name": "time"}, {"name": "none"}, {"name": "null"}]
}
```

| datetime | time | none | null |
|---|---|---|---|
| 9 | 59 | 0 | NULL |

A `date` has no seconds:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "second", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "second"}]
}
```

## Demo

Each order's day at 25 seconds past midnight for each item ordered (`n`); a `duration` literal is a number of µs:

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
            {"k": "lit", "value": 25000000, "type": "duration"}
          ], "type": "duration"}
        ], "type": "datetime"},
        {"k": "call", "fn": "second", "args": [
          {"k": "call", "fn": "add", "args": [
            {"k": "call", "fn": "cast_datetime", "args": [
              {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "date", "collation": "binary"}
            ], "type": "datetime"},
            {"k": "call", "fn": "mul", "args": [
              {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
              {"k": "lit", "value": 25000000, "type": "duration"}
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
  "columns": [{"name": "id"}, {"name": "at"}, {"name": "second"}]
}
```

| id | at | second |
|---|---|---|
| 1 | 2026-11-02 00:01:15 | 15 |
| 2 | 2026-11-02 00:00:25 | 25 |
| 3 | 2026-11-03 00:00:50 | 50 |
| 4 | 2026-11-04 00:04:10 | 10 |
| 5 | 2026-11-05 00:02:05 | 5 |
| 6 | 2026-11-05 00:00:25 | 25 |

## See also

- [`microsecond`](./microsecond), [`minute`](./minute), [`hour`](./hour), [`trunc_temporal`](./trunc_temporal)
- [Date and time functions](./)
- [`call`](../../expressions/call): how a plan calls a function
