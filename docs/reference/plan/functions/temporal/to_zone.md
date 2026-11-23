---
description: 'The wall-clock time in a time zone at a UTC instant.'
---

# to_zone

```ebnf
to_zone ::= '"fn": "to_zone"' ', "args": [' INSTANT ',' ZONE ']'
```

The wall-clock time in `ZONE` at `INSTANT`, a `datetime` read as UTC: the instant plus the zone's offset from UTC
then. [`from_zone`](./from_zone) goes the other way.

## Parameters

| Argument | Type | |
|---|---|---|
| `INSTANT` | `datetime` | A UTC instant. |
| `ZONE` | `text` | A [time zone](./#zones): an IANA name (`Europe/Paris`), `UTC`, or a fixed offset (`+05:30`, `-08`). |

## Returns

`datetime`: a wall-clock time. NULL when `INSTANT` or `ZONE` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `INSTANT` isn't a `datetime` (a `date` or text included): refused when the plan is compiled. |
| `SMALT_MISMATCH` | `ZONE` isn't a time zone the runtime knows, or isn't text. |

## Notes

- A `datetime` has no zone: whether one is a UTC instant or a wall-clock time is what the data means. `to_zone`
  takes the first and gives the second.
- The offset is the zone's at that instant, summer time included: Paris is 1 hour ahead of UTC in winter and 2 in
  summer. [`zone_offset`](./zone_offset) gives the offset itself.
- The zone is an argument like any other, so a column can give each row its own.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["datetime", "datetime", "datetime", "datetime", "datetime", "datetime"],
    "rows": [[
      {"k": "call", "fn": "to_zone", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-07-01 12:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "Europe/Paris", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "to_zone", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-01-15 12:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "Europe/Paris", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "to_zone", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-07-01 12:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "+05:30", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "to_zone", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-07-01 12:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "-08", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "to_zone", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-07-01 12:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "UTC", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "to_zone", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-07-01 12:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": null, "type": "text"}
      ], "type": "datetime"}
    ]]
  },
  "columns": [
    {"name": "paris_summer"},
    {"name": "paris_winter"},
    {"name": "india"},
    {"name": "fixed"},
    {"name": "utc"},
    {"name": "null"}
  ]
}
```

| paris_summer | paris_winter | india | fixed | utc | null |
|---|---|---|---|---|---|
| 2026-07-01 14:00:00 | 2026-01-15 13:00:00 | 2026-07-01 17:30:00 | 2026-07-01 04:00:00 | 2026-07-01 12:00:00 | NULL |

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["datetime"],
    "rows": [[
      {"k": "call", "fn": "to_zone", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-07-01 12:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "Mars/Olympus_Mons", "type": "text"}
      ], "type": "datetime"}
    ]]
  },
  "columns": [{"name": "at"}]
}
```

## Demo

Midnight UTC of each order's day, as the clocks in Tokyo and New York showed it:

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
          {"k": "call", "fn": "to_zone", "args": [
            {"k": "call", "fn": "cast_datetime", "args": [
              {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
            ], "type": "datetime"},
            {"k": "lit", "value": "Asia/Tokyo", "type": "text"}
          ], "type": "datetime"},
          {"k": "call", "fn": "to_zone", "args": [
            {"k": "call", "fn": "cast_datetime", "args": [
              {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
            ], "type": "datetime"},
            {"k": "lit", "value": "America/New_York", "type": "text"}
          ], "type": "datetime"}
        ]
      },
      "collations": ["binary", "binary", "binary"]
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
  "columns": [{"name": "day"}, {"name": "tokyo"}, {"name": "new_york"}]
}
```

| day | tokyo | new_york |
|---|---|---|
| 2026-11-02 | 2026-11-02 09:00:00 | 2026-11-01 19:00:00 |
| 2026-11-03 | 2026-11-03 09:00:00 | 2026-11-02 19:00:00 |
| 2026-11-04 | 2026-11-04 09:00:00 | 2026-11-03 19:00:00 |
| 2026-11-05 | 2026-11-05 09:00:00 | 2026-11-04 19:00:00 |

## See also

- [`from_zone`](./from_zone), [`zone_offset`](./zone_offset), [`trunc_temporal`](./trunc_temporal)
- [Date and time functions](./)
