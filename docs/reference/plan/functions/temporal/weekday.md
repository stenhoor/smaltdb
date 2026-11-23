---
description: 'The ISO day of the week of a date or datetime: Monday is 1, Sunday 7.'
---

# weekday

```ebnf
weekday ::= '"fn": "weekday"' ', "args": [' VALUE ']'
```

The day of the week of a `date` or `datetime`, as ISO 8601 numbers it: Monday is 1, Sunday 7.

## Parameters

| Argument | Type | |
|---|---|---|
| `VALUE` | `date`, `datetime` | The value. |

## Returns

`int`. NULL when `VALUE` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `VALUE` is of another type, text included: a plan that gives one is refused when it is compiled. Make a `date` from text with [`cast_date`](../conversion/cast_date) or [`parse_date`](./parse_date). |

## Notes

- SQLite's `strftime('%w', …)` counts from Sunday as 0; `weekday` follows ISO 8601, as
  [`format_temporal`](./format_temporal)'s `%u` does (its `%w` gives Sunday as 0).
- [`trunc_temporal`](./trunc_temporal) with `week` goes back to the Monday of the week.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "weekday", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-02", "type": "text"}], "type": "date"}
      ], "type": "int"},
      {"k": "call", "fn": "weekday", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"}
      ], "type": "int"},
      {"k": "call", "fn": "weekday", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-11-08 23:59:59", "type": "text"}
        ], "type": "datetime"}
      ], "type": "int"},
      {"k": "call", "fn": "weekday", "args": [{"k": "lit", "value": null, "type": "date"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "monday"}, {"name": "saturday"}, {"name": "sunday"}, {"name": "null"}]
}
```

| monday | saturday | sunday | null |
|---|---|---|---|
| 1 | 6 | 7 | NULL |

A `time` has no day of the week:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "weekday", "args": [
        {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "12:30", "type": "text"}], "type": "time"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "weekday"}]
}
```

## Demo

The orders of each day of the week, with its name, in the week's order:

```json
{
  "kind": "query",
  "plan": {
    "op": "sort",
    "input": {
      "op": "aggregate",
      "input": {"op": "scan", "table": "orders", "columns": [3]},
      "keys": [
        {
          "expr": {"k": "call", "fn": "weekday", "args": [
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
          ], "type": "int"},
          "collation": "binary"
        },
        {
          "expr": {"k": "call", "fn": "format_temporal", "args": [
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"},
            {"k": "lit", "value": "%A", "type": "text"}
          ], "type": "text"},
          "collation": "binary"
        }
      ],
      "aggs": [{"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}],
      "carry": []
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
  "columns": [{"name": "weekday"}, {"name": "name"}, {"name": "orders"}]
}
```

| weekday | name | orders |
|---|---|---|
| 1 | Monday | 2 |
| 2 | Tuesday | 1 |
| 3 | Wednesday | 1 |
| 4 | Thursday | 2 |

## See also

- [`day`](./day), [`day_of_year`](./day_of_year), [`format_temporal`](./format_temporal), [`trunc_temporal`](./trunc_temporal)
- [Date and time functions](./)
- [`call`](../../expressions/call): how a plan calls a function
