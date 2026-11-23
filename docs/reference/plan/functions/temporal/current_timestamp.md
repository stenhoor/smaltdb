---
description: 'The date and time now in UTC, as YYYY-MM-DD HH:MM:SS text.'
---

# current_timestamp

```ebnf
current_timestamp ::= '"fn": "current_timestamp"' ', "args": []'
```

The date and time now in UTC, as text in the form `YYYY-MM-DD HH:MM:SS`: SQL's `CURRENT_TIMESTAMP`. It has no
fraction of a second.

## Parameters

None.

## Returns

`text`: the date and time as `YYYY-MM-DD HH:MM:SS`, 19 characters. Never NULL.

## Errors

None.

## Notes

- `current_timestamp` is an operation the engine compiles itself: a plan may name it, but the catalog doesn't list it
  ([`db.catalog.functions()`](../../../engine/catalog#functions)).
- The clock is read once for each run of a statement, so every row, and every `current_timestamp`, `current_date`,
  `current_time`, `current_timestamp` and `'now'` of the [`datetime`](../datetime/) functions in it, sees the same
  instant. The next run reads the clock again.
- It is UTC, whatever the host's time zone. [`to_zone`](./to_zone) gives the wall-clock time somewhere else.
- The value is text, as SQL's `CURRENT_TIMESTAMP` is. For a `datetime`, pass it to [`cast_datetime`](../conversion/cast_datetime).

## Examples

Its value changes, so these show what it is rather than what it says:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "bool", "bool", "bool"],
    "rows": [[
      {"k": "call", "fn": "length", "args": [
        {"k": "call", "fn": "current_timestamp", "args": [], "type": "text"}
      ], "type": "int"},
      {"k": "call", "fn": "cmp_is_not", "args": [
        {"k": "call", "fn": "parse_datetime", "args": [
          {"k": "call", "fn": "current_timestamp", "args": [], "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": null, "type": "datetime"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "call", "fn": "current_timestamp", "args": [], "type": "text"},
        {"k": "call", "fn": "concat", "args": [
          {"k": "call", "fn": "current_date", "args": [], "type": "text"},
          {"k": "lit", "value": " ", "type": "text"},
          {"k": "call", "fn": "current_time", "args": [], "type": "text"}
        ], "type": "text"}
      ], "type": "bool"},
      {"k": "call", "fn": "cmp_eq", "args": [
        {"k": "call", "fn": "current_timestamp", "args": [], "type": "text"},
        {"k": "call", "fn": "datetime", "args": [], "type": "text"}
      ], "type": "bool"}
    ]]
  },
  "columns": [{"name": "length"}, {"name": "is_datetime"}, {"name": "parts"}, {"name": "same_as_datetime"}]
}
```

| length | is_datetime | parts | same_as_datetime |
|---|---|---|---|
| 19 | true | true | true |

## Demo

Whether each order's day has begun: its midnight is before now:

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
          {"k": "call", "fn": "cmp_lt", "args": [
            {"k": "call", "fn": "cast_datetime", "args": [
              {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
            ], "type": "datetime"},
            {"k": "call", "fn": "cast_datetime", "args": [
              {"k": "call", "fn": "current_timestamp", "args": [], "type": "text"}
            ], "type": "datetime"}
          ], "type": "bool"}
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
  "columns": [{"name": "day"}, {"name": "begun"}]
}
```

| day | begun |
|---|---|
| 2026-11-02 | true |
| 2026-11-03 | true |
| 2026-11-04 | true |
| 2026-11-05 | true |

## See also

- [`current_date`](./current_date), [`current_time`](./current_time), [`datetime`](../datetime/datetime)
- [Date and time functions](./)
