---
description: 'The UTC instant of a wall-clock time in a time zone, with a choice for times that occur twice or not at all.'
---

# from_zone

```ebnf
from_zone ::= '"fn": "from_zone"' ', "args": [' WALL ',' ZONE (',' HOW)? ']'
```

The UTC instant of `WALL`, a wall-clock time in `ZONE`: the time less the zone's offset then. [`to_zone`](./to_zone)
goes the other way. Where clocks go back, a wall-clock time occurs twice; where they go forward, some don't occur at
all. `HOW` says what to do then.

## Parameters

| Argument | Type | |
|---|---|---|
| `WALL` | `datetime` | A wall-clock time in `ZONE`. |
| `ZONE` | `text` | A [time zone](./#zones): an IANA name (`Europe/Paris`), `UTC`, or a fixed offset (`+05:30`, `-08`). |
| `HOW` | `text` | Optional: `compatible` (the default), `earlier`, `later` or `reject`. |

| `HOW` | A time that occurs twice (clocks go back) | A time that doesn't occur (clocks go forward) |
|---|---|---|
| `compatible` | The earlier instant | Moved forward by the gap |
| `earlier` | The earlier instant | Moved back by the gap |
| `later` | The later instant | Moved forward by the gap |
| `reject` | An error (`SMALT_RANGE`) | An error (`SMALT_RANGE`) |

The default is what JavaScript's `Temporal` calls `compatible`.

## Returns

`datetime`: a UTC instant. NULL when `WALL` or `ZONE` is NULL. A NULL `HOW` is `compatible`.

## Errors

| Code | When |
|---|---|
| `SMALT_MISMATCH` | `WALL` isn't a `datetime` (a `date` or text included): refused when the plan is compiled. |
| `SMALT_MISMATCH` | `ZONE` isn't a time zone the runtime knows, or isn't text; `HOW` isn't one of the four. |
| `SMALT_RANGE` | `HOW` is `reject` and the time occurs twice or not at all. |

## Notes

- In Paris, clocks went forward from 02:00 to 03:00 on 29 March 2026, so 02:30 didn't occur; `compatible` reads it
  as 03:30 summer time. They went back from 03:00 to 02:00 on 25 October 2026, so 02:30 occurred twice: at 00:30
  and 01:30 UTC.
- A fixed offset has no gaps or overlaps: every time occurs once.

## Examples

A time in a gap, and a time in an overlap, each read four ways:

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["datetime", "datetime", "datetime", "datetime"],
    "rows": [[
      {"k": "call", "fn": "from_zone", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-03-29 02:30", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "Europe/Paris", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "from_zone", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-03-29 02:30", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "Europe/Paris", "type": "text"},
        {"k": "lit", "value": "earlier", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "from_zone", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-10-25 02:30", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "Europe/Paris", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "from_zone", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-10-25 02:30", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "Europe/Paris", "type": "text"},
        {"k": "lit", "value": "later", "type": "text"}
      ], "type": "datetime"}
    ]]
  },
  "columns": [{"name": "gap"}, {"name": "gap_earlier"}, {"name": "overlap"}, {"name": "overlap_later"}]
}
```

| gap | gap_earlier | overlap | overlap_later |
|---|---|---|---|
| 2026-03-29 01:30:00 | 2026-03-29 00:30:00 | 2026-10-25 00:30:00 | 2026-10-25 01:30:00 |

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["datetime", "datetime", "datetime"],
    "rows": [[
      {"k": "call", "fn": "from_zone", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-07-01 14:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "Europe/Paris", "type": "text"},
        {"k": "lit", "value": "reject", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "from_zone", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-07-01 14:00", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "+05:30", "type": "text"}
      ], "type": "datetime"},
      {"k": "call", "fn": "from_zone", "args": [
        {"k": "lit", "value": null, "type": "datetime"},
        {"k": "lit", "value": "UTC", "type": "text"}
      ], "type": "datetime"}
    ]]
  },
  "columns": [{"name": "paris"}, {"name": "india"}, {"name": "null"}]
}
```

| paris | india | null |
|---|---|---|
| 2026-07-01 12:00:00 | 2026-07-01 08:30:00 | NULL |

<!-- docs:error SMALT_RANGE -->
```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["datetime"],
    "rows": [[
      {"k": "call", "fn": "from_zone", "args": [
        {"k": "call", "fn": "cast_datetime", "args": [
          {"k": "lit", "value": "2026-03-29 02:30", "type": "text"}
        ], "type": "datetime"},
        {"k": "lit", "value": "Europe/Paris", "type": "text"},
        {"k": "lit", "value": "reject", "type": "text"}
      ], "type": "datetime"}
    ]]
  },
  "columns": [{"name": "at"}]
}
```

## Demo

The shop in Paris opens at 09:00; the UTC instant it opened on each order's day:

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
          {"k": "call", "fn": "from_zone", "args": [
            {"k": "call", "fn": "offset_by", "args": [
              {"k": "call", "fn": "cast_datetime", "args": [
                {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
              ], "type": "datetime"},
              {"k": "lit", "value": "9h", "type": "text"}
            ], "type": "datetime"},
            {"k": "lit", "value": "Europe/Paris", "type": "text"}
          ], "type": "datetime"}
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
  "columns": [{"name": "day"}, {"name": "opens_utc"}]
}
```

| day | opens_utc |
|---|---|
| 2026-11-02 | 2026-11-02 08:00:00 |
| 2026-11-03 | 2026-11-03 08:00:00 |
| 2026-11-04 | 2026-11-04 08:00:00 |
| 2026-11-05 | 2026-11-05 08:00:00 |

## See also

- [`to_zone`](./to_zone), [`zone_offset`](./zone_offset), [`make_datetime`](./make_datetime)
- [Date and time functions](./)
