---
description: 'The day of the year of a date or datetime, 1 to 366.'
---

# day_of_year

```ebnf
day_of_year ::= '"fn": "day_of_year"' ', "args": [' VALUE ']'
```

The day of the year of a `date` or `datetime`, as an integer: 1 January is 1, and 31 December is 365, or 366 in a
leap year.

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

- [`format_temporal`](./format_temporal)'s `%j` gives it as three digits (`311`), and `parse_date` reads it back with a
  year (`%Y-%j`).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "day_of_year", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-01-01", "type": "text"}], "type": "date"}
      ], "type": "int"},
      {"k": "call", "fn": "day_of_year", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"}
      ], "type": "int"},
      {"k": "call", "fn": "day_of_year", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2024-12-31 12:00", "type": "text"}
        ], "type": "datetime"}
      ], "type": "int"},
      {"k": "call", "fn": "day_of_year", "args": [{"k": "lit", "value": null, "type": "date"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "first"}, {"name": "date"}, {"name": "leap"}, {"name": "null"}]
}
```

| first | date | leap | null |
|---|---|---|---|
| 1 | 311 | 366 | NULL |

A `time` has no day of the year:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "day_of_year", "args": [
        {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "12:30", "type": "text"}], "type": "time"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "day_of_year"}]
}
```

## Demo

The days with orders, and how far into the year each is:

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
          {"k": "call", "fn": "day_of_year", "args": [
            {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
          ], "type": "int"}
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
  "columns": [{"name": "day"}, {"name": "day_of_year"}]
}
```

| day | day_of_year |
|---|---|
| 2026-11-02 | 306 |
| 2026-11-03 | 307 |
| 2026-11-04 | 308 |
| 2026-11-05 | 309 |

## See also

- [`day`](./day), [`weekday`](./weekday), [`year`](./year), [`format_temporal`](./format_temporal)
- [Date and time functions](./)
- [`call`](../../expressions/call): how a plan calls a function
