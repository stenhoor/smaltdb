---
description: 'Todays date in UTC, as YYYY-MM-DD text.'
---

# current_date

```ebnf
current_date ::= '"fn": "current_date"' ', "args": []'
```

Today's date in UTC, as text in the form `YYYY-MM-DD`: SQL's `CURRENT_DATE`.

## Parameters

None.

## Returns

`text`: the date as `YYYY-MM-DD`, 10 characters. Never NULL.

## Errors

None.

## Notes

- `current_date` is an operation the engine compiles itself: a plan may name it, but the catalog doesn't list it
  ([`db.catalog.functions()`](../../../engine/catalog#functions)).
- The clock is read once for each run of a statement, so every row, and every `current_date`, `current_date`,
  `current_time`, `current_timestamp` and `'now'` of the [`datetime`](../datetime/) functions in it, sees the same
  instant. The next run reads the clock again.
- It is UTC, whatever the host's time zone. [`to_zone`](./to_zone) gives the wall-clock time somewhere else.
- The value is text, as SQL's `CURRENT_DATE` is. For a `date`, pass it to [`cast_date`](../conversion/cast_date).

## Examples

Its value changes, so these show what it is rather than what it says:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "length", "args": [{"k": "call", "fn": "current_date", "args": [], "type": "text"}], "type": "int"},
      {"k": "call", "fn": "cmp_is_not", "args": [
        {"k": "call", "fn": "parse_date", "args": [
          {"k": "call", "fn": "current_date", "args": [], "type": "text"}
        ], "type": "date"},
        {"k": "lit", "value": null, "type": "date"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "call", "fn": "current_date", "args": [], "type": "text"},
        {"k": "call", "fn": "date", "args": [{"k": "lit", "value": "now", "type": "text"}], "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_ge", "args": [
        {"k": "call", "fn": "current_date", "args": [], "type": "text"},
        {"k": "lit", "value": "2026-11-23", "type": "text"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "length"}, {"name": "is_date"}, {"name": "same_as_date"}, {"name": "after_2026"}]
}
```

| length | is_date | same_as_date | after_2026 |
|---|---|---|---|
| 10 | true | true | true |

## Demo

The orders made on or before today, counted (all of them, as their days have passed):

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {
      "op": "filter",
      "input": {"op": "scan", "table": "orders", "columns": [3]},
      "pred": {"k": "call", "fn": "cmp_le", "args": [
        {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"},
        {"k": "call", "fn": "cast_date", "args": [
          {"k": "call", "fn": "current_date", "args": [], "type": "text"}
        ], "type": "date"}
      ], "type": "bool"}
    },
    "keys": [],
    "aggs": [{"fn": "count", "args": [], "star": true, "distinct": false, "collation": "binary", "type": "int"}],
    "carry": []
  },
  "columns": [{"name": "orders"}]
}
```

| orders |
|---|
| 6 |

## See also

- [`current_time`](./current_time), [`current_timestamp`](./current_timestamp), [`date`](../datetime/date)
- [Date and time functions](./)
