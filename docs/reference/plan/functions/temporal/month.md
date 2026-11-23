---
description: 'The month of a date or datetime, 1 to 12.'
---

# month

```ebnf
month ::= '"fn": "month"' ', "args": [' VALUE ']'
```

The month of a `date` or `datetime`, as an integer from 1 (January) to 12 (December).

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

- A `datetime` has no zone: the month is the one its wall-clock text shows. For the month somewhere else, move the
  instant there first with [`to_zone`](./to_zone).
- [`format_temporal`](./format_temporal) gives the month as text: `%m` (`01` to `12`), `%b` (`Nov`) or `%B`
  (`November`).

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "month", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-11-07", "type": "text"}], "type": "date"}
      ], "type": "int"},
      {"k": "call", "fn": "month", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-01-31 23:59:59", "type": "text"}
        ], "type": "datetime"}
      ], "type": "int"},
      {"k": "call", "fn": "month", "args": [{"k": "lit", "value": null, "type": "datetime"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "date"}, {"name": "datetime"}, {"name": "null"}]
}
```

| date | datetime | null |
|---|---|---|
| 11 | 1 | NULL |

A `time` has no month:

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int"],
    "rows": [[
      {"k": "call", "fn": "month", "args": [
        {"k": "call", "fn": "cast_time", "args": [{"k": "lit", "value": "12:30", "type": "text"}], "type": "time"}
      ], "type": "int"}
    ]]
  },
  "columns": [{"name": "month"}]
}
```

## Demo

The items ordered in each month:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {"op": "scan", "table": "orders", "columns": [2, 3]},
    "keys": [
      {
        "expr": {"k": "call", "fn": "month", "args": [
          {"k": "col", "input": 0, "index": 1, "depth": 0, "type": "date", "collation": "binary"}
        ], "type": "int"},
        "collation": "binary"
      }
    ],
    "aggs": [
      {
        "fn": "sum",
        "args": [{"k": "col", "input": 0, "index": 0, "depth": 0, "type": "int", "collation": "binary"}],
        "star": false,
        "distinct": false,
        "collation": "binary",
        "type": "int"
      }
    ],
    "carry": []
  },
  "columns": [{"name": "month"}, {"name": "items"}]
}
```

| month | items |
|---|---|
| 11 | 22 |

## See also

- [`year`](./year), [`day`](./day), [`trunc_temporal`](./trunc_temporal), [`make_date`](./make_date)
- [Date and time functions](./)
- [`call`](../../expressions/call): how a plan calls a function
