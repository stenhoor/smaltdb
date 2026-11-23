---
description: 'A datetime from its year, month and day, and optionally its hour, minute, second and µs.'
---

# make_datetime

```ebnf
make_datetime ::= '"fn": "make_datetime"' ', "args": [' YEAR ',' MONTH ',' DAY (',' HOUR (',' MINUTE (',' SECOND (',' MICROSECOND)?)?)?)? ']'
```

A `datetime` from its parts, each an integer. The date parts are required; the clock parts that are left out are 0,
so three arguments give midnight.

## Parameters

| Argument | Type | |
|---|---|---|
| `YEAR` | `int` | The year: 0 is 1 BC, and years before it are negative. |
| `MONTH` | `int` | The month, 1 to 12. |
| `DAY` | `int` | The day of the month, 1 to the month's last day. |
| `HOUR` | `int` | Optional: the hour, 0 to 23. |
| `MINUTE` | `int` | Optional: the minute, 0 to 59. |
| `SECOND` | `int` | Optional: the second, 0 to 59. |
| `MICROSECOND` | `int` | Optional: the µs within the second, 0 to 999999. |

## Returns

`datetime`. NULL when an argument is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_RANGE` | The date doesn't exist (`2025, 2, 29`), or a clock part is out of its range (hour 24, second 60). |
| `SMALT_MISMATCH` | An argument isn't a whole number: a real with a fraction, or text. |

## Notes

- The value has no zone: it is the wall-clock time the parts give. To read it as the time in a zone and get the UTC
  instant, pass it to [`from_zone`](./from_zone).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["datetime", "datetime", "datetime", "datetime"],
    "rows": [[
      {"k": "call", "fn": "make_datetime", "args": [
        {"k": "lit", "value": 2026, "type": "int"},
        {"k": "lit", "value": 11, "type": "int"},
        {"k": "lit", "value": 7, "type": "int"}
      ], "type": "datetime"},
      {"k": "call", "fn": "make_datetime", "args": [
        {"k": "lit", "value": 2026, "type": "int"},
        {"k": "lit", "value": 11, "type": "int"},
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": 12, "type": "int"},
        {"k": "lit", "value": 30, "type": "int"}
      ], "type": "datetime"},
      {"k": "call", "fn": "make_datetime", "args": [
        {"k": "lit", "value": 2026, "type": "int"},
        {"k": "lit", "value": 11, "type": "int"},
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": 12, "type": "int"},
        {"k": "lit", "value": 30, "type": "int"},
        {"k": "lit", "value": 5, "type": "int"},
        {"k": "lit", "value": 500000, "type": "int"}
      ], "type": "datetime"},
      {"k": "call", "fn": "make_datetime", "args": [
        {"k": "lit", "value": 2026, "type": "int"},
        {"k": "lit", "value": 11, "type": "int"},
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": null, "type": "int"}
      ], "type": "datetime"}
    ]]
  },
  "columns": [{"name": "midnight"}, {"name": "minutes"}, {"name": "all"}, {"name": "null"}]
}
```

| midnight | minutes | all | null |
|---|---|---|---|
| 2026-11-07 00:00:00 | 2026-11-07 12:30:00 | 2026-11-07 12:30:05.500 | NULL |

The clock ends at 23:59:59.999999:

<!-- docs:error SMALT_RANGE -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["datetime"],
    "rows": [[
      {"k": "call", "fn": "make_datetime", "args": [
        {"k": "lit", "value": 2026, "type": "int"},
        {"k": "lit", "value": 11, "type": "int"},
        {"k": "lit", "value": 7, "type": "int"},
        {"k": "lit", "value": 24, "type": "int"}
      ], "type": "datetime"}
    ]]
  },
  "columns": [{"name": "at"}]
}
```

## Demo

Each order's day at 09:15, when the shop opens:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "project",
      "input": {"op": "scan", "table": "orders", "columns": [0, 3]},
      "exprs": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"},
        {"k": "call", "fn": "make_datetime", "args": [
          {"k": "call", "fn": "year", "args": [
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"}
          ], "type": "int"},
          {"k": "call", "fn": "month", "args": [
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"}
          ], "type": "int"},
          {"k": "call", "fn": "day", "args": [
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"}
          ], "type": "int"},
          {"k": "lit", "value": 9, "type": "int"},
          {"k": "lit", "value": 15, "type": "int"}
        ], "type": "datetime"}
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
  "columns": [{"name": "id"}, {"name": "opens"}]
}
```

| id | opens |
|---|---|
| 1 | 2026-11-02 09:15:00 |
| 2 | 2026-11-02 09:15:00 |
| 3 | 2026-11-03 09:15:00 |
| 4 | 2026-11-04 09:15:00 |
| 5 | 2026-11-05 09:15:00 |
| 6 | 2026-11-05 09:15:00 |

## See also

- [`make_date`](./make_date), [`parse_datetime`](./parse_datetime), [`from_zone`](./from_zone), [`offset_by`](./offset_by)
- [`cast_datetime`](../conversion/cast_datetime): a `datetime` from text, a `date` or a number of µs
- [Date and time functions](./)
