---
description: 'A date from its year, month and day.'
---

# make_date

```ebnf
make_date ::= '"fn": "make_date"' ', "args": [' YEAR ',' MONTH ',' DAY ']'
```

A `date` from its year, month and day, each an integer. A date that doesn't exist is an error, not a date in the
next month.

## Parameters

| Argument | Type | |
|---|---|---|
| `YEAR` | `int` | The year: 0 is 1 BC, and years before it are negative. |
| `MONTH` | `int` | The month, 1 to 12. |
| `DAY` | `int` | The day of the month, 1 to the month's last day. |

## Returns

`date`. NULL when an argument is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_RANGE` | The date doesn't exist: a month outside 1 to 12, or a day the month hasn't (`2025, 2, 29`). |
| `SMALT_MISMATCH` | An argument isn't an integer: a real or text, even `'2025'` or `2025.0`. |

## Notes

- The errors come when a row reaches the call, as it runs, not when the plan is compiled.
- SQLite's `date('2025-02-29')` rolls over to `2025-03-01`; `make_date` refuses it. [`offset_by`](./offset_by) moves
  by months and keeps to the month's last day.
- Results write a year beyond 9999 with a sign: `+10000-01-01`.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["date", "date", "date", "date", "date"],
    "rows": [[
      {"k": "call", "fn": "make_date", "args": [
        {"k": "lit", "value": 2026, "type": "int"},
        {"k": "lit", "value": 11, "type": "int"},
        {"k": "lit", "value": 7, "type": "int"}
      ], "type": "date"},
      {"k": "call", "fn": "make_date", "args": [
        {"k": "lit", "value": 2024, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "lit", "value": 29, "type": "int"}
      ], "type": "date"},
      {"k": "call", "fn": "make_date", "args": [
        {"k": "lit", "value": -43, "type": "int"},
        {"k": "lit", "value": 3, "type": "int"},
        {"k": "lit", "value": 15, "type": "int"}
      ], "type": "date"},
      {"k": "call", "fn": "make_date", "args": [
        {"k": "lit", "value": 10000, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "date"},
      {"k": "call", "fn": "make_date", "args": [
        {"k": "lit", "value": 2026, "type": "int"},
        {"k": "lit", "value": null, "type": "int"},
        {"k": "lit", "value": 1, "type": "int"}
      ], "type": "date"}
    ]]
  },
  "columns": [{"name": "date"}, {"name": "leap"}, {"name": "old"}, {"name": "far"}, {"name": "null"}]
}
```

| date | leap | old | far | null |
|---|---|---|---|---|
| 2026-11-07 | 2024-02-29 | -0043-03-15 | +10000-01-01 | NULL |

2025 isn't a leap year:

<!-- docs:error SMALT_RANGE -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["date"],
    "rows": [[
      {"k": "call", "fn": "make_date", "args": [
        {"k": "lit", "value": 2025, "type": "int"},
        {"k": "lit", "value": 2, "type": "int"},
        {"k": "lit", "value": 29, "type": "int"}
      ], "type": "date"}
    ]]
  },
  "columns": [{"name": "date"}]
}
```

## Demo

The first of the month of each order's day:

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
        {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"},
        {"k": "call", "fn": "make_date", "args": [
          {"k": "call", "fn": "year", "args": [
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"}
          ], "type": "int"},
          {"k": "call", "fn": "month", "args": [
            {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"}
          ], "type": "int"},
          {"k": "lit", "value": 1, "type": "int"}
        ], "type": "date"}
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
  "columns": [{"name": "id"}, {"name": "day"}, {"name": "first"}]
}
```

| id | day | first |
|---|---|---|
| 1 | 2026-11-02 | 2026-11-01 |
| 2 | 2026-11-02 | 2026-11-01 |
| 3 | 2026-11-03 | 2026-11-01 |
| 4 | 2026-11-04 | 2026-11-01 |
| 5 | 2026-11-05 | 2026-11-01 |
| 6 | 2026-11-05 | 2026-11-01 |

## See also

- [`make_datetime`](./make_datetime), [`parse_date`](./parse_date), [`year`](./year), [`trunc_temporal`](./trunc_temporal)
- [`cast_date`](../conversion/cast_date): a `date` from text, a `datetime` or a number of days
- [Date and time functions](./)
