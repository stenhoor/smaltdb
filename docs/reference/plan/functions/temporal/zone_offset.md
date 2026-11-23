---
description: 'A time zone''s offset from UTC at a UTC instant, as a duration.'
---

# zone_offset

```ebnf
zone_offset ::= '"fn": "zone_offset"' ', "args": [' INSTANT ',' ZONE ']'
```

The offset of `ZONE` from UTC at `INSTANT`, a `datetime` read as UTC, as a `duration`: positive east of Greenwich,
negative west of it.

## Parameters

| Argument | Type | |
|---|---|---|
| `INSTANT` | `datetime` | A UTC instant. |
| `ZONE` | `text` | A [time zone](./#zones): an IANA name (`Europe/Paris`), `UTC`, or a fixed offset (`+05:30`, `-08`). |

## Returns

`duration`, written in results as ISO 8601 (`PT1H`, `-PT3H30M`). NULL when `INSTANT` or `ZONE` is NULL.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `INSTANT` isn't a `datetime` (a `date` or text included): refused when the plan is compiled. |
| `SMALT_MISMATCH` | `ZONE` isn't a time zone the runtime knows, or isn't text. |

## Notes

- `to_zone(INSTANT, ZONE)` is `INSTANT` plus this offset.
- The offset changes at the instant the zone's clocks change: Paris went from 1 hour to 2 at 01:00 UTC on
  29 March 2026.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["duration", "duration", "duration", "duration", "duration"],
    "rows": [[
      {"k": "call", "fn": "zone_offset", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-03-29 00:59:59", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "Europe/Paris", "type": "text"}
      ], "type": "duration"},
      {"k": "call", "fn": "zone_offset", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-03-29 01:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "Europe/Paris", "type": "text"}
      ], "type": "duration"},
      {"k": "call", "fn": "zone_offset", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-01-15 12:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "America/New_York", "type": "text"}
      ], "type": "duration"},
      {"k": "call", "fn": "zone_offset", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-01-15 12:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "-03:30", "type": "text"}
      ], "type": "duration"},
      {"k": "call", "fn": "zone_offset", "args": [
        {"k": "lit", "value": null, "type": "datetime"},
        {"k": "lit", "value": "UTC", "type": "text"}
      ], "type": "duration"}
    ]]
  },
  "columns": [{"name": "before"}, {"name": "after"}, {"name": "new_york"}, {"name": "fixed"}, {"name": "null"}]
}
```

| before | after | new_york | fixed | null |
|---|---|---|---|---|
| PT1H | PT2H | -PT5H | -PT3H30M | NULL |

<!-- docs:error SMALT_MISMATCH -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["duration"],
    "rows": [[
      {"k": "call", "fn": "zone_offset", "args": [
        {"k": "call", "fn": "cast_date", "args": [{"k": "lit", "value": "2026-01-15", "type": "text"}], "type": "date"},
        {"k": "lit", "value": "UTC", "type": "text"}
      ], "type": "duration"}
    ]]
  },
  "columns": [{"name": "offset"}]
}
```

## Demo

New York's offset at midnight UTC of each order's day, and on 1 November, when its summer time ended:

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
          {"k": "call", "fn": "zone_offset", "args": [
            {"k": "call", "fn": "cast_datetime", "args": [
              {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
            ], "type": "datetime"},
            {"k": "lit", "value": "America/New_York", "type": "text"}
          ], "type": "duration"}
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
  "columns": [{"name": "day"}, {"name": "offset"}]
}
```

| day | offset |
|---|---|
| 2026-11-02 | -PT5H |
| 2026-11-03 | -PT5H |
| 2026-11-04 | -PT5H |
| 2026-11-05 | -PT5H |

## See also

- [`to_zone`](./to_zone), [`from_zone`](./from_zone)
- [Date and time functions](./)
