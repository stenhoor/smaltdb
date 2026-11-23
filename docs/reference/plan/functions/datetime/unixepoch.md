---
description: 'The seconds since 1970-01-01 00:00:00 UTC of a time value, after its modifiers.'
---

# unixepoch

```ebnf
unixepoch ::= '"fn": "unixepoch"' ', "args": [' (TIME (',' MODIFIER)*)? ']'
```

The seconds since 1970-01-01 00:00:00 UTC of a time value, after its modifiers: SQLite's `unixepoch()`. The result
is an integer, with the fraction cut off; with the `subsec` modifier it is a real with milliseconds.

## Parameters

| Argument | Type | |
|---|---|---|
| `TIME` | any | Optional: a [time value](./#time-values): text, or a number (a julian day, or seconds with `unixepoch`). Without one, the current instant. |
| `MODIFIER` | `text` | Any number: [modifiers](./#modifiers), applied from left to right. |

## Returns

An integer (`int`), or a `real` with `subsec`: the catalog gives `num`, so declare the type the call gives. NULL when
an argument is NULL, when the time value or a modifier doesn't parse, and when the result is out of range.

## Errors

| Code | When |
|---|---|
| `SMALT_ERROR` | In an index expression or a CHECK constraint, the call reads the clock or the host's time zone. |

## Notes

- A `date` or `datetime` value is read as the number underneath it, not as its date: pass it through
  [`cast_text`](../conversion/cast_text) first.
- Before 1970 the result is negative, and without `subsec` the cut goes toward the earlier second:
  `1969-12-31 23:59:59.5` gives -1.
- To read seconds back, give them to the other functions with the `unixepoch` modifier.

## Examples

```json
{
  "kind": "query",
  "plan": {
    "op": "values",
    "types": ["int", "real", "int", "int", "int"],
    "rows": [[
      {"k": "call", "fn": "unixepoch", "args": [{"k": "lit", "value": "2026-11-07 12:30:45.999", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "unixepoch", "args": [
        {"k": "lit", "value": "2026-11-07 12:30:45.25", "type": "text"},
        {"k": "lit", "value": "subsec", "type": "text"}
      ], "type": "real"},
      {"k": "call", "fn": "unixepoch", "args": [{"k": "lit", "value": "1970-01-01", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "unixepoch", "args": [{"k": "lit", "value": "1969-12-31 23:59:59.5", "type": "text"}], "type": "int"},
      {"k": "call", "fn": "unixepoch", "args": [{"k": "lit", "value": null, "type": "text"}], "type": "int"}
    ]]
  },
  "columns": [{"name": "seconds"}, {"name": "subsec"}, {"name": "epoch"}, {"name": "before"}, {"name": "null"}]
}
```

| seconds | subsec | epoch | before | null |
|---|---|---|---|---|
| 1794054645 | 1794054645.25 | 0 | -1 | NULL |

## Demo

Each order's day as seconds since 1970:

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
          {"k": "call", "fn": "unixepoch", "args": [
            {"k": "call", "fn": "cast_text", "args": [
              {"k": "col", "input": 0, "index": 0, "depth": 0, "type": "date", "collation": "binary"}
            ], "type": "text"}
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
  "columns": [{"name": "day"}, {"name": "seconds"}]
}
```

| day | seconds |
|---|---|
| 2026-11-02 | 1793577600 |
| 2026-11-03 | 1793664000 |
| 2026-11-04 | 1793750400 |
| 2026-11-05 | 1793836800 |

## See also

- [`julianday`](./julianday), [`strftime`](./strftime) (`%s`), [`datetime`](./datetime)
- [Date and time text functions](./)
- [`call`](../../expressions/call): how a plan calls a function
