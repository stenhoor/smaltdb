---
description: 'The µs within the second of a datetime or time, 0 to 999999.'
---

# microsecond

```ebnf
microsecond ::= '"fn": "microsecond"' ', "args": [' VALUE ']'
```

The fraction of the second of a `datetime` or `time`, in µs: an integer from 0 to 999999. A `datetime` or `time`
holds µs, so this is the finest part it has.

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

- It is the µs within the second, not since the start of the minute: [`second`](./second) gives the whole seconds.
- The milliseconds are `div_trunc` of it by 1000; [`format_temporal`](./format_temporal)'s `%f` gives all six
  digits as text.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "microsecond", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-07 15:04:09.123456", "type": "text"}
        ], "type": "datetime"}
      ], "type": "int"},
      {"k": "call", "fn": "microsecond", "args": [
        {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "09:30:00.5", "type": "text"}], "type": "time"}
      ], "type": "int"},
      {"k": "call", "fn": "microsecond", "args": [
        {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "09:30", "type": "text"}], "type": "time"}
      ], "type": "int"},
      {"k": "call", "fn": "microsecond", "args": [{"k": "lit", "value": null, "type": "datetime"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "datetime"}, {"name": "half"}, {"name": "none"}, {"name": "null"}]
}
```

| datetime | half | none | null |
|---|---|---|---|
| 123456 | 500000 | 0 | NULL |

A `date` has no fraction of a second:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "microsecond", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "microsecond"}]
}
```

## Demo

Each order's day at an eighth of a second past midnight for each item ordered (`n`); a `duration` literal is a number of µs:

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
            {"k": "lit", "value": 125000, "type": "duration"}
          ], "type": "duration"}
        ], "type": "datetime"},
        {"k": "call", "fn": "microsecond", "args": [
          {"k": "call", "fn": "add", "args": [
            {"k": "call", "fn": "cast_datetime", "args": [
              {"k": "col", "input": 0, "index": 2, "depth": 0, "type": "date", "collation": "binary"}
            ], "type": "datetime"},
            {"k": "call", "fn": "mul", "args": [
              {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "int", "collation": "binary"},
              {"k": "lit", "value": 125000, "type": "duration"}
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
  "columns": [{"name": "id"}, {"name": "at"}, {"name": "microsecond"}]
}
```

| id | at | microsecond |
|---|---|---|
| 1 | 2026-11-02 00:00:00.375 | 375000 |
| 2 | 2026-11-02 00:00:00.125 | 125000 |
| 3 | 2026-11-03 00:00:00.250 | 250000 |
| 4 | 2026-11-04 00:00:01.250 | 250000 |
| 5 | 2026-11-05 00:00:00.625 | 625000 |
| 6 | 2026-11-05 00:00:00.125 | 125000 |

## See also

- [`second`](./second), [`minute`](./minute), [`trunc_temporal`](./trunc_temporal), [`format_temporal`](./format_temporal)
- [Date and time functions](./)
- [`call`](../../expressions/call): how a plan calls a function
