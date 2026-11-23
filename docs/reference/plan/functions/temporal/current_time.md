---
description: 'The time now in UTC, as HH:MM:SS text.'
---

# current_time

```ebnf
current_time ::= '"fn": "current_time"' ', "args": []'
```

The time of day now in UTC, as text in the form `HH:MM:SS`: SQL's `CURRENT_TIME`. It has no fraction of a second.

## Parameters

None.

## Returns

`text`: the time as `HH:MM:SS`, 8 characters. Never NULL.

## Errors

None.

## Notes

- `current_time` is an operation the engine compiles itself: a plan may name it, but the catalog doesn't list it
  ([`db.catalog.functions()`](../../../engine/catalog#functions)).
- The clock is read once for each run of a statement, so every row, and every `current_time`, `current_date`,
  `current_time`, `current_timestamp` and `'now'` of the [`datetime`](../datetime/) functions in it, sees the same
  instant. The next run reads the clock again.
- It is UTC, whatever the host's time zone. [`to_zone`](./to_zone) gives the wall-clock time somewhere else.
- The value is text, as SQL's `CURRENT_TIME` is. For a `time`, pass it to [`cast_time`](../conversion/cast_time).

## Examples

Its value changes, so these show what it is rather than what it says:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "length", "args": [{"k": "call", "fn": "current_time", "args": [], "type": "text"}], "type": "int"},
      {"k": "call", "fn": "glob", "args": [
        {"k": "call", "fn": "current_time", "args": [], "type": "text"},
        {"k": "lit", "value": "[0-2][0-9]:[0-5][0-9]:[0-5][0-9]", "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "call", "fn": "current_time", "args": [], "type": "text"},
        {"k": "call", "fn": "time", "args": [{"k": "lit", "value": "now", "type": "text"}], "type": "text"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "length"}, {"name": "shape"}, {"name": "same_as_time"}]
}
```

| length | shape | same_as_time |
|---|---|---|
| 8 | true | true |

## Demo

Every row of a run sees the same time: the distinct times over the orders, counted:

```json
{
  "kind": "query",
  "plan": {
    "op": "aggregate",
    "input": {"op": "scan", "table": "orders", "columns": [0]},
    "keys": [],
    "aggs": [
      {
        "fn": "count",
        "args": [{"k": "call", "fn": "current_time", "args": [], "type": "text"}],
        "star": false,
        "distinct": true,
        "collation": "binary",
        "type": "int"
      }
    ],
    "carry": []
  },
  "columns": [{"name": "times"}]
}
```

| times |
|---|
| 1 |

## See also

- [`current_date`](./current_date), [`current_timestamp`](./current_timestamp), [`time`](../datetime/time)
- [Date and time functions](./)
